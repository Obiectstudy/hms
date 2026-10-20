// DashScope（百炼）OpenAI 兼容模式的视觉识别适配器。
// 浏览器直连：Key 由调用方从 IndexedDB 读出后传入，本模块不持久化任何凭据。
import { calibrateItems } from './foods.js';

export const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const DEFAULT_MODEL = 'qwen3-vl-plus';
export const MODEL_CANDIDATES = ['qwen3-vl-plus', 'qwen-vl-max', 'qwen-vl-plus', 'qwen2.5-vl-72b-instruct'];
export const REQUEST_TIMEOUT_MS = 25000;

const SYSTEM_PROMPT = '你是营养分析助手。你只输出 JSON，不输出解释文字或 Markdown 围栏。';

const HTTP_HINTS = {
  400: '请求格式不被服务端接受，可能是该模型不支持图片输入，请换用视觉模型。',
  401: 'API Key 无效或已过期，请到「设置 → 视觉识别」重新填写。',
  403: 'Key 已通过校验但没有该模型的权限，请到百炼控制台开通模型，或换用其他候选模型。',
  429: '请求过于频繁或额度不足，请稍后重试或检查账户配额。',
  500: '视觉服务内部错误，可稍后重试。',
  502: '视觉服务网关错误，可稍后重试。',
  503: '视觉服务繁忙，请稍后重试。',
};

function round1(n) {
  return Math.round((Number(n) + Number.EPSILON) * 10) / 10;
}

function toNum(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const m = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  }
  return null;
}

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[\s_\-.()（）[\]{}]/g, '');
}

function fieldSet(aliases) {
  return new Set(aliases.map(normalizeKey));
}

const NAME_KEYS = fieldSet(['name', 'food', 'food_name', 'dish', 'dish_name', 'title', 'label', '食物', '食品', '名称', '菜名', '菜品', '食物名称']);
const GRAM_KEYS = fieldSet(['grams', 'gram', 'g', 'weight', 'weight_g', 'weight_grams', 'quantity', 'amount', 'portion', 'portion_g', 'serving', 'serving_g', '克数', '重量', '份量', '克']);
const KCAL_KEYS = fieldSet(['kcal', 'cal', 'calorie', 'calories', 'energy', 'energy_kcal', 'kcal_per', '热量', '能量', '卡路里', '千卡']);
const CARB_KEYS = fieldSet(['carb', 'carbs', 'carbohydrate', 'carbohydrates', 'carb_g', 'carbohydrate_g', 'carbs_g', 'starch', 'sugar', '碳水', '碳水化合物']);
const PROTEIN_KEYS = fieldSet(['protein', 'proteins', 'protein_g', 'proteins_g', '蛋白质', '蛋白']);
const FAT_KEYS = fieldSet(['fat', 'fats', 'fat_g', 'lipid', 'lipids', '脂肪']);
const FIBER_KEYS = fieldSet(['fiber', 'fibre', 'dietary_fiber', 'dietary_fibre', 'fiber_g', '纤维', '膳食纤维']);
const SODIUM_KEYS = fieldSet(['sodium', 'na', 'sodium_mg', 'salt', '钠', '盐']);
const CONFIDENCE_KEYS = fieldSet(['confidence', 'conf', 'certainty', '置信度', '把握']);
const NOTE_KEYS = fieldSet(['note', 'notes', 'message', 'comment', '说明', '备注']);
const ITEMS_KEYS = fieldSet(['items', 'foods', 'results', 'data', 'list', 'food_items', '食物', '结果', '条目']);

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (keys.has(normalizeKey(k))) return v;
  }
  return undefined;
}

function normalizeConfidence(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 0.8) return 'high';
    if (value >= 0.5) return 'medium';
    return 'low';
  }
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'high' || text === '高') return 'high';
  if (text === 'medium' || text === '中') return 'medium';
  if (text === 'low' || text === '低') return 'low';
  return undefined;
}

function modelJsonError(message, raw) {
  const err = new Error(message);
  err.raw = raw;
  return err;
}

// 从任意文本里截出第一个括号配平的 JSON 值：模型常在前后加解释文字。
function extractFirstJson(text) {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseJsonLoose(text) {
  const attempts = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) attempts.push(fenced[1].trim());
  const extracted = extractFirstJson(text);
  if (extracted) attempts.push(extracted);
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      return JSON.parse(attempt);
    } catch {
      // 继续尝试下一种切片方式
    }
  }
  return undefined;
}

function hasNameish(obj) {
  return typeof pick(obj, NAME_KEYS) === 'string' && String(pick(obj, NAME_KEYS)).trim() !== '';
}

function hasNutritionNumbers(obj) {
  return [KCAL_KEYS, CARB_KEYS, PROTEIN_KEYS, FAT_KEYS].some((keys) => Number.isFinite(toNum(pick(obj, keys))));
}

// 返回 null 表示「找不到条目容器」；返回 [] 表示「容器存在但为空」。
function itemsFrom(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;
  for (const [k, v] of Object.entries(value)) {
    if (ITEMS_KEYS.has(normalizeKey(k)) && Array.isArray(v)) return v;
  }
  for (const v of Object.values(value)) {
    if (Array.isArray(v) && v.some((x) => x && typeof x === 'object' && (hasNameish(x) || hasNutritionNumbers(x)))) return v;
  }
  if (hasNameish(value) || hasNutritionNumbers(value)) return [value];
  for (const v of Object.values(value)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = itemsFrom(v);
      if (nested && nested.length) return nested;
    }
  }
  return null;
}

function normalizeRawItem(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const rawName = pick(obj, NAME_KEYS);
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  const grams = toNum(pick(obj, GRAM_KEYS));
  let kcal = toNum(pick(obj, KCAL_KEYS));
  let carb = toNum(pick(obj, CARB_KEYS));
  let protein = toNum(pick(obj, PROTEIN_KEYS));
  let fat = toNum(pick(obj, FAT_KEYS));
  const fiber = toNum(pick(obj, FIBER_KEYS));
  const sodium = toNum(pick(obj, SODIUM_KEYS));
  const hasAnyNumber = [grams, kcal, carb, protein, fat, fiber, sodium].some(Number.isFinite);
  if (!name && !hasAnyNumber) return null;

  const hasAllMacros = [carb, protein, fat].every(Number.isFinite);
  if (!Number.isFinite(kcal) && hasAllMacros) kcal = Math.round(carb * 4 + protein * 4 + fat * 9);
  if (Number.isFinite(kcal) && !hasAllMacros) {
    carb = (kcal * 0.5) / 4;
    protein = (kcal * 0.2) / 4;
    fat = (kcal * 0.3) / 9;
  }

  const item = { name: name || '未命名食物' };
  if (Number.isFinite(grams)) item.grams = round1(grams);
  item.kcal = Number.isFinite(kcal) ? Math.round(Math.max(0, kcal)) : 0;
  item.carb = round1(Math.max(0, carb || 0));
  item.protein = round1(Math.max(0, protein || 0));
  item.fat = round1(Math.max(0, fat || 0));
  if (Number.isFinite(fiber)) item.fiber = round1(Math.max(0, fiber));
  if (Number.isFinite(sodium)) item.sodium = round1(Math.max(0, sodium));
  const confidence = normalizeConfidence(pick(obj, CONFIDENCE_KEYS));
  if (confidence) item.confidence = confidence;
  return item;
}

export function parseModelJson(text) {
  const raw = typeof text === 'string' ? text : text == null ? '' : String(text);
  const trimmed = raw.trim();
  if (!trimmed) throw modelJsonError('模型返回了空内容，无法解析识别结果。', raw);

  const value = parseJsonLoose(trimmed);
  if (value === undefined) throw modelJsonError('无法解析模型返回的 JSON（可能被截断或不是 JSON）。', raw);

  const found = itemsFrom(value);
  if (found === null) throw modelJsonError('模型返回的 JSON 里没有食物条目。', raw);

  const items = found.map(normalizeRawItem).filter(Boolean);
  if (found.length > 0 && items.length === 0) throw modelJsonError('模型返回的食物条目不含任何可用字段。', raw);

  const result = { items };
  const note = value && typeof value === 'object' && !Array.isArray(value) ? pick(value, NOTE_KEYS) : undefined;
  if (typeof note === 'string' && note.trim()) result.note = note.trim();
  return result;
}

export function buildPrompt() {
  return [
    '请分析这张食物照片，完成：',
    '1. 识别画面中全部食物（包括主食、配菜、汤和饮料），不要遗漏。',
    '2. 中式菜品按常见一份的真实份量估算克数与营养素。',
    '3. 每项输出 { name, grams, kcal, carb, protein, fat, fiber?, sodium?, confidence }。',
    '4. 碳水/蛋白质/脂肪单位为克，钠单位为毫克，数值都是这一份的实际摄入量。',
    '5. 无法确定克数时给出合理估计，并把 confidence 设为 "low"。',
    '只输出 {"items":[...]} 这一段 JSON，不要解释文字，不要 Markdown 围栏。',
  ].join('\n');
}

export function buildRequestBody({ dataUrl, model } = {}) {
  if (typeof dataUrl !== 'string' || !dataUrl) {
    throw new Error('缺少图片数据，无法构造识别请求。');
  }
  return {
    model: model || DEFAULT_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: buildPrompt() },
        ],
      },
    ],
    temperature: 0.1,
  };
}

function joinUrl(baseUrl) {
  const base = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

function timeoutError(ms) {
  const err = new Error(`识别超时（${Math.round(ms / 1000)} 秒）：照片可能太大或网络太慢，建议换个网络后重试。`);
  err.code = 'TIMEOUT';
  return err;
}

function networkError(cause) {
  const err = new Error(`网络请求失败：请检查手机网络后重试。${cause?.message ? `（${cause.message}）` : ''}`);
  err.code = 'NETWORK';
  err.cause = cause;
  return err;
}

function isTimeoutCause(err) {
  if (!err) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  return /timeout|timed out|aborted/i.test(String(err.message || ''));
}

function httpError(status, serverText, model) {
  let detail = '';
  try {
    const parsed = JSON.parse(serverText);
    const e = parsed?.error;
    if (e && typeof e === 'object') detail = [e.code, e.message].filter(Boolean).join(': ');
    else detail = parsed?.message || parsed?.code || '';
  } catch {
    detail = String(serverText || '').trim().slice(0, 200);
  }
  let hint = HTTP_HINTS[status];
  if (!hint && status === 404) hint = '';
  if (status === 404) {
    hint = `模型「${model}」不存在或未开通，请在设置中切换模型。候选：${MODEL_CANDIDATES.join(' / ')}。`;
  }
  if (!hint) hint = status >= 500 ? '视觉服务暂时不可用，请稍后重试。' : '请求被服务端拒绝，请检查设置后重试。';
  const err = new Error(`识别请求失败（HTTP ${status}）：${hint}${detail ? ` 服务端信息：${detail}` : ''}`);
  err.status = status;
  err.detail = detail;
  err.raw = serverText;
  err.code = 'HTTP_' + status;
  if (status === 401 || status === 403 || status === 404) err.needSettings = true;
  return err;
}

export async function fileToDataUrl(file, { maxEdge = 1024, quality = 0.8 } = {}) {
  try {
    if (!file) throw new Error('没有选择图片文件。');
    const type = String(file.type || '');
    if (type === 'image/heic' || type === 'image/heif') {
      throw new Error('iPhone 的 HEIC 照片浏览器读不了，请在相册里导出为 JPG 后再选。');
    }
    if (type && !type.startsWith('image/')) {
      throw new Error(`这个文件不是图片（${type}），请选择 JPG 或 PNG 照片。`);
    }
    if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') {
      throw new Error('当前环境不支持图片压缩（缺少浏览器画布），请直接选原图或手动添加食物。');
    }
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器画布初始化失败。');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (typeof bitmap.close === 'function') bitmap.close();
    return { dataUrl: canvas.toDataURL('image/jpeg', quality), mime: 'image/jpeg' };
  } catch (err) {
    if (err instanceof Error && /[\u4e00-\u9fa5]/.test(err.message)) throw err;
    throw new Error(`图片处理失败：${err?.message || '未知错误'}，请换一张照片重试。`);
  }
}

async function resolveDataUrl(input) {
  if (!input) throw new Error('没有拿到图片，请重新选择照片。');
  if (typeof input === 'object' && typeof input.dataUrl === 'string') {
    if (!/^data:image\//i.test(input.dataUrl)) throw new Error('图片数据格式不对，请重新拍照。');
    return input.dataUrl;
  }
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    const { dataUrl } = await fileToDataUrl(input);
    return dataUrl;
  }
  throw new Error('不支持的图片输入，请重新选择照片。');
}

function extractContent(payload) {
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text ?? payload?.output?.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

export async function analyzeFoodPhoto(input, { apiKey, model, baseUrl, fetchImpl } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) {
    const err = new Error('还没有填写 API Key：请到「设置 → 视觉识别」填写后再拍照识别。');
    err.code = 'NO_API_KEY';
    err.needSettings = true;
    throw err;
  }
  const dataUrl = await resolveDataUrl(input);
  const chosenModel = model || DEFAULT_MODEL;
  const body = buildRequestBody({ dataUrl, model: chosenModel, baseUrl });
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('当前环境不支持网络请求（fetch 不可用）。');

  let response;
  try {
    response = await doFetch(joinUrl(baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
    });
  } catch (cause) {
    if (isTimeoutCause(cause)) throw timeoutError(REQUEST_TIMEOUT_MS);
    throw networkError(cause);
  }

  const text = await response.text();
  if (!response.ok) throw httpError(response.status, text, chosenModel);

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    const err = new Error('服务端返回的不是合法 JSON，无法解析识别结果。');
    err.code = 'BAD_JSON';
    err.raw = text;
    throw err;
  }

  const content = extractContent(payload);
  if (!content.trim()) {
    const err = new Error('模型没有返回识别内容，可能是图片过于模糊，请重拍或手动添加。');
    err.code = 'EMPTY_CONTENT';
    err.raw = text;
    throw err;
  }

  let parsed;
  try {
    parsed = parseModelJson(content);
  } catch (err) {
    if (!err.raw) err.raw = content;
    err.rawResponse = text;
    throw err;
  }

  let items;
  try {
    items = calibrateItems(parsed.items);
  } catch (err) {
    if (!err.raw) err.raw = content;
    throw err;
  }

  return { items, raw: content, model: payload?.model || chosenModel, usage: payload?.usage };
}

export async function testConnection({ apiKey, model, baseUrl, fetchImpl } = {}) {
  const chosenModel = model || DEFAULT_MODEL;
  const result = (ok, message, finalModel = chosenModel) => ({ ok, message, model: finalModel });
  const key = String(apiKey || '').trim();
  if (!key) return result(false, '还没有填写 API Key，请到「设置 → 视觉识别」填写后重试。');
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return result(false, '当前环境不支持网络请求（fetch 不可用）。');

  let response;
  try {
    response = await doFetch(joinUrl(baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: chosenModel,
        messages: [{ role: 'user', content: '只回复 ok' }],
        max_tokens: 1,
        temperature: 0,
      }),
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
    });
  } catch (cause) {
    if (isTimeoutCause(cause)) return result(false, `连接超时（${REQUEST_TIMEOUT_MS / 1000} 秒），请检查网络后重试。`);
    return result(false, `连接失败：请检查手机网络后重试。${cause?.message ? `（${cause.message}）` : ''}`);
  }

  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }

  if (response.ok) {
    let respModel = chosenModel;
    try {
      const payload = JSON.parse(text);
      if (payload && typeof payload.model === 'string' && payload.model) respModel = payload.model;
    } catch {
      // 连接测试只关心 HTTP 层成功，响应体解析失败不算失败
    }
    return result(true, `连接成功，模型「${respModel}」可用。`, respModel);
  }

  if (response.status === 401) {
    return result(false, 'API Key 无效或已过期：请到「设置 → 视觉识别」重新填写。');
  }
  if (response.status === 403) {
    return result(false, 'Key 有效但没有该模型权限：请到百炼控制台开通模型，或在设置中换一个候选模型。');
  }
  if (response.status === 404) {
    return result(false, `模型「${chosenModel}」不存在或未开通。候选模型：${MODEL_CANDIDATES.join(' / ')}。`);
  }
  if (response.status === 429) {
    return result(false, '请求过于频繁或额度不足：请稍后重试或检查账户配额。');
  }
  let detail = '';
  try {
    const parsed = JSON.parse(text);
    detail = parsed?.error?.message || parsed?.message || '';
  } catch {
    detail = String(text || '').trim().slice(0, 120);
  }
  return result(false, `连接失败（HTTP ${response.status}）${detail ? `：${detail}` : '：请稍后重试'}。`);
}
