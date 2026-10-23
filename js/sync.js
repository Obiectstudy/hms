/**
 * 云同步的纯函数层：整库快照的打包 / 解析 / 同步决策 / 冲突副本 / 防抖调度。
 *
 * 这个文件里没有任何网络调用——真实的上传下载由阶段 3 的适配器接入（后端选型见 SPEC §15.3）。
 * 这里只提供可测试的决策核心：所有函数要么是纯输入输出，要么把时钟与定时器作为参数注入。
 *
 * 「本地有没有改动」不用脏标记（写路径漏标一次就是静默的不同步），而是同步时现算内容校验和，
 * 与 meta.syncState.checksum（上次成功推/拉时的锚点）比较：不等就是有改动。
 */

export const SNAPSHOT_VERSION = 1;
export const SYNC_STATE_KEY = 'syncState';

/** 无法稳定序列化（函数 / BigInt / 循环引用 …）时的固定兜底校验和。 */
const CHECKSUM_FALLBACK = '00000000';
// 32 位 FNV-1a：短、快、对「内容变了」足够敏感，而且不需要 crypto
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 16777619;

function fnv1a(text) {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 稳定序列化：对象键排序、数组保序；其余语义与 JSON.stringify 一致
 * （值为 undefined / 函数 / Symbol 的键被丢弃，数组项变成 null，Date 走 toJSON）。
 * 返回 undefined 表示「这个值本身进不了 JSON」。
 */
function stableStringify(value, seen) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? String(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      throw new Error('bigint 无法稳定序列化');
    default:
      break;
  }
  if (typeof value !== 'object') return undefined;
  if (typeof value.toJSON === 'function') return stableStringify(value.toJSON(), seen);
  if (seen.has(value)) throw new Error('循环引用无法稳定序列化');

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => stableStringify(item, seen) ?? 'null');
      return `[${items.join(',')}]`;
    }
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      const text = stableStringify(value[key], seen);
      if (text === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${text}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    // 同一个对象在兄弟位置重复出现是合法的，只有「自己包含自己」才算循环
    seen.delete(value);
  }
}

/** 确定性校验和：同样的数据永远得同一个值。用于判断「本地是否改过」。 */
export function checksum(value) {
  let text;
  try {
    text = stableStringify(value, new Set());
  } catch {
    return CHECKSUM_FALLBACK;
  }
  return typeof text === 'string' ? fnv1a(text) : CHECKSUM_FALLBACK;
}

// ---------- 云同步的密钥边界 ----------

/**
 * 云同步绝不携带的设置键：API Key 是设备本地凭据，用户明确选择「不同步」。
 * 实现落在本文件而不是 js/pure.js，是因为本文件被既有断言钉死「源码零网络零 DOM 且不含跨模块引用」；
 * js/pure.js 把这三个导出原样再导出，所以别处拿到的与这里用的是同一份实现（logic 用例钉住身份相等）。
 */
export const SYNC_EXCLUDED_SETTINGS = ['apiKey'];

/** 深拷贝：优先用环境的克隆能力，拿不到（老浏览器 / 含函数的数据体）时退回逐键克隆。 */
function deepCopy(value) {
  if (!value || typeof value !== 'object') return value;
  const clone = globalThis.structuredClone;
  if (typeof clone === 'function') {
    try {
      return clone(value);
    } catch {
      /* 含函数值的数据体克不动，退回逐键克隆 */
    }
  }
  if (Array.isArray(value)) return value.map(deepCopy);
  const out = {};
  for (const key of Object.keys(value)) out[key] = deepCopy(value[key]);
  return out;
}

function dropExcludedKeys(settings) {
  if (!isDataObject(settings)) return;
  for (const key of SYNC_EXCLUDED_SETTINGS) delete settings[key];
}

/**
 * 返回一份深拷贝副本，并删掉 settings 里的排除键（顶层 settings 与 meta.settings 都处理：
 * 快照里设置其实住在 meta.settings）。非对象入参返回安全空对象，绝不抛。
 */
export function stripSyncSecrets(payload) {
  const out = deepCopy(payload);
  if (!isDataObject(out)) return {};
  dropExcludedKeys(out.settings);
  dropExcludedKeys(out.meta && out.meta.settings);
  return out;
}

/** 设置容器在快照里的两个可能位置：顶层 settings 与 meta.settings。 */
const SETTINGS_PATHS = [['settings'], ['meta', 'settings']];

function readPath(source, path) {
  let cur = source;
  for (const key of path) {
    if (!isDataObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function writePath(target, path, value) {
  let cur = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (!isDataObject(cur[key])) cur[key] = {};
    cur = cur[key];
  }
  cur[path[path.length - 1]] = value;
}

/**
 * 拉取远端快照之后、落到本机之前：以远端为基准，但密钥只认本机。
 * 1) 排除键一律不采信远端（哪怕是老版本传上去的密钥），本机有就写回本机的值；
 * 2) 远端没有 settings（或缺成非对象）时整份沿用本机 settings —— 远端没表态不等于本机设置丢了；
 * 3) 两边都不是对象时返回安全空对象 {}，绝不抛。
 */
export function mergeRemoteIntoLocal({ remote, local } = {}) {
  const base = isDataObject(remote) ? deepCopy(remote) : {};
  const localSrc = isDataObject(local) ? local : {};
  for (const path of SETTINGS_PATHS) {
    const remoteSettings = readPath(base, path);
    const localSettings = readPath(localSrc, path);
    // 「远端没表态」= 缺这个容器、或给了个空对象：此时整份沿用本机设置。
    // 不这么做的话，一台从没保存过设置的设备推上来的空 settings 会把别人的模型名 / 单位偏好冲成默认值。
    if (!isDataObject(remoteSettings) || !Object.keys(remoteSettings).length) {
      if (isDataObject(localSettings)) writePath(base, path, deepCopy(localSettings));
      continue;
    }
    for (const key of SYNC_EXCLUDED_SETTINGS) {
      if (isDataObject(localSettings) && key in localSettings) remoteSettings[key] = deepCopy(localSettings[key]);
      else delete remoteSettings[key];
    }
  }
  return base;
}

// ---------- 快照 ----------

function isDataObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRev(rev) {
  return Number.isInteger(rev) && rev >= 0 ? rev : 0;
}

function normalizeTime(savedAt, fallback) {
  const at = Number(savedAt);
  return Number.isFinite(at) && at > 0 ? Math.floor(at) : fallback;
}

/** 打包一条整库快照。校验失败抛中文错误，交给调用方决定怎么提示。 */
export function buildSnapshot({ accountId, rev, savedAt, payload } = {}) {
  const id = typeof accountId === 'string' ? accountId.trim() : '';
  if (!id) throw new Error('快照缺少账号标识');
  if (!isDataObject(payload)) throw new Error('快照缺少数据体');
  return {
    v: SNAPSHOT_VERSION,
    accountId: id,
    rev: normalizeRev(rev),
    savedAt: normalizeTime(savedAt, Date.now()),
    payload,
  };
}

/**
 * 解析一条快照。脏数据（版本不符 / 缺字段 / 类型不对 / 根本不是对象）一律 null，绝不抛：
 * 远端返回什么都不能把同步流程炸掉。
 */
export function parseSnapshot(raw) {
  if (!isDataObject(raw)) return null;
  if (raw.v !== SNAPSHOT_VERSION) return null;
  const accountId = typeof raw.accountId === 'string' ? raw.accountId.trim() : '';
  if (!accountId) return null;
  if (!Number.isInteger(raw.rev) || raw.rev < 0) return null;
  if (!isDataObject(raw.payload)) return null;
  const savedAt = normalizeTime(raw.savedAt, 0);
  if (!savedAt) return null;
  return { v: SNAPSHOT_VERSION, accountId, rev: raw.rev, savedAt, payload: raw.payload };
}

// ---------- 同步决策 ----------

function usableRemote(remote) {
  return isDataObject(remote) && Number.isInteger(remote.rev) && remote.rev >= 0;
}

/** 业务记录数：快照里四张明细表的条数合计（photos 不进快照，不计入）。 */
export function businessRecordCount(payload) {
  const src = isDataObject(payload) ? payload : {};
  return countRows(src.weights) + countRows(src.meals) + countRows(src.exercises) + countRows(src.waters);
}

/**
 * 给定本地与远端状态，返回该做什么。conflict-pull 的含义是：
 * 两边都动过 —— 调用方必须先 makeConflictBackup 存下本机数据，再拉远端覆盖，绝不静默丢数据。
 */
export function planSync({ localRev = 0, localChecksum, syncedChecksum, remote = null, localRecordCount } = {}) {
  const rev = normalizeRev(localRev);
  if (!usableRemote(remote)) {
    return { action: 'push', reason: '远端没有可用的快照，上传本机数据' };
  }
  const remoteRev = remote.rev;
  // syncedChecksum 为 null/undefined = 从没成功同步过：本地一律按「有改动」处理 —— 除了一种例外：
  // 本机一条业务记录都没有（新设备首次登录）时没有任何值得备份的本机数据，
  // 按「有改动」判会白留一份空冲突副本并弹提示，所以按无改动走 pull。
  const neverSynced = syncedChecksum == null;
  const pristine = neverSynced && Number(localRecordCount) === 0;
  const dirty = !pristine && (neverSynced || localChecksum !== syncedChecksum);

  if (remoteRev < rev) {
    return { action: 'push', reason: '远端版本落后于本机，上传本机数据纠正远端' };
  }
  if (remoteRev > rev) {
    if (pristine) return { action: 'pull', reason: '本机没有业务数据且从没同步过，直接拉取远端' };
    return dirty
      ? { action: 'conflict-pull', reason: '本地与远端都有改动，先备份本机数据再拉取远端' }
      : { action: 'pull', reason: '本地无改动，远端版本更新，拉取远端' };
  }
  return dirty
    ? { action: 'push', reason: '本地有改动，远端版本一致，上传本机数据' }
    : { action: 'none', reason: '本地无改动且远端版本一致，无需同步' };
}

// ---------- 冲突副本 ----------

/**
 * 把落败的那份数据包一层，存进 meta.conflictBackup（SPEC §15.2）。
 * 包装体只有 savedAt + payload 两个字段，不带 v/accountId/rev —— 正是靠这一点与正式快照区分。
 */
export function makeConflictBackup({ payload, savedAt } = {}) {
  return { savedAt: normalizeTime(savedAt, Date.now()), payload };
}

/** 只认 { savedAt > 0, payload 是对象 } 这一种形状；正式快照（带 v/rev/accountId）不算副本。 */
export function isConflictBackup(raw) {
  if (!isDataObject(raw)) return false;
  if ('v' in raw || 'accountId' in raw || 'rev' in raw) return false;
  if (!normalizeTime(raw.savedAt, 0)) return false;
  return isDataObject(raw.payload);
}

// ---------- 防抖调度 ----------

/**
 * 防抖调度：本地改动后延迟触发一次上传，窗口内的连续 schedule 合并成一次（并重置计时）。
 * now / setTimer / clearTimer 默认用 Date.now / setTimeout / clearTimeout，注入假实现后可确定性推进。
 * onFire(reason, waitedMs)：waitedMs 是这次触发实际等了多少毫秒（flush 立即触发时为 0）。
 */
export function createDebouncer({ delayMs = 5000, onFire, now, setTimer, clearTimer } = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const arm = typeof setTimer === 'function' ? setTimer : (fn, ms) => setTimeout(fn, ms);
  const disarm = typeof clearTimer === 'function' ? clearTimer : (id) => clearTimeout(id);
  const fire = typeof onFire === 'function' ? onFire : () => {};
  const delay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;

  let timer = null;
  let scheduledAt = 0;
  let armed = false;
  let reason = null;
  let generation = 0;

  function trigger() {
    if (!armed) return;
    const waitedMs = Math.max(0, clock() - scheduledAt);
    const text = reason;
    armed = false;
    timer = null;
    generation += 1; // 还在路上的定时器就此作废
    reason = null;
    fire(text, waitedMs);
  }

  return {
    schedule(nextReason) {
      reason = nextReason === undefined ? null : nextReason;
      if (timer !== null) {
        disarm(timer);
        timer = null;
      }
      scheduledAt = clock();
      armed = true;
      generation += 1;
      const mine = generation;
      timer = arm(() => {
        if (mine !== generation) return; // 已经被 cancel / flush / 再次 schedule 换掉
        timer = null;
        trigger();
      }, delay);
    },
    cancel() {
      if (timer !== null) {
        disarm(timer);
        timer = null;
      }
      armed = false;
      generation += 1;
      reason = null;
    },
    pending() {
      return armed;
    },
    flush() {
      if (timer !== null) {
        disarm(timer);
        timer = null;
      }
      trigger();
    },
  };
}

// ---------- 摘要 ----------

function countRows(rows) {
  return Array.isArray(rows) ? rows.length : 0;
}

/** 列表页/调试页要的一行摘要：存于何时、多少条记录、包多大。非法快照返回 null。 */
export function snapshotSummary(snapshot) {
  const snap = parseSnapshot(snapshot);
  if (!snap) return null;
  let bytes = 0;
  try {
    bytes = String(JSON.stringify(snap.payload) ?? '').length;
  } catch {
    return null; // 循环引用之类根本发不出去
  }
  return {
    savedAt: snap.savedAt,
    records:
      countRows(snap.payload.weights) +
      countRows(snap.payload.meals) +
      countRows(snap.payload.exercises) +
      countRows(snap.payload.waters),
    bytes,
  };
}

// ---------- 载荷压缩（网关 POST /push 的请求体上限） ----------
//
// 网关对 /push 请求体的硬上限是 102400 字节（实测 102401 → 413 EXCEED_MAX_PAYLOAD_SIZE），
// 而这个 413 是网关自产的、不带 CORS 头：真机 WebView 读不到响应体，界面只会说「网络不可用」，
// 用户既看不懂也没法自救。所以「压缩 + 量字节 + 拦下超限」全部放在客户端、发请求之前；
// 服务端一行不改（它只把 payload 当不透明 JSON 对象存，不需要认识压缩包装）。

/** 压缩包装体的标记键：{ "__gz": "<base64>" }。老快照没有这个键，照旧按普通 JSON 处理。 */
export const GZIP_MARKER_KEY = '__gz';

/**
 * 单次上传的请求体安全阈值：网关硬上限 102400（GATEWAY_MAX_REQUEST_BYTES，见 js/cloud-api.js），
 * 留 2400 字节余量给 token 与包装开销。超过就明确拒绝上传 —— 绝不把注定 413 的请求发出去。
 */
export const PUSH_BODY_LIMIT_BYTES = 100000;

/** 低于这个大小就不压缩：base64 的 33% 膨胀加上包装开销会吃掉压缩收益，小数据原样上传更省也更兼容。 */
export const PUSH_COMPRESS_MIN_BYTES = 8192;

/**
 * UTF-8 字节数（不是字符数：一个汉字 3 字节、emoji 4 字节）。
 * 判断超限必须用它 —— String.length 会把中文载荷算小三分之二，正好是最危险的方向。
 */
export function utf8Bytes(text) {
  const src = typeof text === 'string' ? text : String(text ?? '');
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(src).length;
  // 兜底（实际上到不了：能跑 ES module 的环境都有 TextEncoder）：没有它就按 UTF-8 规则手算
  let bytes = 0;
  for (let i = 0; i < src.length; i += 1) {
    const code = src.charCodeAt(i);
    const next = i + 1 < src.length ? src.charCodeAt(i + 1) : 0;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * POST /push 请求体的确切文本：键与顺序跟 js/cloud-api.js 发出去的 body 完全一致（用例钉死）。
 * 这样「量出来的大小」就是「发出去的大小」，量字节与发请求不存在第二份算法。
 */
export function pushBodyText({ token, baseRev, payload } = {}) {
  return JSON.stringify({ token, baseRev, payload });
}

/** 压缩包装体：服务端照旧当不透明 JSON 存，客户端靠这个键认出压缩体。 */
export function compressedPayloadOf(base64) {
  return { [GZIP_MARKER_KEY]: base64 };
}

/** 是不是压缩包装体：只认「有 __gz 且为字符串」。普通 JSON 的老快照永远不会命中这条。 */
export function isCompressedPayload(value) {
  return isDataObject(value) && typeof value[GZIP_MARKER_KEY] === 'string';
}

/** 把一段字节灌进 TransformStream 再收回来：浏览器与 Node 通用，不依赖 Blob / Response。 */
async function pumpThrough(transform, bytes) {
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const chunks = [];
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  })();
  const writing = (async () => {
    await writer.write(bytes);
    await writer.close();
  })();
  await Promise.all([reading, writing]); // 数据坏了 / 流出错在任一侧都会在这里抛
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64); // 非法 base64 在这里抛，由调用方翻成中文
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 环境默认的 gzip 编解码器（CompressionStream / DecompressionStream）。
 * 拿不到这两个能力（老 WebView）就返回 null —— 调用方必须回退成不压缩上传，绝不能因此同步不了。
 */
export function createStreamCompressor(scope) {
  const source = isDataObject(scope) ? scope : globalThis;
  const compress = source.CompressionStream;
  const decompress = source.DecompressionStream;
  if (typeof compress !== 'function' || typeof decompress !== 'function') return null;
  if (typeof TextEncoder !== 'function' || typeof TextDecoder !== 'function') return null;
  return {
    /** 文本 → gzip 字节 → base64。 */
    async compressToBase64(text) {
      const bytes = await pumpThrough(new compress('gzip'), new TextEncoder().encode(String(text ?? '')));
      return bytesToBase64(bytes);
    },
    /** base64 → gzip 字节 → 文本；base64 坏了、或压根不是 gzip 数据都会抛，由调用方翻成中文。 */
    async decompressFromBase64(base64) {
      const bytes = await pumpThrough(new decompress('gzip'), base64ToBytes(String(base64 ?? '')));
      return new TextDecoder().decode(bytes);
    },
  };
}

/** 压缩能力解析：没注入就用环境能力；显式传 null 表示「不要压缩」（老环境模拟与单测用）。 */
function resolveCompressor(compressor) {
  if (compressor === null) return null;
  if (compressor && typeof compressor === 'object') return compressor;
  return createStreamCompressor();
}

function positiveBytes(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function kbText(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function tooLargeMessage(bytes, limit, compressed) {
  return `本机数据太大：${compressed ? '压缩后' : ''}请求体 ${kbText(bytes)}，超过单次上传上限 ${kbText(limit)}，`
    + '本次没有上传，本机数据一个字节都没动。请先在设置页导出备份，再清理部分历史数据后重试。';
}

/**
 * 上传前的编码 + 前置拦截（纯逻辑，不发任何请求）：
 *   1) 先量出「原样上传」的请求体字节数；
 *   2) 载荷够大时 gzip → base64 → { __gz }，只有确实更小才采用；
 *   3) 环境没有压缩能力 / 压缩反而更大 / 载荷太小 → 原样上传（绝不因为「压不动」就同步不了）；
 *   4) 最终请求体超过阈值 → ok:false + 中文原因，且不交出 payload / body（免得调用方顺手用上）。
 * 返回 { ok, mode, compressed, payload, body, bytes, rawBytes, gzipBytes, limitBytes, overLimit, error, message }。
 */
export async function encodePayloadForUpload({ payload, token, baseRev, compressor, limitBytes, compressMinBytes } = {}) {
  const limit = positiveBytes(limitBytes, PUSH_BODY_LIMIT_BYTES);
  const minBytes = positiveBytes(compressMinBytes, PUSH_COMPRESS_MIN_BYTES);
  const rejected = (error, message) => ({
    ok: false, error, message, mode: 'raw', compressed: false, payload: null, body: '',
    bytes: 0, rawBytes: 0, gzipBytes: 0, limitBytes: limit, overLimit: false,
  });
  if (!isDataObject(payload)) return rejected('bad-payload', '本机没有可上传的数据：载荷不是对象');
  let rawText;
  try {
    rawText = pushBodyText({ token, baseRev, payload });
  } catch (error) {
    return rejected('bad-payload', `本机数据无法序列化（${reasonOf(error)}），本次没有上传`);
  }
  const rawBytes = utf8Bytes(rawText);
  let gzipPayload = null;
  let gzipText = '';
  let gzipBytes = 0;
  if (rawBytes >= minBytes) {
    const codec = resolveCompressor(compressor);
    if (codec && typeof codec.compressToBase64 === 'function') {
      try {
        gzipPayload = compressedPayloadOf(await codec.compressToBase64(JSON.stringify(payload)));
        gzipText = pushBodyText({ token, baseRev, payload: gzipPayload });
        gzipBytes = utf8Bytes(gzipText);
      } catch {
        gzipPayload = null; // 压缩失败不该让同步失败：退回原样上传
      }
    }
  }
  const compressed = Boolean(gzipPayload) && gzipBytes < rawBytes;
  const body = compressed ? gzipText : rawText;
  const bytes = compressed ? gzipBytes : rawBytes;
  const overLimit = bytes > limit;
  return {
    ok: !overLimit,
    mode: compressed ? 'gzip' : 'raw',
    compressed,
    // 超限时一个字节都不交出去：调用方只能拿到「为什么不行」，拿不到能发的载荷
    payload: overLimit ? null : (compressed ? gzipPayload : payload),
    body: overLimit ? '' : body,
    bytes,
    rawBytes,
    gzipBytes,
    limitBytes: limit,
    overLimit,
    error: overLimit ? 'payload-too-large' : undefined,
    message: overLimit ? tooLargeMessage(bytes, limit, compressed) : undefined,
  };
}

/**
 * 云端载荷解码：有 __gz 标记才解压；没有就原样返回（向后兼容 —— 老快照是普通 JSON）。
 * 解压失败一律 ok:false + 中文原因：绝不把认不出的东西当数据写进本机。
 */
export async function decodePayloadFromCloud(payload, options) {
  const { compressor } = options && typeof options === 'object' ? options : {};
  if (!isCompressedPayload(payload)) return { ok: true, compressed: false, payload };
  const codec = resolveCompressor(compressor);
  if (!codec || typeof codec.decompressFromBase64 !== 'function') {
    return {
      ok: false,
      compressed: true,
      error: 'no-decompressor',
      message: '云端数据是压缩格式，但当前环境不支持解压：请升级浏览器或 App 之后再同步',
    };
  }
  let text = '';
  try {
    text = await codec.decompressFromBase64(payload[GZIP_MARKER_KEY]);
  } catch (error) {
    return {
      ok: false,
      compressed: true,
      error: 'bad-payload',
      message: `云端数据解压失败（${reasonOf(error)}），可能不是本 App 写上去的压缩快照`,
    };
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, compressed: true, error: 'bad-payload', message: '云端数据解压后不是合法 JSON，无法读取' };
  }
  if (!isDataObject(data)) {
    return { ok: false, compressed: true, error: 'bad-payload', message: '云端数据解压后不是快照对象，无法读取' };
  }
  return { ok: true, compressed: true, payload: data };
}

// ---------- 云同步编排（阶段 3：网络与存储都由外面注入） ----------
// transport 由界面注入（js/cloud-transport.js），存储接口由调用方注入（js/store.js + js/db.js）。
// 本文件因此依旧零网络、零 DOM、零本地存储：全部依赖都可换成假实现，决策路径能确定性重放。

/** 冲突副本在 meta 里的键名（SPEC §15.2）：形状是 { savedAt, payload }，不带 v/accountId/rev。 */
export const CONFLICT_BACKUP_KEY = 'conflictBackup';

/** 每次同步都会变、但内容上不该算「本机改动」的 meta 键；规则必须与 store.getSyncPayload 一致。 */
export const SYNC_VOLATILE_META_KEYS = ['syncState', 'lastExportedAt'];

/**
 * 把 db.dumpAll() 的输出折成与 store.getSyncPayload() 完全同形的数据体，并给出校验和。
 * 纯函数（不碰存储），所以「本机有没有改动」的判断不会写任何 meta：
 * getSyncPayload 会顺手记一笔导出时间，用它做只读判断会把设置页的备份提醒静默关掉。
 * 与 store.getSyncPayload() 的内容等价由 ui.smoke 的一条用例钉死。
 */
export function syncDigestOf(dump) {
  const src = dump && typeof dump === 'object' ? dump : {};
  const meta = { ...(src.meta && typeof src.meta === 'object' ? src.meta : {}) };
  for (const key of SYNC_VOLATILE_META_KEYS) delete meta[key];
  // 剥密钥的时机在算校验和之前：锚点记的是「云端收到的那份」的指纹，密钥变了不算本机数据改动
  const payload = stripSyncSecrets({ app: 'hms', ...src, meta });
  delete payload.exportedAt;
  return { payload, checksum: checksum(payload) };
}

/** runSyncOnce 需要的存储接口：全部是函数，缺一个就明确报错，不去猜。 */
export const SYNC_STORAGE_METHODS = ['dumpAll', 'getSyncState', 'setSyncState', 'loadAll', 'getMeta', 'setMeta'];

function missingMethods(storage, names) {
  const src = storage && typeof storage === 'object' ? storage : {};
  return names.filter((name) => typeof src[name] !== 'function');
}

function reasonOf(error) {
  return error && error.message ? String(error.message) : String(error);
}

function failed(action, error, message, rev = 0) {
  return { ok: false, action, error, rev, message };
}

/** 非负整数 rev，其余一律 0。 */
function safeRev(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * 同步一次。返回 { ok, action, rev, message }（外加 savedAt / backupAt / reason 之类的上下文），永不抛：
 * 界面把 message 原样显示出来就是一句可读的中文。
 *
 * @param {object} options
 * @param {string} options.accountId 本机账号 id
 * @param {object} options.transport  { pull, push } —— 见 js/cloud-transport.js
 * @param {string} options.token      本机保存的登录令牌
 * @param {Function} [options.now]    时钟注入，默认 Date.now
 * @param {object} options.storage    { dumpAll, getSyncState, setSyncState, loadAll, getMeta, setMeta }
 * @param {object} [options.compressor] 压缩器注入（默认用环境的 CompressionStream；传 null = 不压缩）
 * @param {number} [options.limitBytes] 请求体安全阈值，默认 PUSH_BODY_LIMIT_BYTES
 * @param {number} [options.compressMinBytes] 触发压缩的最小载荷，默认 PUSH_COMPRESS_MIN_BYTES
 */
export async function runSyncOnce({
  accountId, transport, token, now, storage, compressor, limitBytes, compressMinBytes,
} = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const missing = missingMethods(storage, SYNC_STORAGE_METHODS);
  if (missing.length) {
    return failed('failed', 'no-storage', `同步所需的本地存储接口没接上（缺 ${missing.join('、')}），请刷新页面后重试`);
  }
  if (!transport || typeof transport.pull !== 'function' || typeof transport.push !== 'function') {
    return failed('failed', 'not-configured', '云同步未配置：没有可用的网关地址');
  }
  const auth = typeof token === 'string' ? token.trim() : '';
  if (!auth) return failed('failed', 'unauthorized', '还没登录：请先用云账号登录，再同步');

  // 1) 本机：内容 + 上次成功的锚点。localDump 留的是原始 dump（可能含密钥）：
  //    digest 已经剥过密钥（进云端的是它），合并远端时还要用原始那份把本机设置取回来。
  let digest;
  let localDump = null;
  let localRev = 0;
  let syncedChecksum = null;
  try {
    localDump = await storage.dumpAll();
    digest = syncDigestOf(localDump);
    const state = await storage.getSyncState();
    localRev = safeRev(state?.rev);
    syncedChecksum = typeof state?.checksum === 'string' && state.checksum ? state.checksum : null;
  } catch (error) {
    return failed('failed', 'local-error', `读取本机数据失败：${reasonOf(error)}`);
  }

  // 2) 云端：rev 与 payload 都认得出才参与决策。认不出就当「远端没有可用快照」交给 planSync 走上传——
  //    上传撞上 409 时会给出明确中文，本机数据一个字节都不会动。
  let remote = null;
  try {
    remote = await transport.pull({ token: auth });
  } catch (error) {
    return failed('failed', 'network', `无法连接云端：${reasonOf(error)}`, localRev);
  }
  if (!remote || remote.ok !== true) {
    return failed('failed', remote?.error ?? 'network', remote?.message || '拉取云端数据失败', localRev);
  }
  // 2b) 压缩快照（{ __gz }）先解出来再参与决策；解不出来就明确报错并原样保留本机数据，
  //     绝不把认不出的东西当数据写进本机（老快照没有标记，原样通过）。
  const decoded = await decodePayloadFromCloud(remote.payload, { compressor });
  if (!decoded.ok) {
    return failed('pull', decoded.error, `云端数据读取失败：${decoded.message}；本机数据没有被改动`, localRev);
  }
  const remoteSnap = parseSnapshot({
    v: SNAPSHOT_VERSION,
    accountId: typeof accountId === 'string' && accountId.trim() ? accountId.trim() : 'remote',
    rev: safeRev(remote.rev),
    savedAt: Number(remote.savedAt) || clock(),
    payload: decoded.payload,
  });
  const usableRemote = remoteSnap && remoteSnap.rev > 0 ? remoteSnap : null;

  // 3) 决策：全交给 planSync，本文件不重写一遍规则。localRecordCount 用来识别
  //    「新设备首次登录（空库且从没同步过）」——那种情况下不留空冲突副本，直接 pull。
  const plan = planSync({
    localRev,
    localChecksum: digest.checksum,
    syncedChecksum,
    remote: usableRemote,
    localRecordCount: businessRecordCount(digest.payload),
  });

  // 4a) 上传
  if (plan.action === 'push') {
    // 4a-0) 上传前编码：里面能压就压成 { __gz }、压不动就原样；最终请求体超限则在这里直接拦下。
    // 网关自产的 413 不带 CORS 头，真机上只会显示「网络不可用」——所以宁可不上传，也要给一句能看懂的中文。
    const upload = await encodePayloadForUpload({
      // 上传前再剥一次：任何要走云端的 payload 都不许带上 settings 里的密钥
      payload: stripSyncSecrets(digest.payload),
      token: auth,
      baseRev: localRev,
      compressor,
      limitBytes,
      compressMinBytes,
    });
    if (!upload.ok) {
      return failed('push', upload.error ?? 'payload-too-large', upload.message || '本机数据太大，无法上传', localRev);
    }
    let pushed = null;
    try {
      pushed = await transport.push({ token: auth, baseRev: localRev, payload: upload.payload });
    } catch (error) {
      return failed('push', 'network', `上传失败：${reasonOf(error)}`, localRev);
    }
    if (!pushed || pushed.ok !== true) {
      const serverRev = safeRev(pushed?.rev) || localRev;
      if (pushed?.error === 'rev-conflict') {
        return {
          ok: false,
          action: 'push',
          error: 'rev-conflict',
          rev: serverRev,
          message: `云端已有更新（rev ${serverRev}），本机改动还没上传：再点一次「立即同步」会先把本机数据存成冲突副本，再拉取云端`,
        };
      }
      return failed('push', pushed?.error ?? 'network', pushed?.message || '上传失败', serverRev);
    }
    const nextRev = Number.isInteger(pushed.rev) && pushed.rev >= 0 ? pushed.rev : localRev + 1;
    const savedAt = clock();
    try {
      await storage.setSyncState({ rev: nextRev, savedAt, checksum: digest.checksum });
    } catch (error) {
      return failed('push', 'local-error', `数据已上传，但本机同步锚点没保存（${reasonOf(error)}），下次可能重复上传一次`, nextRev);
    }
    return { ok: true, action: 'push', rev: nextRev, savedAt, message: `已上传本机数据（云端 rev ${nextRev}）`, reason: plan.reason };
  }

  // 4b) 下载：conflict-pull 先留冲突副本，绝不静默丢本机数据
  if (plan.action === 'pull' || plan.action === 'conflict-pull') {
    if (!usableRemote) {
      return failed(plan.action, 'bad-remote', '云端快照无法识别（版本或字段不对），本机数据没有被改动', localRev);
    }
    let backupAt = null;
    if (plan.action === 'conflict-pull') {
      const backup = makeConflictBackup({ payload: digest.payload, savedAt: clock() });
      try {
        await storage.setMeta(CONFLICT_BACKUP_KEY, backup);
        backupAt = backup.savedAt;
      } catch (error) {
        return failed(plan.action, 'local-error', `本机数据备份成冲突副本失败（${reasonOf(error)}），已放弃拉取以免丢数据`, localRev);
      }
    }
    // 应用到本机之前先合并：以远端为基准，但本机 settings 里的密钥原样留下（远端是被剥过的）
    const merged = mergeRemoteIntoLocal({ remote: usableRemote.payload, local: localDump });
    try {
      await storage.loadAll(merged, 'replace');
    } catch (error) {
      return failed(plan.action, 'local-error', `写入云端数据失败：${reasonOf(error)}`, localRev);
    }
    // 锚点按「云端数据落到本机之后」重新算：loadAll 的合并语义可能与快照内容不完全一致
    let appliedChecksum = digest.checksum;
    try {
      appliedChecksum = syncDigestOf(await storage.dumpAll()).checksum;
    } catch {
      // 算不出来就用拉取前的值：最坏是下次再推一次，绝不会凭空变成「已同步」
    }
    const savedAt = Number(usableRemote.savedAt) > 0 ? usableRemote.savedAt : clock();
    try {
      await storage.setSyncState({ rev: usableRemote.rev, savedAt, checksum: appliedChecksum });
    } catch (error) {
      return failed(plan.action, 'local-error', `云端数据已写入本机，但同步锚点没保存：${reasonOf(error)}`, usableRemote.rev);
    }
    return {
      ok: true,
      action: plan.action,
      rev: usableRemote.rev,
      savedAt,
      backupAt,
      reason: plan.reason,
      message: plan.action === 'conflict-pull'
        ? `本机改动已存成冲突副本，并已用云端数据（rev ${usableRemote.rev}）覆盖本机`
        : `已用云端数据（rev ${usableRemote.rev}）覆盖本机`,
    };
  }

  // 4c) 两边一致：只把 savedAt 记成「刚确认过」
  const savedAt = clock();
  try {
    await storage.setSyncState({ rev: localRev, savedAt, checksum: digest.checksum });
  } catch (error) {
    return failed('none', 'local-error', `同步状态没保存：${reasonOf(error)}`, localRev);
  }
  return { ok: true, action: 'none', rev: localRev, savedAt, message: '本机与云端已一致，无需同步', reason: plan.reason };
}

/** 读本机的冲突副本（按既有形状校验）：脏数据、取不到、存储不可用都返回 null，不抛。 */
export async function readConflictBackup(storage) {
  const src = storage && typeof storage === 'object' ? storage : {};
  if (typeof src.getMeta !== 'function') return null;
  let raw = null;
  try {
    raw = await src.getMeta(CONFLICT_BACKUP_KEY, null);
  } catch {
    return null;
  }
  return isConflictBackup(raw) ? raw : null;
}

/**
 * 本机改动后的防抖同步：连续改动合并成一次，默认延迟 5 秒（由 createDebouncer 保证）。
 * resolveContext() 返回 { accountId, transport, token, storage }；返回 null（未登录 / 未配置 / 没账号）
 * 就静默跳过这次触发——没登录不该被弹一堆错误。
 * fire() 立即同步一次（不等防抖）；whenIdle() 用来等正在跑的那次结束。
 */
export function createSyncScheduler({
  delayMs = 5000,
  resolveContext,
  runner,
  now,
  setTimer,
  clearTimer,
  onResult,
  onError,
} = {}) {
  const run = typeof runner === 'function' ? runner : runSyncOnce;
  let inflight = null;

  function fire(reason) {
    const task = Promise.resolve()
      .then(() => (typeof resolveContext === 'function' ? resolveContext() : null))
      .then((context) => (context ? run({ ...context, now }) : null))
      .then((result) => {
        if (result && typeof onResult === 'function') onResult(result, reason);
        return result;
      })
      .catch((error) => {
        if (typeof onError === 'function') onError(error, reason);
        return null;
      });
    inflight = task;
    return task;
  }

  const debouncer = createDebouncer({ delayMs, now, setTimer, clearTimer, onFire: (reason) => fire(reason) });

  return {
    schedule(reason) {
      debouncer.schedule(reason);
    },
    cancel() {
      debouncer.cancel();
    },
    pending() {
      return debouncer.pending();
    },
    flush() {
      debouncer.flush();
      return inflight;
    },
    fire,
    whenIdle() {
      return inflight ?? Promise.resolve(null);
    },
  };
}
