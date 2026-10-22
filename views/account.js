// 账号页（本机多账号 + 云同步）：登记 / 切换 / 改名 / 删除 + 登录 / 注册 / 找回密码 / 同步。
// 隔离原则见 js/accounts.js：一个账号一个 IndexedDB 库，本机数据永远留在这台设备。
// 云端只做「整库快照的备份与恢复」：登录后把本机数据推上去，换设备时再拉下来；
// 冲突时先在本机留一份副本（meta.conflictBackup），绝不静默覆盖本机数据。
import { el, toast, confirmDialog, openSheet, emptyState } from '../js/ui.js';
import {
  listAccounts, getActiveAccount, createAccount, renameAccount, removeAccount,
  dbNameForAccount, LEGACY_DB_NAME, MAX_ACCOUNTS,
} from '../js/accounts.js';
import { currentAccount, switchAccount, getSyncState, setSyncState } from '../js/store.js';
import { dumpAll, loadAll, getMeta, setMeta } from '../js/db.js';
import {
  baseUrl as CLOUD_BASE_URL, isCloudConfigured, readCloudAuth, writeCloudAuth,
  clearCloudToken, bindAccountServerId,
} from '../js/cloud-config.js';
import { createCloudTransport } from '../js/cloud-transport.js';
import { runSyncOnce, createSyncScheduler, readConflictBackup, syncDigestOf } from '../js/sync.js';

const go = (hash) => window.HMS.navigate(hash);
const refresh = () => window.HMS.refresh();

const messageOf = (error) => (error && error.message ? error.message : String(error));

const isLegacy = (account) => dbNameForAccount(account) === LEGACY_DB_NAME;

// 同步层的存储接口：js/sync.js 保持「零 import 的纯函数层」，存储与网络都由调用方注入。
const SYNC_STORAGE = { dumpAll, getSyncState, setSyncState, loadAll, getMeta, setMeta };

const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;
const PASSWORD_MIN = 8;
const SYNC_DEBOUNCE_MS = 5000;

function checkUsername(raw) {
  const value = String(raw ?? '').trim();
  if (!USERNAME_RE.test(value)) throw new Error('用户名需 3–32 位字母、数字或下划线');
  return value;
}

function checkPassword(raw) {
  const value = String(raw ?? '');
  if (value.length < PASSWORD_MIN) throw new Error(`密码至少 ${PASSWORD_MIN} 位`);
  return value;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 同步时间：只到分钟（秒没有信息量，还占宽度）。取不到就是「尚未同步」。 */
function fmtWhen(ts) {
  const value = Number(ts);
  if (!Number.isFinite(value) || value <= 0) return '尚未同步';
  const d = new Date(value);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 本机数据规模与内容指纹：dumpAll 是数据层唯一只读统计入口。
 * 指纹走 syncDigestOf（纯函数），不碰 meta —— 用 store.getSyncPayload 做只读判断会顺手
 * 记一笔导出时间，把设置页的备份提醒静默关掉。
 */
async function readLocalSummary() {
  try {
    const dump = await dumpAll();
    const counts = {
      weights: dump.weights.length,
      meals: dump.meals.length,
      exercises: dump.exercises.length,
      waters: dump.waters.length,
    };
    const digest = syncDigestOf(dump);
    let bytes = 0;
    try {
      bytes = String(JSON.stringify(digest.payload) ?? '').length;
    } catch {
      bytes = 0; // 循环引用之类根本发不出去，规模显示 0 就行，别连累整页
    }
    return {
      counts,
      total: counts.weights + counts.meals + counts.exercises + counts.waters,
      bytes,
      checksum: digest.checksum,
    };
  } catch {
    return null; // 统计失败只让数字变成「—」
  }
}

/** 同步状态：锚点（时间 / rev）+ 本机有没有改动。任何一项取不到都不抛。 */
async function readSyncStatus(summary) {
  let state = null;
  try {
    state = await getSyncState();
  } catch {
    state = null;
  }
  const backup = await readConflictBackup(SYNC_STORAGE);
  const rev = Number.isInteger(state?.rev) && state.rev >= 0 ? state.rev : 0;
  const syncedChecksum = typeof state?.checksum === 'string' && state.checksum ? state.checksum : null;
  // 从没成功同步过（没有锚点）= 本机一定有未上传的改动；连本机内容都读不出来才是「不知道」
  const dirty = summary ? (syncedChecksum ? summary.checksum !== syncedChecksum : true) : null;
  return {
    rev,
    savedAt: Number(state?.savedAt) > 0 ? Math.floor(Number(state.savedAt)) : null,
    dirty,
    backupAt: backup ? backup.savedAt : null,
  };
}

const SCALE_ROWS = [
  ['weights', '体重'],
  ['meals', '饮食'],
  ['exercises', '运动'],
  ['waters', '饮水'],
];

function createdText(createdAt) {
  const ts = Number(createdAt);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} 创建`;
}

/** 行内 async 流程：异常一律变成一条 toast，不冒泡成未处理的 rejection。 */
function guard(task) {
  return () => {
    Promise.resolve().then(task).catch((error) => toast(messageOf(error), 'error'));
  };
}

function inputBox(props = {}) {
  return el('input', { className: 'input', type: 'text', ...props });
}

function labeled(label, control) {
  return el('label', { className: 'field' }, el('span', { className: 'field__label', text: label }), control);
}

/**
 * 起名弹层：新建与改名共用。
 * onSubmit 抛错时把中文报错原样显示（例如「账号名称不能为空」）并保持弹层打开。
 */
function askName({ title, value, submitText, note, onSubmit }) {
  return openSheet({
    title,
    content: ({ close }) => {
      const input = inputBox({ value: value || '', attr: { maxlength: '20', placeholder: '例如 家人' } });
      const submit = el('button', { className: 'btn btn--primary btn--block', text: submitText });
      submit.addEventListener('click', () => {
        Promise.resolve()
          .then(() => onSubmit(input.value))
          .then((result) => close(result), (error) => toast(messageOf(error), 'error'));
      });
      return el('div', { className: 'col' },
        labeled('账号名称', input),
        note ? el('div', { className: 'muted', text: note }) : null,
        submit,
      );
    },
    actions: [{ text: '取消', value: null }],
  });
}

/**
 * 云账号表单弹层：登录 / 注册 / 找回密码共用。
 * onSubmit 校验失败或后端报错都只把中文提示打出来，弹层保持打开让用户改。
 */
function askCloudForm({ title, note, submitText, fields, onSubmit }) {
  return openSheet({
    title,
    content: ({ close }) => {
      const controls = fields.map((field) => {
        const input = el('input', {
          className: 'input',
          type: field.type || 'text',
          value: field.value ?? '',
          placeholder: field.placeholder || '',
          attr: { autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', ...(field.attr || {}) },
        });
        return { key: field.key, input, node: labeled(field.label, input) };
      });
      const submit = el('button', { className: 'btn btn--primary btn--block', text: submitText });
      submit.addEventListener('click', () => {
        const values = {};
        for (const control of controls) values[control.key] = control.input.value;
        Promise.resolve()
          .then(() => onSubmit(values))
          .then((result) => close(result), (error) => toast(messageOf(error), 'error'));
      });
      return el('div', { className: 'col' },
        controls.map((control) => control.node),
        note ? el('div', { className: 'muted', text: note }) : null,
        submit,
      );
    },
    actions: [{ text: '取消', value: null }],
  });
}

function copyText(text) {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    toast('这个浏览器不支持一键复制，请手动抄写', 'info');
    return;
  }
  Promise.resolve(clipboard.writeText(text)).then(
    () => toast('恢复码已复制', 'ok'),
    () => toast('复制失败，请手动抄写', 'error'),
  );
}

/**
 * 恢复码：只出现一次，必须点「我已保存」才算看过。
 * 关掉（× / 遮罩 / Esc 都是 null）就再弹一次——恢复码没存下来就永远找不回密码了。
 */
async function showRecoveryCode({ username, recoveryCode }) {
  let confirmed = false;
  while (!confirmed) {
    const answer = await openSheet({
      title: '请立即保存恢复码',
      content: ({ close }) => el('div', { className: 'col' },
        el('div', { className: 'cloud-code' },
          el('div', { className: 'cloud-code__label', text: `${username || '云账号'} 的恢复码` }),
          el('div', { className: 'cloud-code__value', text: recoveryCode }),
        ),
        el('div', { className: 'muted', text: '恢复码只出现一次：忘了密码只能靠它重置。请抄写或截图后存到安全的地方。' }),
        el('button', { className: 'btn btn--ghost btn--block', text: '复制恢复码', onClick: () => copyText(recoveryCode) }),
        el('button', { className: 'btn btn--primary btn--block', text: '我已保存', onClick: () => close('saved') }),
      ),
      actions: [],
    });
    if (answer === 'saved') confirmed = true;
    else toast('恢复码只出现一次，请点「我已保存」再关闭', 'error');
  }
}

export async function render(root, deps = {}) {
  const ensured = await currentAccount(); // 幂等：一次都没建过账号时先认领老库
  const accounts = listAccounts();
  const current = ensured ?? { id: null, name: '本机', dbName: LEGACY_DB_NAME };
  const activeId = accounts.some((a) => a.id === current.id) ? current.id : null;

  // 云同步依赖：地址来自 js/cloud-config.js；测试可以整份注入（含假 transport，绝不真发请求）
  const cloudUrl = typeof deps.baseUrl === 'string' ? deps.baseUrl : CLOUD_BASE_URL;
  const cloudReady = isCloudConfigured(cloudUrl);
  const transport = deps.transport ?? (cloudReady ? createCloudTransport({ baseUrl: cloudUrl, fetchImpl: deps.fetchImpl }) : null);

  const summary = await readLocalSummary();
  const scale = summary ? summary.counts : null;
  const cloudAuth = cloudReady ? readCloudAuth(current.id) : null;
  const loggedIn = Boolean(cloudAuth?.token);
  const status = await readSyncStatus(summary);

  root.appendChild(el('div', { className: 'row row--between' },
    el('div', { className: 'col' },
      el('div', { className: 'h1', text: '账号' }),
      el('div', { className: 'muted', text: '每个账号的数据单独保存' }),
    ),
    el('button', { className: 'btn btn--ghost btn--sm', text: '返回设置', onClick: () => go('#/settings') }),
  ));

  // ---- 当前账号 ----
  const legacyCurrent = isLegacy(current);
  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '当前账号' }),
      el('span', { className: legacyCurrent ? 'pill pill--ok' : 'pill', text: legacyCurrent ? '本机老数据' : '新建的账号' }),
    ),
    el('div', { className: 'account-name', text: String(current.name || '本机') }),
    el('div', { className: 'grid-2 account-stats' },
      SCALE_ROWS.map(([key, label]) => {
        const count = scale ? scale[key] : null;
        const known = Number.isFinite(count);
        return el('div', { className: 'stat' },
          el('div', { className: 'stat__line' },
            el('span', { className: 'stat__value stat__value--sm', text: known ? String(count) : '—' }),
            known ? el('span', { className: 'stat__unit', text: '条' }) : null,
          ),
          el('div', { className: 'stat__label', text: label }),
        );
      }),
    ),
    el('div', { className: 'muted', text: loggedIn
      ? `已开启云同步：云端账号 ${cloudAuth.username || cloudAuth.serverId}`
      : '数据只存在这台设备' }),
  ));

  // ---- 云同步 ----
  root.appendChild(buildCloudCard());

  // ---- 账号列表 ----
  const full = accounts.length >= MAX_ACCOUNTS;
  const listCard = el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '账号列表' }),
      el('div', { className: 'muted', text: `${accounts.length} / ${MAX_ACCOUNTS}` }),
    ),
  );

  const list = el('div', { className: 'account-list' });
  for (const account of accounts) {
    const active = account.id === activeId;
    const legacy = isLegacy(account);
    const identity = legacy ? '本机老数据' : '新建的账号';
    const created = legacy ? '' : createdText(account.createdAt);
    const bound = cloudReady ? readCloudAuth(account.id) : null;
    const binding = bound?.token ? `已登录 ${bound.username || '云端账号'}` : (bound?.serverId ? '已绑定云端' : '');
    list.appendChild(el('div', { className: active ? 'account-row account-row--active' : 'account-row' },
      el('button', { className: 'account-row__main', onClick: guard(() => selectAccount(account)) },
        el('div', { className: 'account-row__name', text: account.name }),
        el('div', { className: 'account-row__meta', text: [identity, created, active ? '当前使用' : '点一下切换', binding].filter(Boolean).join(' · ') }),
      ),
      el('div', { className: 'account-row__acts' },
        el('button', { className: 'account-row__btn', text: '改名', onClick: guard(() => renameFlow(account)) }),
        legacy
          ? el('button', { className: 'account-row__btn account-row__btn--danger', text: '删除', disabled: true, attr: { 'aria-disabled': 'true' } })
          : el('button', { className: 'account-row__btn account-row__btn--danger', text: '删除', onClick: guard(() => removeFlow(account)) }),
      ),
      legacy ? el('div', { className: 'account-row__note', text: '本机数据所在账号不能删除' }) : null,
    ));
  }
  listCard.appendChild(accounts.length ? list : emptyState('还没有可切换的账号', '新建账号', guard(createFlow)));
  listCard.appendChild(el('button', {
    className: 'btn btn--primary btn--block account-new',
    text: full ? `已达上限（${MAX_ACCOUNTS} 个）` : '新建账号',
    disabled: full,
    onClick: guard(createFlow),
  }));
  root.appendChild(listCard);

  // 防抖同步的接线点：本阶段还没有哪个视图会在写入后通知同步，先挂到 window.HMS.cloud 上，
  // 谁写入数据谁调 window.HMS.cloud.schedule('local-change')（本地改动后 5 秒内合并成一次同步）。
  if (cloudReady && loggedIn) installCloudScheduler();

  // ---------- 云同步卡片 ----------

  function buildCloudCard() {
    const card = el('div', { className: 'card col cloud-card' },
      el('div', { className: 'card__head', style: { marginBottom: '0' } },
        el('div', { className: 'card__title', text: '云同步' }),
        cloudReady
          ? el('span', { className: loggedIn ? 'pill pill--ok' : 'pill', text: loggedIn ? '已登录' : '未登录' })
          : el('span', { className: 'pill pill--warn', text: '未配置' }),
      ),
    );

    if (!cloudReady) {
      card.appendChild(el('div', { className: 'cloud-note', text: '云同步未配置：填好网关地址后，就能用云账号在别的设备恢复数据。' }));
      card.appendChild(el('div', { className: 'muted', text: '未配置之前不会发出任何网络请求，本机功能一切照旧。' }));
      return card;
    }

    if (loggedIn) {
      card.appendChild(el('div', { className: 'cloud-account' },
        el('span', { className: 'cloud-account__name', text: cloudAuth.username || '云账号' }),
        cloudAuth.serverId ? el('span', { className: 'cloud-account__id', text: `ID ${cloudAuth.serverId}` }) : null,
      ));
    } else {
      card.appendChild(el('div', { className: 'cloud-note', text: '登录后可把本机数据备份到云端，也能在别的设备恢复。' }));
    }

    const rows = [
      ['上次同步', el('span', { className: 'cloud-status__value', text: fmtWhen(status.savedAt) })],
      ['云端版本', el('span', { className: 'cloud-status__value', text: `rev ${status.rev}` })],
      ['本机数据', el('span', { className: 'cloud-status__value', text: summary ? `${summary.total} 条 · ${fmtBytes(summary.bytes)}` : '—' })],
      ['本机改动', status.dirty === null || status.dirty === undefined
        ? el('span', { className: 'cloud-status__value', text: '—' })
        : el('span', { className: status.dirty ? 'pill pill--warn' : 'pill pill--ok', text: status.dirty ? '有未同步改动' : '已全部同步' })],
    ];
    card.appendChild(el('div', { className: 'cloud-status' },
      rows.map(([label, value]) => el('div', { className: 'cloud-status__row' },
        el('span', { className: 'cloud-status__label', text: label }),
        value,
      )),
    ));

    if (status.backupAt) {
      card.appendChild(el('div', { className: 'cloud-warn', text: `存在冲突副本：${fmtWhen(status.backupAt)} 的本机数据已在本机备份（冲突时不会静默覆盖），需要时可在设置页导出查看。` }));
    }

    // 注册时拿到了恢复码但用户还没点「我已保存」（比如中途切了页面）：在本机留着，随时能再看一次
    if (cloudAuth?.pendingRecoveryCode) {
      card.appendChild(el('div', { className: 'cloud-warn' },
        el('div', { text: '恢复码还没确认保存：它只出现一次，忘了密码只能靠它。' }),
        el('button', { className: 'btn btn--ghost btn--block', text: '查看恢复码', onClick: guard(reviewRecoveryCode) }),
      ));
    }

    if (loggedIn) {
      card.appendChild(el('button', { className: 'btn btn--primary btn--block', text: '立即同步', onClick: guard(() => syncNow()) }));
      card.appendChild(el('button', { className: 'btn btn--ghost btn--block', text: '退出登录', onClick: guard(logoutFlow) }));
    } else {
      card.appendChild(el('div', { className: 'cloud-actions' },
        el('button', { className: 'btn btn--primary', text: '登录', onClick: guard(() => loginFlow()) }),
        el('button', { className: 'btn btn--ghost', text: '注册', onClick: guard(() => registerFlow()) }),
      ));
      card.appendChild(el('button', { className: 'btn btn--ghost btn--block', text: '找回密码', onClick: guard(() => resetFlow()) }));
    }
    return card;
  }

  // ---------- 云同步流程 ----------

  /** 同步一次：结果一律提示成一句中文（成功绿色 / 失败红色），绝不抛。 */
  async function syncNow({ token } = {}) {
    const saved = readCloudAuth(current.id);
    const useToken = token || saved?.token;
    if (!useToken) {
      toast('请先登录云账号', 'error');
      return null;
    }
    const result = await runSyncOnce({ accountId: current.id, transport, token: useToken, storage: SYNC_STORAGE });
    toast(result.message, result.ok ? 'ok' : 'error');
    return result;
  }

  async function loginFlow(presetUsername = '') {
    const result = await askCloudForm({
      title: '登录云账号',
      note: '登录后本机数据会同步到云端，也能在别的设备恢复。',
      submitText: '登录',
      fields: [
        { key: 'username', label: '用户名', value: presetUsername, placeholder: '注册时用的用户名' },
        { key: 'password', label: '密码', type: 'password', placeholder: `至少 ${PASSWORD_MIN} 位`, attr: { autocomplete: 'current-password' } },
      ],
      onSubmit: async (values) => {
        const username = checkUsername(values.username);
        const password = checkPassword(values.password);
        const res = await transport.login({ username, password });
        if (!res || res.ok !== true) throw new Error(res?.message || '登录失败，请检查用户名和密码');
        const token = String(res.token ?? '').trim();
        if (!token) throw new Error('登录成功但没有拿到令牌，请联系云端管理员');
        return { username, token, userId: String(res.userId ?? '').trim(), expiresAt: res.expiresAt };
      },
    });
    if (!result) return null;

    writeCloudAuth(current.id, {
      username: result.username,
      serverId: result.userId,
      token: result.token,
      expiresAt: result.expiresAt,
    });
    if (result.userId) bindAccountServerId(current.id, result.userId);
    toast(`已登录：${result.username}`, 'ok');
    const synced = await syncNow({ token: result.token }); // 登录成功立刻同步一次
    await refresh();
    return synced;
  }

  async function registerFlow() {
    const result = await askCloudForm({
      title: '注册云账号',
      note: '恢复码只会出现一次，请务必保存：忘了密码只能靠它',
      submitText: '注册',
      fields: [
        { key: 'username', label: '用户名', placeholder: '3–32 位字母、数字或下划线', attr: { maxlength: '32', autocomplete: 'username' } },
        { key: 'password', label: '密码', type: 'password', placeholder: `至少 ${PASSWORD_MIN} 位`, attr: { autocomplete: 'new-password' } },
        { key: 'confirm', label: '再输一次密码', type: 'password', attr: { autocomplete: 'new-password' } },
      ],
      onSubmit: async (values) => {
        const username = checkUsername(values.username);
        const password = checkPassword(values.password);
        if (password !== values.confirm) throw new Error('两次输入的密码不一致');
        const res = await transport.register({ username, password });
        if (!res || res.ok !== true) throw new Error(res?.message || '注册失败，请稍后再试');
        const recoveryCode = String(res.recoveryCode ?? '').trim();
        if (!recoveryCode) throw new Error('注册成功但没有拿到恢复码，请联系云端管理员');
        return { username, userId: String(res.userId ?? '').trim(), recoveryCode };
      },
    });
    if (!result) return null;

    // 先落「绑定」再谈恢复码：用户中途切页也不会连账号绑定都丢
    if (result.userId) {
      writeCloudAuth(current.id, { serverId: result.userId, username: result.username });
      bindAccountServerId(current.id, result.userId);
    }
    writeCloudAuth(current.id, { pendingRecoveryCode: result.recoveryCode });
    await showRecoveryCode(result); // 不点「我已保存」不算看过，恢复码只出现一次
    writeCloudAuth(current.id, { pendingRecoveryCode: '' });
    await refresh();
    toast(`注册成功：${result.username}，请用新密码登录`, 'ok');
    return loginFlow(result.username); // 注册不返回令牌，顺手把用户名带进登录框
  }

  async function resetFlow(presetUsername = '') {
    const result = await askCloudForm({
      title: '用恢复码找回密码',
      note: '恢复码只在注册时出现一次；忘了密码只能靠它重置。',
      submitText: '重置密码',
      fields: [
        { key: 'username', label: '用户名', value: presetUsername, placeholder: '注册时用的用户名' },
        { key: 'recoveryCode', label: '恢复码', placeholder: '注册时保存的那一串' },
        { key: 'newPassword', label: '新密码', type: 'password', placeholder: `至少 ${PASSWORD_MIN} 位`, attr: { autocomplete: 'new-password' } },
      ],
      onSubmit: async (values) => {
        const username = checkUsername(values.username);
        const recoveryCode = String(values.recoveryCode ?? '').trim();
        if (!recoveryCode) throw new Error('请填写恢复码');
        const newPassword = checkPassword(values.newPassword);
        const res = await transport.reset({ username, recoveryCode, newPassword });
        if (!res || res.ok !== true) throw new Error(res?.message || '重置失败，请检查用户名和恢复码');
        return { username };
      },
    });
    if (!result) return null;

    toast('密码已重置，请用新密码登录', 'ok');
    return loginFlow(result.username);
  }

  /** 恢复码还没确认保存时再看一次：同一套「必须点我已保存」的弹层，确认后从本机抹掉。 */
  async function reviewRecoveryCode() {
    const saved = readCloudAuth(current.id);
    if (!saved?.pendingRecoveryCode) {
      toast('恢复码已经确认保存过了', 'info');
      return;
    }
    await showRecoveryCode({ username: saved.username, recoveryCode: saved.pendingRecoveryCode });
    writeCloudAuth(current.id, { pendingRecoveryCode: '' });
    await refresh();
    toast('恢复码已确认保存', 'ok');
  }

  async function logoutFlow() {
    const ok = await confirmDialog({
      title: '退出云账号？',
      message: '退出后本机数据仍在，只是不再自动同步到云端。',
      okText: '退出登录',
    });
    if (!ok) return;
    clearCloudToken(current.id); // 只清令牌：本机数据与「已绑定云端」的记录都留着
    await refresh();
    toast('已退出登录，本机数据未动', 'ok');
  }

  function installCloudScheduler() {
    const win = typeof window !== 'undefined' ? window : null;
    const scheduler = createSyncScheduler({
      delayMs: SYNC_DEBOUNCE_MS,
      resolveContext: () => {
        const active = getActiveAccount(); // 每次触发都按「当前是谁」重算，切账号后不会同步错库
        if (!active) return null;
        const saved = readCloudAuth(active.id);
        if (!saved?.token) return null;
        return { accountId: active.id, transport, token: saved.token, storage: SYNC_STORAGE };
      },
      onResult: (result) => {
        if (!result.ok) toast(result.message, 'error');
      },
      onError: (error) => toast(messageOf(error), 'error'),
    });
    if (win && win.HMS) {
      win.HMS.cloud = {
        schedule: (reason) => scheduler.schedule(reason),
        flush: () => scheduler.flush(),
        cancel: () => scheduler.cancel(),
        pending: () => scheduler.pending(),
      };
    }
    return scheduler;
  }

  // ---------- 本机账号操作 ----------

  async function selectAccount(account) {
    if (account.id === activeId) {
      toast('已经在这个账号');
      return;
    }
    await switchAccount(account.id); // 换库：库名跟着账号走，页面按新库重画
    await refresh();
    toast(`已切换到 ${account.name}`, 'ok');
  }

  async function createFlow() {
    const created = await askName({
      title: '新建账号',
      value: '',
      submitText: '创建并切换',
      note: '新账号从空数据开始，与现在的数据互不影响',
      onSubmit: (name) => createAccount({ name }),
    });
    if (!created || typeof created !== 'object') return; // 用户取消：什么都没发生
    await switchAccount(created.id);
    await refresh();
    toast('新账号从空数据开始', 'ok');
  }

  async function renameFlow(account) {
    const renamed = await askName({
      title: '重命名账号',
      value: account.name,
      submitText: '保存名称',
      onSubmit: (name) => renameAccount(account.id, name),
    });
    if (!renamed || typeof renamed !== 'object') return;
    await refresh();
    toast(`已改名为 ${renamed.name}`, 'ok');
  }

  async function removeFlow(account) {
    const ok = await confirmDialog({
      title: `删除账号「${account.name}」？`,
      message: '该账号的数据会从本机删除，且无法恢复。',
      okText: '删除',
    });
    if (!ok) return;
    await removeAccount(account.id);
    let next = null;
    if (account.id === activeId) {
      // 删掉的正是当前账号：回到目录里的下一个账号（通常是认领老库的那个）
      next = await currentAccount();
      if (next) await switchAccount(next.id);
    }
    await refresh();
    toast(next ? `已删除「${account.name}」，已切回「${next.name}」` : `已删除「${account.name}」`, 'ok');
  }
}
