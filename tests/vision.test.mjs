// vision-ai 的自动验收：全部用注入的假 fetchImpl，不碰真实网络与 API Key。
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  MODEL_CANDIDATES,
  STANDARD_DISHES,
  buildRequestBody,
  buildPrompt,
  fileToDataUrl,
  parseModelJson,
  analyzeFoodPhoto,
  testConnection,
} from '../js/vision.js';
import { FOODS, searchFoods, findFood, calibrateItems, foodUnits } from '../js/foods.js';

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

// ---------------------------------------------------------------- 复合菜：数据 / 检索 / 校准

test('食物库规模：总数 ≥450、成品菜 ≥250、原料 ≥150', () => {
  const dishes = FOODS.filter((f) => f.kind === 'dish');
  const ingredients = FOODS.filter((f) => f.kind === 'ingredient');
  assert(FOODS.length >= 450, `总数不足：${FOODS.length}`);
  assert(dishes.length >= 250, `成品菜不足：${dishes.length}`);
  assert(ingredients.length >= 150, `原料不足：${ingredients.length}`);
  eq(dishes.length + ingredients.length, FOODS.length, '每条都必须打上 kind');
});

test('食物库结构自洽：字段齐全、id/name 唯一、kcal 与 4/4/9 相符、宏量合计 ≤100g、成品菜都有 unit', () => {
  const ids = new Set();
  const names = new Set();
  const bad = [];
  for (const food of FOODS) {
    const where = `${food?.id ?? '(无 id)'}/${food?.name ?? '(无名称)'}`;
    assert(typeof food.id === 'string' && food.id.trim(), `${where} 缺 id`);
    assert(typeof food.name === 'string' && food.name.trim(), `${where} 缺名称`);
    assert(!ids.has(food.id), `id 重复：${food.id}`);
    assert(!names.has(food.name), `名称重复：${food.name}`);
    ids.add(food.id);
    names.add(food.name);
    assert(food.kind === 'dish' || food.kind === 'ingredient', `${where} kind 非法：${food.kind}`);
    assert(Array.isArray(food.aliases || []), `${where} aliases 必须是数组`);
    for (const alias of food.aliases || []) assert(typeof alias === 'string' && alias.trim(), `${where} 别名非法`);
    const p = food.per100g;
    assert(p && typeof p === 'object', `${where} 缺 per100g`);
    for (const key of ['kcal', 'carb', 'protein', 'fat']) {
      const v = p[key];
      assert(typeof v === 'number' && Number.isFinite(v), `${where}.${key} 必须是有限数字（实际 ${v}）`);
      assert(v >= 0, `${where}.${key} 不能为负`);
    }
    assert(Number.isInteger(p.kcal), `${where}.kcal 必须是整数`);
    assert(p.kcal <= 920, `${where}.kcal 超出纯油上限：${p.kcal}`);
    const calc = p.carb * 4 + p.protein * 4 + p.fat * 9;
    const tol = Math.max(30, p.kcal * 0.3);
    if (Math.abs(calc - p.kcal) > tol) bad.push(`${food.name}(标${p.kcal}/算${Math.round(calc)})`);
    const macroSum = p.carb + p.protein + p.fat;
    if (macroSum > 100.5) bad.push(`${food.name}(宏量合计 ${macroSum.toFixed(1)})`);
    for (const key of ['fiber', 'sodium']) {
      if (key in p) assert(Number.isFinite(p[key]) && p[key] >= 0, `${where}.${key} 非法`);
    }
    if (food.kind === 'dish') {
      assert(food.unit && typeof food.unit.name === 'string' && food.unit.name, `${where} 成品菜缺 unit`);
      assert(Number.isFinite(food.unit.grams) && food.unit.grams >= 5 && food.unit.grams <= 1000, `${where}.unit.grams 越界`);
    }
  }
  eq(bad, [], 'kcal/宏量不自洽的条目');
});

test('食物库覆盖常见分类与用户点名的必含菜', () => {
  const names = new Set(FOODS.map((f) => f.name));
  const required = [
    '菠菜炒鸡蛋', '番茄炒蛋', '青椒炒肉', '青椒土豆丝', '宫保鸡丁', '鱼香肉丝', '麻婆豆腐',
    '红烧肉', '红烧茄子', '地三鲜', '蒜蓉油麦菜', '清炒西兰花', '西红柿鸡蛋汤', '紫菜蛋花汤',
    '冬瓜排骨汤', '蛋炒饭', '西红柿鸡蛋面', '馄饨', '猪肉白菜包子', '小米粥', '皮蛋瘦肉粥',
    '酸辣土豆丝', '回锅肉', '糖醋里脊', '可乐鸡翅', '咖喱鸡', '麻辣烫', '兰州拉面',
    '黄焖鸡米饭', '螺蛳粉', '煎饼果子',
  ];
  for (const name of required) assert(names.has(name), `库内缺少必含菜：${name}`);
});

test('findFood：同一道菜的多种写法命中同一条', () => {
  const canonical = findFood('菠菜炒鸡蛋');
  eq(canonical?.name, '菠菜炒鸡蛋', '标准菜名命中');
  eq(canonical?.kind, 'dish', '成品菜 kind');
  const alt = findFood('菠菜炒蛋');
  assert(alt && alt.id === canonical.id, `「菠菜炒蛋」应命中同一道菜（实际 ${alt?.name}）`);
  const tomato = findFood('西红柿炒鸡蛋');
  assert(tomato && tomato.id === findFood('番茄炒蛋').id, `「西红柿炒鸡蛋」应命中番茄炒蛋（实际 ${tomato?.name}）`);
  assert(!/[蛋]$/.test(tomato.name.replace('炒蛋', '')), '不能退化成原料');
});

test('findFood：带修饰词也能命中菜名（宫保鸡丁（小份）/ 一份红烧茄子）', () => {
  eq(findFood('宫保鸡丁（小份）')?.id, 'kung-pao-chicken', '括号修饰');
  eq(findFood('一份红烧茄子')?.id, findFood('红烧茄子')?.id, '前缀「一份」');
  eq(findFood('家常红烧茄子')?.id, findFood('红烧茄子')?.id, '前缀「家常」');
  eq(findFood('清炒西兰花（小份）')?.id, 'stir-broccoli', '库内既有菜名');
});

test('findFood：能命中菜名时不退化成原料', () => {
  eq(findFood('土豆丝')?.kind, 'dish', '土豆丝应命中菜品');
  assert(/土豆丝/.test(findFood('土豆丝').name), `实际命中 ${findFood('土豆丝')?.name}`);
  eq(findFood('土豆')?.kind, 'ingredient', '单说土豆仍是原料');
  eq(findFood('菠菜')?.kind, 'ingredient', '单说菠菜仍是原料');
  eq(findFood('鸡蛋')?.kind, 'ingredient', '单说鸡蛋仍是原料');
});

test('findFood：kind 提示参与名称校准', () => {
  eq(findFood('土豆丝', { kind: 'dish' })?.kind, 'dish', 'dish 期望命中菜');
  eq(findFood('菠菜炒', { kind: 'dish' })?.name, '菠菜炒鸡蛋', 'kind=dish 时优先菜名');
  eq(findFood('菠菜炒', { kind: 'ingredient' })?.name, '菠菜', 'kind=ingredient 时优先原料');
  eq(findFood('黄瓜炒', { kind: 'ingredient' })?.name, '黄瓜', 'kind=ingredient 时优先原料（黄瓜）');
  // 精确命中（名称/别名完全一致）始终优先于 kind 提示，避免把「土豆丝」这种别名猜错
  eq(findFood('土豆丝', { kind: 'ingredient' })?.name, '青椒土豆丝', '精确别名不被 kind 覆盖');
  eq(findFood('宫保鸡丁', { kind: 'dish' })?.id, 'kung-pao-chicken', '精确命中不受提示影响');
});

test('searchFoods：菜品优先（dish 排在 ingredient 之前）', () => {
  const out = searchFoods('炒', 30);
  assert(out.length > 0, '「炒」应有结果');
  const firstIngredient = out.findIndex((f) => f.kind === 'ingredient');
  const lastDish = out.map((f) => f.kind === 'dish').lastIndexOf(true);
  assert(firstIngredient === -1 || lastDish < firstIngredient, '菜品必须排在原料前面');
  eq(out[0].kind, 'dish', '首条应是菜品');
});

test('searchFoods：空查询的热门里既有主食也有家常菜', () => {
  const hot = searchFoods('');
  eq(hot.length, 10, '热门条数');
  assert(hot.some((f) => f.name === '米饭'), '热门缺米饭');
  assert(hot.some((f) => f.kind === 'dish' && /炒/.test(f.name)), '热门缺家常菜');
});

test('calibrateItems：整份成品菜用库值覆盖，不是鸡蛋+菠菜的相加', () => {
  const dish = findFood('菠菜炒鸡蛋');
  const [item] = calibrateItems([{ name: '菠菜炒鸡蛋', grams: 300, kcal: 999, carb: 0, protein: 0, fat: 0, confidence: 'high' }]);
  eq(item.foodId, dish.id, 'foodId 指向整道菜');
  eq(item.kind, 'dish', 'kind 透出成品菜');
  eq(item.kcal, Math.round(dish.per100g.kcal * 3), 'kcal 用库值 ×3');
  close(item.fat, Math.round(dish.per100g.fat * 3 * 10) / 10, '脂肪用库值 ×3');
  const rawFat = (findFood('鸡蛋').per100g.fat + findFood('菠菜').per100g.fat) / 2;
  assert(dish.per100g.fat > rawFat * 1.5, `含油成品菜的脂肪应明显高于生料（${dish.per100g.fat} vs ${rawFat.toFixed(1)}）`);
  const rawKcal300 = Math.round(((findFood('鸡蛋').per100g.kcal + findFood('菠菜').per100g.kcal) / 2) * 3);
  assert(item.kcal > rawKcal300, `成品菜热量应高于同重量生料相加（${item.kcal} vs ${rawKcal300}）`);
});

test('calibrateItems：模型给了 kind 时按它校准名称匹配', () => {
  const [asDish] = calibrateItems([{ name: '宫保鸡丁', grams: 250, kind: 'dish', kcal: 1, carb: 1, protein: 1, fat: 1 }]);
  eq(asDish.foodId, 'kung-pao-chicken', 'dish 命中');
  eq(asDish.kind, 'dish', 'kind 透出');
  const [unknown] = calibrateItems([{ name: '神秘拼盘', grams: 100, kind: 'dish', kcal: 200 }]);
  eq(unknown.kind, 'dish', '未命中时保留模型给的 kind');
});

test('buildPrompt：明确「一道菜就返回菜名」的规则并附标准菜名参考', () => {
  const prompt = buildPrompt();
  for (const token of ['菜名', 'kind', 'dish', 'ingredient', 'unit', '烹调油', '禁止']) {
    assert(prompt.includes(token), `提示词缺少关键词：${token}`);
  }
  assert(/不要解释文字/.test(prompt) && /只输出/.test(prompt), '仍要求只输出 JSON');
  const listed = STANDARD_DISHES.filter((name) => prompt.includes(name));
  assert(STANDARD_DISHES.length >= 50 && STANDARD_DISHES.length <= 60, `标准菜名条数应在 50–60（实际 ${STANDARD_DISHES.length}）`);
  assert(listed.length >= 30, `提示词里至少要出现 30 个标准菜名（实际 ${listed.length}）`);
  const names = new Set(FOODS.map((f) => f.name));
  for (const name of STANDARD_DISHES) assert(names.has(name), `标准菜名必须在库内：${name}`);
});

test('parseModelJson：解析模型新增的 kind 与 unit 提示', () => {
  const out = parseModelJson('{"items":[{"name":"菠菜炒鸡蛋","kind":"dish","unit":"1 盘","grams":250,"kcal":265,"carb":6.5,"protein":13.5,"fat":20.5}]}');
  eq(out.items[0].kind, 'dish', 'kind');
  eq(out.items[0].grams, 250, 'grams');
  const fromUnit = parseModelJson('{"items":[{"name":"红烧茄子","kind":"菜品","unit":{"name":"1 盘","grams":250},"kcal":330}]}');
  eq(fromUnit.items[0].kind, 'dish', '中文 kind');
  eq(fromUnit.items[0].grams, 250, '缺 grams 时用 unit.grams');
});

// ---------------------------------------------------------------- v1.6 食物粒度 / 份量单位 / 提示词

test('v1.6：findFood("去皮鸡腿") 命中 skin=off 条目且热量明显低于带皮', () => {
  const off = findFood('去皮鸡腿');
  assert(off, '未命中「去皮鸡腿」');
  assert(off.skin === 'off' || /去皮/.test(off.name), `命中项没有去皮标记：${off.name}`);
  assert(/鸡腿/.test(off.name), `应命中鸡腿类条目，实际 ${off.name}`);
  const on = FOODS.find((f) => f.skin === 'on' && /鸡腿/.test(f.name) && f.state === 'raw');
  assert(on, '库内缺少带皮鸡腿（生）');
  assert(off.per100g.kcal < on.per100g.kcal * 0.8, `去皮 ${off.per100g.kcal} 应明显低于带皮 ${on.per100g.kcal}`);
});

test('v1.6：去皮鸡腿的常见别名都落到同一条', () => {
  const base = findFood('去皮鸡腿');
  for (const alias of ['鸡腿去皮', '无皮鸡腿', '鸡腿肉去皮']) {
    const hit = findFood(alias);
    assert(hit && hit.id === base.id, `${alias} 命中了 ${hit?.name}`);
  }
});

test('v1.6：findFood("鸡胸肉") 命中，生/熟两条能按括号名分别命中', () => {
  const generic = findFood('鸡胸肉');
  assert(generic, '未命中「鸡胸肉」');
  const raw = findFood('鸡胸肉（生）');
  const cooked = findFood('鸡胸肉（熟）');
  assert(raw && cooked && raw.id !== cooked.id, '生/熟应是两条不同数据');
  assert(raw.state === 'raw' && cooked.state === 'cooked', '生/熟 state 标记错误');
  assert(cooked.per100g.kcal > raw.per100g.kcal, `熟 ${cooked.per100g.kcal} 应高于生 ${raw.per100g.kcal}`);
});

test('v1.6：foodUnits 归一化（units / 只有 unit / 都没有 / 过滤脏数据）', () => {
  eq(foodUnits({ units: [{ name: '1 只', grams: 90 }, { name: '1 盘', grams: 200 }] }), [{ name: '1 只', grams: 90 }, { name: '1 盘', grams: 200 }], 'units 优先');
  eq(foodUnits({ unit: { name: '1 碗', grams: 200 } }), [{ name: '1 碗', grams: 200 }], '只有 unit');
  eq(foodUnits({ name: '无单位' }), [], '都没有返回空数组');
  eq(foodUnits(null), [], 'null 安全');
  eq(foodUnits({ units: [{ name: '坏', grams: 0 }, { name: '坏2', grams: Number.NaN }, { name: '好', grams: 50 }] }), [{ name: '好', grams: 50 }], '过滤非法 grams');
  eq(foodUnits({ units: [], unit: { name: '1 盒', grams: 250 } }), [{ name: '1 盒', grams: 250 }], '空 units 回落 unit');
  const frozen = deepFreeze({ units: [{ name: '1 个', grams: 50 }] });
  const norm = foodUnits(frozen);
  norm[0].grams = 1;
  eq(frozen.units[0].grams, 50, 'foodUnits 返回副本，不修改入参');
});

test('v1.6：库内所有 units 合法（名称非空、克数 5–1000、同名不重复、unit=units[0]）', () => {
  const bad = [];
  let count = 0;
  for (const food of FOODS) {
    if (!Array.isArray(food.units)) continue;
    count++;
    const seen = new Set();
    for (const unit of food.units) {
      if (!unit || typeof unit.name !== 'string' || !unit.name.trim()) { bad.push(`${food.name}(单位名空)`); continue; }
      if (typeof unit.grams !== 'number' || !Number.isFinite(unit.grams) || unit.grams < 5 || unit.grams > 1000) bad.push(`${food.name}(${unit.name}=${unit.grams})`);
      if (seen.has(unit.name)) bad.push(`${food.name}(单位重名 ${unit.name})`);
      seen.add(unit.name);
    }
    if (food.units.length && food.unit && (food.unit.name !== food.units[0].name || food.unit.grams !== food.units[0].grams)) bad.push(`${food.name}(unit≠units[0])`);
  }
  assert(count >= 200, `带 units 的食物只有 ${count} 条`);
  eq(bad, [], '非法份量单位');
});

test('v1.6：同一食物的生/熟两条都在，熟的热量必须更高（水分流失）', () => {
  const pairs = [
    ['chicken-breast-raw', 'chicken-breast-cooked'],
    ['chicken-leg-skin-off-raw', 'chicken-leg-skin-off-cooked'],
    ['chicken-leg-skin-on-raw', 'chicken-leg-skin-on-cooked'],
    ['pork-hind-leg-lean-raw', 'pork-hind-leg-lean-cooked'],
    ['pork-belly-raw', 'pork-belly-cooked'],
    ['beef-shank-raw', 'beef-shank-cooked'],
    ['beef-brisket-raw', 'beef-brisket-cooked'],
    ['salmon-raw', 'salmon-cooked'],
    ['shrimp-raw', 'shrimp-cooked'],
    ['whole-egg-raw', 'boiled-egg'],
  ];
  for (const [rawId, cookedId] of pairs) {
    const raw = FOODS.find((f) => f.id === rawId);
    const cooked = FOODS.find((f) => f.id === cookedId);
    assert(raw && cooked, `缺少生/熟条目：${rawId} / ${cookedId}`);
    assert(raw.state === 'raw' && cooked.state === 'cooked', `${rawId}/${cookedId} 的 state 标记不对`);
    assert(cooked.per100g.kcal > raw.per100g.kcal, `${cooked.name}(${cooked.per100g.kcal}) 应高于 ${raw.name}(${raw.per100g.kcal})`);
  }
});

test('v1.6：带皮/去皮是两条数据，去皮热量更低', () => {
  const pairs = [
    ['chicken-leg-skin-on-raw', 'chicken-leg-skin-off-raw'],
    ['chicken-leg-skin-on-cooked', 'chicken-leg-skin-off-cooked'],
    ['chicken-wing-skin-on-raw', 'chicken-wing-skin-off-raw'],
  ];
  for (const [onId, offId] of pairs) {
    const on = FOODS.find((f) => f.id === onId);
    const off = FOODS.find((f) => f.id === offId);
    assert(on && off, `缺少带皮/去皮条目：${onId} / ${offId}`);
    assert(on.skin === 'on' && off.skin === 'off', `${onId}/${offId} 的 skin 标记不对`);
    assert(off.per100g.kcal < on.per100g.kcal * 0.85, `${off.name}(${off.per100g.kcal}) 应明显低于 ${on.name}(${on.per100g.kcal})`);
  }
});

test('v1.6：buildPrompt 要求部位/去皮/生熟写进名字，并给份量单位与克数', () => {
  const prompt = buildPrompt();
  for (const token of ['部位', '去皮', '生熟', '带皮', '1 只（去皮，去骨）', '鸡腿（去皮，熟）', '油炸', '水煮']) {
    assert(prompt.includes(token), `提示词缺少关键词：${token}`);
  }
  assert(/unit/.test(prompt) && /grams/.test(prompt), '缺少 unit/grams 要求');
});

test('v1.6：新增 ≥120 条高粒度数据，part/skin/state 已启用', () => {
  const baseline = 526; // v1.5 的库容量，v1.6 起追加高粒度条目
  assert(FOODS.length - baseline >= 120, `新增仅 ${FOODS.length - baseline} 条`);
  const withPart = FOODS.filter((f) => typeof f.part === 'string' && f.part.trim());
  const skinOff = FOODS.filter((f) => f.skin === 'off');
  const skinOn = FOODS.filter((f) => f.skin === 'on');
  const raw = FOODS.filter((f) => f.state === 'raw');
  const cooked = FOODS.filter((f) => f.state === 'cooked');
  assert(withPart.length >= 30, `part 只有 ${withPart.length} 条`);
  assert(skinOff.length >= 5 && skinOn.length >= 5, `skin off/on 覆盖不足：${skinOff.length}/${skinOn.length}`);
  assert(raw.length >= 10 && cooked.length >= 10, `生/熟覆盖不足：${raw.length}/${cooked.length}`);
});

test('v1.6：新增条目全部带 1–3 个真实份量，且不糊弄成「1 份」', () => {
  const added = FOODS.slice(526);
  assert(added.length >= 120, `新增仅 ${added.length} 条`);
  const bad = added.filter((f) => !Array.isArray(f.units) || f.units.length === 0 || f.units.length > 3).map((f) => `${f.name}(${f.units ? f.units.length : '无'})`);
  eq(bad, [], '新增条目的 units 缺失或超过 3 个');
  const vague = added.filter((f) => f.units.every((u) => /^1 ?份$/.test(u.name))).map((f) => f.name);
  eq(vague, [], '新增条目不应只用「1 份」');
});

test('v1.6：份量单位覆盖只/片/把/勺/盒等真实单位，不再只有碗和克重', () => {
  const names = new Set();
  for (const food of FOODS) for (const unit of foodUnits(food)) names.add(unit.name.replace(/\d+/g, ''));
  const text = [...names].join(' ');
  for (const token of ['只', '片', '把', '勺', '盒', '根', '块', '个', '碗']) {
    assert(text.includes(token), `单位里缺少「${token}」`);
  }
  assert(names.size >= 20, `单位种类只有 ${names.size} 种`);
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
