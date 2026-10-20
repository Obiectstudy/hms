// vision-ai 的自动验收：全部用注入的假 fetchImpl，不碰真实网络与 API Key。
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  MODEL_CANDIDATES,
  buildRequestBody,
  buildPrompt,
  fileToDataUrl,
  parseModelJson,
  analyzeFoodPhoto,
  testConnection,
} from '../js/vision.js';
import { FOODS, searchFoods, findFood, calibrateItems } from '../js/foods.js';

const results = { passed: 0, failed: 0, failures: [] };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function eq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}：期望 ${b}，实际 ${a}`);
}

function close(actual, expected, message, epsilon = 0.001) {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > epsilon) {
    throw new Error(`${message}：期望 ≈${expected}，实际 ${actual}`);
  }
}

async function rejects(fn, pattern, message) {
  try {
    await fn();
  } catch (err) {
    if (pattern && !pattern.test(String(err?.message || ''))) {
      throw new Error(`${message}：错误文案不符（实际：${err?.message}）`);
    }
    return err;
  }
  throw new Error(`${message}：预期抛错但没有抛`);
}

function throwsSync(fn, pattern, message) {
  try {
    fn();
  } catch (err) {
    if (pattern && !pattern.test(String(err?.message || ''))) {
      throw new Error(`${message}：错误文案不符（实际：${err?.message}）`);
    }
    return err;
  }
  throw new Error(`${message}：预期抛错但没有抛`);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------- parseModelJson

test('parseModelJson 吃掉 ```json 围栏', () => {
  const text = '```json\n{"items":[{"name":"米饭","grams":200,"kcal":232,"carb":51.8,"protein":5.2,"fat":0.6}]}\n```';
  const out = parseModelJson(text);
  eq(out.items.length, 1, '条数');
  eq(out.items[0].name, '米饭', '名称');
  eq(out.items[0].grams, 200, '克数');
  eq(out.items[0].kcal, 232, 'kcal');
});

test('parseModelJson 解析裸 JSON 数组', () => {
  const out = parseModelJson('[{"name":"鸡蛋","grams":50,"kcal":72,"carb":0.8,"protein":6.7,"fat":4.4}]');
  eq(out.items[0].name, '鸡蛋', '名称');
  eq(out.items[0].protein, 6.7, '蛋白质');
});

test('parseModelJson 解析 {items:[...]}', () => {
  const out = parseModelJson('{"items":[{"name":"牛奶","grams":200,"kcal":108,"carb":6.8,"protein":6,"fat":6.4}]}');
  eq(out.items.length, 1, '条数');
  eq(out.items[0].name, '牛奶', '名称');
  eq(out.items[0].carb, 6.8, '碳水');
});

test('parseModelJson 忽略前后解释文字', () => {
  const text = '好的，我看到图里有一碗米饭。\n{"items":[{"name":"米饭","grams":150,"kcal":174,"carb":38.9,"protein":3.9,"fat":0.5}]}\n希望有帮助！';
  const out = parseModelJson(text);
  eq(out.items[0].grams, 150, '克数');
});

test('parseModelJson 支持单个对象（无 items 包装）', () => {
  const out = parseModelJson('{"name":"香蕉","grams":120,"kcal":112,"carb":26.4,"protein":1.7,"fat":0.2,"confidence":"high"}');
  eq(out.items.length, 1, '条数');
  eq(out.items[0].confidence, 'high', 'confidence');
});

test('parseModelJson 容忍字段名大小写/下划线变体与数值字符串', () => {
  const text = '{"Food_Name":"米饭","Weight_G":"200g","Calories":"232 kcal","Carbs":"51.8","protein_g":"5.2","Fat":"0.6g","Sodium_Mg":"4mg"}';
  const out = parseModelJson(text);
  eq(out.items[0].name, '米饭', '名称');
  eq(out.items[0].grams, 200, '克数');
  eq(out.items[0].kcal, 232, 'kcal');
  eq(out.items[0].carb, 51.8, '碳水');
  eq(out.items[0].protein, 5.2, '蛋白质');
  eq(out.items[0].fat, 0.6, '脂肪');
  eq(out.items[0].sodium, 4, '钠');
});

test('parseModelJson 支持中文键名与带括号字段名', () => {
  const out = parseModelJson('{"食品":"酸奶","重量":"200g","热量":144,"蛋白质(g)":"7.2","碳水(g)":"18"}');
  eq(out.items[0].name, '酸奶', '中文名称键');
  eq(out.items[0].grams, 200, '中文克数键');
  eq(out.items[0].kcal, 144, '中文热量键');
  eq(out.items[0].protein, 7.2, '带括号字段名');
  eq(out.items[0].carb, 18, '带括号碳水');
});

test('parseModelJson 缺 kcal 但有宏量时用 4/4/9 补齐', () => {
  const out = parseModelJson('{"items":[{"name":"测试食物","grams":100,"carb":10,"protein":5,"fat":2}]}');
  eq(out.items[0].kcal, 78, '4/4/9 计算');
  close(out.items[0].carb, 10, '碳水保持');
});

test('parseModelJson 缺宏量但有 kcal 时按 0.5/0.2/0.3 反推', () => {
  const out = parseModelJson('{"items":[{"name":"测试食物","grams":100,"kcal":200}]}');
  close(out.items[0].carb, 25, '碳水反推');
  close(out.items[0].protein, 10, '蛋白反推');
  close(out.items[0].fat, 6.7, '脂肪反推');
});

test('parseModelJson 空输入抛中文错误并保留原文', () => {
  const err = throwsSync(() => parseModelJson('   '), /空/, '空输入');
  eq(err.raw, '   ', 'error.raw 保留原文');
});

test('parseModelJson 彻底失败时抛错且 error.raw 带原文', () => {
  const raw = '抱歉，这张图片太模糊了，我无法判断。';
  const err = throwsSync(() => parseModelJson(raw), /解析/, '非 JSON');
  eq(err.raw, raw, 'error.raw');
});

test('parseModelJson 空数组返回空 items，交给 calibrateItems 报规则 4', () => {
  const out = parseModelJson('{"items":[]}');
  eq(out.items.length, 0, '空数组');
});

// ---------------------------------------------------------------- 请求体与提示词

test('buildRequestBody 结构与 messages 顺序正确', () => {
  const dataUrl = 'data:image/jpeg;base64,AAAA';
  const body = buildRequestBody({ dataUrl, model: 'qwen-vl-plus' });
  eq(Object.keys(body), ['model', 'messages', 'temperature'], '顶层字段');
  eq(body.model, 'qwen-vl-plus', 'model 透传');
  eq(body.temperature, 0.1, 'temperature');
  eq(body.messages.length, 2, '消息数');
  eq(body.messages[0].role, 'system', 'system 在前');
  eq(body.messages[1].role, 'user', 'user 在后');
  assert(Array.isArray(body.messages[1].content), 'user.content 应为数组');
  eq(body.messages[1].content[0].type, 'image_url', '图片块第一');
  eq(body.messages[1].content[0].image_url.url, dataUrl, 'dataURL 直接放进 image_url');
  eq(body.messages[1].content[1].type, 'text', '文本块第二');
  assert(body.messages[1].content[1].text.includes('只输出'), '提示词要求只输出 JSON');
});

test('buildRequestBody 缺图片时报中文错误', () => {
  throwsSync(() => buildRequestBody({}), /图片/, '缺 dataUrl');
});

test('默认模型与候选清单锁定为实测可用值', () => {
  eq(DEFAULT_MODEL, 'qwen3-vl-plus', '默认模型');
  eq(MODEL_CANDIDATES, ['qwen3-vl-plus', 'qwen-vl-max', 'qwen-vl-plus', 'qwen2.5-vl-72b-instruct'], '候选清单');
  eq(MODEL_CANDIDATES[0], DEFAULT_MODEL, '默认模型必须在候选首位');
  assert(!MODEL_CANDIDATES.some((m) => /ocr/i.test(m)), 'OCR 类模型不适合食物识别，不应进入候选');
});

test('buildPrompt 覆盖 SPEC 8.2 的字段与低置信度要求', () => {
  const prompt = buildPrompt();
  for (const token of ['name', 'grams', 'kcal', 'carb', 'protein', 'fat', 'fiber', 'sodium', 'confidence']) {
    assert(prompt.includes(token), `提示词缺少 ${token}`);
  }
  assert(prompt.includes('low'), '提示词缺少 low 置信度要求');
  assert(prompt.includes('不要解释文字'), '提示词缺少只输出 JSON 约束');
});

// ---------------------------------------------------------------- calibrateItems

test('calibrateItems 规则1：库命中用库值覆盖四项并记 foodId', () => {
  const [item] = calibrateItems([{ name: '米饭 1 碗', grams: 200, kcal: 999, carb: 1, protein: 1, fat: 1 }]);
  eq(item.foodId, 'rice', 'foodId');
  eq(item.grams, 200, '克数');
  eq(item.kcal, 232, 'kcal 用库值');
  close(item.carb, 51.8, '碳水用库值');
  close(item.protein, 5.2, '蛋白用库值');
  close(item.fat, 0.6, '脂肪用库值');
});

test('calibrateItems 规则1：容忍括号后缀写法', () => {
  const [item] = calibrateItems([{ name: '红烧肉（小份）', grams: 120 }]);
  eq(item.foodId, 'braised-pork', 'foodId');
  eq(item.kcal, 566, 'kcal');
  close(item.fat, 55.2, '脂肪');
});

test('calibrateItems 规则2：未命中但有 kcal 时按 0.5/0.2/0.3 反推宏量', () => {
  const [item] = calibrateItems([{ name: '神秘能量棒', grams: 50, kcal: 200 }]);
  assert(!item.foodId, '未命中不应有 foodId');
  close(item.carb, 25, '碳水');
  close(item.protein, 10, '蛋白');
  close(item.fat, 6.7, '脂肪');
});

test('calibrateItems 规则3：grams<=0 夹到 50 并降为 low', () => {
  const [item] = calibrateItems([{ name: '神秘汤', grams: 0, kcal: 100, confidence: 'high' }]);
  eq(item.grams, 50, '克数夹取');
  eq(item.confidence, 'low', '置信度下调');
});

test('calibrateItems 规则3：grams>2000 夹到 500 并降为 low', () => {
  const [item] = calibrateItems([{ name: '神秘拼盘', grams: 5000, kcal: 800 }]);
  eq(item.grams, 500, '克数夹取');
  eq(item.confidence, 'low', '置信度下调');
});

test('calibrateItems 规则4：空数组抛中文提示', () => {
  throwsSync(() => calibrateItems([]), /没识别出食物/, '空数组');
  throwsSync(() => calibrateItems(null), /没识别出食物/, '非数组');
});

test('calibrateItems 是纯函数，不修改入参', () => {
  const input = deepFreeze([{ name: '米饭', grams: 200, kcal: 1, carb: 1, protein: 1, fat: 1, confidence: 'high' }]);
  const first = calibrateItems(input);
  const second = calibrateItems(input);
  eq(first, second, '两次结果一致');
  eq(input[0].kcal, 1, '入参未被修改');
  assert(first[0] !== input[0], '返回新对象');
});

// ---------------------------------------------------------------- analyzeFoodPhoto

const ITEM_CONTENT = JSON.stringify({
  items: [{ name: '米饭', grams: 200, kcal: 180, carb: 40, protein: 4, fat: 1, confidence: 'high' }],
});

test('analyzeFoodPhoto 200 正常 JSON：回填库值、透传模型与请求结构', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return jsonResponse({ model: 'qwen3-vl-plus', choices: [{ message: { content: ITEM_CONTENT } }], usage: { total_tokens: 12 } });
  };
  const out = await analyzeFoodPhoto({ dataUrl: 'data:image/jpeg;base64,AAAA', mime: 'image/jpeg' }, { apiKey: 'test-key', fetchImpl });
  eq(out.items[0].foodId, 'rice', '库校准');
  eq(out.items[0].kcal, 232, '库值覆盖模型估算');
  eq(out.model, 'qwen3-vl-plus', '模型名');
  eq(out.raw, ITEM_CONTENT, 'raw 保留模型原文');
  eq(out.usage.total_tokens, 12, 'usage 透传');
  eq(captured.url, `${DEFAULT_BASE_URL}/chat/completions`, '端点拼接');
  eq(captured.options.method, 'POST', '方法');
  eq(captured.options.headers.Authorization, 'Bearer test-key', '鉴权头');
  eq(captured.options.headers['Content-Type'], 'application/json', '内容类型');
  const body = JSON.parse(captured.options.body);
  eq(body.model, DEFAULT_MODEL, '请求体 model');
  eq(body.messages[1].content[0].image_url.url, 'data:image/jpeg;base64,AAAA', '请求体图片');
});

test('analyzeFoodPhoto 自定义 baseUrl 去尾斜杠后拼 /chat/completions', async () => {
  let url;
  const fetchImpl = async (u) => {
    url = u;
    return jsonResponse({ choices: [{ message: { content: ITEM_CONTENT } }] });
  };
  await analyzeFoodPhoto({ dataUrl: 'data:image/jpeg;base64,AAAA' }, { apiKey: 'k', baseUrl: 'https://example.com/v1/', fetchImpl });
  eq(url, 'https://example.com/v1/chat/completions', 'URL');
});

test('analyzeFoodPhoto 200 但模型内容不是 JSON：抛解析错误并带原文', async () => {
  const raw = '抱歉，这张图我看不清。';
  const fetchImpl = async () => jsonResponse({ choices: [{ message: { content: raw } }] });
  const err = await rejects(
    () => analyzeFoodPhoto({ dataUrl: 'data:image/jpeg;base64,AAAA' }, { apiKey: 'k', fetchImpl }),
    /解析/,
    '非 JSON 内容',
  );
  eq(err.raw, raw, 'error.raw 供视图展示原文');
});

test('analyzeFoodPhoto 200 但响应体不是 JSON：报服务端返回异常', async () => {
  const fetchImpl = async () => new Response('<html>bad gateway</html>', { status: 200 });
  await rejects(
    () => analyzeFoodPhoto({ dataUrl: 'data:image/jpeg;base64,AAAA' }, { apiKey: 'k', fetchImpl }),
    /合法 JSON/,
    '响应体非 JSON',
  );
});

test('analyzeFoodPhoto 401：提示 Key 无效', async () => {
  const fetchImpl = async () =>
    jsonResponse({ error: { code: 'InvalidApiKey', message: 'Invalid API-key provided.' } }, 401);
  const err = await rejects(
    () => analyzeFoodPhoto({ dataUrl: 'data:image/jpeg;base64,AAAA' }, { apiKey: 'bad', fetchImpl }),
    /HTTP 401/,
    '401 状态',
  );
  assert(/API Key/.test(err.message), `401 文案应指导检查 Key（实际：${err.message}）`);
  eq(err.status, 401, 'status 附加');
});

test('analyzeFoodPhoto 404：列出候选模型', async () => {
  const fetchImpl = async () => jsonResponse({ error: { code: 'ModelNotFound', message: 'model not found' } }, 404);
  const err = await rejects(
    () => analyzeFoodPhoto({ dataUrl: 'data:image/jpeg;base64,AAAA' }, { apiKey: 'k', fetchImpl }),
    /HTTP 404/,
    '404 状态',
  );
  for (const candidate of MODEL_CANDIDATES) {
    assert(err.message.includes(candidate), `404 文案应列出候选 ${candidate}`);
  }
});

test('analyzeFoodPhoto 500：提示服务端错误', async () => {
  const fetchImpl = async () => jsonResponse({ error: { message: 'internal error' } }, 500);
  await rejects(
    () => analyzeFoodPhoto({ dataUrl: 'data:image/jpeg;base64,AAAA' }, { apiKey: 'k', fetchImpl }),
    /HTTP 500/,
    '500 状态',
  );
});

test('analyzeFoodPhoto 超时：转成中文超时提示', async () => {
  const fetchImpl = async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  };
  await rejects(
    () => analyzeFoodPhoto({ dataUrl: 'data:image/jpeg;base64,AAAA' }, { apiKey: 'k', fetchImpl }),
    /超时/,
    '超时分支',
  );
});

test('analyzeFoodPhoto 网络失败：转成中文网络提示', async () => {
  const fetchImpl = async () => {
    throw new TypeError('Failed to fetch');
  };
  await rejects(
    () => analyzeFoodPhoto({ dataUrl: 'data:image/jpeg;base64,AAAA' }, { apiKey: 'k', fetchImpl }),
    /网络/,
    '网络分支',
  );
});

test('analyzeFoodPhoto 无 Key 时不发请求，提示去设置', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return jsonResponse({});
  };
  const err = await rejects(
    () => analyzeFoodPhoto({ dataUrl: 'data:image/jpeg;base64,AAAA' }, { apiKey: '', fetchImpl }),
    /API Key/,
    '缺 Key',
  );
  assert(err.needSettings === true, 'needSettings 标记');
  assert(!called, '不应发请求');
});

test('analyzeFoodPhoto 对模型返回空 items 走规则 4 中文提示', async () => {
  const fetchImpl = async () => jsonResponse({ choices: [{ message: { content: '{"items":[]}' } }] });
  await rejects(
    () => analyzeFoodPhoto({ dataUrl: 'data:image/jpeg;base64,AAAA' }, { apiKey: 'k', fetchImpl }),
    /没识别出食物/,
    '空 items',
  );
});

// ---------------------------------------------------------------- testConnection

test('testConnection 成功：ok=true 且回传模型', async () => {
  const fetchImpl = async () => jsonResponse({ model: 'qwen3-vl-plus', choices: [{ message: { content: 'ok' } }] });
  const out = await testConnection({ apiKey: 'k', fetchImpl });
  eq(out.ok, true, 'ok');
  eq(out.model, 'qwen3-vl-plus', 'model');
  assert(/成功/.test(out.message), `成功文案（实际：${out.message}）`);
});

test('testConnection 401：提示 Key 无效', async () => {
  const fetchImpl = async () => jsonResponse({ error: { code: 'InvalidApiKey' } }, 401);
  const out = await testConnection({ apiKey: 'bad', fetchImpl });
  eq(out.ok, false, 'ok');
  assert(/API Key/.test(out.message), `401 文案（实际：${out.message}）`);
});

test('testConnection 404：提示模型不存在并列出候选', async () => {
  const fetchImpl = async () => jsonResponse({ error: { message: 'model not found' } }, 404);
  const out = await testConnection({ apiKey: 'k', model: 'qwen-vl-none', fetchImpl });
  eq(out.ok, false, 'ok');
  assert(/模型/.test(out.message), `404 文案（实际：${out.message}）`);
  assert(out.message.includes('qwen-vl-plus'), '应列出候选');
});

test('testConnection 无 Key：直接返回可操作提示', async () => {
  const out = await testConnection({ apiKey: '' });
  eq(out.ok, false, 'ok');
  assert(/API Key/.test(out.message), '无 Key 文案');
});

// ---------------------------------------------------------------- 食物库

test('食物库条数 >= 100 且 id 唯一', () => {
  assert(FOODS.length >= 100, `条数不足：${FOODS.length}`);
  const ids = new Set(FOODS.map((f) => f.id));
  eq(ids.size, FOODS.length, 'id 唯一');
  for (const food of FOODS) {
    assert(typeof food.id === 'string' && food.id, 'id 必须为非空字符串');
    assert(typeof food.name === 'string' && food.name.trim(), `名称缺失：${food.id}`);
    assert(food.per100g && typeof food.per100g === 'object', `per100g 缺失：${food.id}`);
    for (const key of ['kcal', 'carb', 'protein', 'fat']) {
      const v = food.per100g[key];
      assert(typeof v === 'number' && Number.isFinite(v), `${food.id}.${key} 必须是有限数字（实际 ${v}）`);
      assert(v >= 0, `${food.id}.${key} 不能为负`);
    }
    assert(Number.isInteger(food.per100g.kcal), `${food.id}.kcal 必须是整数`);
    for (const key of ['carb', 'protein', 'fat']) {
      const v = food.per100g[key];
      assert(Math.abs(v * 10 - Math.round(v * 10)) < 1e-9, `${food.id}.${key} 应保留 1 位小数（实际 ${v}）`);
    }
    for (const key of ['fiber', 'sodium']) {
      if (key in food.per100g) {
        assert(Number.isFinite(food.per100g[key]), `${food.id}.${key} 必须是有限数字`);
      }
    }
    if (food.unit) {
      assert(typeof food.unit.name === 'string' && food.unit.name, `${food.id}.unit.name`);
      assert(Number.isFinite(food.unit.grams) && food.unit.grams > 0, `${food.id}.unit.grams`);
    }
    for (const alias of food.aliases || []) {
      assert(typeof alias === 'string' && alias.trim(), `${food.id} 别名非法`);
    }
  }
});

test('食物库覆盖 SPEC 5.4 的主要类别', () => {
  const names = FOODS.map((f) => f.name);
  for (const required of ['米饭', '馒头', '鸡胸肉', '鸡蛋', '豆腐', '西兰花', '苹果', '核桃', '植物油', '可乐', '宫保鸡丁', '麻辣烫']) {
    assert(names.includes(required), `缺少类别代表：${required}`);
  }
});

test('searchFoods：空查询返回热门前 N', () => {
  eq(searchFoods('').length, 10, '默认热门条数');
  eq(searchFoods('', 5).length, 5, 'limit 生效');
  for (const food of searchFoods('', 5)) assert(FOODS.includes(food), '热门项必须来自 FOODS');
});

test('searchFoods：中文检索命中且精确名优先', () => {
  const byRice = searchFoods('米饭');
  assert(byRice.length > 0, '米饭应有结果');
  eq(byRice[0].name, '米饭', '精确命中排第一');
  const byChicken = searchFoods('鸡');
  assert(byChicken.length > 0, '单字「鸡」应有结果');
  assert(byChicken.some((f) => f.name.includes('鸡')), '结果应包含「鸡」');
});

test('searchFoods：别名检索（土豆 -> 马铃薯）', () => {
  const out = searchFoods('马铃薯');
  eq(out[0].id, 'potato', '别名命中');
});

test('findFood：精确 / 别名 / 带后缀 / 括号写法', () => {
  eq(findFood('鸡蛋')?.id, 'egg', '精确');
  eq(findFood('西红柿')?.id, 'tomato', '别名');
  eq(findFood('米饭 1 碗')?.id, 'rice', '带份量后缀');
  eq(findFood('红烧肉（小份）')?.id, 'braised-pork', '带括号后缀');
  eq(findFood('完全不存在的食物')?.id, undefined, '未命中返回 null');
});

// ---------------------------------------------------------------- 环境边界

test('fileToDataUrl 在无 DOM 的 Node 环境给出中文错误', async () => {
  await rejects(() => fileToDataUrl({ type: 'image/jpeg', size: 1 }), /图片|画布/, '无 DOM 分支');
});

// ---------------------------------------------------------------- runner

export async function run() {
  results.passed = 0;
  results.failed = 0;
  results.failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      results.passed++;
    } catch (err) {
      results.failed++;
      results.failures.push({ name, error: String(err?.message || err) });
    }
  }
  console.log(`\n[vision.test] ${results.passed} passed, ${results.failed} failed`);
  if (results.failures.length) {
    for (const f of results.failures) console.log(`  ✗ ${f.name}\n    ${f.error}`);
  }
  return { passed: results.passed, failed: results.failed, failures: results.failures };
}

const isMain = (() => {
  try {
    return Boolean(process?.argv?.[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const outcome = await run();
  if (outcome.failed > 0) process.exitCode = 1;
}
