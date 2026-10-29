// 内置食物营养库：纯静态、零依赖、可离线。
// 数值为每 100g 可食部/成品的常见公开营养数据，用于校准模型输出与手动录入，不追求实验室精度。
// kind: 'dish' 是「做好的成品菜/成品主食」，数值按含油烹饪后的成品折算，unit 是每人份；
// kind: 'ingredient' 是生料/单一原料（生蔬菜、生肉、生米、油盐酱醋等），需要再加工。

const round1 = (n) => Math.round((Number(n) + Number.EPSILON) * 10) / 10;

function toNum(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const m = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  }
  return null;
}

// 去掉括号注释与标点，让「红烧肉（小份）」「米饭 1 碗」这类写法和库内名称对齐。
export function normalizeName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·•,，、;；:：。.!！?？"'“”‘’\-_/]/g, '');
}

// 保留括号内容的归一化：名称里的「（去皮，熟）」是区分粒度的一部分，不能像 normalizeName 那样整段丢掉。
function normalizeKeepingNotes(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·•,，、;；:：。.!！?？"'“”‘’\-_/（）()\[\]【】]/g, '');
}

const UNIT = '克|g|kg|千克|斤|两|ml|毫升|碗|个|只|份|片|块|条|根|杯|勺|匙|盒|袋|串|颗|粒|把|张|寸';
const QUANTITY_TAIL = new RegExp(`(?:约|大概)?[\\d一二两三四五六七八九十半]+\\s*(?:${UNIT})?$`, 'i');

export function stripQuantity(value) {
  const source = String(value ?? '');
  let out = source.trim();
  let prev;
  do {
    prev = out;
    out = out.replace(QUANTITY_TAIL, '').trim();
  } while (out && out !== prev);
  return out || source;
}

export const FOODS = [
  // —— 主食 ——
  { id: 'rice', kind: 'dish', name: '米饭', aliases: ['白米饭', '大米饭'], per100g: { kcal: 116, carb: 25.9, protein: 2.6, fat: 0.3, fiber: 0.3, sodium: 2 }, unit: { name: '1 碗', grams: 200 } },
  { id: 'brown-rice', kind: 'dish', name: '糙米饭', aliases: ['糙米'], per100g: { kcal: 112, carb: 23.5, protein: 2.7, fat: 0.9, fiber: 1.8, sodium: 3 }, unit: { name: '1 碗', grams: 200 } },
  { id: 'congee', kind: 'dish', name: '白粥', aliases: ['稀饭', '大米粥'], per100g: { kcal: 46, carb: 9.9, protein: 1.1, fat: 0.2, fiber: 0.1, sodium: 2 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'millet-congee', kind: 'dish', name: '小米粥', aliases: ['小米稀饭'], per100g: { kcal: 46, carb: 8.4, protein: 1.4, fat: 0.7, fiber: 0.3, sodium: 2 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'steamed-bun', kind: 'dish', name: '馒头', aliases: ['白馒头'], per100g: { kcal: 223, carb: 47.0, protein: 7.0, fat: 1.1, fiber: 1.3, sodium: 130 }, unit: { name: '1 个', grams: 100 } },
  { id: 'huajuan', kind: 'dish', name: '花卷', aliases: [], per100g: { kcal: 214, carb: 45.6, protein: 6.4, fat: 1.6, fiber: 1.0, sodium: 120 }, unit: { name: '1 个', grams: 80 } },
  { id: 'whole-wheat-bread', kind: 'dish', name: '全麦面包', aliases: ['全麦吐司'], per100g: { kcal: 246, carb: 47.0, protein: 9.0, fat: 3.2, fiber: 6.0, sodium: 400 }, unit: { name: '1 片', grams: 35 } },
  { id: 'white-bread', kind: 'dish', name: '白面包', aliases: ['吐司', '面包'], per100g: { kcal: 280, carb: 51.0, protein: 8.5, fat: 4.5, fiber: 2.7, sodium: 450 }, unit: { name: '1 片', grams: 35 } },
  { id: 'noodles', kind: 'dish', name: '面条', aliases: ['煮面', '汤面', '面'], per100g: { kcal: 110, carb: 22.8, protein: 3.9, fat: 0.5, fiber: 0.8, sodium: 30 }, unit: { name: '1 碗', grams: 250 } },
  { id: 'dried-noodles', kind: 'ingredient', name: '挂面', aliases: ['干面条'], per100g: { kcal: 348, carb: 74.0, protein: 10.5, fat: 0.9, fiber: 1.5, sodium: 180 } },
  { id: 'rice-noodles', kind: 'dish', name: '米粉', aliases: ['米线', '粉'], per100g: { kcal: 109, carb: 24.9, protein: 1.6, fat: 0.2, fiber: 0.4, sodium: 20 }, unit: { name: '1 碗', grams: 250 } },
  { id: 'hefen', kind: 'dish', name: '河粉', aliases: ['沙河粉'], per100g: { kcal: 109, carb: 24.5, protein: 1.8, fat: 0.3, fiber: 0.5, sodium: 25 }, unit: { name: '1 碗', grams: 250 } },
  { id: 'dumpling', kind: 'dish', name: '饺子', aliases: ['水饺', '猪肉饺子'], per100g: { kcal: 230, carb: 25.0, protein: 9.0, fat: 9.5, fiber: 1.0, sodium: 500 }, unit: { name: '1 个', grams: 20 } },
  { id: 'baozi', kind: 'dish', name: '包子', aliases: ['肉包', '肉包子'], per100g: { kcal: 227, carb: 27.0, protein: 8.0, fat: 9.0, fiber: 1.0, sodium: 450 }, unit: { name: '1 个', grams: 80 } },
  { id: 'youtiao', kind: 'dish', name: '油条', aliases: [], per100g: { kcal: 388, carb: 51.0, protein: 6.9, fat: 17.6, fiber: 1.0, sodium: 580 }, unit: { name: '1 根', grams: 60 } },
  { id: 'corn', kind: 'ingredient', name: '玉米', aliases: ['甜玉米', '玉米棒'], per100g: { kcal: 112, carb: 22.8, protein: 4.0, fat: 1.2, fiber: 2.9, sodium: 3 }, unit: { name: '1 根', grams: 200 } },
  { id: 'sweet-potato', kind: 'ingredient', name: '红薯', aliases: ['地瓜', '番薯'], state: 'raw', per100g: { kcal: 86, carb: 20.1, protein: 1.6, fat: 0.1, fiber: 3.0, sodium: 30 }, units: [{ name: '1 个', grams: 200 }, { name: '1 块', grams: 100 }] },
  { id: 'potato', kind: 'ingredient', name: '土豆', aliases: ['马铃薯'], per100g: { kcal: 77, carb: 17.2, protein: 2.0, fat: 0.2, fiber: 2.2, sodium: 6 }, unit: { name: '1 个', grams: 150 } },
  { id: 'purple-sweet-potato', kind: 'ingredient', name: '紫薯', aliases: [], per100g: { kcal: 82, carb: 19.0, protein: 1.3, fat: 0.2, fiber: 2.5, sodium: 25 } },
  { id: 'oats', kind: 'ingredient', name: '燕麦片', aliases: ['燕麦'], state: 'raw', per100g: { kcal: 377, carb: 66.3, protein: 13.0, fat: 6.7, fiber: 10.0, sodium: 4 }, units: [{ name: '1 勺（干）', grams: 10 }, { name: '1 杯（干）', grams: 80 }, { name: '1 小袋（即食）', grams: 40 }] },
  { id: 'pasta', kind: 'dish', name: '意大利面', aliases: ['意面'], state: 'cooked', per100g: { kcal: 158, carb: 30.9, protein: 5.8, fat: 0.9, fiber: 1.8, sodium: 6 }, units: [{ name: '1 碗', grams: 200 }, { name: '1 盘', grams: 250 }] },
  { id: 'rice-cake', kind: 'ingredient', name: '年糕', aliases: [], per100g: { kcal: 154, carb: 34.0, protein: 3.3, fat: 0.6, fiber: 0.6, sodium: 30 } },
  { id: 'shaobing', kind: 'dish', name: '烧饼', aliases: [], per100g: { kcal: 326, carb: 52.0, protein: 8.0, fat: 10.0, fiber: 1.5, sodium: 500 }, unit: { name: '1 个', grams: 100 } },
  { id: 'zongzi', kind: 'dish', name: '粽子', aliases: [], per100g: { kcal: 195, carb: 35.0, protein: 5.5, fat: 3.9, fiber: 0.9, sodium: 250 }, unit: { name: '1 个', grams: 150 } },

  // —— 肉禽 ——
  { id: 'chicken-breast', kind: 'ingredient', name: '鸡胸肉', aliases: ['鸡胸', '鸡脯肉', '生鸡胸肉'], part: '胸', skin: 'off', state: 'raw', per100g: { kcal: 118, carb: 1.0, protein: 23.0, fat: 1.9, fiber: 0, sodium: 45 }, units: [{ name: '1 块（手掌大）', grams: 120 }, { name: '1 袋（冷冻装）', grams: 500 }] },
  { id: 'chicken-leg', kind: 'ingredient', name: '鸡腿', aliases: ['鸡腿肉'], part: '腿', skin: 'on', state: 'raw', per100g: { kcal: 181, carb: 0, protein: 20.0, fat: 11.0, fiber: 0, sodium: 70 }, units: [{ name: '1 只（带骨）', grams: 120 }, { name: '1 只（去骨）', grams: 90 }] },
  { id: 'chicken-wing', kind: 'ingredient', name: '鸡翅', aliases: ['鸡翅中'], part: '翅', skin: 'on', state: 'raw', per100g: { kcal: 194, carb: 0.6, protein: 19.0, fat: 12.7, fiber: 0, sodium: 80 }, units: [{ name: '1 个（翅中）', grams: 40 }, { name: '1 个（翅根）', grams: 50 }] },
  { id: 'chicken-feet', kind: 'ingredient', name: '鸡爪', aliases: ['凤爪'], per100g: { kcal: 254, carb: 2.7, protein: 23.9, fat: 16.4, fiber: 0, sodium: 170 } },
  { id: 'egg', kind: 'ingredient', name: '鸡蛋', aliases: ['水煮蛋', '煮鸡蛋', '蛋'], state: 'raw', per100g: { kcal: 144, carb: 1.5, protein: 13.3, fat: 8.8, fiber: 0, sodium: 130 }, units: [{ name: '1 个（中）', grams: 50 }, { name: '1 个（大）', grams: 60 }, { name: '1 个蛋白', grams: 33 }] },
  { id: 'egg-white', kind: 'ingredient', name: '蛋清', aliases: ['蛋白', '鸡蛋清'], per100g: { kcal: 60, carb: 2.4, protein: 11.6, fat: 0.1, fiber: 0, sodium: 160 } },
  { id: 'egg-yolk', kind: 'ingredient', name: '蛋黄', aliases: ['鸡蛋黄'], per100g: { kcal: 328, carb: 3.6, protein: 15.2, fat: 28.2, fiber: 0, sodium: 50 }, unit: { name: '1 个', grams: 20 } },
  { id: 'pork-lean', kind: 'ingredient', name: '猪肉', aliases: ['瘦猪肉', '猪瘦肉'], part: '后腿', state: 'raw', per100g: { kcal: 143, carb: 1.5, protein: 20.3, fat: 6.2, fiber: 0, sodium: 60 }, units: [{ name: '1 块', grams: 100 }, { name: '1 斤', grams: 500 }] },
  { id: 'pork-belly', kind: 'ingredient', name: '五花肉', aliases: ['猪五花', '肥肉'], part: '五花', skin: 'on', state: 'raw', per100g: { kcal: 518, carb: 0, protein: 9.3, fat: 53.0, fiber: 0, sodium: 55 }, units: [{ name: '1 块', grams: 50 }, { name: '1 片（回锅肉）', grams: 15 }] },
  { id: 'pork-mince', kind: 'ingredient', name: '猪肉馅', aliases: ['肉末', '肉馅'], per100g: { kcal: 278, carb: 1.0, protein: 15.0, fat: 23.0, fiber: 0, sodium: 80 } },
  { id: 'beef-lean', kind: 'ingredient', name: '牛肉', aliases: ['瘦牛肉'], per100g: { kcal: 106, carb: 1.2, protein: 20.2, fat: 2.3, fiber: 0, sodium: 55 } },
  { id: 'beef-brisket', kind: 'ingredient', name: '牛腩', aliases: ['牛腩肉'], part: '腩', state: 'raw', per100g: { kcal: 154, carb: 0, protein: 17.0, fat: 9.0, fiber: 0, sodium: 60 }, units: [{ name: '1 块', grams: 60 }, { name: '1 碗（块）', grams: 200 }] },
  { id: 'lamb', kind: 'ingredient', name: '羊肉', aliases: ['瘦羊肉'], per100g: { kcal: 118, carb: 0.2, protein: 20.5, fat: 3.9, fiber: 0, sodium: 70 } },
  { id: 'sausage', kind: 'ingredient', name: '火腿肠', aliases: ['香肠', '火腿'], per100g: { kcal: 212, carb: 12.0, protein: 13.0, fat: 12.0, fiber: 0, sodium: 800 }, unit: { name: '1 根', grams: 50 } },
  { id: 'bacon', kind: 'ingredient', name: '培根', aliases: [], per100g: { kcal: 541, carb: 0.6, protein: 37.0, fat: 42.0, fiber: 0, sodium: 1400 }, unit: { name: '1 片', grams: 15 } },
  { id: 'duck', kind: 'ingredient', name: '鸭肉', aliases: ['鸭'], per100g: { kcal: 240, carb: 0.2, protein: 15.5, fat: 19.7, fiber: 0, sodium: 70 } },
  { id: 'roast-duck', kind: 'dish', name: '烤鸭', aliases: ['北京烤鸭'], per100g: { kcal: 436, carb: 3.0, protein: 16.6, fat: 38.4, fiber: 0, sodium: 600 }, unit: { name: '1 份', grams: 150 } },
  { id: 'pork-liver', kind: 'ingredient', name: '猪肝', aliases: ['猪肝片'], per100g: { kcal: 126, carb: 5.0, protein: 19.3, fat: 3.5, fiber: 0, sodium: 68 } },

  // —— 水产 ——
  { id: 'salmon', kind: 'ingredient', name: '三文鱼', aliases: ['鲑鱼'], state: 'raw', per100g: { kcal: 139, carb: 0, protein: 17.2, fat: 7.8, fiber: 0, sodium: 50 }, units: [{ name: '1 块', grams: 120 }, { name: '1 盘', grams: 200 }] },
  { id: 'hairtail', kind: 'ingredient', name: '带鱼', aliases: [], per100g: { kcal: 127, carb: 3.1, protein: 17.7, fat: 4.9, fiber: 0, sodium: 150 } },
  { id: 'grass-carp', kind: 'ingredient', name: '草鱼', aliases: [], per100g: { kcal: 113, carb: 0, protein: 16.6, fat: 5.2, fiber: 0, sodium: 46 } },
  { id: 'seabass', kind: 'ingredient', name: '鲈鱼', aliases: [], per100g: { kcal: 105, carb: 0, protein: 18.6, fat: 3.4, fiber: 0, sodium: 144 } },
  { id: 'shrimp', kind: 'ingredient', name: '虾仁', aliases: ['虾肉'], state: 'raw', per100g: { kcal: 48, carb: 0.9, protein: 10.6, fat: 0.4, fiber: 0, sodium: 80 }, units: [{ name: '1 只', grams: 10 }, { name: '1 盘', grams: 150 }] },
  { id: 'prawn', kind: 'ingredient', name: '基围虾', aliases: ['虾', '大虾'], per100g: { kcal: 101, carb: 1.5, protein: 18.2, fat: 2.3, fiber: 0, sodium: 172 }, unit: { name: '1 只', grams: 15 } },
  { id: 'squid', kind: 'ingredient', name: '鱿鱼', aliases: ['鱿鱼须'], per100g: { kcal: 75, carb: 1.0, protein: 15.0, fat: 1.1, fiber: 0, sodium: 110 } },
  { id: 'clam', kind: 'ingredient', name: '蛤蜊', aliases: ['花蛤', '蛤蜊肉'], per100g: { kcal: 62, carb: 2.8, protein: 10.1, fat: 1.1, fiber: 0, sodium: 425 } },
  { id: 'kelp', kind: 'ingredient', name: '海带', aliases: ['海带丝', '昆布'], per100g: { kcal: 13, carb: 2.1, protein: 1.2, fat: 0.1, fiber: 0.5, sodium: 233 } },
  { id: 'nori', kind: 'ingredient', name: '紫菜', aliases: ['海苔'], per100g: { kcal: 250, carb: 44.1, protein: 26.7, fat: 1.1, fiber: 21.6, sodium: 710 } },

  // —— 蛋奶 ——
  { id: 'milk', kind: 'ingredient', name: '牛奶', aliases: ['纯牛奶', '全脂牛奶'], per100g: { kcal: 54, carb: 3.4, protein: 3.0, fat: 3.2, fiber: 0, sodium: 37 }, units: [{ name: '1 盒（250ml）', grams: 258 }, { name: '1 杯', grams: 200 }] },
  { id: 'lowfat-milk', kind: 'ingredient', name: '低脂牛奶', aliases: ['低脂奶'], per100g: { kcal: 42, carb: 5.0, protein: 3.4, fat: 1.0, fiber: 0, sodium: 40 }, units: [{ name: '1 盒（250ml）', grams: 258 }, { name: '1 杯', grams: 200 }] },
  { id: 'yogurt', kind: 'ingredient', name: '酸奶', aliases: ['原味酸奶'], per100g: { kcal: 72, carb: 9.3, protein: 2.5, fat: 2.7, fiber: 0, sodium: 40 }, unit: { name: '1 杯', grams: 200 } },
  { id: 'greek-yogurt', kind: 'ingredient', name: '希腊酸奶', aliases: [], per100g: { kcal: 59, carb: 3.6, protein: 10.0, fat: 0.4, fiber: 0, sodium: 36 } },
  { id: 'cheese', kind: 'ingredient', name: '奶酪', aliases: ['芝士', '干酪'], per100g: { kcal: 328, carb: 3.5, protein: 25.0, fat: 26.0, fiber: 0, sodium: 600 }, unit: { name: '1 片', grams: 20 } },
  { id: 'soymilk', kind: 'ingredient', name: '豆浆', aliases: ['无糖豆浆'], per100g: { kcal: 31, carb: 1.2, protein: 3.0, fat: 1.6, fiber: 0.2, sodium: 5 }, unit: { name: '1 杯', grams: 250 } },
  { id: 'milk-powder', kind: 'ingredient', name: '奶粉', aliases: ['全脂奶粉'], per100g: { kcal: 478, carb: 51.0, protein: 20.0, fat: 21.0, fiber: 0, sodium: 370 } },

  // —— 豆制品 ——
  { id: 'tofu-firm', kind: 'ingredient', name: '豆腐', aliases: ['北豆腐', '老豆腐'], per100g: { kcal: 98, carb: 2.0, protein: 12.2, fat: 4.8, fiber: 0.5, sodium: 7 } },
  { id: 'tofu-silken', kind: 'ingredient', name: '内酯豆腐', aliases: ['嫩豆腐', '南豆腐'], per100g: { kcal: 50, carb: 2.9, protein: 5.0, fat: 2.4, fiber: 0.4, sodium: 6 } },
  { id: 'tofu-dried', kind: 'ingredient', name: '豆腐干', aliases: ['香干', '豆干'], per100g: { kcal: 140, carb: 6.2, protein: 16.2, fat: 3.6, fiber: 0.8, sodium: 330 } },
  { id: 'tofu-skin', kind: 'ingredient', name: '豆腐皮', aliases: ['油豆皮'], per100g: { kcal: 409, carb: 18.8, protein: 44.6, fat: 17.4, fiber: 0.2, sodium: 20 } },
  { id: 'fuzhu', kind: 'ingredient', name: '腐竹', aliases: ['腐竹段'], per100g: { kcal: 459, carb: 22.3, protein: 44.6, fat: 21.7, fiber: 1.0, sodium: 27 } },
  { id: 'soybean', kind: 'ingredient', name: '黄豆', aliases: ['大豆'], per100g: { kcal: 390, carb: 34.2, protein: 35.0, fat: 16.0, fiber: 15.5, sodium: 2 } },
  { id: 'edamame', kind: 'ingredient', name: '毛豆', aliases: ['青豆'], per100g: { kcal: 131, carb: 10.5, protein: 13.1, fat: 5.0, fiber: 4.0, sodium: 3 } },
  { id: 'bean-sprout', kind: 'ingredient', name: '豆芽', aliases: ['黄豆芽', '绿豆芽'], per100g: { kcal: 18, carb: 2.1, protein: 2.1, fat: 0.1, fiber: 0.8, sodium: 5 } },
  { id: 'qianzhang', kind: 'ingredient', name: '千张', aliases: ['百叶', '豆皮'], per100g: { kcal: 262, carb: 5.5, protein: 24.5, fat: 16.0, fiber: 1.0, sodium: 30 } },

  // —— 蔬菜 ——
  { id: 'broccoli', kind: 'ingredient', name: '西兰花', aliases: ['西蓝花'], per100g: { kcal: 36, carb: 4.3, protein: 4.1, fat: 0.6, fiber: 1.6, sodium: 33 } },
  { id: 'spinach', kind: 'ingredient', name: '菠菜', aliases: [], per100g: { kcal: 28, carb: 4.5, protein: 2.6, fat: 0.3, fiber: 1.7, sodium: 85 } },
  { id: 'lettuce', kind: 'ingredient', name: '生菜', aliases: ['叶用生菜'], per100g: { kcal: 15, carb: 2.0, protein: 1.3, fat: 0.3, fiber: 0.7, sodium: 32 } },
  { id: 'cabbage', kind: 'ingredient', name: '白菜', aliases: ['大白菜'], per100g: { kcal: 17, carb: 3.2, protein: 1.5, fat: 0.1, fiber: 0.8, sodium: 57 } },
  { id: 'bok-choy', kind: 'ingredient', name: '油菜', aliases: ['小白菜', '青菜'], per100g: { kcal: 23, carb: 3.8, protein: 1.8, fat: 0.5, fiber: 1.1, sodium: 74 } },
  { id: 'celery', kind: 'ingredient', name: '芹菜', aliases: ['西芹'], per100g: { kcal: 20, carb: 3.3, protein: 1.2, fat: 0.2, fiber: 1.2, sodium: 159 } },
  { id: 'cucumber', kind: 'ingredient', name: '黄瓜', aliases: ['青瓜'], per100g: { kcal: 16, carb: 2.9, protein: 0.8, fat: 0.2, fiber: 0.5, sodium: 5 } },
  { id: 'tomato', kind: 'ingredient', name: '番茄', aliases: ['西红柿'], per100g: { kcal: 20, carb: 4.0, protein: 0.9, fat: 0.2, fiber: 0.5, sodium: 5 } },
  { id: 'eggplant', kind: 'ingredient', name: '茄子', aliases: [], per100g: { kcal: 23, carb: 4.9, protein: 1.1, fat: 0.2, fiber: 1.3, sodium: 5 } },
  { id: 'green-pepper', kind: 'ingredient', name: '青椒', aliases: ['柿子椒', '彩椒'], per100g: { kcal: 22, carb: 5.4, protein: 1.0, fat: 0.2, fiber: 1.4, sodium: 3 } },
  { id: 'carrot', kind: 'ingredient', name: '胡萝卜', aliases: ['红萝卜'], per100g: { kcal: 39, carb: 8.8, protein: 1.0, fat: 0.2, fiber: 1.1, sodium: 71 } },
  { id: 'radish', kind: 'ingredient', name: '白萝卜', aliases: ['萝卜'], per100g: { kcal: 21, carb: 5.0, protein: 0.9, fat: 0.1, fiber: 1.0, sodium: 62 } },
  { id: 'onion', kind: 'ingredient', name: '洋葱', aliases: ['圆葱'], per100g: { kcal: 40, carb: 9.0, protein: 1.1, fat: 0.2, fiber: 0.9, sodium: 4 } },
  { id: 'wood-ear', kind: 'ingredient', name: '木耳', aliases: ['黑木耳'], per100g: { kcal: 265, carb: 65.6, protein: 12.1, fat: 1.5, fiber: 29.9, sodium: 48 } },
  { id: 'shiitake', kind: 'ingredient', name: '香菇', aliases: ['冬菇'], per100g: { kcal: 26, carb: 5.2, protein: 2.2, fat: 0.3, fiber: 3.3, sodium: 1 } },
  { id: 'enoki', kind: 'ingredient', name: '金针菇', aliases: [], per100g: { kcal: 32, carb: 6.0, protein: 2.4, fat: 0.4, fiber: 2.7, sodium: 4 } },
  { id: 'pumpkin', kind: 'ingredient', name: '南瓜', aliases: ['倭瓜'], per100g: { kcal: 23, carb: 5.3, protein: 0.7, fat: 0.1, fiber: 0.8, sodium: 1 } },
  { id: 'wax-gourd', kind: 'ingredient', name: '冬瓜', aliases: [], per100g: { kcal: 12, carb: 2.6, protein: 0.4, fat: 0.2, fiber: 0.7, sodium: 1 } },
  { id: 'bitter-melon', kind: 'ingredient', name: '苦瓜', aliases: ['凉瓜'], per100g: { kcal: 19, carb: 4.3, protein: 0.7, fat: 0.1, fiber: 1.4, sodium: 2 } },
  { id: 'lotus-root', kind: 'ingredient', name: '莲藕', aliases: ['藕'], per100g: { kcal: 73, carb: 16.4, protein: 1.9, fat: 0.2, fiber: 1.2, sodium: 44 } },
  { id: 'yam', kind: 'ingredient', name: '山药', aliases: ['淮山'], per100g: { kcal: 57, carb: 12.4, protein: 1.9, fat: 0.2, fiber: 0.8, sodium: 18 } },
  { id: 'okra', kind: 'ingredient', name: '秋葵', aliases: ['羊角豆'], per100g: { kcal: 37, carb: 7.5, protein: 1.9, fat: 0.2, fiber: 3.2, sodium: 3 } },

  // —— 水果 ——
  { id: 'apple', kind: 'ingredient', name: '苹果', aliases: ['红富士'], per100g: { kcal: 53, carb: 13.7, protein: 0.4, fat: 0.2, fiber: 1.7, sodium: 1 }, unit: { name: '1 个', grams: 200 } },
  { id: 'banana', kind: 'ingredient', name: '香蕉', aliases: [], per100g: { kcal: 93, carb: 22.0, protein: 1.4, fat: 0.2, fiber: 1.2, sodium: 1 }, unit: { name: '1 根', grams: 120 } },
  { id: 'orange', kind: 'ingredient', name: '橙子', aliases: ['橙', '脐橙'], per100g: { kcal: 48, carb: 11.1, protein: 0.8, fat: 0.2, fiber: 2.4, sodium: 1 } },
  { id: 'watermelon', kind: 'ingredient', name: '西瓜', aliases: [], per100g: { kcal: 31, carb: 7.9, protein: 0.5, fat: 0.1, fiber: 0.3, sodium: 3 } },
  { id: 'grape', kind: 'ingredient', name: '葡萄', aliases: ['提子'], per100g: { kcal: 45, carb: 10.3, protein: 0.4, fat: 0.3, fiber: 0.4, sodium: 2 } },
  { id: 'strawberry', kind: 'ingredient', name: '草莓', aliases: [], per100g: { kcal: 32, carb: 7.1, protein: 1.0, fat: 0.2, fiber: 1.1, sodium: 4 } },
  { id: 'pear', kind: 'ingredient', name: '梨', aliases: ['雪梨', '鸭梨'], per100g: { kcal: 50, carb: 13.3, protein: 0.4, fat: 0.2, fiber: 3.1, sodium: 2 } },
  { id: 'kiwi', kind: 'ingredient', name: '猕猴桃', aliases: ['奇异果'], per100g: { kcal: 61, carb: 14.5, protein: 0.8, fat: 0.6, fiber: 2.6, sodium: 3 } },
  { id: 'blueberry', kind: 'ingredient', name: '蓝莓', aliases: [], per100g: { kcal: 57, carb: 14.5, protein: 0.7, fat: 0.3, fiber: 2.4, sodium: 1 } },
  { id: 'mango', kind: 'ingredient', name: '芒果', aliases: [], per100g: { kcal: 60, carb: 15.0, protein: 0.8, fat: 0.4, fiber: 1.6, sodium: 1 } },
  { id: 'peach', kind: 'ingredient', name: '桃子', aliases: ['水蜜桃'], per100g: { kcal: 42, carb: 10.1, protein: 0.6, fat: 0.1, fiber: 1.3, sodium: 1 } },
  { id: 'dragon-fruit', kind: 'ingredient', name: '火龙果', aliases: ['红心火龙果'], per100g: { kcal: 55, carb: 13.3, protein: 1.1, fat: 0.2, fiber: 1.6, sodium: 2 } },
  { id: 'pomelo', kind: 'ingredient', name: '柚子', aliases: ['西柚'], per100g: { kcal: 42, carb: 9.5, protein: 0.8, fat: 0.2, fiber: 1.0, sodium: 1 } },
  { id: 'lychee', kind: 'ingredient', name: '荔枝', aliases: [], per100g: { kcal: 71, carb: 16.6, protein: 0.8, fat: 0.4, fiber: 1.3, sodium: 1 } },
  { id: 'cherry', kind: 'ingredient', name: '樱桃', aliases: ['车厘子'], per100g: { kcal: 46, carb: 10.2, protein: 1.1, fat: 0.2, fiber: 0.3, sodium: 1 } },
  { id: 'avocado', kind: 'ingredient', name: '牛油果', aliases: ['鳄梨'], per100g: { kcal: 160, carb: 8.5, protein: 2.0, fat: 14.7, fiber: 6.7, sodium: 7 } },

  // —— 坚果 ——
  { id: 'peanut', kind: 'ingredient', name: '花生', aliases: ['花生米'], per100g: { kcal: 574, carb: 16.1, protein: 24.8, fat: 44.3, fiber: 5.5, sodium: 3 } },
  { id: 'walnut', kind: 'ingredient', name: '核桃', aliases: ['核桃仁'], per100g: { kcal: 646, carb: 13.7, protein: 14.9, fat: 58.8, fiber: 6.1, sodium: 6 } },
  { id: 'almond', kind: 'ingredient', name: '杏仁', aliases: ['巴旦木'], per100g: { kcal: 579, carb: 21.6, protein: 21.2, fat: 49.9, fiber: 12.5, sodium: 1 } },
  { id: 'cashew', kind: 'ingredient', name: '腰果', aliases: [], per100g: { kcal: 553, carb: 30.2, protein: 18.2, fat: 43.9, fiber: 3.6, sodium: 12 } },
  { id: 'sunflower-seed', kind: 'ingredient', name: '瓜子', aliases: ['葵花籽'], per100g: { kcal: 606, carb: 12.5, protein: 19.1, fat: 52.8, fiber: 4.5, sodium: 5 } },
  { id: 'pistachio', kind: 'ingredient', name: '开心果', aliases: [], per100g: { kcal: 562, carb: 27.2, protein: 20.2, fat: 45.3, fiber: 10.6, sodium: 10 } },
  { id: 'sesame', kind: 'ingredient', name: '芝麻', aliases: ['黑芝麻', '白芝麻'], per100g: { kcal: 573, carb: 24.0, protein: 17.3, fat: 46.0, fiber: 11.8, sodium: 11 } },
  { id: 'raisin', kind: 'ingredient', name: '葡萄干', aliases: [], per100g: { kcal: 341, carb: 83.4, protein: 2.5, fat: 0.4, fiber: 1.6, sodium: 11 } },

  // —— 油与调味 ——
  { id: 'vegetable-oil', kind: 'ingredient', name: '植物油', aliases: ['食用油', '大豆油'], per100g: { kcal: 899, carb: 0, protein: 0, fat: 99.9, fiber: 0, sodium: 0 }, unit: { name: '1 勺', grams: 10 } },
  { id: 'peanut-oil', kind: 'ingredient', name: '花生油', aliases: [], per100g: { kcal: 899, carb: 0, protein: 0, fat: 99.9, fiber: 0, sodium: 0 }, unit: { name: '1 勺', grams: 10 } },
  { id: 'olive-oil', kind: 'ingredient', name: '橄榄油', aliases: [], per100g: { kcal: 899, carb: 0, protein: 0, fat: 99.9, fiber: 0, sodium: 0 }, unit: { name: '1 勺', grams: 10 } },
  { id: 'butter', kind: 'ingredient', name: '黄油', aliases: [], per100g: { kcal: 717, carb: 0.1, protein: 0.9, fat: 81.1, fiber: 0, sodium: 643 }, unit: { name: '1 小块', grams: 10 } },
  { id: 'sugar', kind: 'ingredient', name: '白砂糖', aliases: ['白糖', '糖'], per100g: { kcal: 400, carb: 99.9, protein: 0, fat: 0, fiber: 0, sodium: 1 }, unit: { name: '1 小勺', grams: 5 } },
  { id: 'honey', kind: 'ingredient', name: '蜂蜜', aliases: [], per100g: { kcal: 321, carb: 75.6, protein: 0.4, fat: 1.9, fiber: 0, sodium: 4 }, unit: { name: '1 勺', grams: 15 } },
  { id: 'soy-sauce', kind: 'ingredient', name: '酱油', aliases: ['生抽', '老抽'], per100g: { kcal: 63, carb: 10.1, protein: 5.6, fat: 0.1, fiber: 0, sodium: 5757 }, unit: { name: '1 勺', grams: 15 } },
  { id: 'vinegar', kind: 'ingredient', name: '醋', aliases: ['米醋', '陈醋'], per100g: { kcal: 31, carb: 4.9, protein: 2.1, fat: 0.3, fiber: 0, sodium: 262 } },

  // —— 饮料 ——
  { id: 'cola', kind: 'ingredient', name: '可乐', aliases: ['可口可乐', '汽水'], per100g: { kcal: 43, carb: 10.8, protein: 0, fat: 0, fiber: 0, sodium: 4 }, unit: { name: '1 罐', grams: 330 } },
  { id: 'cola-zero', kind: 'ingredient', name: '无糖可乐', aliases: ['零度可乐', '健怡可乐'], per100g: { kcal: 0, carb: 0, protein: 0, fat: 0, fiber: 0, sodium: 10 }, unit: { name: '1 罐', grams: 330 } },
  { id: 'orange-juice', kind: 'ingredient', name: '橙汁', aliases: ['果汁'], per100g: { kcal: 45, carb: 10.4, protein: 0.7, fat: 0.2, fiber: 0.2, sodium: 1 }, unit: { name: '1 杯', grams: 250 } },
  { id: 'beer', kind: 'ingredient', name: '啤酒', aliases: [], per100g: { kcal: 32, carb: 2.9, protein: 0.3, fat: 0, fiber: 0, sodium: 11 }, unit: { name: '1 罐', grams: 330 } },
  { id: 'latte', kind: 'ingredient', name: '拿铁咖啡', aliases: ['拿铁'], per100g: { kcal: 42, carb: 4.0, protein: 2.4, fat: 1.6, fiber: 0, sodium: 30 }, unit: { name: '1 杯', grams: 350 } },
  { id: 'americano', kind: 'ingredient', name: '美式咖啡', aliases: ['黑咖啡'], per100g: { kcal: 1, carb: 0, protein: 0.1, fat: 0, fiber: 0, sodium: 2 }, unit: { name: '1 杯', grams: 350 } },
  { id: 'milk-tea', kind: 'ingredient', name: '奶茶', aliases: ['珍珠奶茶'], per100g: { kcal: 76, carb: 12.0, protein: 1.2, fat: 2.6, fiber: 0, sodium: 25 }, unit: { name: '1 杯', grams: 500 } },
  { id: 'green-tea', kind: 'ingredient', name: '绿茶', aliases: ['无糖茶'], per100g: { kcal: 1, carb: 0, protein: 0.1, fat: 0, fiber: 0, sodium: 1 }, unit: { name: '1 杯', grams: 250 } },

  // —— 常见菜品 / 外卖 ——
  { id: 'kung-pao-chicken', kind: 'dish', name: '宫保鸡丁', aliases: ['宫爆鸡丁'], per100g: { kcal: 196, carb: 9.5, protein: 13.5, fat: 12.0, fiber: 1.2, sodium: 700 }, unit: { name: '1 份', grams: 250 } },
  { id: 'mapo-tofu', kind: 'dish', name: '麻婆豆腐', aliases: [], per100g: { kcal: 137, carb: 5.0, protein: 8.5, fat: 9.5, fiber: 0.8, sodium: 750 }, unit: { name: '1 份', grams: 250 } },
  { id: 'yuxiang-pork', kind: 'dish', name: '鱼香肉丝', aliases: [], per100g: { kcal: 168, carb: 9.0, protein: 9.5, fat: 11.0, fiber: 1.0, sodium: 800 }, unit: { name: '1 份', grams: 250 } },
  { id: 'braised-pork', kind: 'dish', name: '红烧肉', aliases: [], per100g: { kcal: 472, carb: 5.0, protein: 10.0, fat: 46.0, fiber: 0, sodium: 600 }, unit: { name: '1 份', grams: 150 } },
  { id: 'tomato-egg', kind: 'dish', name: '番茄炒蛋', aliases: ['西红柿炒鸡蛋'], per100g: { kcal: 86, carb: 4.5, protein: 4.5, fat: 5.5, fiber: 0.6, sodium: 450 }, unit: { name: '1 份', grams: 200 } },
  { id: 'stir-broccoli', kind: 'dish', name: '清炒西兰花', aliases: ['炒西兰花'], per100g: { kcal: 52, carb: 4.8, protein: 3.0, fat: 2.6, fiber: 1.6, sodium: 320 }, unit: { name: '1 份', grams: 200 } },
  { id: 'stir-greens', kind: 'dish', name: '炒青菜', aliases: ['清炒时蔬'], per100g: { kcal: 60, carb: 4.0, protein: 1.8, fat: 4.2, fiber: 1.2, sodium: 380 }, unit: { name: '1 份', grams: 200 } },
  { id: 'malatang', kind: 'dish', name: '麻辣烫', aliases: ['冒菜'], per100g: { kcal: 110, carb: 8.0, protein: 7.0, fat: 6.0, fiber: 1.5, sodium: 900 }, unit: { name: '1 份', grams: 600 } },
  { id: 'beef-noodles', kind: 'dish', name: '牛肉面', aliases: ['红烧牛肉面'], per100g: { kcal: 127, carb: 17.0, protein: 6.5, fat: 3.5, fiber: 0.8, sodium: 700 }, unit: { name: '1 碗', grams: 600 } },
  { id: 'lanzhou-noodles', kind: 'dish', name: '兰州拉面', aliases: ['拉面'], per100g: { kcal: 121, carb: 20.0, protein: 6.0, fat: 2.5, fiber: 0.7, sodium: 800 }, unit: { name: '1 碗', grams: 600 } },
  { id: 'fried-rice', kind: 'dish', name: '炒饭', aliases: ['扬州炒饭'], per100g: { kcal: 163, carb: 24.0, protein: 5.0, fat: 5.5, fiber: 0.6, sodium: 600 }, unit: { name: '1 份', grams: 300 } },
  { id: 'egg-fried-rice', kind: 'dish', name: '蛋炒饭', aliases: [], per100g: { kcal: 170, carb: 24.5, protein: 5.2, fat: 5.8, fiber: 0.6, sodium: 620 }, unit: { name: '1 份', grams: 300 } },
  { id: 'pizza', kind: 'dish', name: '披萨', aliases: ['比萨'], per100g: { kcal: 266, carb: 33.0, protein: 11.0, fat: 10.0, fiber: 2.0, sodium: 600 }, unit: { name: '1 块', grams: 100 } },
  { id: 'hamburger', kind: 'dish', name: '汉堡', aliases: ['汉堡包', '牛肉汉堡'], per100g: { kcal: 250, carb: 28.0, protein: 13.0, fat: 10.0, fiber: 1.5, sodium: 500 }, unit: { name: '1 个', grams: 110 } },
  { id: 'fries', kind: 'dish', name: '薯条', aliases: ['炸薯条'], per100g: { kcal: 312, carb: 41.0, protein: 3.4, fat: 15.0, fiber: 3.8, sodium: 210 }, unit: { name: '1 份', grams: 100 } },
  { id: 'fried-chicken', kind: 'dish', name: '炸鸡', aliases: ['炸鸡块'], per100g: { kcal: 279, carb: 11.0, protein: 22.0, fat: 17.0, fiber: 0.5, sodium: 700 }, unit: { name: '1 块', grams: 100 } },
  { id: 'vegetable-salad', kind: 'dish', name: '蔬菜沙拉', aliases: ['沙拉', '轻食沙拉'], per100g: { kcal: 35, carb: 4.0, protein: 1.5, fat: 1.5, fiber: 1.4, sodium: 150 }, unit: { name: '1 份', grams: 200 } },
  { id: 'sandwich', kind: 'dish', name: '三明治', aliases: [], per100g: { kcal: 240, carb: 28.0, protein: 12.0, fat: 8.5, fiber: 1.8, sodium: 550 }, unit: { name: '1 个', grams: 150 } },
  { id: 'hot-sour-soup', kind: 'dish', name: '酸辣汤', aliases: [], per100g: { kcal: 45, carb: 5.0, protein: 2.5, fat: 1.8, fiber: 0.4, sodium: 500 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'xiaolongbao', kind: 'dish', name: '小笼包', aliases: ['小笼'], per100g: { kcal: 220, carb: 24.0, protein: 9.0, fat: 9.5, fiber: 0.8, sodium: 480 }, unit: { name: '1 个', grams: 30 } },
  { id: 'sushi', kind: 'dish', name: '寿司', aliases: ['寿司卷'], per100g: { kcal: 150, carb: 28.0, protein: 6.0, fat: 1.5, fiber: 0.6, sodium: 400 }, unit: { name: '1 个', grams: 30 } },
  { id: 'jianbing', kind: 'dish', name: '煎饼果子', aliases: ['煎饼'], per100g: { kcal: 257, carb: 34.0, protein: 8.0, fat: 9.5, fiber: 1.2, sodium: 550 }, unit: { name: '1 份', grams: 200 } },
  { id: 'pidan-congee', kind: 'dish', name: '皮蛋瘦肉粥', aliases: ['瘦肉粥'], per100g: { kcal: 48, carb: 7.5, protein: 2.8, fat: 1.0, fiber: 0.1, sodium: 300 }, unit: { name: '1 碗', grams: 300 } },

  // —— 零食 ——
  { id: 'chocolate', kind: 'dish', name: '巧克力', aliases: ['黑巧克力'], per100g: { kcal: 546, carb: 61.0, protein: 4.9, fat: 31.0, fiber: 3.4, sodium: 24 }, unit: { name: '1 块', grams: 25 } },
  { id: 'potato-chips', kind: 'dish', name: '薯片', aliases: [], per100g: { kcal: 548, carb: 52.9, protein: 6.5, fat: 34.0, fiber: 4.4, sodium: 525 }, unit: { name: '1 包', grams: 70 } },
  { id: 'instant-noodles', kind: 'dish', name: '方便面', aliases: ['泡面'], per100g: { kcal: 472, carb: 61.6, protein: 9.5, fat: 20.0, fiber: 2.0, sodium: 1144 }, unit: { name: '1 包', grams: 100 } },
  { id: 'ice-cream', kind: 'dish', name: '冰激凌', aliases: ['冰淇淋', '雪糕'], per100g: { kcal: 207, carb: 24.0, protein: 3.5, fat: 11.0, fiber: 0.7, sodium: 80 }, unit: { name: '1 支', grams: 80 } },
  { id: 'mooncake', kind: 'dish', name: '月饼', aliases: [], per100g: { kcal: 400, carb: 60.0, protein: 6.0, fat: 15.0, fiber: 1.0, sodium: 200 }, unit: { name: '1 个', grams: 100 } },
  { id: 'cake', kind: 'dish', name: '蛋糕', aliases: ['奶油蛋糕'], per100g: { kcal: 348, carb: 50.0, protein: 6.0, fat: 13.0, fiber: 0.8, sodium: 250 }, unit: { name: '1 块', grams: 100 } },
  // —— 以下为「复合菜优先」扩充：成品菜按含油烹饪后每人份折算 ——

  // —— 家常炒菜 ——
  { id: 'bocai-chao-jidan', kind: 'dish', name: '菠菜炒鸡蛋', aliases: ['菠菜炒蛋', '炒菠菜鸡蛋'], per100g: { kcal: 106, carb: 2.6, protein: 5.4, fat: 8.2, fiber: 0.9, sodium: 380 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'qingjiao-chao-rou', kind: 'dish', name: '青椒炒肉', aliases: ['青椒肉丝', '青椒炒肉丝'], per100g: { kcal: 138, carb: 4, protein: 9, fat: 9.5, fiber: 1.1, sodium: 430 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'qingjiao-tudousi', kind: 'dish', name: '青椒土豆丝', aliases: ['土豆丝', '青椒炒土豆丝'], per100g: { kcal: 108, carb: 12.5, protein: 2, fat: 5.5, fiber: 1.4, sodium: 360 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'suanla-tudousi', kind: 'dish', name: '酸辣土豆丝', aliases: ['醋溜土豆丝', '酸辣土豆'], per100g: { kcal: 113, carb: 13, protein: 2.1, fat: 5.8, fiber: 1.4, sodium: 420 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'hongshao-qiezi', kind: 'dish', name: '红烧茄子', aliases: ['烧茄子', '红烧紫茄子'], per100g: { kcal: 133, carb: 7.5, protein: 2.2, fat: 10.5, fiber: 1.3, sodium: 380 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'disanxian', kind: 'dish', name: '地三鲜', aliases: ['东北地三鲜'], per100g: { kcal: 144, carb: 12, protein: 2.5, fat: 9.5, fiber: 1.8, sodium: 400 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'suanrong-youmaicai', kind: 'dish', name: '蒜蓉油麦菜', aliases: ['蒜蓉炒油麦菜', '清炒油麦菜'], per100g: { kcal: 79, carb: 3.2, protein: 1.8, fat: 6.5, fiber: 1.2, sodium: 340 }, unit: { name: '1 盘', grams: 220 } },
  { id: 'huiguo-rou', kind: 'dish', name: '回锅肉', aliases: ['回锅肉片'], per100g: { kcal: 334, carb: 5.5, protein: 10.5, fat: 30, fiber: 0.8, sodium: 620 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'tangcu-liji', kind: 'dish', name: '糖醋里脊', aliases: ['糖醋肉'], per100g: { kcal: 249, carb: 22, protein: 11, fat: 13, fiber: 0.4, sodium: 480 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'kele-jichi', kind: 'dish', name: '可乐鸡翅', aliases: [], per100g: { kcal: 226, carb: 9, protein: 16, fat: 14, fiber: 0.2, sodium: 520 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'gali-ji', kind: 'dish', name: '咖喱鸡', aliases: ['咖喱鸡块'], per100g: { kcal: 159, carb: 9.5, protein: 11, fat: 8.5, fiber: 1.2, sodium: 480 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'ganbian-doujiao', kind: 'dish', name: '干煸豆角', aliases: ['干煸四季豆', '干煸芸豆'], per100g: { kcal: 127, carb: 8, protein: 3.5, fat: 9, fiber: 3, sodium: 420 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'suantai-chao-rou', kind: 'dish', name: '蒜苔炒肉', aliases: ['蒜薹炒肉', '蒜苔肉丝'], per100g: { kcal: 141, carb: 7.5, protein: 8.5, fat: 8.5, fiber: 2, sodium: 420 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'qincai-chao-rou', kind: 'dish', name: '芹菜炒肉', aliases: ['芹菜炒肉丝'], per100g: { kcal: 120, carb: 4.5, protein: 7.5, fat: 8, fiber: 1.6, sodium: 430 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'muer-chao-jidan', kind: 'dish', name: '木耳炒鸡蛋', aliases: ['木耳炒蛋', '鸡蛋炒木耳'], per100g: { kcal: 114, carb: 3.5, protein: 7, fat: 8, fiber: 1.8, sodium: 380 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'huanggua-chao-jidan', kind: 'dish', name: '黄瓜炒鸡蛋', aliases: ['黄瓜炒蛋'], per100g: { kcal: 102, carb: 2.8, protein: 5.8, fat: 7.5, fiber: 0.6, sodium: 350 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'jiucai-chao-jidan', kind: 'dish', name: '韭菜炒鸡蛋', aliases: ['韭菜炒蛋'], per100g: { kcal: 115, carb: 3.2, protein: 6.5, fat: 8.5, fiber: 1.3, sodium: 370 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'kugua-chao-jidan', kind: 'dish', name: '苦瓜炒鸡蛋', aliases: ['苦瓜炒蛋'], per100g: { kcal: 111, carb: 3, protein: 6.2, fat: 8.2, fiber: 1.2, sodium: 340 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'yangcong-chao-jidan', kind: 'dish', name: '洋葱炒鸡蛋', aliases: ['洋葱炒蛋'], per100g: { kcal: 114, carb: 4.5, protein: 6, fat: 8, fiber: 1, sodium: 340 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'qingjiao-chao-dan', kind: 'dish', name: '青椒炒蛋', aliases: ['辣椒炒蛋', '尖椒炒蛋'], per100g: { kcal: 117, carb: 3.5, protein: 6.5, fat: 8.5, fiber: 1.1, sodium: 380 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'xihongshi-caihua', kind: 'dish', name: '西红柿炒菜花', aliases: ['番茄炒菜花'], per100g: { kcal: 82, carb: 5, protein: 2, fat: 6, fiber: 1.4, sodium: 340 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'shousi-baocai', kind: 'dish', name: '手撕包菜', aliases: ['手撕圆白菜'], per100g: { kcal: 89, carb: 5, protein: 1.5, fat: 7, fiber: 1.5, sodium: 400 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'ganguo-caihua', kind: 'dish', name: '干锅花菜', aliases: ['干锅有机花菜'], per100g: { kcal: 135, carb: 6, protein: 3, fat: 11, fiber: 1.6, sodium: 460 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'suanrong-xilanhua', kind: 'dish', name: '蒜蓉西兰花', aliases: ['蒜蓉西蓝花'], per100g: { kcal: 87, carb: 5, protein: 3.2, fat: 6, fiber: 1.7, sodium: 320 }, unit: { name: '1 盘', grams: 220 } },
  { id: 'suanrong-bocai', kind: 'dish', name: '蒜蓉菠菜', aliases: ['炒菠菜', '清炒菠菜'], per100g: { kcal: 83, carb: 3.5, protein: 2.5, fat: 6.5, fiber: 1.5, sodium: 360 }, unit: { name: '1 盘', grams: 220 } },
  { id: 'qingchao-helandou', kind: 'dish', name: '清炒荷兰豆', aliases: ['炒荷兰豆'], per100g: { kcal: 86, carb: 6.5, protein: 2.6, fat: 5.5, fiber: 2.5, sodium: 320 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'shangtang-wawacai', kind: 'dish', name: '上汤娃娃菜', aliases: ['上汤白菜'], per100g: { kcal: 56, carb: 3.5, protein: 2.5, fat: 3.5, fiber: 1, sodium: 420 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'culiu-baicai', kind: 'dish', name: '醋溜白菜', aliases: ['醋溜大白菜'], per100g: { kcal: 78, carb: 5.5, protein: 1.5, fat: 5.5, fiber: 1.2, sodium: 400 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'suanla-baicai', kind: 'dish', name: '酸辣白菜', aliases: [], per100g: { kcal: 82, carb: 6, protein: 1.5, fat: 5.8, fiber: 1.2, sodium: 450 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'hupi-qingjiao', kind: 'dish', name: '虎皮青椒', aliases: ['虎皮尖椒'], per100g: { kcal: 98, carb: 6, protein: 1.5, fat: 7.5, fiber: 1.3, sodium: 380 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'yuxiang-qiezi', kind: 'dish', name: '鱼香茄子', aliases: ['鱼香茄条'], per100g: { kcal: 132, carb: 9.5, protein: 2, fat: 9.5, fiber: 1.4, sodium: 500 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'roumo-qiezi', kind: 'dish', name: '肉末茄子', aliases: ['肉沫茄子'], per100g: { kcal: 133, carb: 7, protein: 6, fat: 9, fiber: 1.4, sodium: 520 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'mayi-shangshu', kind: 'dish', name: '蚂蚁上树', aliases: ['肉末粉丝'], per100g: { kcal: 169, carb: 16, protein: 6, fat: 9, fiber: 0.8, sodium: 560 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'nongjia-xiaochaorou', kind: 'dish', name: '农家小炒肉', aliases: ['小炒肉', '农家小炒'], per100g: { kcal: 222, carb: 4, protein: 11, fat: 18, fiber: 0.9, sodium: 620 }, unit: { name: '1 盘', grams: 220 } },
  { id: 'lajiao-chao-rou', kind: 'dish', name: '辣椒炒肉', aliases: ['尖椒炒肉片'], per100g: { kcal: 195, carb: 4.5, protein: 10.5, fat: 15, fiber: 1, sodium: 580 }, unit: { name: '1 盘', grams: 220 } },
  { id: 'muxu-rou', kind: 'dish', name: '木须肉', aliases: ['木樨肉'], per100g: { kcal: 146, carb: 6, protein: 8, fat: 10, fiber: 0.9, sodium: 520 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'jingjiang-rousi', kind: 'dish', name: '京酱肉丝', aliases: [], per100g: { kcal: 196, carb: 10, protein: 12, fat: 12, fiber: 0.6, sodium: 640 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'yuxiang-jisi', kind: 'dish', name: '鱼香鸡丝', aliases: [], per100g: { kcal: 150, carb: 8.5, protein: 11, fat: 8, fiber: 0.9, sodium: 600 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'gongbao-xiaren', kind: 'dish', name: '宫保虾球', aliases: ['宫保虾仁'], per100g: { kcal: 161, carb: 9, protein: 11, fat: 9, fiber: 0.8, sodium: 640 }, unit: { name: '1 盘', grams: 220 } },
  { id: 'xiqin-baihe', kind: 'dish', name: '西芹百合', aliases: ['西芹炒百合'], per100g: { kcal: 91, carb: 8.5, protein: 1.8, fat: 5.5, fiber: 1.4, sodium: 320 }, unit: { name: '1 盘', grams: 220 } },
  { id: 'jiucai-xiaren', kind: 'dish', name: '韭菜炒虾仁', aliases: ['韭菜虾仁'], per100g: { kcal: 104, carb: 2.5, protein: 10, fat: 6, fiber: 1.1, sodium: 420 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'xiaren-huadan', kind: 'dish', name: '虾仁滑蛋', aliases: ['虾仁炒蛋'], per100g: { kcal: 146, carb: 2, protein: 12, fat: 10, fiber: 0.4, sodium: 420 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'xianyandan-nangua', kind: 'dish', name: '咸蛋黄焗南瓜', aliases: ['蛋黄焗南瓜'], per100g: { kcal: 152, carb: 12, protein: 3.5, fat: 10, fiber: 1, sodium: 380 }, unit: { name: '1 盘', grams: 220 } },
  { id: 'jianjiao-gan-doufu', kind: 'dish', name: '尖椒干豆腐', aliases: ['尖椒豆腐皮'], per100g: { kcal: 137, carb: 5, protein: 9, fat: 9, fiber: 1.2, sodium: 520 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'qincai-xianggan', kind: 'dish', name: '芹菜香干', aliases: ['芹菜炒豆腐干'], per100g: { kcal: 123, carb: 5, protein: 10, fat: 7, fiber: 1.6, sodium: 560 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'jiucai-xianggan', kind: 'dish', name: '韭菜炒香干', aliases: ['韭菜豆干'], per100g: { kcal: 132, carb: 5.5, protein: 10.5, fat: 7.5, fiber: 1.5, sodium: 540 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'xihulu-chaodan', kind: 'dish', name: '西葫芦炒蛋', aliases: ['西葫芦炒鸡蛋'], per100g: { kcal: 102, carb: 3.2, protein: 5.5, fat: 7.5, fiber: 0.9, sodium: 340 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'xianggu-qingcai', kind: 'dish', name: '香菇青菜', aliases: ['香菇油菜'], per100g: { kcal: 74, carb: 4, protein: 2.2, fat: 5.5, fiber: 1.4, sodium: 360 }, unit: { name: '1 盘', grams: 220 } },
  { id: 'haoyou-shengcai', kind: 'dish', name: '蚝油生菜', aliases: [], per100g: { kcal: 72, carb: 4, protein: 1.5, fat: 5.5, fiber: 0.9, sodium: 420 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'suanrong-kongxincai', kind: 'dish', name: '蒜蓉空心菜', aliases: ['炒空心菜'], per100g: { kcal: 74, carb: 3, protein: 2, fat: 6, fiber: 1.6, sodium: 380 }, unit: { name: '1 盘', grams: 220 } },
  { id: 'majiang-bocai', kind: 'dish', name: '麻酱菠菜', aliases: ['芝麻酱拌菠菜'], per100g: { kcal: 106, carb: 4.5, protein: 4, fat: 8, fiber: 1.4, sodium: 380 }, unit: { name: '1 盘', grams: 180 } },
  { id: 'fanqie-tudoupian', kind: 'dish', name: '番茄土豆片', aliases: ['西红柿土豆片'], per100g: { kcal: 97, carb: 11, protein: 2, fat: 5, fiber: 1.5, sodium: 340 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'chao-san-si', kind: 'dish', name: '炒三丝', aliases: ['素炒三丝'], per100g: { kcal: 101, carb: 7, protein: 3.5, fat: 6.5, fiber: 1.6, sodium: 420 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'qingchao-sijidou', kind: 'dish', name: '清炒四季豆', aliases: ['清炒豆角'], per100g: { kcal: 90, carb: 6.5, protein: 2.5, fat: 6, fiber: 2.8, sodium: 340 }, unit: { name: '1 盘', grams: 220 } },
  { id: 'chao-xianggu', kind: 'dish', name: '炒香菇', aliases: ['清炒香菇'], per100g: { kcal: 82, carb: 5.5, protein: 2.6, fat: 5.5, fiber: 2, sodium: 340 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'xiqin-chao-rou', kind: 'dish', name: '西芹炒肉', aliases: ['西芹肉片'], per100g: { kcal: 118, carb: 4.5, protein: 8, fat: 7.5, fiber: 1.5, sodium: 440 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'lianou-chao-rou', kind: 'dish', name: '莲藕炒肉', aliases: ['藕片炒肉'], per100g: { kcal: 127, carb: 9.5, protein: 6.5, fat: 7, fiber: 1.6, sodium: 420 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'suanmiao-chao-rou', kind: 'dish', name: '蒜苗炒肉', aliases: ['青蒜炒肉'], per100g: { kcal: 139, carb: 6.5, protein: 8, fat: 9, fiber: 1.8, sodium: 430 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'baicai-chao-rou', kind: 'dish', name: '白菜炒肉', aliases: ['大白菜炒肉片'], per100g: { kcal: 116, carb: 4.5, protein: 7.5, fat: 7.5, fiber: 1.3, sodium: 420 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'shanyao-muer', kind: 'dish', name: '山药炒木耳', aliases: ['木耳炒山药'], per100g: { kcal: 106, carb: 10.5, protein: 2.5, fat: 6, fiber: 1.8, sodium: 330 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'baocai-fensi', kind: 'dish', name: '包菜炒粉丝', aliases: ['圆白菜炒粉丝'], per100g: { kcal: 120, carb: 14, protein: 2.5, fat: 6, fiber: 1.4, sodium: 420 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'yangcong-chao-rou', kind: 'dish', name: '洋葱炒肉', aliases: ['洋葱肉片', '洋葱炒肉片'], per100g: { kcal: 135, carb: 6.5, protein: 8, fat: 8.5, fiber: 1, sodium: 430 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'douya-chao-rou', kind: 'dish', name: '豆芽炒肉', aliases: ['黄豆芽炒肉'], per100g: { kcal: 114, carb: 4, protein: 7.5, fat: 7.5, fiber: 1.4, sodium: 420 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'pinggu-chao-rou', kind: 'dish', name: '平菇炒肉', aliases: ['平菇炒肉片'], per100g: { kcal: 114, carb: 4.5, protein: 7, fat: 7.5, fiber: 1.6, sodium: 400 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'qincai-chao-jidan', kind: 'dish', name: '芹菜炒鸡蛋', aliases: ['芹菜炒蛋'], per100g: { kcal: 110, carb: 3, protein: 6.5, fat: 8, fiber: 1.4, sodium: 380 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'roumo-doujiao', kind: 'dish', name: '肉末豆角', aliases: ['肉末豆角丝'], per100g: { kcal: 141, carb: 8, protein: 7, fat: 9, fiber: 2.6, sodium: 480 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'xianggu-chao-rou', kind: 'dish', name: '香菇炒肉', aliases: ['香菇炒肉片'], per100g: { kcal: 120, carb: 5, protein: 8, fat: 7.5, fiber: 1.8, sodium: 420 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'huluobo-chaorousi', kind: 'dish', name: '胡萝卜炒肉丝', aliases: ['胡萝卜炒肉'], per100g: { kcal: 123, carb: 8, protein: 7, fat: 7, fiber: 1.6, sodium: 420 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'muer-chao-rou', kind: 'dish', name: '木耳炒肉', aliases: ['木耳炒肉片'], per100g: { kcal: 120, carb: 4, protein: 8, fat: 8, fiber: 2, sodium: 440 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'maodou-chaoroumo', kind: 'dish', name: '毛豆炒肉末', aliases: ['毛豆炒肉'], per100g: { kcal: 132, carb: 6, protein: 9, fat: 8, fiber: 2.2, sodium: 460 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'doujiao-chao-rousi', kind: 'dish', name: '豆角炒肉丝', aliases: ['豆角炒肉'], per100g: { kcal: 132, carb: 7.5, protein: 7.5, fat: 8, fiber: 2.6, sodium: 460 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'qingchao-xiaobaicai', kind: 'dish', name: '清炒小白菜', aliases: ['炒小白菜'], per100g: { kcal: 69, carb: 3, protein: 1.8, fat: 5.5, fiber: 1.2, sodium: 340 }, unit: { name: '1 盘', grams: 220 } },
  { id: 'jiucai-chao-douya', kind: 'dish', name: '韭菜炒豆芽', aliases: ['豆芽炒韭菜'], per100g: { kcal: 77, carb: 3.5, protein: 2.2, fat: 6, fiber: 1.4, sodium: 360 }, unit: { name: '1 盘', grams: 220 } },
  { id: 'qingjiao-chao-xianggan', kind: 'dish', name: '青椒炒香干', aliases: ['青椒香干'], per100g: { kcal: 130, carb: 5.5, protein: 10, fat: 7.5, fiber: 1.5, sodium: 540 }, unit: { name: '1 盘', grams: 250 } },

  // —— 炖 / 烧 / 焖 / 蒸 ——
  { id: 'hongshao-niurou', kind: 'dish', name: '红烧牛肉', aliases: ['烧牛肉'], per100g: { kcal: 184, carb: 5, protein: 14, fat: 12, fiber: 0.5, sodium: 620 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'tudou-shao-niurou', kind: 'dish', name: '土豆烧牛肉', aliases: ['牛肉炖土豆'], per100g: { kcal: 161, carb: 9, protein: 11, fat: 9, fiber: 1.2, sodium: 560 }, unit: { name: '1 盘', grams: 300 } },
  { id: 'hongshao-daiyu', kind: 'dish', name: '红烧带鱼', aliases: ['烧带鱼'], per100g: { kcal: 175, carb: 3.5, protein: 16.5, fat: 10.5, fiber: 0.2, sodium: 520 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'tangcu-paigu', kind: 'dish', name: '糖醋排骨', aliases: ['糖醋小排'], per100g: { kcal: 248, carb: 12, protein: 14, fat: 16, fiber: 0.2, sodium: 480 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'hongshao-paigu', kind: 'dish', name: '红烧排骨', aliases: ['红烧小排'], per100g: { kcal: 264, carb: 6, protein: 15, fat: 20, fiber: 0.2, sodium: 560 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'paigu-dun-doujiao', kind: 'dish', name: '排骨炖豆角', aliases: ['豆角炖排骨'], per100g: { kcal: 172, carb: 6, protein: 10, fat: 12, fiber: 2, sodium: 520 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'zhurou-dun-fentiao', kind: 'dish', name: '猪肉炖粉条', aliases: ['猪肉炖宽粉'], per100g: { kcal: 170, carb: 12, protein: 8, fat: 10, fiber: 0.8, sodium: 560 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'xiaoji-dun-mogu', kind: 'dish', name: '小鸡炖蘑菇', aliases: [], per100g: { kcal: 138, carb: 4.5, protein: 12, fat: 8, fiber: 1.5, sodium: 520 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'huangmen-ji', kind: 'dish', name: '黄焖鸡', aliases: ['黄焖鸡块'], per100g: { kcal: 164, carb: 6, protein: 12.5, fat: 10, fiber: 1.2, sodium: 600 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'luobo-dun-yangrou', kind: 'dish', name: '萝卜炖羊肉', aliases: ['羊肉炖萝卜'], per100g: { kcal: 128, carb: 4, protein: 10, fat: 8, fiber: 1, sodium: 520 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'hongshao-zhuti', kind: 'dish', name: '红烧猪蹄', aliases: ['红烧猪脚'], per100g: { kcal: 240, carb: 3, protein: 12, fat: 20, fiber: 0.1, sodium: 480 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'dongpo-rou', kind: 'dish', name: '东坡肉', aliases: [], per100g: { kcal: 461, carb: 4.5, protein: 9.5, fat: 45, fiber: 0, sodium: 500 }, unit: { name: '1 盘', grams: 150 } },
  { id: 'meicai-kourou', kind: 'dish', name: '梅菜扣肉', aliases: [], per100g: { kcal: 383, carb: 8, protein: 9, fat: 35, fiber: 1.2, sodium: 560 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'fenzheng-rou', kind: 'dish', name: '粉蒸肉', aliases: ['米粉蒸肉'], per100g: { kcal: 268, carb: 14, protein: 8, fat: 20, fiber: 0.6, sodium: 480 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'hongshao-jikuai', kind: 'dish', name: '红烧鸡块', aliases: ['红烧鸡'], per100g: { kcal: 186, carb: 6.5, protein: 13, fat: 12, fiber: 1.1, sodium: 560 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'sanbei-ji', kind: 'dish', name: '三杯鸡', aliases: [], per100g: { kcal: 202, carb: 5, protein: 14, fat: 14, fiber: 0.8, sodium: 700 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'dapan-ji', kind: 'dish', name: '大盘鸡', aliases: ['新疆大盘鸡'], per100g: { kcal: 157, carb: 10, protein: 9, fat: 9, fiber: 1.5, sodium: 620 }, unit: { name: '1 盘', grams: 400 } },
  { id: 'hongshao-yu', kind: 'dish', name: '红烧鱼', aliases: ['红烧鲤鱼'], per100g: { kcal: 153, carb: 4, protein: 14, fat: 9, fiber: 0.4, sodium: 560 }, unit: { name: '1 盘', grams: 300 } },
  { id: 'suancai-yu', kind: 'dish', name: '酸菜鱼', aliases: ['酸菜鱼片'], per100g: { kcal: 133, carb: 3, protein: 11, fat: 8.5, fiber: 0.9, sodium: 780 }, unit: { name: '1 碗', grams: 400 } },
  { id: 'shuizhu-yu', kind: 'dish', name: '水煮鱼', aliases: [], per100g: { kcal: 168, carb: 3.5, protein: 11.5, fat: 12, fiber: 0.8, sodium: 820 }, unit: { name: '1 碗', grams: 400 } },
  { id: 'qingzheng-luyu', kind: 'dish', name: '清蒸鲈鱼', aliases: ['蒸鲈鱼'], per100g: { kcal: 116, carb: 0.8, protein: 17, fat: 5, fiber: 0, sodium: 480 }, unit: { name: '1 盘', grams: 300 } },
  { id: 'suancai-bairou', kind: 'dish', name: '酸菜白肉', aliases: ['杀猪菜'], per100g: { kcal: 222, carb: 4, protein: 11, fat: 18, fiber: 1, sodium: 700 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'douban-yu', kind: 'dish', name: '豆瓣鱼', aliases: ['豆瓣鲤鱼'], per100g: { kcal: 138, carb: 3.5, protein: 13, fat: 8, fiber: 0.6, sodium: 640 }, unit: { name: '1 盘', grams: 300 } },
  { id: 'luobo-dun-niunan', kind: 'dish', name: '萝卜炖牛腩', aliases: ['牛腩炖萝卜'], per100g: { kcal: 144, carb: 6, protein: 12, fat: 8, fiber: 1.1, sodium: 520 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'banli-dun-ji', kind: 'dish', name: '板栗炖鸡', aliases: ['板栗烧鸡'], per100g: { kcal: 172, carb: 14, protein: 11, fat: 8, fiber: 1.6, sodium: 480 }, unit: { name: '1 盘', grams: 300 } },
  { id: 'hongshao-donggua', kind: 'dish', name: '红烧冬瓜', aliases: ['酱烧冬瓜'], per100g: { kcal: 101, carb: 6, protein: 1.2, fat: 8, fiber: 1, sodium: 420 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'qiezi-bao', kind: 'dish', name: '茄子煲', aliases: ['鱼香茄子煲'], per100g: { kcal: 132, carb: 8, protein: 2.5, fat: 10, fiber: 1.5, sodium: 520 }, unit: { name: '1 煲', grams: 300 } },
  { id: 'xianggu-dun-ji', kind: 'dish', name: '香菇炖鸡', aliases: ['香菇鸡汤'], per100g: { kcal: 106, carb: 3, protein: 10, fat: 6, fiber: 1, sodium: 520 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'huangdou-dun-zhuti', kind: 'dish', name: '黄豆炖猪蹄', aliases: ['猪蹄炖黄豆'], per100g: { kcal: 217, carb: 5, protein: 11, fat: 17, fiber: 1.2, sodium: 520 }, unit: { name: '1 盘', grams: 300 } },
  { id: 'xianggu-huaji', kind: 'dish', name: '香菇滑鸡', aliases: ['滑鸡'], per100g: { kcal: 120, carb: 4.5, protein: 13, fat: 5.5, fiber: 1, sodium: 560 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'zheng-paigu', kind: 'dish', name: '粉蒸排骨', aliases: ['米粉蒸排骨'], per100g: { kcal: 226, carb: 13, protein: 12, fat: 14, fiber: 0.5, sodium: 520 }, unit: { name: '1 盘', grams: 250 } },

  // —— 汤 / 羹 ——
  { id: 'fanqie-jidan-tang', kind: 'dish', name: '西红柿鸡蛋汤', aliases: ['番茄蛋汤', '西红柿蛋汤'], per100g: { kcal: 43, carb: 3, protein: 2.2, fat: 2.5, fiber: 0.3, sodium: 380 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'zicai-danhua-tang', kind: 'dish', name: '紫菜蛋花汤', aliases: ['紫菜汤'], per100g: { kcal: 38, carb: 2.5, protein: 2, fat: 2.2, fiber: 0.4, sodium: 420 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'donggua-paigu-tang', kind: 'dish', name: '冬瓜排骨汤', aliases: ['排骨冬瓜汤'], per100g: { kcal: 62, carb: 2, protein: 4.5, fat: 4, fiber: 0.4, sodium: 380 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'yumi-paigu-tang', kind: 'dish', name: '玉米排骨汤', aliases: ['排骨玉米汤'], per100g: { kcal: 72, carb: 5, protein: 4, fat: 4, fiber: 0.6, sodium: 360 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'qingdun-jitang', kind: 'dish', name: '清炖鸡汤', aliases: ['鸡汤', '土鸡汤'], per100g: { kcal: 56, carb: 1, protein: 5, fat: 3.5, fiber: 0, sodium: 380 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'laoya-tang', kind: 'dish', name: '老鸭汤', aliases: ['酸萝卜老鸭汤'], per100g: { kcal: 63, carb: 1.5, protein: 4, fat: 4.5, fiber: 0.3, sodium: 420 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'yuwan-tang', kind: 'dish', name: '鱼丸汤', aliases: ['鱼圆汤'], per100g: { kcal: 60, carb: 6, protein: 4.5, fat: 2, fiber: 0.3, sodium: 480 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'zhurou-wanzi-tang', kind: 'dish', name: '猪肉丸子汤', aliases: ['丸子汤', '肉丸汤'], per100g: { kcal: 102, carb: 6, protein: 6, fat: 6, fiber: 0.5, sodium: 480 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'haidai-paigu-tang', kind: 'dish', name: '海带排骨汤', aliases: ['海带汤'], per100g: { kcal: 65, carb: 2, protein: 4.8, fat: 4.2, fiber: 0.6, sodium: 420 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'fanqie-niunan-tang', kind: 'dish', name: '番茄牛腩汤', aliases: ['牛腩汤'], per100g: { kcal: 77, carb: 3.5, protein: 5.5, fat: 4.5, fiber: 0.5, sodium: 420 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'donggua-wanzi-tang', kind: 'dish', name: '冬瓜丸子汤', aliases: ['冬瓜肉丸汤'], per100g: { kcal: 79, carb: 4.5, protein: 5, fat: 4.5, fiber: 0.5, sodium: 450 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'jidan-geng', kind: 'dish', name: '鸡蛋羹', aliases: ['蒸蛋', '水蒸蛋', '蒸鸡蛋'], per100g: { kcal: 75, carb: 1.5, protein: 6, fat: 5, fiber: 0, sodium: 320 }, unit: { name: '1 碗', grams: 150 } },
  { id: 'doufu-geng', kind: 'dish', name: '豆腐羹', aliases: ['豆腐蛋花羹'], per100g: { kcal: 53, carb: 3.5, protein: 4, fat: 2.5, fiber: 0.4, sodium: 380 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'yumi-geng', kind: 'dish', name: '玉米羹', aliases: ['玉米浓汤'], per100g: { kcal: 71, carb: 10, protein: 2, fat: 2.5, fiber: 0.8, sodium: 320 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'yiner-tang', kind: 'dish', name: '银耳汤', aliases: ['银耳莲子汤'], per100g: { kcal: 39, carb: 9, protein: 0.4, fat: 0.1, fiber: 0.8, sodium: 10 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'hongdou-tang', kind: 'dish', name: '红豆汤', aliases: ['红豆沙'], per100g: { kcal: 85, carb: 18, protein: 2, fat: 0.5, fiber: 1.5, sodium: 20 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'lvdou-tang', kind: 'dish', name: '绿豆汤', aliases: ['绿豆沙'], per100g: { kcal: 61, carb: 13, protein: 1.5, fat: 0.3, fiber: 0.8, sodium: 15 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'fanqie-doufu-tang', kind: 'dish', name: '番茄豆腐汤', aliases: [], per100g: { kcal: 42, carb: 3, protein: 3, fat: 2, fiber: 0.5, sodium: 400 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'bocai-doufu-tang', kind: 'dish', name: '菠菜豆腐汤', aliases: [], per100g: { kcal: 42, carb: 2.5, protein: 3.5, fat: 2, fiber: 0.6, sodium: 380 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'suanla-doufu-geng', kind: 'dish', name: '酸辣豆腐羹', aliases: ['豆腐酸辣汤'], per100g: { kcal: 46, carb: 4, protein: 3, fat: 2, fiber: 0.5, sodium: 520 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'donggua-tang', kind: 'dish', name: '冬瓜汤', aliases: ['清汤冬瓜'], per100g: { kcal: 14, carb: 1.5, protein: 0.6, fat: 0.6, fiber: 0.5, sodium: 320 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'luosong-tang', kind: 'dish', name: '罗宋汤', aliases: ['罗宋浓汤'], per100g: { kcal: 65, carb: 8, protein: 2.5, fat: 2.5, fiber: 0.8, sodium: 480 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'naiyou-mogu-tang', kind: 'dish', name: '奶油蘑菇汤', aliases: ['蘑菇汤'], per100g: { kcal: 79, carb: 6.5, protein: 2, fat: 5, fiber: 0.5, sodium: 420 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'sigua-dantang', kind: 'dish', name: '丝瓜蛋汤', aliases: ['丝瓜鸡蛋汤'], per100g: { kcal: 45, carb: 2.5, protein: 2.5, fat: 2.8, fiber: 0.6, sodium: 340 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'jiyu-doufu-tang', kind: 'dish', name: '鲫鱼豆腐汤', aliases: ['鲫鱼汤'], per100g: { kcal: 57, carb: 1.5, protein: 6, fat: 3, fiber: 0.4, sodium: 400 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'yumi-huluobo-tang', kind: 'dish', name: '玉米胡萝卜汤', aliases: ['胡萝卜玉米汤'], per100g: { kcal: 40, carb: 5, protein: 1.5, fat: 1.5, fiber: 0.8, sodium: 320 }, unit: { name: '1 碗', grams: 350 } },

  // —— 蛋类菜 ——
  { id: 'jian-dan', kind: 'dish', name: '煎蛋', aliases: ['荷包蛋', '煎鸡蛋'], per100g: { kcal: 134, carb: 0.8, protein: 12.5, fat: 9, fiber: 0, sodium: 320 }, unit: { name: '1 个', grams: 50 } },
  { id: 'chao-jidan', kind: 'dish', name: '炒鸡蛋', aliases: ['炒蛋', '滑蛋'], per100g: { kcal: 144, carb: 1.5, protein: 12, fat: 10, fiber: 0, sodium: 340 }, unit: { name: '1 份', grams: 150 } },
  { id: 'pidan', kind: 'dish', name: '皮蛋', aliases: ['松花蛋'], per100g: { kcal: 158, carb: 3, protein: 14, fat: 10, fiber: 0, sodium: 540 }, unit: { name: '1 个', grams: 60 } },
  { id: 'chayedan', kind: 'dish', name: '茶叶蛋', aliases: ['卤蛋'], per100g: { kcal: 146, carb: 2.5, protein: 12.5, fat: 9.5, fiber: 0, sodium: 620 }, unit: { name: '1 个', grams: 55 } },
  { id: 'suanhuang-chaodan', kind: 'dish', name: '蒜黄炒蛋', aliases: ['蒜黄炒鸡蛋'], per100g: { kcal: 118, carb: 3.5, protein: 6.8, fat: 8.5, fiber: 1.2, sodium: 360 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'xianyadan', kind: 'dish', name: '咸鸭蛋', aliases: ['咸蛋'], per100g: { kcal: 173, carb: 2, protein: 12, fat: 13, fiber: 0, sodium: 2500 }, unit: { name: '1 个', grams: 60 } },

  // —— 豆腐 / 豆制品菜 ——
  { id: 'jiachang-doufu', kind: 'dish', name: '家常豆腐', aliases: ['家常烧豆腐'], per100g: { kcal: 126, carb: 5, protein: 8.5, fat: 8, fiber: 0.9, sodium: 600 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'hongshao-doufu', kind: 'dish', name: '红烧豆腐', aliases: ['烧豆腐'], per100g: { kcal: 109, carb: 5, protein: 7.5, fat: 6.5, fiber: 0.8, sodium: 560 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'pidan-doufu', kind: 'dish', name: '皮蛋豆腐', aliases: ['凉拌皮蛋豆腐'], per100g: { kcal: 92, carb: 2.5, protein: 7, fat: 6, fiber: 0.5, sodium: 600 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'xiaocong-ban-doufu', kind: 'dish', name: '小葱拌豆腐', aliases: ['拌豆腐'], per100g: { kcal: 72, carb: 2.5, protein: 6.5, fat: 4, fiber: 0.6, sodium: 480 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'doufunao', kind: 'dish', name: '豆腐脑', aliases: ['豆花', '豆腐花'], per100g: { kcal: 38, carb: 2, protein: 3, fat: 2, fiber: 0.3, sodium: 400 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'ganjian-doufu', kind: 'dish', name: '干煎豆腐', aliases: ['香煎豆腐', '煎豆腐'], per100g: { kcal: 120, carb: 4, protein: 8, fat: 8, fiber: 0.6, sodium: 480 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'xianggu-doufu', kind: 'dish', name: '香菇豆腐', aliases: [], per100g: { kcal: 100, carb: 4, protein: 7.5, fat: 6, fiber: 1, sodium: 480 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'yuxiang-doufu', kind: 'dish', name: '鱼香豆腐', aliases: [], per100g: { kcal: 111, carb: 6, protein: 7, fat: 6.5, fiber: 0.8, sodium: 620 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'xiaren-doufu', kind: 'dish', name: '虾仁豆腐', aliases: [], per100g: { kcal: 89, carb: 2, protein: 9, fat: 5, fiber: 0.4, sodium: 480 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'tieban-doufu', kind: 'dish', name: '铁板豆腐', aliases: [], per100g: { kcal: 113, carb: 4.5, protein: 8, fat: 7, fiber: 0.6, sodium: 620 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'xianggan-chao-rou', kind: 'dish', name: '香干炒肉', aliases: ['豆干炒肉'], per100g: { kcal: 130, carb: 5, protein: 9.5, fat: 8, fiber: 1.2, sodium: 560 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'fuzhu-shaorou', kind: 'dish', name: '腐竹烧肉', aliases: ['腐竹炒肉'], per100g: { kcal: 166, carb: 7, protein: 12, fat: 10, fiber: 0.8, sodium: 520 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'liangban-fuzhu', kind: 'dish', name: '凉拌腐竹', aliases: [], per100g: { kcal: 171, carb: 8.5, protein: 14, fat: 9, fiber: 1.2, sodium: 480 }, unit: { name: '1 盘', grams: 150 } },
  { id: 'qianzhang-rousi', kind: 'dish', name: '千张炒肉丝', aliases: ['千张肉丝'], per100g: { kcal: 140, carb: 5.5, protein: 11.5, fat: 8, fiber: 1.2, sodium: 520 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'shaguo-doufu', kind: 'dish', name: '砂锅豆腐', aliases: ['豆腐煲'], per100g: { kcal: 94, carb: 4, protein: 7, fat: 5.5, fiber: 0.8, sodium: 520 }, unit: { name: '1 煲', grams: 300 } },
  { id: 'youdoufu-shaorou', kind: 'dish', name: '油豆腐烧肉', aliases: ['豆腐泡烧肉'], per100g: { kcal: 180, carb: 8, protein: 10, fat: 12, fiber: 0.6, sodium: 540 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'wuxiang-suji', kind: 'dish', name: '五香素鸡', aliases: ['素鸡'], per100g: { kcal: 140, carb: 6.5, protein: 15, fat: 6, fiber: 0.5, sodium: 600 }, unit: { name: '1 盘', grams: 150 } },
  { id: 'ganguo-doufu', kind: 'dish', name: '干锅豆腐', aliases: [], per100g: { kcal: 133, carb: 5, protein: 8, fat: 9, fiber: 0.9, sodium: 680 }, unit: { name: '1 盘', grams: 250 } },

  // —— 青菜 / 凉菜 ——
  { id: 'liangban-huanggua', kind: 'dish', name: '凉拌黄瓜', aliases: ['拍黄瓜', '凉拌青瓜'], per100g: { kcal: 48, carb: 3, protein: 1, fat: 3.5, fiber: 0.8, sodium: 380 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'liangban-muer', kind: 'dish', name: '凉拌木耳', aliases: ['凉拌黑木耳'], per100g: { kcal: 70, carb: 6.5, protein: 2, fat: 4, fiber: 4, sodium: 400 }, unit: { name: '1 盘', grams: 150 } },
  { id: 'liangban-haidaisi', kind: 'dish', name: '凉拌海带丝', aliases: [], per100g: { kcal: 53, carb: 5, protein: 1.5, fat: 3, fiber: 1.2, sodium: 480 }, unit: { name: '1 盘', grams: 150 } },
  { id: 'liangban-fensi', kind: 'dish', name: '凉拌粉丝', aliases: ['粉丝拌菜'], per100g: { kcal: 103, carb: 14, protein: 1.5, fat: 4.5, fiber: 0.8, sodium: 420 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'liangpi', kind: 'dish', name: '凉皮', aliases: ['陕西凉皮'], per100g: { kcal: 131, carb: 18, protein: 3.5, fat: 5, fiber: 0.8, sodium: 500 }, unit: { name: '1 份', grams: 300 } },
  { id: 'suanni-bairou', kind: 'dish', name: '蒜泥白肉', aliases: [], per100g: { kcal: 236, carb: 2, protein: 12, fat: 20, fiber: 0.2, sodium: 600 }, unit: { name: '1 盘', grams: 150 } },
  { id: 'koushui-ji', kind: 'dish', name: '口水鸡', aliases: ['麻辣鸡'], per100g: { kcal: 190, carb: 3, protein: 13, fat: 14, fiber: 0.3, sodium: 700 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'bansansi', kind: 'dish', name: '拌三丝', aliases: [], per100g: { kcal: 70, carb: 6, protein: 2.5, fat: 4, fiber: 1.4, sodium: 400 }, unit: { name: '1 盘', grams: 180 } },
  { id: 'su-shenjin', kind: 'dish', name: '素什锦', aliases: ['凉拌素什锦'], per100g: { kcal: 93, carb: 9, protein: 4, fat: 4.5, fiber: 1.5, sodium: 460 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'liangban-jinzhengu', kind: 'dish', name: '凉拌金针菇', aliases: [], per100g: { kcal: 68, carb: 6, protein: 3, fat: 3.5, fiber: 2, sodium: 460 }, unit: { name: '1 盘', grams: 180 } },
  { id: 'liangban-kugua', kind: 'dish', name: '凉拌苦瓜', aliases: [], per100g: { kcal: 49, carb: 4, protein: 1.5, fat: 3, fiber: 1.6, sodium: 340 }, unit: { name: '1 盘', grams: 180 } },
  { id: 'liangban-oupian', kind: 'dish', name: '凉拌藕片', aliases: ['凉拌莲藕'], per100g: { kcal: 88, carb: 12, protein: 2, fat: 3.5, fiber: 1.4, sodium: 380 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'baizhuo-caixin', kind: 'dish', name: '白灼菜心', aliases: ['白灼芥兰'], per100g: { kcal: 49, carb: 2.5, protein: 1.8, fat: 3.5, fiber: 1.2, sodium: 340 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'qingchao-lusun', kind: 'dish', name: '清炒芦笋', aliases: ['炒芦笋'], per100g: { kcal: 67, carb: 4, protein: 2.5, fat: 4.5, fiber: 1.6, sodium: 320 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'qingchao-sigua', kind: 'dish', name: '清炒丝瓜', aliases: [], per100g: { kcal: 61, carb: 4, protein: 1.2, fat: 4.5, fiber: 0.8, sodium: 320 }, unit: { name: '1 盘', grams: 220 } },
  { id: 'suanrong-tonghao', kind: 'dish', name: '蒜蓉茼蒿', aliases: ['炒茼蒿'], per100g: { kcal: 76, carb: 3.2, protein: 2.2, fat: 6, fiber: 1.4, sodium: 360 }, unit: { name: '1 盘', grams: 220 } },
  { id: 'liangban-doufusi', kind: 'dish', name: '凉拌豆腐丝', aliases: ['豆腐丝'], per100g: { kcal: 126, carb: 6, protein: 12, fat: 6, fiber: 1, sodium: 520 }, unit: { name: '1 盘', grams: 150 } },

  // —— 肉类硬菜 ——
  { id: 'ziran-yangrou', kind: 'dish', name: '孜然羊肉', aliases: ['孜然羊肉片'], per100g: { kcal: 210, carb: 5, protein: 16, fat: 14, fiber: 0.6, sodium: 600 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'congbao-yangrou', kind: 'dish', name: '葱爆羊肉', aliases: ['葱爆羊肉片'], per100g: { kcal: 175, carb: 4, protein: 15, fat: 11, fiber: 0.8, sodium: 520 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'heijiao-niuliu', kind: 'dish', name: '黑椒牛柳', aliases: ['黑椒牛肉'], per100g: { kcal: 178, carb: 7, protein: 15, fat: 10, fiber: 0.6, sodium: 560 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'haoyou-niurou', kind: 'dish', name: '蚝油牛肉', aliases: [], per100g: { kcal: 156, carb: 5.5, protein: 15.5, fat: 8, fiber: 0.6, sodium: 640 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'xiaochao-huangniurou', kind: 'dish', name: '小炒黄牛肉', aliases: ['小炒牛肉'], per100g: { kcal: 197, carb: 4, protein: 16, fat: 13, fiber: 0.9, sodium: 660 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'hongshao-shizitou', kind: 'dish', name: '红烧狮子头', aliases: ['狮子头'], per100g: { kcal: 242, carb: 9, protein: 11, fat: 18, fiber: 0.6, sodium: 560 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'sixi-wanzi', kind: 'dish', name: '四喜丸子', aliases: [], per100g: { kcal: 235, carb: 10, protein: 10.5, fat: 17, fiber: 0.6, sodium: 560 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'gulao-rou', kind: 'dish', name: '咕咾肉', aliases: ['咕噜肉'], per100g: { kcal: 238, carb: 18, protein: 10, fat: 14, fiber: 0.4, sodium: 480 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'larou-chao-suantai', kind: 'dish', name: '腊肉炒蒜薹', aliases: ['蒜薹炒腊肉'], per100g: { kcal: 185, carb: 6, protein: 11, fat: 13, fiber: 1.8, sodium: 680 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'lazi-ji', kind: 'dish', name: '辣子鸡', aliases: ['重庆辣子鸡'], per100g: { kcal: 227, carb: 6, protein: 17, fat: 15, fiber: 1, sodium: 760 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'baiqie-ji', kind: 'dish', name: '白切鸡', aliases: ['白斩鸡'], per100g: { kcal: 155, carb: 0.5, protein: 18, fat: 9, fiber: 0, sodium: 480 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'yanju-ji', kind: 'dish', name: '盐焗鸡', aliases: [], per100g: { kcal: 169, carb: 0.8, protein: 19, fat: 10, fiber: 0, sodium: 600 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'pijiu-ya', kind: 'dish', name: '啤酒鸭', aliases: [], per100g: { kcal: 198, carb: 4, protein: 14, fat: 14, fiber: 0.5, sodium: 640 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'jiangbao-ya', kind: 'dish', name: '姜爆鸭', aliases: ['姜母鸭'], per100g: { kcal: 195, carb: 5, protein: 14.5, fat: 13, fiber: 0.8, sodium: 660 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'shao-e', kind: 'dish', name: '烧鹅', aliases: ['广式烧鹅'], per100g: { kcal: 288, carb: 3, protein: 15, fat: 24, fiber: 0, sodium: 680 }, unit: { name: '1 盘', grams: 150 } },
  { id: 'gali-niurou', kind: 'dish', name: '咖喱牛肉', aliases: ['咖喱牛腩'], per100g: { kcal: 170, carb: 7, protein: 13, fat: 10, fiber: 1, sodium: 560 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'hongshao-niunan', kind: 'dish', name: '红烧牛腩', aliases: [], per100g: { kcal: 189, carb: 5, protein: 13, fat: 13, fiber: 0.5, sodium: 620 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'hongshao-yangrou', kind: 'dish', name: '红烧羊肉', aliases: [], per100g: { kcal: 198, carb: 4, protein: 14, fat: 14, fiber: 0.4, sodium: 640 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'guobao-rou', kind: 'dish', name: '锅包肉', aliases: [], per100g: { kcal: 262, carb: 24, protein: 10, fat: 14, fiber: 0.4, sodium: 480 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'liurouduan', kind: 'dish', name: '溜肉段', aliases: [], per100g: { kcal: 225, carb: 16, protein: 11, fat: 13, fiber: 0.5, sodium: 560 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'zheng-roubing', kind: 'dish', name: '蒸肉饼', aliases: ['肉饼'], per100g: { kcal: 180, carb: 6, protein: 12, fat: 12, fiber: 0.4, sodium: 520 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'zhenzhu-wanzi', kind: 'dish', name: '珍珠丸子', aliases: ['糯米丸子'], per100g: { kcal: 176, carb: 18, protein: 8, fat: 8, fiber: 0.4, sodium: 440 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'niang-doufu', kind: 'dish', name: '酿豆腐', aliases: ['客家酿豆腐'], per100g: { kcal: 124, carb: 4.5, protein: 8.5, fat: 8, fiber: 0.8, sodium: 520 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'niang-kugua', kind: 'dish', name: '酿苦瓜', aliases: [], per100g: { kcal: 133, carb: 5, protein: 8, fat: 9, fiber: 1.2, sodium: 520 }, unit: { name: '1 盘', grams: 250 } },

  // —— 水产（成品菜） ——
  { id: 'baizhuo-xia', kind: 'dish', name: '白灼虾', aliases: ['水煮虾', '白灼基围虾'], per100g: { kcal: 94, carb: 1, protein: 19, fat: 1.5, fiber: 0, sodium: 420 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'youmen-daxia', kind: 'dish', name: '油焖大虾', aliases: [], per100g: { kcal: 160, carb: 4, protein: 18, fat: 8, fiber: 0.3, sodium: 620 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'suanrong-fensi-xia', kind: 'dish', name: '蒜蓉粉丝蒸虾', aliases: ['蒜蓉虾'], per100g: { kcal: 158, carb: 12, protein: 14, fat: 6, fiber: 0.5, sodium: 560 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'xiangjian-daiyu', kind: 'dish', name: '香煎带鱼', aliases: ['煎带鱼'], per100g: { kcal: 163, carb: 3, protein: 17.5, fat: 9, fiber: 0.2, sodium: 520 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'tangcu-yu', kind: 'dish', name: '糖醋鱼', aliases: ['糖醋鲤鱼'], per100g: { kcal: 185, carb: 14, protein: 12, fat: 9, fiber: 0.3, sodium: 560 }, unit: { name: '1 盘', grams: 300 } },
  { id: 'qingzheng-dazhaxie', kind: 'dish', name: '清蒸大闸蟹', aliases: ['大闸蟹'], per100g: { kcal: 102, carb: 0.5, protein: 16, fat: 4, fiber: 0, sodium: 480 }, unit: { name: '1 只', grams: 150 } },
  { id: 'suanrong-shanbei', kind: 'dish', name: '蒜蓉扇贝', aliases: ['蒜蓉粉丝扇贝'], per100g: { kcal: 118, carb: 6, protein: 10, fat: 6, fiber: 0.4, sodium: 600 }, unit: { name: '1 份', grams: 300 } },
  { id: 'xiangla-xie', kind: 'dish', name: '香辣蟹', aliases: ['香辣河蟹'], per100g: { kcal: 202, carb: 5, protein: 14, fat: 14, fiber: 0.5, sodium: 760 }, unit: { name: '1 盘', grams: 350 } },
  { id: 'malaxiaolongxia', kind: 'dish', name: '麻辣小龙虾', aliases: ['小龙虾', '油焖小龙虾'], per100g: { kcal: 153, carb: 3, protein: 15, fat: 9, fiber: 0.2, sodium: 700 }, unit: { name: '1 盘', grams: 400 } },
  { id: 'jiucai-chao-youyu', kind: 'dish', name: '韭菜炒鱿鱼', aliases: ['鱿鱼炒韭菜'], per100g: { kcal: 116, carb: 3.5, protein: 12, fat: 6, fiber: 0.8, sodium: 560 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'xiangjian-sanwenyu', kind: 'dish', name: '香煎三文鱼', aliases: ['煎三文鱼'], per100g: { kcal: 168, carb: 0.5, protein: 19, fat: 10, fiber: 0, sodium: 420 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'lacao-geli', kind: 'dish', name: '辣炒蛤蜊', aliases: ['爆炒花蛤'], per100g: { kcal: 105, carb: 4, protein: 11, fat: 5, fiber: 0.4, sodium: 720 }, unit: { name: '1 盘', grams: 300 } },
  { id: 'duojiao-yutou', kind: 'dish', name: '剁椒鱼头', aliases: [], per100g: { kcal: 154, carb: 4, protein: 12, fat: 10, fiber: 0.8, sodium: 720 }, unit: { name: '1 盘', grams: 350 } },
  { id: 'qingzheng-huanghuayu', kind: 'dish', name: '清蒸黄花鱼', aliases: ['蒸黄鱼'], per100g: { kcal: 104, carb: 1, protein: 17, fat: 3.5, fiber: 0, sodium: 520 }, unit: { name: '1 盘', grams: 300 } },
  { id: 'xiangla-youyu', kind: 'dish', name: '香辣鱿鱼', aliases: ['辣炒鱿鱼'], per100g: { kcal: 148, carb: 5, protein: 14, fat: 8, fiber: 0.4, sodium: 780 }, unit: { name: '1 盘', grams: 250 } },
  { id: 'qingzheng-jiweixia', kind: 'dish', name: '清蒸基围虾', aliases: ['蒸虾'], per100g: { kcal: 98, carb: 1, protein: 19.5, fat: 1.8, fiber: 0, sodium: 380 }, unit: { name: '1 盘', grams: 200 } },
  { id: 'shuizhu-niwa', kind: 'dish', name: '水煮牛蛙', aliases: ['馋嘴牛蛙'], per100g: { kcal: 161, carb: 4, protein: 16, fat: 9, fiber: 0.5, sodium: 780 }, unit: { name: '1 碗', grams: 400 } },
  { id: 'ganguo-xia', kind: 'dish', name: '干锅虾', aliases: ['麻辣干锅虾'], per100g: { kcal: 186, carb: 4.5, protein: 15, fat: 12, fiber: 0.6, sodium: 820 }, unit: { name: '1 盘', grams: 350 } },

  // —— 米饭 / 面 / 粉 / 盖饭 ——
  { id: 'xihongshi-jidan-mian', kind: 'dish', name: '西红柿鸡蛋面', aliases: ['番茄鸡蛋面'], per100g: { kcal: 127, carb: 15, protein: 5.5, fat: 5, fiber: 1, sodium: 620 }, unit: { name: '1 碗', grams: 600 } },
  { id: 'zhajiang-mian', kind: 'dish', name: '炸酱面', aliases: ['老北京炸酱面'], per100g: { kcal: 179, carb: 22, protein: 7, fat: 7, fiber: 1.2, sodium: 800 }, unit: { name: '1 碗', grams: 600 } },
  { id: 'regan-mian', kind: 'dish', name: '热干面', aliases: ['武汉热干面'], per100g: { kcal: 217, carb: 26, protein: 8, fat: 9, fiber: 1.2, sodium: 720 }, unit: { name: '1 碗', grams: 400 } },
  { id: 'yangchun-mian', kind: 'dish', name: '阳春面', aliases: ['清汤面'], per100g: { kcal: 98, carb: 16, protein: 4, fat: 2, fiber: 0.8, sodium: 620 }, unit: { name: '1 碗', grams: 600 } },
  { id: 'dandan-mian', kind: 'dish', name: '担担面', aliases: ['四川担担面'], per100g: { kcal: 201, carb: 22, protein: 8, fat: 9, fiber: 1, sodium: 820 }, unit: { name: '1 碗', grams: 400 } },
  { id: 'chongqing-xiaomian', kind: 'dish', name: '重庆小面', aliases: ['小面'], per100g: { kcal: 185, carb: 20, protein: 7, fat: 8.5, fiber: 1.2, sodium: 780 }, unit: { name: '1 碗', grams: 500 } },
  { id: 'suanla-fen', kind: 'dish', name: '酸辣粉', aliases: [], per100g: { kcal: 155, carb: 20, protein: 3, fat: 7, fiber: 1, sodium: 780 }, unit: { name: '1 碗', grams: 500 } },
  { id: 'luosifen', kind: 'dish', name: '螺蛳粉', aliases: ['柳州螺蛳粉'], per100g: { kcal: 159, carb: 18, protein: 6, fat: 7, fiber: 1.5, sodium: 900 }, unit: { name: '1 碗', grams: 600 } },
  { id: 'guilin-mifen', kind: 'dish', name: '桂林米粉', aliases: [], per100g: { kcal: 153, carb: 20, protein: 7, fat: 5, fiber: 1, sodium: 760 }, unit: { name: '1 碗', grams: 500 } },
  { id: 'guoqiao-mixian', kind: 'dish', name: '过桥米线', aliases: [], per100g: { kcal: 114, carb: 14, protein: 5.5, fat: 4, fiber: 0.9, sodium: 620 }, unit: { name: '1 碗', grams: 700 } },
  { id: 'niurou-fen', kind: 'dish', name: '牛肉粉', aliases: ['牛肉米粉'], per100g: { kcal: 116, carb: 14, protein: 6, fat: 4, fiber: 0.8, sodium: 720 }, unit: { name: '1 碗', grams: 600 } },
  { id: 'huangmen-jimi-fan', kind: 'dish', name: '黄焖鸡米饭', aliases: ['黄焖鸡饭'], per100g: { kcal: 152, carb: 17, protein: 8.5, fat: 5.5, fiber: 0.9, sodium: 620 }, unit: { name: '1 份', grams: 500 } },
  { id: 'gali-ji-fan', kind: 'dish', name: '咖喱鸡饭', aliases: ['咖喱鸡盖饭'], per100g: { kcal: 156, carb: 18, protein: 7.5, fat: 6, fiber: 1, sodium: 560 }, unit: { name: '1 份', grams: 450 } },
  { id: 'hongshao-rou-gaifan', kind: 'dish', name: '红烧肉盖饭', aliases: ['红烧肉饭'], per100g: { kcal: 208, carb: 18, protein: 7, fat: 12, fiber: 0.6, sodium: 620 }, unit: { name: '1 份', grams: 450 } },
  { id: 'fanqie-jidan-gaifan', kind: 'dish', name: '西红柿鸡蛋盖饭', aliases: ['番茄鸡蛋盖饭'], per100g: { kcal: 136, carb: 16, protein: 5.5, fat: 5.5, fiber: 0.8, sodium: 620 }, unit: { name: '1 份', grams: 450 } },
  { id: 'yuxiang-rousi-gaifan', kind: 'dish', name: '鱼香肉丝盖饭', aliases: ['鱼香肉丝饭'], per100g: { kcal: 166, carb: 17, protein: 6.5, fat: 8, fiber: 0.8, sodium: 680 }, unit: { name: '1 份', grams: 450 } },
  { id: 'gongbao-jidan-gaifan', kind: 'dish', name: '宫保鸡丁盖饭', aliases: ['宫保鸡丁饭'], per100g: { kcal: 175, carb: 17, protein: 7.5, fat: 8.5, fiber: 1, sodium: 700 }, unit: { name: '1 份', grams: 450 } },
  { id: 'lurou-fan', kind: 'dish', name: '卤肉饭', aliases: ['台湾卤肉饭'], per100g: { kcal: 197, carb: 22, protein: 7, fat: 9, fiber: 0.6, sodium: 720 }, unit: { name: '1 份', grams: 400 } },
  { id: 'paigu-fan', kind: 'dish', name: '排骨饭', aliases: ['排骨盖饭'], per100g: { kcal: 175, carb: 20, protein: 8, fat: 7, fiber: 0.8, sodium: 600 }, unit: { name: '1 份', grams: 450 } },
  { id: 'gali-niurou-fan', kind: 'dish', name: '咖喱牛肉饭', aliases: ['咖喱牛肉盖饭'], per100g: { kcal: 150, carb: 18, protein: 7, fat: 5.5, fiber: 1, sodium: 560 }, unit: { name: '1 份', grams: 450 } },
  { id: 'jitui-fan', kind: 'dish', name: '鸡腿饭', aliases: ['鸡腿盖饭'], per100g: { kcal: 164, carb: 19, protein: 8.5, fat: 6, fiber: 0.8, sodium: 640 }, unit: { name: '1 份', grams: 450 } },
  { id: 'baozaifan', kind: 'dish', name: '煲仔饭', aliases: ['广式煲仔饭'], per100g: { kcal: 176, carb: 24, protein: 6.5, fat: 6, fiber: 0.7, sodium: 620 }, unit: { name: '1 份', grams: 450 } },
  { id: 'feiniu-fan', kind: 'dish', name: '肥牛饭', aliases: ['肥牛盖饭'], per100g: { kcal: 176, carb: 19, protein: 8, fat: 7.5, fiber: 0.6, sodium: 640 }, unit: { name: '1 份', grams: 450 } },
  { id: 'zhujiao-fan', kind: 'dish', name: '猪脚饭', aliases: ['猪手饭'], per100g: { kcal: 189, carb: 19, protein: 8, fat: 9, fiber: 0.6, sodium: 640 }, unit: { name: '1 份', grams: 450 } },
  { id: 'danbaofan', kind: 'dish', name: '蛋包饭', aliases: [], per100g: { kcal: 157, carb: 18, protein: 6.5, fat: 6.5, fiber: 0.8, sodium: 560 }, unit: { name: '1 份', grams: 400 } },
  { id: 'shiguo-banfan', kind: 'dish', name: '石锅拌饭', aliases: ['拌饭'], per100g: { kcal: 141, carb: 18, protein: 6, fat: 5, fiber: 1.2, sodium: 600 }, unit: { name: '1 份', grams: 450 } },
  { id: 'fantuan', kind: 'dish', name: '饭团', aliases: ['三角饭团'], per100g: { kcal: 163, carb: 30, protein: 4, fat: 3, fiber: 0.5, sodium: 400 }, unit: { name: '1 个', grams: 120 } },
  { id: 'chao-hefen', kind: 'dish', name: '炒河粉', aliases: ['干炒河粉'], per100g: { kcal: 171, carb: 22, protein: 5, fat: 7, fiber: 0.8, sodium: 720 }, unit: { name: '1 盘', grams: 350 } },
  { id: 'chao-mifen', kind: 'dish', name: '炒米粉', aliases: ['星洲炒米粉'], per100g: { kcal: 156, carb: 21, protein: 4.5, fat: 6, fiber: 1, sodium: 700 }, unit: { name: '1 盘', grams: 350 } },
  { id: 'chao-mian', kind: 'dish', name: '炒面', aliases: ['炒面条'], per100g: { kcal: 190, carb: 24, protein: 5.5, fat: 8, fiber: 1, sodium: 780 }, unit: { name: '1 盘', grams: 350 } },
  { id: 'ganchao-niuhe', kind: 'dish', name: '干炒牛河', aliases: ['炒牛河'], per100g: { kcal: 195, carb: 23, protein: 6.5, fat: 8.5, fiber: 0.8, sodium: 760 }, unit: { name: '1 盘', grams: 350 } },
  { id: 'banmian', kind: 'dish', name: '拌面', aliases: ['新疆拌面', '拉条子'], per100g: { kcal: 175, carb: 22, protein: 6, fat: 7, fiber: 1, sodium: 700 }, unit: { name: '1 盘', grams: 400 } },
  { id: 'lengmian', kind: 'dish', name: '冷面', aliases: ['朝鲜冷面'], per100g: { kcal: 105, carb: 16, protein: 4.5, fat: 2.5, fiber: 1, sodium: 640 }, unit: { name: '1 碗', grams: 600 } },
  { id: 'rousi-mian', kind: 'dish', name: '肉丝面', aliases: ['榨菜肉丝面'], per100g: { kcal: 125, carb: 15, protein: 6, fat: 4.5, fiber: 0.9, sodium: 680 }, unit: { name: '1 碗', grams: 600 } },
  { id: 'paigu-mian', kind: 'dish', name: '排骨面', aliases: [], per100g: { kcal: 138, carb: 16, protein: 6, fat: 5.5, fiber: 0.9, sodium: 700 }, unit: { name: '1 碗', grams: 600 } },
  { id: 'zimi-fan', kind: 'dish', name: '紫米饭', aliases: ['紫米'], per100g: { kcal: 115, carb: 25, protein: 2.8, fat: 0.4, fiber: 1, sodium: 2 }, unit: { name: '1 碗', grams: 200 } },
  { id: 'zaliang-fan', kind: 'dish', name: '杂粮饭', aliases: ['五谷饭'], per100g: { kcal: 117, carb: 24, protein: 3.5, fat: 0.8, fiber: 2, sodium: 3 }, unit: { name: '1 碗', grams: 200 } },
  { id: 'limai-fan', kind: 'dish', name: '藜麦饭', aliases: [], per100g: { kcal: 120, carb: 21, protein: 4.5, fat: 2, fiber: 2.5, sodium: 5 }, unit: { name: '1 碗', grams: 200 } },
  { id: 'qiaomai-mian', kind: 'dish', name: '荞麦面', aliases: ['荞麦面条'], per100g: { kcal: 111, carb: 21, protein: 5, fat: 0.8, fiber: 1.5, sodium: 400 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'huimian', kind: 'dish', name: '烩面', aliases: ['河南烩面'], per100g: { kcal: 119, carb: 14, protein: 5.5, fat: 4.5, fiber: 0.8, sodium: 680 }, unit: { name: '1 碗', grams: 700 } },
  { id: 'youpo-mian', kind: 'dish', name: '油泼面', aliases: ['陕西油泼面'], per100g: { kcal: 201, carb: 24, protein: 6, fat: 9, fiber: 1, sodium: 720 }, unit: { name: '1 碗', grams: 400 } },

  // —— 早餐（包子 / 馒头 / 粥 / 饼） ——
  { id: 'huntun', kind: 'dish', name: '馄饨', aliases: ['云吞', '抄手'], per100g: { kcal: 102, carb: 12, protein: 4.5, fat: 4, fiber: 0.6, sodium: 520 }, unit: { name: '1 个', grams: 15 } },
  { id: 'zhurou-baicai-baozi', kind: 'dish', name: '猪肉白菜包子', aliases: ['白菜包子', '猪肉包子'], per100g: { kcal: 206, carb: 26, protein: 7.5, fat: 8, fiber: 1.2, sodium: 520 }, unit: { name: '1 个', grams: 100 } },
  { id: 'niurou-baozi', kind: 'dish', name: '牛肉包子', aliases: ['牛肉包'], per100g: { kcal: 223, carb: 27, protein: 8.5, fat: 9, fiber: 1.2, sodium: 560 }, unit: { name: '1 个', grams: 100 } },
  { id: 'dousha-bao', kind: 'dish', name: '豆沙包', aliases: ['豆沙包子'], per100g: { kcal: 208, carb: 38, protein: 6, fat: 3.5, fiber: 1.5, sodium: 320 }, unit: { name: '1 个', grams: 80 } },
  { id: 'su-caibao', kind: 'dish', name: '素菜包', aliases: ['青菜包', '菜包子'], per100g: { kcal: 169, carb: 26, protein: 5, fat: 5, fiber: 1.6, sodium: 480 }, unit: { name: '1 个', grams: 80 } },
  { id: 'tangbao', kind: 'dish', name: '灌汤包', aliases: ['汤包'], per100g: { kcal: 209, carb: 24, protein: 8, fat: 9, fiber: 1, sodium: 600 }, unit: { name: '1 个', grams: 25 } },
  { id: 'shengjian-bao', kind: 'dish', name: '生煎包', aliases: ['生煎'], per100g: { kcal: 246, carb: 26, protein: 8.5, fat: 12, fiber: 0.8, sodium: 600 }, unit: { name: '1 个', grams: 40 } },
  { id: 'guotie', kind: 'dish', name: '锅贴', aliases: ['煎饺'], per100g: { kcal: 222, carb: 25, protein: 8, fat: 10, fiber: 1, sodium: 620 }, unit: { name: '1 个', grams: 25 } },
  { id: 'shaomai', kind: 'dish', name: '烧麦', aliases: ['烧卖'], per100g: { kcal: 212, carb: 28, protein: 7, fat: 8, fiber: 0.8, sodium: 560 }, unit: { name: '1 个', grams: 30 } },
  { id: 'changfen', kind: 'dish', name: '肠粉', aliases: ['广东肠粉'], per100g: { kcal: 112, carb: 14, protein: 5, fat: 4, fiber: 0.6, sodium: 520 }, unit: { name: '1 份', grams: 300 } },
  { id: 'luobogao', kind: 'dish', name: '萝卜糕', aliases: [], per100g: { kcal: 154, carb: 22, protein: 3, fat: 6, fiber: 1.2, sodium: 480 }, unit: { name: '1 份', grams: 150 } },
  { id: 'babao-zhou', kind: 'dish', name: '八宝粥', aliases: ['腊八粥'], per100g: { kcal: 97, carb: 19, protein: 3, fat: 1, fiber: 1.2, sodium: 60 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'nangua-zhou', kind: 'dish', name: '南瓜粥', aliases: [], per100g: { kcal: 59, carb: 12, protein: 1.5, fat: 0.6, fiber: 0.6, sodium: 30 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'hongzao-zhou', kind: 'dish', name: '红枣粥', aliases: [], per100g: { kcal: 63, carb: 13, protein: 1.6, fat: 0.5, fiber: 0.6, sodium: 30 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'shucai-zhou', kind: 'dish', name: '蔬菜粥', aliases: ['青菜粥'], per100g: { kcal: 54, carb: 10, protein: 1.8, fat: 0.8, fiber: 0.6, sodium: 300 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'yumi-zhou', kind: 'dish', name: '玉米粥', aliases: [], per100g: { kcal: 58, carb: 11, protein: 1.8, fat: 0.7, fiber: 0.8, sodium: 25 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'yanmai-zhou', kind: 'dish', name: '燕麦粥', aliases: [], per100g: { kcal: 68, carb: 11, protein: 2.5, fat: 1.6, fiber: 1.2, sodium: 40 }, unit: { name: '1 碗', grams: 350 } },
  { id: 'jidan-guanbing', kind: 'dish', name: '鸡蛋灌饼', aliases: ['灌饼'], per100g: { kcal: 201, carb: 23, protein: 7, fat: 9, fiber: 0.8, sodium: 540 }, unit: { name: '1 个', grams: 180 } },
  { id: 'roujiamo', kind: 'dish', name: '肉夹馍', aliases: ['腊汁肉夹馍'], per100g: { kcal: 246, carb: 30, protein: 9, fat: 10, fiber: 0.8, sodium: 620 }, unit: { name: '1 个', grams: 180 } },
  { id: 'tangyuan', kind: 'dish', name: '汤圆', aliases: ['元宵'], per100g: { kcal: 188, carb: 30, protein: 3.5, fat: 6, fiber: 0.6, sodium: 40 }, unit: { name: '1 个', grams: 20 } },
  { id: 'zhengjiao', kind: 'dish', name: '蒸饺', aliases: ['蒸饺子'], per100g: { kcal: 180, carb: 24, protein: 7.5, fat: 6, fiber: 0.9, sodium: 520 }, unit: { name: '1 个', grams: 25 } },
  { id: 'xianbing', kind: 'dish', name: '馅饼', aliases: ['肉馅饼'], per100g: { kcal: 215, carb: 26, protein: 7.5, fat: 9, fiber: 0.8, sodium: 560 }, unit: { name: '1 个', grams: 150 } },
  { id: 'shouzhuabing', kind: 'dish', name: '手抓饼', aliases: ['千层饼'], per100g: { kcal: 252, carb: 30, protein: 6, fat: 12, fiber: 0.8, sodium: 520 }, unit: { name: '1 张', grams: 120 } },
  { id: 'congyoubing', kind: 'dish', name: '葱油饼', aliases: [], per100g: { kcal: 271, carb: 32, protein: 6.5, fat: 13, fiber: 0.8, sodium: 520 }, unit: { name: '1 张', grams: 120 } },
  { id: 'jidanbing', kind: 'dish', name: '鸡蛋饼', aliases: [], per100g: { kcal: 200, carb: 25, protein: 7, fat: 8, fiber: 0.6, sodium: 420 }, unit: { name: '1 张', grams: 150 } },

  // —— 外卖快餐 / 小吃 ——
  { id: 'zhajitui', kind: 'dish', name: '炸鸡腿', aliases: ['炸鸡腿块'], per100g: { kcal: 320, carb: 26, protein: 18, fat: 16, fiber: 0.5, sodium: 700 }, unit: { name: '1 个', grams: 120 } },
  { id: 'jimihua', kind: 'dish', name: '鸡米花', aliases: [], per100g: { kcal: 299, carb: 26, protein: 15, fat: 15, fiber: 0.6, sodium: 720 }, unit: { name: '1 份', grams: 100 } },
  { id: 'mala-xiangguo', kind: 'dish', name: '麻辣香锅', aliases: ['香锅'], per100g: { kcal: 222, carb: 12, protein: 7.5, fat: 16, fiber: 1.8, sodium: 900 }, unit: { name: '1 份', grams: 400 } },
  { id: 'guandongzhu', kind: 'dish', name: '关东煮', aliases: ['关东煮串'], per100g: { kcal: 88, carb: 8, protein: 5, fat: 4, fiber: 0.8, sodium: 800 }, unit: { name: '1 份', grams: 300 } },
  { id: 'danta', kind: 'dish', name: '蛋挞', aliases: ['蛋塔'], per100g: { kcal: 267, carb: 28, protein: 5, fat: 15, fiber: 0.5, sodium: 200 }, unit: { name: '1 个', grams: 60 } },
  { id: 'zhangyu-wanzi', kind: 'dish', name: '章鱼小丸子', aliases: ['章鱼烧'], per100g: { kcal: 177, carb: 18, protein: 6, fat: 9, fiber: 0.6, sodium: 600 }, unit: { name: '1 份', grams: 150 } },
  { id: 'mala-ban', kind: 'dish', name: '麻辣拌', aliases: [], per100g: { kcal: 172, carb: 10, protein: 6, fat: 12, fiber: 1.5, sodium: 900 }, unit: { name: '1 份', grams: 350 } },
  { id: 'shaguo-mixian', kind: 'dish', name: '砂锅米线', aliases: ['砂锅粉'], per100g: { kcal: 119, carb: 14, protein: 5.5, fat: 4.5, fiber: 1, sodium: 700 }, unit: { name: '1 份', grams: 600 } },
  { id: 'huoguo', kind: 'dish', name: '麻辣火锅', aliases: ['火锅'], per100g: { kcal: 164, carb: 6, protein: 8, fat: 12, fiber: 1.5, sodium: 800 }, unit: { name: '1 份', grams: 500 } },
  { id: 'chuanchuanxiang', kind: 'dish', name: '串串香', aliases: ['钵钵鸡'], per100g: { kcal: 173, carb: 7, protein: 7, fat: 13, fiber: 1.5, sodium: 900 }, unit: { name: '1 份', grams: 400 } },
  { id: 'suantang-feiniu', kind: 'dish', name: '酸汤肥牛', aliases: ['金汤肥牛'], per100g: { kcal: 154, carb: 4, protein: 12, fat: 10, fiber: 0.8, sodium: 760 }, unit: { name: '1 份', grams: 400 } },
  { id: 'zha-jipai', kind: 'dish', name: '炸鸡排', aliases: ['鸡排'], per100g: { kcal: 330, carb: 25, protein: 17, fat: 18, fiber: 0.6, sodium: 780 }, unit: { name: '1 份', grams: 150 } },
  { id: 'jirou-juan', kind: 'dish', name: '鸡肉卷', aliases: ['老北京鸡肉卷'], per100g: { kcal: 221, carb: 24, protein: 11, fat: 9, fiber: 0.8, sodium: 620 }, unit: { name: '1 个', grams: 150 } },
  { id: 'xiajiao', kind: 'dish', name: '虾饺', aliases: ['水晶虾饺'], per100g: { kcal: 148, carb: 20, protein: 8, fat: 4, fiber: 0.6, sodium: 520 }, unit: { name: '1 个', grams: 25 } },
  { id: 'nuomiji', kind: 'dish', name: '糯米鸡', aliases: [], per100g: { kcal: 200, carb: 26, protein: 6, fat: 8, fiber: 0.8, sodium: 560 }, unit: { name: '1 个', grams: 150 } },
  { id: 'chashao-bao', kind: 'dish', name: '叉烧包', aliases: [], per100g: { kcal: 219, carb: 32, protein: 7, fat: 7, fiber: 1, sodium: 480 }, unit: { name: '1 个', grams: 80 } },
  { id: 'liangmian', kind: 'dish', name: '凉面', aliases: ['麻酱凉面'], per100g: { kcal: 154, carb: 20, protein: 5, fat: 6, fiber: 1, sodium: 640 }, unit: { name: '1 份', grams: 300 } },
  { id: 'gali-yudan', kind: 'dish', name: '咖喱鱼蛋', aliases: ['鱼蛋'], per100g: { kcal: 160, carb: 15, protein: 7, fat: 8, fiber: 0.5, sodium: 700 }, unit: { name: '1 份', grams: 150 } },
  { id: 'chao-niangao', kind: 'dish', name: '炒年糕', aliases: ['辣炒年糕'], per100g: { kcal: 170, carb: 26, protein: 3, fat: 6, fiber: 0.8, sodium: 520 }, unit: { name: '1 份', grams: 250 } },
  { id: 'kao-lengmian', kind: 'dish', name: '烤冷面', aliases: ['东北烤冷面'], per100g: { kcal: 192, carb: 24, protein: 6, fat: 8, fiber: 0.8, sodium: 620 }, unit: { name: '1 份', grams: 200 } },

  // —— 卤味 / 烧烤 ——
  { id: 'jiang-niurou', kind: 'dish', name: '酱牛肉', aliases: ['卤牛肉'], per100g: { kcal: 172, carb: 3, protein: 22, fat: 8, fiber: 0.2, sodium: 800 }, unit: { name: '1 盘', grams: 150 } },
  { id: 'lu-jizhua', kind: 'dish', name: '卤鸡爪', aliases: ['卤凤爪'], per100g: { kcal: 235, carb: 3, protein: 22, fat: 15, fiber: 0.2, sodium: 900 }, unit: { name: '1 份', grams: 150 } },
  { id: 'lu-yabo', kind: 'dish', name: '卤鸭脖', aliases: ['鸭脖'], per100g: { kcal: 204, carb: 4, protein: 20, fat: 12, fiber: 0.2, sodium: 900 }, unit: { name: '1 份', grams: 150 } },
  { id: 'lu-zhuer', kind: 'dish', name: '卤猪耳', aliases: ['猪耳朵'], per100g: { kcal: 286, carb: 2, protein: 20, fat: 22, fiber: 0.1, sodium: 800 }, unit: { name: '1 盘', grams: 150 } },
  { id: 'lu-zhugan', kind: 'dish', name: '卤猪肝', aliases: ['卤肝'], per100g: { kcal: 154, carb: 5, protein: 20, fat: 6, fiber: 0.2, sodium: 700 }, unit: { name: '1 盘', grams: 150 } },
  { id: 'lu-doufugan', kind: 'dish', name: '卤豆腐干', aliases: ['卤香干'], per100g: { kcal: 137, carb: 7, protein: 16, fat: 5, fiber: 0.8, sodium: 800 }, unit: { name: '1 盘', grams: 150 } },
  { id: 'jiang-ya', kind: 'dish', name: '酱鸭', aliases: [], per100g: { kcal: 242, carb: 4, protein: 16, fat: 18, fiber: 0.2, sodium: 760 }, unit: { name: '1 盘', grams: 150 } },
  { id: 'chashao', kind: 'dish', name: '叉烧', aliases: ['蜜汁叉烧'], per100g: { kcal: 201, carb: 12, protein: 18, fat: 9, fiber: 0.3, sodium: 700 }, unit: { name: '1 盘', grams: 150 } },
  { id: 'yangrou-chuan', kind: 'dish', name: '羊肉串', aliases: ['烤羊肉串'], per100g: { kcal: 188, carb: 3, protein: 17, fat: 12, fiber: 0.4, sodium: 800 }, unit: { name: '1 串', grams: 60 } },
  { id: 'kao-jichi', kind: 'dish', name: '烤鸡翅', aliases: ['奥尔良鸡翅'], per100g: { kcal: 222, carb: 9, protein: 15, fat: 14, fiber: 0.3, sodium: 800 }, unit: { name: '1 个', grams: 50 } },
  { id: 'kao-wuhuarou', kind: 'dish', name: '烤五花肉', aliases: ['韩式烤肉'], per100g: { kcal: 308, carb: 3, protein: 11, fat: 28, fiber: 0.2, sodium: 700 }, unit: { name: '1 份', grams: 150 } },
  { id: 'kao-jiucai', kind: 'dish', name: '烤韭菜', aliases: ['烤韭菜串'], per100g: { kcal: 82, carb: 5, protein: 2, fat: 6, fiber: 1.8, sodium: 600 }, unit: { name: '1 份', grams: 100 } },
  { id: 'kao-qiezi', kind: 'dish', name: '烤茄子', aliases: ['蒜蓉烤茄子'], per100g: { kcal: 112, carb: 8, protein: 2, fat: 8, fiber: 1.4, sodium: 600 }, unit: { name: '1 份', grams: 200 } },
  { id: 'kao-shenghao', kind: 'dish', name: '烤生蚝', aliases: ['蒜蓉生蚝'], per100g: { kcal: 106, carb: 4, protein: 9, fat: 6, fiber: 0.4, sodium: 700 }, unit: { name: '1 份', grams: 200 } },
  { id: 'kao-yumi', kind: 'dish', name: '烤玉米', aliases: ['烤玉米棒'], per100g: { kcal: 88, carb: 14, protein: 3.5, fat: 2, fiber: 2, sodium: 200 }, unit: { name: '1 根', grams: 200 } },
  { id: 'tieban-youyu', kind: 'dish', name: '铁板鱿鱼', aliases: ['烤鱿鱼'], per100g: { kcal: 148, carb: 4, protein: 15, fat: 8, fiber: 0.4, sodium: 800 }, unit: { name: '1 份', grams: 200 } },
  { id: 'kao-yu', kind: 'dish', name: '烤鱼', aliases: ['万州烤鱼'], per100g: { kcal: 180, carb: 4, protein: 14, fat: 12, fiber: 0.6, sodium: 800 }, unit: { name: '1 份', grams: 400 } },

  // —— 补充常见原料与调味 ——
  { id: 'zhurou-paigu', kind: 'ingredient', name: '排骨', aliases: ['猪排骨', '小排'], per100g: { kcal: 202, carb: 1, protein: 18, fat: 14, fiber: 0, sodium: 60 } },
  { id: 'zhuti', kind: 'ingredient', name: '猪蹄', aliases: ['猪脚'], per100g: { kcal: 258, carb: 2, protein: 22, fat: 18, fiber: 0, sodium: 100 } },
  { id: 'niujianzi', kind: 'ingredient', name: '牛腱子', aliases: ['牛腱'], per100g: { kcal: 135, carb: 1.5, protein: 21, fat: 5, fiber: 0, sodium: 70 } },
  { id: 'zhuliji', kind: 'ingredient', name: '猪里脊', aliases: ['里脊肉'], per100g: { kcal: 138, carb: 1.5, protein: 20.5, fat: 5.5, fiber: 0, sodium: 55 } },
  { id: 'yangroupian', kind: 'ingredient', name: '羊肉片', aliases: ['涮羊肉'], per100g: { kcal: 150, carb: 0.5, protein: 19, fat: 8, fiber: 0, sodium: 80 } },
  { id: 'jizhen', kind: 'ingredient', name: '鸡胗', aliases: ['鸡肫'], per100g: { kcal: 116, carb: 2, protein: 19, fat: 3.5, fiber: 0, sodium: 250 } },
  { id: 'zhudu', kind: 'ingredient', name: '猪肚', aliases: [], per100g: { kcal: 117, carb: 3, protein: 15, fat: 5, fiber: 0, sodium: 200 } },
  { id: 'yaxue', kind: 'ingredient', name: '鸭血', aliases: ['血豆腐'], per100g: { kcal: 60, carb: 1, protein: 13, fat: 0.4, fiber: 0, sodium: 170 } },
  { id: 'huanghuayu', kind: 'ingredient', name: '黄花鱼', aliases: ['黄鱼'], per100g: { kcal: 95, carb: 0.5, protein: 17.5, fat: 2.5, fiber: 0, sodium: 120 } },
  { id: 'jiyu', kind: 'ingredient', name: '鲫鱼', aliases: [], per100g: { kcal: 94, carb: 0.5, protein: 17, fat: 2.7, fiber: 0, sodium: 40 } },
  { id: 'longliyu', kind: 'ingredient', name: '龙利鱼', aliases: ['巴沙鱼'], per100g: { kcal: 76, carb: 0.5, protein: 15, fat: 1.5, fiber: 0, sodium: 90 } },
  { id: 'xueyu', kind: 'ingredient', name: '鳕鱼', aliases: [], per100g: { kcal: 79, carb: 0.5, protein: 18, fat: 0.5, fiber: 0, sodium: 130 } },
  { id: 'shanbei', kind: 'ingredient', name: '扇贝', aliases: ['扇贝肉'], per100g: { kcal: 61, carb: 3, protein: 11, fat: 0.6, fiber: 0, sodium: 340 } },
  { id: 'shenghao', kind: 'ingredient', name: '生蚝', aliases: ['牡蛎'], per100g: { kcal: 70, carb: 4, protein: 10, fat: 1.5, fiber: 0, sodium: 460 } },
  { id: 'pangxie', kind: 'ingredient', name: '螃蟹', aliases: ['河蟹'], per100g: { kcal: 108, carb: 0.5, protein: 17.5, fat: 4, fiber: 0, sodium: 200 } },
  { id: 'anchundan', kind: 'ingredient', name: '鹌鹑蛋', aliases: [], per100g: { kcal: 157, carb: 1.5, protein: 13, fat: 11, fiber: 0, sodium: 100 }, unit: { name: '1 个', grams: 10 } },
  { id: 'youdoufu', kind: 'ingredient', name: '油豆腐', aliases: ['豆腐泡'], per100g: { kcal: 217, carb: 6.5, protein: 14, fat: 15, fiber: 0.3, sodium: 20 } },
  { id: 'wandou', kind: 'ingredient', name: '豌豆', aliases: ['青豌豆'], per100g: { kcal: 81, carb: 14, protein: 5.5, fat: 0.3, fiber: 3, sodium: 3 } },
  { id: 'sijidou', kind: 'ingredient', name: '四季豆', aliases: ['豆角', '芸豆'], per100g: { kcal: 66, carb: 13.5, protein: 2.5, fat: 0.2, fiber: 2, sodium: 5 } },
  { id: 'tonghao', kind: 'ingredient', name: '茼蒿', aliases: [], per100g: { kcal: 21, carb: 2.7, protein: 1.9, fat: 0.3, fiber: 1.2, sodium: 160 } },
  { id: 'youmaicai', kind: 'ingredient', name: '油麦菜', aliases: [], per100g: { kcal: 18, carb: 2.1, protein: 1.4, fat: 0.4, fiber: 0.6, sodium: 80 } },
  { id: 'lusun', kind: 'ingredient', name: '芦笋', aliases: [], per100g: { kcal: 23, carb: 4, protein: 1.4, fat: 0.1, fiber: 2, sodium: 3 } },
  { id: 'helandou', kind: 'ingredient', name: '荷兰豆', aliases: [], per100g: { kcal: 42, carb: 7.5, protein: 2.5, fat: 0.2, fiber: 2.6, sodium: 4 } },
  { id: 'wawacai', kind: 'ingredient', name: '娃娃菜', aliases: [], per100g: { kcal: 20, carb: 3, protein: 1.6, fat: 0.2, fiber: 0.9, sodium: 130 } },
  { id: 'kongxincai', kind: 'ingredient', name: '空心菜', aliases: ['通菜'], per100g: { kcal: 23, carb: 3, protein: 2.2, fat: 0.2, fiber: 1.4, sodium: 94 } },
  { id: 'xihulu', kind: 'ingredient', name: '西葫芦', aliases: ['角瓜'], per100g: { kcal: 20, carb: 3.8, protein: 0.8, fat: 0.2, fiber: 0.6, sodium: 6 } },
  { id: 'sigua', kind: 'ingredient', name: '丝瓜', aliases: [], per100g: { kcal: 23, carb: 4.2, protein: 1, fat: 0.2, fiber: 0.6, sodium: 3 } },
  { id: 'pinggu', kind: 'ingredient', name: '平菇', aliases: [], per100g: { kcal: 28, carb: 4.5, protein: 1.9, fat: 0.3, fiber: 2.3, sodium: 5 } },
  { id: 'koumo', kind: 'ingredient', name: '口蘑', aliases: ['白蘑菇'], per100g: { kcal: 30, carb: 4, protein: 2.7, fat: 0.3, fiber: 2.1, sodium: 5 } },
  { id: 'yiner', kind: 'ingredient', name: '银耳', aliases: [], per100g: { kcal: 37, carb: 8, protein: 1, fat: 0.1, fiber: 2.6, sodium: 20 } },
  { id: 'hongdou', kind: 'ingredient', name: '红豆', aliases: ['赤小豆'], per100g: { kcal: 115, carb: 20, protein: 7.5, fat: 0.6, fiber: 7.5, sodium: 3 } },
  { id: 'lvdou', kind: 'ingredient', name: '绿豆', aliases: [], per100g: { kcal: 119, carb: 21, protein: 7, fat: 0.8, fiber: 6.4, sodium: 3 } },
  { id: 'dami', kind: 'ingredient', name: '大米', aliases: ['粳米', '生米'], per100g: { kcal: 341, carb: 77, protein: 7, fat: 0.6, fiber: 0.4, sodium: 2 } },
  { id: 'mianfen', kind: 'ingredient', name: '面粉', aliases: ['小麦粉'], per100g: { kcal: 347, carb: 74, protein: 10, fat: 1.2, fiber: 0.7, sodium: 2 } },
  { id: 'dianfen', kind: 'ingredient', name: '淀粉', aliases: ['玉米淀粉'], per100g: { kcal: 343, carb: 85, protein: 0.5, fat: 0.1, fiber: 0, sodium: 5 } },
  { id: 'bingtang', kind: 'ingredient', name: '冰糖', aliases: [], per100g: { kcal: 396, carb: 99, protein: 0, fat: 0, fiber: 0, sodium: 2 } },
  { id: 'haoyou', kind: 'ingredient', name: '蚝油', aliases: [], per100g: { kcal: 92, carb: 20, protein: 2.5, fat: 0.2, fiber: 0, sodium: 3000 }, unit: { name: '1 勺', grams: 15 } },
  { id: 'doubanjiang', kind: 'ingredient', name: '豆瓣酱', aliases: ['郫县豆瓣'], per100g: { kcal: 95, carb: 12, protein: 5, fat: 3, fiber: 2, sodium: 3500 }, unit: { name: '1 勺', grams: 15 } },
  { id: 'lajiajiang', kind: 'ingredient', name: '辣椒酱', aliases: ['老干妈'], per100g: { kcal: 118, carb: 10, protein: 1.5, fat: 8, fiber: 2, sodium: 3000 }, unit: { name: '1 勺', grams: 15 } },
  { id: 'xiangyou', kind: 'ingredient', name: '香油', aliases: ['芝麻油'], per100g: { kcal: 893, carb: 0.5, protein: 0, fat: 99, fiber: 0, sodium: 10 }, unit: { name: '1 勺', grams: 10 } },
  { id: 'liaojiu', kind: 'ingredient', name: '料酒', aliases: [], per100g: { kcal: 23, carb: 5, protein: 0.5, fat: 0.1, fiber: 0, sodium: 800 }, unit: { name: '1 勺', grams: 15 } },
  { id: 'doufurui', kind: 'ingredient', name: '豆腐乳', aliases: ['腐乳'], per100g: { kcal: 120, carb: 3, protein: 9, fat: 8, fiber: 0, sodium: 2000 }, unit: { name: '1 块', grams: 15 } },
  { id: 'xiapi', kind: 'ingredient', name: '虾皮', aliases: [], per100g: { kcal: 153, carb: 2.5, protein: 30, fat: 2.5, fiber: 0, sodium: 5000 }, unit: { name: '1 勺', grams: 5 } },
  { id: 'heimi', kind: 'ingredient', name: '黑米', aliases: [], per100g: { kcal: 359, carb: 75, protein: 9, fat: 2.5, fiber: 3, sodium: 3 } },
  { id: 'xiaomi', kind: 'ingredient', name: '小米', aliases: ['黄小米'], per100g: { kcal: 364, carb: 75, protein: 9, fat: 3.1, fiber: 1.6, sodium: 5 } },
  { id: 'ningmeng', kind: 'ingredient', name: '柠檬', aliases: [], per100g: { kcal: 32, carb: 6.2, protein: 1.1, fat: 0.3, fiber: 1.3, sodium: 1 }, unit: { name: '1 个', grams: 100 } },
  { id: 'hamigua', kind: 'ingredient', name: '哈密瓜', aliases: [], per100g: { kcal: 35, carb: 7.9, protein: 0.5, fat: 0.1, fiber: 0.2, sodium: 27 }, unit: { name: '1 块', grams: 150 } },
  { id: 'shiliu', kind: 'ingredient', name: '石榴', aliases: [], per100g: { kcal: 61, carb: 13.5, protein: 1.4, fat: 0.2, fiber: 4.8, sodium: 1 }, unit: { name: '1 个', grams: 200 } },
  { id: 'ziganlan', kind: 'ingredient', name: '紫甘蓝', aliases: ['紫包菜'], per100g: { kcal: 31, carb: 6, protein: 1.2, fat: 0.2, fiber: 2, sodium: 30 } },
  { id: 'fanqiejiang', kind: 'ingredient', name: '番茄酱', aliases: ['番茄沙司'], per100g: { kcal: 71, carb: 16, protein: 1.2, fat: 0.2, fiber: 1, sodium: 900 }, unit: { name: '1 勺', grams: 15 } },

  // —— v1.6 高粒度：部位 × 去皮 × 生熟（鸡 / 猪 / 牛 / 羊 / 水产） ——
  // 命名约定：括号里写清「带皮/去皮」「生/熟」，生熟两条都存在时用户才能按自己的称重口径选。
  { id: 'chicken-breast-raw', kind: 'ingredient', name: '鸡胸肉（生）', aliases: ['生鸡胸肉', '鸡胸肉生'], part: '胸', skin: 'off', state: 'raw', per100g: { kcal: 118, carb: 1.0, protein: 23.0, fat: 1.9, fiber: 0, sodium: 45 }, units: [{ name: '1 块（手掌大）', grams: 120 }, { name: '1 袋（冷冻装）', grams: 500 }] },
  { id: 'chicken-breast-cooked', kind: 'ingredient', name: '鸡胸肉（熟）', aliases: ['熟鸡胸肉', '水煮鸡胸（熟）'], part: '胸', skin: 'off', state: 'cooked', per100g: { kcal: 165, carb: 0, protein: 31.0, fat: 3.6, fiber: 0, sodium: 55 }, units: [{ name: '1 块（熟）', grams: 100 }, { name: '1 碗（撕丝）', grams: 150 }] },
  { id: 'chicken-breast-boiled', kind: 'dish', name: '水煮鸡胸肉', aliases: ['水煮鸡胸', '白水煮鸡胸'], part: '胸', skin: 'off', state: 'cooked', per100g: { kcal: 150, carb: 0, protein: 28.0, fat: 3.3, fiber: 0, sodium: 60 }, units: [{ name: '1 块', grams: 100 }, { name: '1 盘', grams: 200 }] },
  { id: 'chicken-breast-instant', kind: 'dish', name: '即食鸡胸肉（原味）', aliases: ['即食鸡胸', '包装鸡胸肉'], part: '胸', skin: 'off', state: 'cooked', per100g: { kcal: 110, carb: 2.5, protein: 21.0, fat: 1.5, fiber: 0.5, sodium: 600 }, units: [{ name: '1 袋', grams: 100 }, { name: '1 片', grams: 50 }] },
  { id: 'chicken-breast-pan', kind: 'dish', name: '香煎鸡胸肉（少油）', aliases: ['煎鸡胸肉', '鸡胸肉（煎）'], part: '胸', skin: 'off', state: 'cooked', per100g: { kcal: 175, carb: 1.0, protein: 27.0, fat: 6.5, fiber: 0, sodium: 420 }, units: [{ name: '1 块', grams: 110 }, { name: '1 盘', grams: 200 }] },
  { id: 'chicken-breast-roast', kind: 'dish', name: '鸡胸肉（烤，无油）', aliases: ['烤鸡胸肉', '鸡胸肉（烤）'], part: '胸', skin: 'off', state: 'cooked', per100g: { kcal: 165, carb: 0, protein: 31.0, fat: 3.6, fiber: 0, sodium: 70 }, units: [{ name: '1 块', grams: 100 }, { name: '1 盘', grams: 180 }] },
  { id: 'chicken-leg-skin-on-raw', kind: 'ingredient', name: '鸡腿（带皮，生）', aliases: ['带皮鸡腿', '鸡腿带皮', '鸡腿肉（带皮）'], part: '腿', skin: 'on', state: 'raw', per100g: { kcal: 181, carb: 0, protein: 20.0, fat: 11.0, fiber: 0, sodium: 70 }, units: [{ name: '1 只（带骨）', grams: 120 }, { name: '1 只（去骨）', grams: 90 }] },
  { id: 'chicken-leg-skin-off-raw', kind: 'ingredient', name: '鸡腿（去皮，生）', aliases: ['去皮鸡腿', '鸡腿去皮', '无皮鸡腿', '鸡腿肉去皮', '去皮鸡腿肉'], part: '腿', skin: 'off', state: 'raw', per100g: { kcal: 120, carb: 0, protein: 19.5, fat: 4.2, fiber: 0, sodium: 75 }, units: [{ name: '1 只（去皮，去骨）', grams: 90 }, { name: '1 只（带骨）', grams: 110 }] },
  { id: 'chicken-leg-skin-on-cooked', kind: 'ingredient', name: '鸡腿（带皮，熟）', aliases: ['带皮鸡腿（熟）', '熟鸡腿（带皮）'], part: '腿', skin: 'on', state: 'cooked', per100g: { kcal: 208, carb: 0, protein: 25.0, fat: 11.5, fiber: 0, sodium: 80 }, units: [{ name: '1 只（带骨）', grams: 110 }, { name: '1 只（去骨）', grams: 85 }] },
  { id: 'chicken-leg-skin-off-cooked', kind: 'ingredient', name: '鸡腿（去皮，熟）', aliases: ['去皮鸡腿（熟）', '熟鸡腿（去皮）', '去皮鸡腿肉（熟）'], part: '腿', skin: 'off', state: 'cooked', per100g: { kcal: 165, carb: 0, protein: 26.5, fat: 5.6, fiber: 0, sodium: 85 }, units: [{ name: '1 只（去皮，去骨）', grams: 85 }, { name: '1 只（带骨）', grams: 100 }] },
  { id: 'chicken-leg-skin-off-pan', kind: 'dish', name: '鸡腿（去皮，煎）', aliases: ['煎去皮鸡腿', '去皮鸡腿（煎）'], part: '腿', skin: 'off', state: 'cooked', per100g: { kcal: 180, carb: 1.0, protein: 27.0, fat: 7.0, fiber: 0, sodium: 400 }, units: [{ name: '1 只', grams: 85 }] },
  { id: 'chicken-wing-skin-on-raw', kind: 'ingredient', name: '鸡翅（带皮，生）', aliases: ['带皮鸡翅', '鸡翅中生'], part: '翅', skin: 'on', state: 'raw', per100g: { kcal: 194, carb: 0.6, protein: 19.0, fat: 12.7, fiber: 0, sodium: 80 }, units: [{ name: '1 个（翅中）', grams: 40 }, { name: '1 个（翅根）', grams: 50 }] },
  { id: 'chicken-wing-skin-off-raw', kind: 'ingredient', name: '鸡翅（去皮，生）', aliases: ['去皮鸡翅', '无皮鸡翅'], part: '翅', skin: 'off', state: 'raw', per100g: { kcal: 126, carb: 0, protein: 21.0, fat: 4.5, fiber: 0, sodium: 85 }, units: [{ name: '1 个（去皮）', grams: 35 }] },
  { id: 'chicken-wing-skin-on-cooked', kind: 'ingredient', name: '鸡翅（带皮，熟）', aliases: ['带皮鸡翅（熟）', '熟鸡翅（带皮）'], part: '翅', skin: 'on', state: 'cooked', per100g: { kcal: 248, carb: 0.5, protein: 23.0, fat: 16.5, fiber: 0, sodium: 120 }, units: [{ name: '1 个（烤）', grams: 45 }, { name: '1 盘（6 个）', grams: 270 }] },
  { id: 'chicken-skin', kind: 'ingredient', name: '鸡皮', aliases: ['鸡皮（熟）', '炸鸡皮'], part: '皮', skin: 'on', state: 'cooked', per100g: { kcal: 349, carb: 0, protein: 14.0, fat: 32.0, fiber: 0, sodium: 70 }, units: [{ name: '1 块', grams: 30 }, { name: '1 把', grams: 50 }] },
  { id: 'chicken-feet-cooked', kind: 'ingredient', name: '鸡爪（煮熟，去骨）', aliases: ['熟鸡爪', '白煮鸡爪'], part: '爪', state: 'cooked', per100g: { kcal: 215, carb: 0.5, protein: 23.9, fat: 13.5, fiber: 0, sodium: 160 }, units: [{ name: '1 只', grams: 35 }, { name: '1 盘', grams: 150 }] },
  { id: 'chicken-liver', kind: 'ingredient', name: '鸡肝', aliases: ['鸡肝（生）'], part: '肝', state: 'raw', per100g: { kcal: 121, carb: 2.8, protein: 16.6, fat: 4.8, fiber: 0, sodium: 90 }, units: [{ name: '1 副', grams: 50 }, { name: '1 个', grams: 40 }] },
  { id: 'chicken-heart', kind: 'ingredient', name: '鸡心', aliases: ['鸡心（生）'], part: '心', state: 'raw', per100g: { kcal: 172, carb: 0.6, protein: 15.9, fat: 11.8, fiber: 0, sodium: 150 }, units: [{ name: '1 个', grams: 10 }, { name: '1 把', grams: 50 }] },
  { id: 'roast-chicken-leg', kind: 'dish', name: '烤鸡腿（带皮）', aliases: ['鸡腿（烤）', '烤鸡腿'], part: '腿', skin: 'on', state: 'cooked', per100g: { kcal: 216, carb: 1.5, protein: 22.0, fat: 13.0, fiber: 0, sodium: 520 }, units: [{ name: '1 只', grams: 120 }, { name: '1 盘', grams: 240 }] },
  { id: 'roast-chicken', kind: 'dish', name: '烤鸡（带皮）', aliases: ['烤鸡', '烧鸡（带皮）'], part: '整鸡', skin: 'on', state: 'cooked', per100g: { kcal: 215, carb: 1.0, protein: 24.0, fat: 12.5, fiber: 0, sodium: 480 }, units: [{ name: '1 只（小）', grams: 800 }, { name: '1 块', grams: 100 }] },
  { id: 'duck-breast', kind: 'ingredient', name: '鸭胸（去皮）', aliases: ['去皮鸭胸', '鸭胸肉'], part: '胸', skin: 'off', state: 'raw', per100g: { kcal: 140, carb: 0, protein: 20.0, fat: 6.5, fiber: 0, sodium: 60 }, units: [{ name: '1 块', grams: 150 }] },
  { id: 'duck-egg', kind: 'ingredient', name: '鸭蛋', aliases: ['鸭蛋（生）'], state: 'raw', per100g: { kcal: 180, carb: 3.1, protein: 12.6, fat: 13.0, fiber: 0, sodium: 106 }, units: [{ name: '1 个', grams: 70 }] },
  { id: 'pork-hind-leg-lean-raw', kind: 'ingredient', name: '猪后腿瘦肉（生）', aliases: ['后腿瘦肉', '猪腿肉（瘦）'], part: '后腿', state: 'raw', per100g: { kcal: 143, carb: 1.5, protein: 20.3, fat: 6.2, fiber: 0, sodium: 60 }, units: [{ name: '1 块', grams: 100 }, { name: '1 斤', grams: 500 }] },
  { id: 'pork-hind-leg-lean-cooked', kind: 'ingredient', name: '猪后腿瘦肉（熟）', aliases: ['后腿瘦肉（熟）'], part: '后腿', state: 'cooked', per100g: { kcal: 190, carb: 0, protein: 27.5, fat: 8.0, fiber: 0, sodium: 65 }, units: [{ name: '1 块', grams: 85 }, { name: '1 碗（肉丝）', grams: 120 }] },
  { id: 'pork-tenderloin-raw', kind: 'ingredient', name: '猪里脊（生）', aliases: ['生里脊肉', '里脊肉（生）'], part: '里脊', state: 'raw', per100g: { kcal: 138, carb: 1.5, protein: 20.5, fat: 5.5, fiber: 0, sodium: 55 }, units: [{ name: '1 块', grams: 100 }, { name: '1 盘（肉片）', grams: 150 }] },
  { id: 'pork-tenderloin-cooked', kind: 'ingredient', name: '猪里脊（熟）', aliases: ['熟猪里脊', '里脊肉（熟）'], part: '里脊', state: 'cooked', per100g: { kcal: 187, carb: 0, protein: 28.5, fat: 7.5, fiber: 0, sodium: 60 }, units: [{ name: '1 块', grams: 80 }, { name: '1 盘（肉片）', grams: 150 }] },
  { id: 'pork-belly-raw', kind: 'ingredient', name: '五花肉（生）', aliases: ['带皮五花肉', '五花肉生'], part: '五花', skin: 'on', state: 'raw', per100g: { kcal: 518, carb: 0, protein: 9.3, fat: 53.0, fiber: 0, sodium: 55 }, units: [{ name: '1 块', grams: 50 }, { name: '1 片（回锅肉）', grams: 15 }] },
  { id: 'pork-belly-cooked', kind: 'ingredient', name: '五花肉（熟）', aliases: ['熟五花肉', '五花肉（煮）'], part: '五花', skin: 'on', state: 'cooked', per100g: { kcal: 545, carb: 0, protein: 11.0, fat: 52.0, fiber: 0, sodium: 60 }, units: [{ name: '1 片（熟）', grams: 15 }, { name: '1 块', grams: 50 }] },
  { id: 'pork-trotter-cooked', kind: 'ingredient', name: '猪蹄（熟，去骨）', aliases: ['熟猪蹄', '猪脚（熟）'], part: '蹄', state: 'cooked', per100g: { kcal: 260, carb: 0, protein: 26.0, fat: 17.0, fiber: 0, sodium: 90 }, units: [{ name: '1 只', grams: 200 }, { name: '1 块', grams: 80 }] },
  { id: 'pork-liver-cooked', kind: 'ingredient', name: '猪肝（熟）', aliases: ['熟猪肝', '猪肝（煮）'], part: '肝', state: 'cooked', per100g: { kcal: 150, carb: 3.0, protein: 26.0, fat: 4.5, fiber: 0, sodium: 80 }, units: [{ name: '1 片', grams: 20 }, { name: '1 盘', grams: 150 }] },
  { id: 'pork-ribs-cooked', kind: 'ingredient', name: '排骨（熟）', aliases: ['熟排骨', '猪排骨（熟）'], part: '肋排', state: 'cooked', per100g: { kcal: 278, carb: 0, protein: 24.0, fat: 20.0, fiber: 0, sodium: 70 }, units: [{ name: '1 块', grams: 40 }, { name: '1 盘', grams: 200 }] },
  { id: 'pork-mince-lean', kind: 'ingredient', name: '猪肉馅（瘦）', aliases: ['瘦肉馅', '猪肉末（瘦）'], state: 'raw', per100g: { kcal: 190, carb: 1.0, protein: 19.0, fat: 12.0, fiber: 0, sodium: 75 }, units: [{ name: '1 勺', grams: 20 }, { name: '1 小碗', grams: 150 }] },
  { id: 'pork-blood', kind: 'ingredient', name: '猪血', aliases: ['血豆腐', '猪血旺'], state: 'cooked', per100g: { kcal: 55, carb: 0.9, protein: 12.2, fat: 0.3, fiber: 0, sodium: 60 }, units: [{ name: '1 块', grams: 80 }, { name: '1 碗', grams: 200 }] },
  { id: 'pork-skin', kind: 'ingredient', name: '猪皮', aliases: ['猪皮（熟）'], part: '皮', skin: 'on', state: 'cooked', per100g: { kcal: 363, carb: 0, protein: 27.0, fat: 28.0, fiber: 0, sodium: 80 }, units: [{ name: '1 块', grams: 30 }] },
  { id: 'pork-chop', kind: 'ingredient', name: '猪排（带骨，生）', aliases: ['猪大排', '带骨猪排'], part: '排', state: 'raw', per100g: { kcal: 231, carb: 0.5, protein: 18.0, fat: 17.0, fiber: 0, sodium: 65 }, units: [{ name: '1 块', grams: 150 }] },
  { id: 'beef-shank-raw', kind: 'ingredient', name: '牛腱（生）', aliases: ['生牛腱', '牛腱子（生）'], part: '腱', state: 'raw', per100g: { kcal: 135, carb: 1.5, protein: 21.0, fat: 5.0, fiber: 0, sodium: 70 }, units: [{ name: '1 块', grams: 150 }, { name: '1 片（酱牛肉）', grams: 20 }] },
  { id: 'beef-shank-cooked', kind: 'ingredient', name: '牛腱（熟）', aliases: ['熟牛腱', '牛腱子（熟）'], part: '腱', state: 'cooked', per100g: { kcal: 175, carb: 0.5, protein: 30.0, fat: 5.5, fiber: 0, sodium: 70 }, units: [{ name: '1 片', grams: 20 }, { name: '1 盘', grams: 150 }] },
  { id: 'beef-brisket-raw', kind: 'ingredient', name: '牛腩（生）', aliases: ['生牛腩', '牛腩肉（生）'], part: '腩', state: 'raw', per100g: { kcal: 154, carb: 0, protein: 17.0, fat: 9.0, fiber: 0, sodium: 60 }, units: [{ name: '1 块', grams: 60 }, { name: '1 碗（块）', grams: 200 }] },
  { id: 'beef-brisket-cooked', kind: 'ingredient', name: '牛腩（熟）', aliases: ['熟牛腩', '牛腩肉（熟）'], part: '腩', state: 'cooked', per100g: { kcal: 233, carb: 0, protein: 24.0, fat: 14.5, fiber: 0, sodium: 70 }, units: [{ name: '1 块', grams: 40 }, { name: '1 碗', grams: 200 }] },
  { id: 'beef-roll', kind: 'ingredient', name: '肥牛卷', aliases: ['肥牛', '肥牛片', '雪花肥牛'], part: '腹', state: 'raw', per100g: { kcal: 250, carb: 0.5, protein: 15.0, fat: 20.5, fiber: 0, sodium: 70 }, units: [{ name: '1 卷', grams: 12 }, { name: '1 盘', grams: 200 }] },
  { id: 'beef-roll-cooked', kind: 'ingredient', name: '肥牛卷（涮熟）', aliases: ['肥牛（熟）', '涮肥牛'], part: '腹', state: 'cooked', per100g: { kcal: 300, carb: 0.5, protein: 20.0, fat: 24.0, fiber: 0, sodium: 90 }, units: [{ name: '1 片', grams: 15 }, { name: '1 碗', grams: 200 }] },
  { id: 'beef-tenderloin', kind: 'ingredient', name: '牛里脊', aliases: ['牛柳', '牛里脊肉'], part: '里脊', state: 'raw', per100g: { kcal: 107, carb: 0, protein: 22.2, fat: 0.9, fiber: 0, sodium: 55 }, units: [{ name: '1 块', grams: 150 }, { name: '1 片（牛排）', grams: 200 }] },
  { id: 'beef-tenderloin-cooked', kind: 'ingredient', name: '牛里脊（熟）', aliases: ['熟牛里脊', '牛柳（熟）'], part: '里脊', state: 'cooked', per100g: { kcal: 180, carb: 0, protein: 30.0, fat: 6.0, fiber: 0, sodium: 65 }, units: [{ name: '1 块', grams: 120 }] },
  { id: 'beef-mince', kind: 'ingredient', name: '牛肉馅', aliases: ['牛肉末', '碎牛肉'], state: 'raw', per100g: { kcal: 250, carb: 0, protein: 17.1, fat: 20.0, fiber: 0, sodium: 70 }, units: [{ name: '1 勺', grams: 20 }, { name: '1 小碗', grams: 150 }] },
  { id: 'beef-mince-cooked', kind: 'ingredient', name: '牛肉馅（熟）', aliases: ['熟牛肉馅'], state: 'cooked', per100g: { kcal: 270, carb: 0, protein: 20.0, fat: 20.0, fiber: 0, sodium: 80 }, units: [{ name: '1 勺', grams: 20 }, { name: '1 小碗', grams: 120 }] },
  { id: 'beef-sirloin', kind: 'ingredient', name: '西冷牛排（生）', aliases: ['西冷', '牛排（生）'], part: '西冷', state: 'raw', per100g: { kcal: 210, carb: 0.5, protein: 20.0, fat: 14.0, fiber: 0, sodium: 55 }, units: [{ name: '1 块', grams: 200 }] },
  { id: 'beef-jerky', kind: 'dish', name: '牛肉干', aliases: ['风干牛肉干'], state: 'cooked', per100g: { kcal: 550, carb: 12.0, protein: 45.0, fat: 34.0, fiber: 0, sodium: 1200 }, units: [{ name: '1 小包', grams: 30 }, { name: '1 片', grams: 10 }] },
  { id: 'beef-tripe', kind: 'ingredient', name: '牛百叶', aliases: ['毛肚', '牛肚'], part: '百叶', state: 'raw', per100g: { kcal: 70, carb: 0, protein: 14.5, fat: 1.6, fiber: 0, sodium: 60 }, units: [{ name: '1 盘', grams: 200 }] },
  { id: 'beef-tongue', kind: 'ingredient', name: '牛舌', aliases: ['牛舌片'], state: 'raw', per100g: { kcal: 224, carb: 2.0, protein: 16.0, fat: 17.0, fiber: 0, sodium: 70 }, units: [{ name: '1 片', grams: 30 }, { name: '1 盘', grams: 150 }] },
  { id: 'lamb-leg', kind: 'ingredient', name: '羊腿肉', aliases: ['羊腿', '羊肉（腿）'], part: '腿', state: 'raw', per100g: { kcal: 203, carb: 0.5, protein: 18.0, fat: 14.0, fiber: 0, sodium: 65 }, units: [{ name: '1 块', grams: 150 }, { name: '1 串', grams: 25 }] },
  { id: 'beef-ball', kind: 'dish', name: '牛肉丸', aliases: ['牛肉丸子', '潮汕牛肉丸'], state: 'cooked', per100g: { kcal: 180, carb: 10.0, protein: 16.0, fat: 8.5, fiber: 0, sodium: 700 }, units: [{ name: '1 个', grams: 15 }, { name: '1 碗', grams: 150 }] },
  { id: 'salmon-raw', kind: 'ingredient', name: '三文鱼（生）', aliases: ['生三文鱼', '三文鱼生'], state: 'raw', per100g: { kcal: 139, carb: 0, protein: 17.2, fat: 7.8, fiber: 0, sodium: 50 }, units: [{ name: '1 块', grams: 120 }, { name: '1 盘', grams: 200 }] },
  { id: 'salmon-cooked', kind: 'ingredient', name: '三文鱼（熟）', aliases: ['熟三文鱼', '烤三文鱼（熟）'], state: 'cooked', per100g: { kcal: 206, carb: 0, protein: 22.5, fat: 12.4, fiber: 0, sodium: 55 }, units: [{ name: '1 块', grams: 120 }, { name: '1 盘', grams: 200 }] },
  { id: 'salmon-sashimi', kind: 'dish', name: '三文鱼刺身', aliases: ['刺身三文鱼', '三文鱼片'], state: 'raw', per100g: { kcal: 145, carb: 1.0, protein: 20.0, fat: 6.5, fiber: 0, sodium: 350 }, units: [{ name: '1 片', grams: 15 }, { name: '1 盘（8 片）', grams: 120 }] },
  { id: 'shrimp-raw', kind: 'ingredient', name: '虾仁（生）', aliases: ['生虾仁', '虾仁生'], state: 'raw', per100g: { kcal: 48, carb: 0.9, protein: 10.6, fat: 0.4, fiber: 0, sodium: 80 }, units: [{ name: '1 只', grams: 10 }, { name: '1 盘', grams: 150 }] },
  { id: 'shrimp-cooked', kind: 'ingredient', name: '虾仁（熟）', aliases: ['熟虾仁', '水煮虾仁'], state: 'cooked', per100g: { kcal: 99, carb: 0.2, protein: 24.0, fat: 0.4, fiber: 0, sodium: 110 }, units: [{ name: '1 只', grams: 12 }, { name: '1 盘', grams: 150 }] },
  { id: 'boiled-shrimp', kind: 'dish', name: '白灼虾仁', aliases: ['水煮虾仁（去壳）', '白灼虾（去壳）'], state: 'cooked', per100g: { kcal: 100, carb: 1.0, protein: 20.0, fat: 1.5, fiber: 0, sodium: 380 }, units: [{ name: '1 盘', grams: 200 }] },
  { id: 'shrimp-paste', kind: 'dish', name: '虾滑', aliases: ['虾滑丸', '虾泥'], state: 'cooked', per100g: { kcal: 98, carb: 8.0, protein: 14.0, fat: 1.5, fiber: 0, sodium: 600 }, units: [{ name: '1 勺', grams: 30 }, { name: '1 盘', grams: 200 }] },
  { id: 'tuna-raw', kind: 'ingredient', name: '金枪鱼（生）', aliases: ['吞拿鱼', '金枪鱼肉'], state: 'raw', per100g: { kcal: 144, carb: 0, protein: 23.0, fat: 5.0, fiber: 0, sodium: 50 }, units: [{ name: '1 块', grams: 100 }] },
  { id: 'tuna-water', kind: 'dish', name: '金枪鱼（水浸罐头）', aliases: ['水浸金枪鱼罐头', '金枪鱼罐头'], state: 'cooked', per100g: { kcal: 116, carb: 0, protein: 25.5, fat: 1.0, fiber: 0, sodium: 300 }, units: [{ name: '1 罐', grams: 120 }, { name: '1 勺', grams: 30 }] },
  { id: 'tuna-oil', kind: 'dish', name: '金枪鱼（油浸罐头）', aliases: ['油浸金枪鱼罐头'], state: 'cooked', per100g: { kcal: 200, carb: 0, protein: 24.0, fat: 11.0, fiber: 0, sodium: 320 }, units: [{ name: '1 罐', grams: 120 }, { name: '1 勺', grams: 30 }] },
  { id: 'fish-ball', kind: 'dish', name: '鱼丸', aliases: ['鱼丸（火锅）'], state: 'cooked', per100g: { kcal: 107, carb: 10.0, protein: 10.0, fat: 2.5, fiber: 0, sodium: 600 }, units: [{ name: '1 个', grams: 15 }, { name: '1 碗', grams: 150 }] },
  { id: 'crab-stick', kind: 'dish', name: '蟹棒', aliases: ['蟹柳', '蟹肉棒'], state: 'cooked', per100g: { kcal: 95, carb: 12.0, protein: 8.0, fat: 1.0, fiber: 0, sodium: 700 }, units: [{ name: '1 根', grams: 15 }] },

  // —— v1.6 高粒度：蛋奶 / 主食 / 坚果 / 蔬菜 / 健身餐 ——
  { id: 'whole-egg-raw', kind: 'ingredient', name: '全蛋（生）', aliases: ['全蛋', '整蛋', '带黄鸡蛋'], state: 'raw', per100g: { kcal: 143, carb: 0.7, protein: 12.6, fat: 9.5, fiber: 0, sodium: 140 }, units: [{ name: '1 个（中）', grams: 50 }, { name: '1 个（大）', grams: 60 }] },
  { id: 'boiled-egg', kind: 'dish', name: '水煮蛋（全蛋）', aliases: ['水煮鸡蛋', '白煮蛋', '全蛋（熟）'], state: 'cooked', per100g: { kcal: 155, carb: 1.1, protein: 12.6, fat: 10.6, fiber: 0, sodium: 140 }, units: [{ name: '1 个（中）', grams: 50 }, { name: '1 个（大）', grams: 60 }] },
  { id: 'boiled-egg-white', kind: 'ingredient', name: '水煮蛋白（去黄）', aliases: ['蛋白（熟）', '水煮蛋清'], state: 'cooked', per100g: { kcal: 52, carb: 1.1, protein: 10.9, fat: 0.2, fiber: 0, sodium: 160 }, units: [{ name: '1 个', grams: 33 }, { name: '1 碗（约 6 个）', grams: 200 }] },
  { id: 'boiled-egg-yolk', kind: 'ingredient', name: '水煮蛋黄（熟）', aliases: ['蛋黄（熟）', '水煮蛋黄'], state: 'cooked', per100g: { kcal: 322, carb: 3.0, protein: 16.0, fat: 27.0, fiber: 0, sodium: 50 }, units: [{ name: '1 个', grams: 17 }] },
  { id: 'skim-milk', kind: 'ingredient', name: '脱脂牛奶', aliases: ['零脂牛奶', '脱脂奶'], per100g: { kcal: 34, carb: 5.0, protein: 3.4, fat: 0.1, fiber: 0, sodium: 42 }, units: [{ name: '1 盒（250ml）', grams: 258 }, { name: '1 杯', grams: 200 }] },
  { id: 'whole-milk-35', kind: 'ingredient', name: '全脂牛奶（3.5%）', aliases: ['全脂奶', '全脂牛奶（盒装）'], per100g: { kcal: 64, carb: 4.8, protein: 3.3, fat: 3.6, fiber: 0, sodium: 43 }, units: [{ name: '1 盒（250ml）', grams: 258 }, { name: '1 杯', grams: 200 }] },
  { id: 'plain-yogurt', kind: 'ingredient', name: '原味酸奶（全脂）', aliases: ['酸奶', '原味酸奶'], per100g: { kcal: 72, carb: 5.0, protein: 3.5, fat: 4.0, fiber: 0, sodium: 50 }, units: [{ name: '1 杯', grams: 150 }, { name: '1 盒', grams: 100 }] },
  { id: 'lowfat-yogurt', kind: 'ingredient', name: '脱脂酸奶（无糖）', aliases: ['零脂酸奶'], per100g: { kcal: 56, carb: 7.7, protein: 3.4, fat: 0.1, fiber: 0, sodium: 55 }, units: [{ name: '1 杯', grams: 150 }] },
  { id: 'cheese-slice', kind: 'dish', name: '芝士片', aliases: ['奶酪片', '起司片'], state: 'cooked', per100g: { kcal: 300, carb: 3.0, protein: 18.0, fat: 24.0, fiber: 0, sodium: 1200 }, units: [{ name: '1 片', grams: 20 }] },
  { id: 'cream', kind: 'ingredient', name: '淡奶油', aliases: ['奶油', '稀奶油'], per100g: { kcal: 345, carb: 2.7, protein: 2.1, fat: 37.0, fiber: 0, sodium: 40 }, units: [{ name: '1 勺', grams: 15 }] },
  { id: 'pasta-dry', kind: 'ingredient', name: '意大利面（干）', aliases: ['意面（干）', '干意大利面'], state: 'raw', per100g: { kcal: 371, carb: 75.0, protein: 13.0, fat: 1.5, fiber: 2.5, sodium: 6 }, units: [{ name: '1 人份（干）', grams: 80 }, { name: '1 把', grams: 100 }] },
  { id: 'pasta-cooked', kind: 'dish', name: '意大利面（熟）', aliases: ['意面（熟）', '熟意大利面'], state: 'cooked', per100g: { kcal: 158, carb: 30.9, protein: 5.8, fat: 0.9, fiber: 1.8, sodium: 6 }, units: [{ name: '1 碗', grams: 200 }, { name: '1 盘', grams: 250 }] },
  { id: 'oats-dry', kind: 'ingredient', name: '燕麦片（干）', aliases: ['燕麦（干）', '干燕麦片'], state: 'raw', per100g: { kcal: 377, carb: 66.3, protein: 13.0, fat: 6.7, fiber: 10.0, sodium: 4 }, units: [{ name: '1 勺（干）', grams: 10 }, { name: '1 杯（干）', grams: 80 }, { name: '1 小袋（即食）', grams: 40 }] },
  { id: 'oats-cooked', kind: 'dish', name: '燕麦片（熟，冲调）', aliases: ['燕麦粥', '冲调燕麦'], state: 'cooked', per100g: { kcal: 71, carb: 12.0, protein: 2.5, fat: 1.5, fiber: 1.7, sodium: 30 }, units: [{ name: '1 碗', grams: 250 }, { name: '1 杯', grams: 200 }] },
  { id: 'sweet-potato-raw', kind: 'ingredient', name: '红薯（生）', aliases: ['生红薯', '地瓜（生）'], state: 'raw', per100g: { kcal: 86, carb: 20.1, protein: 1.6, fat: 0.1, fiber: 3.0, sodium: 30 }, units: [{ name: '1 个', grams: 200 }, { name: '1 块', grams: 100 }] },
  { id: 'sweet-potato-steamed', kind: 'dish', name: '红薯（蒸，熟）', aliases: ['蒸红薯', '熟红薯', '地瓜（蒸）'], state: 'cooked', per100g: { kcal: 90, carb: 20.7, protein: 2.0, fat: 0.2, fiber: 3.0, sodium: 30 }, units: [{ name: '1 个', grams: 200 }, { name: '1 块', grams: 100 }] },
  { id: 'rice-cooked', kind: 'dish', name: '米饭（熟）', aliases: ['熟米饭', '白米饭（熟）'], state: 'cooked', per100g: { kcal: 116, carb: 25.9, protein: 2.6, fat: 0.3, fiber: 0.3, sodium: 2 }, units: [{ name: '1 碗', grams: 200 }, { name: '1 小碗', grams: 150 }, { name: '1 拳', grams: 150 }] },
  { id: 'brown-rice-raw', kind: 'ingredient', name: '糙米（生）', aliases: ['生糙米', '糙米（干）'], state: 'raw', per100g: { kcal: 348, carb: 72.2, protein: 7.7, fat: 2.7, fiber: 3.5, sodium: 3 }, units: [{ name: '1 杯', grams: 180 }, { name: '1 碗', grams: 150 }] },
  { id: 'quinoa-cooked', kind: 'dish', name: '藜麦（熟）', aliases: ['熟藜麦'], state: 'cooked', per100g: { kcal: 120, carb: 21.0, protein: 4.4, fat: 1.9, fiber: 2.8, sodium: 7 }, units: [{ name: '1 碗', grams: 200 }, { name: '1 勺', grams: 15 }] },
  { id: 'quinoa-raw', kind: 'ingredient', name: '藜麦（生）', aliases: ['生藜麦', '藜麦米'], state: 'raw', per100g: { kcal: 368, carb: 64.0, protein: 14.0, fat: 6.0, fiber: 7.0, sodium: 5 }, units: [{ name: '1 杯', grams: 170 }] },
  { id: 'corn-cooked', kind: 'dish', name: '玉米（煮）', aliases: ['煮玉米', '水煮玉米'], state: 'cooked', per100g: { kcal: 106, carb: 22.8, protein: 4.0, fat: 1.2, fiber: 2.9, sodium: 3 }, units: [{ name: '1 根', grams: 200 }, { name: '1 段', grams: 100 }] },
  { id: 'corn-raw', kind: 'ingredient', name: '玉米（生）', aliases: ['生玉米', '甜玉米（生）'], state: 'raw', per100g: { kcal: 112, carb: 22.8, protein: 4.0, fat: 1.2, fiber: 2.9, sodium: 3 }, units: [{ name: '1 根', grams: 200 }] },
  { id: 'potato-steamed', kind: 'dish', name: '土豆（蒸）', aliases: ['蒸土豆', '土豆（熟）'], state: 'cooked', per100g: { kcal: 87, carb: 20.0, protein: 2.0, fat: 0.1, fiber: 2.2, sodium: 6 }, units: [{ name: '1 个', grams: 150 }, { name: '1 块', grams: 80 }] },
  { id: 'potato-raw', kind: 'ingredient', name: '土豆（生）', aliases: ['生土豆', '马铃薯（生）'], state: 'raw', per100g: { kcal: 77, carb: 17.2, protein: 2.0, fat: 0.2, fiber: 2.2, sodium: 6 }, units: [{ name: '1 个', grams: 150 }] },
  { id: 'mixed-grain-rice', kind: 'dish', name: '杂粮饭（熟）', aliases: ['杂粮米饭', '五谷饭'], state: 'cooked', per100g: { kcal: 118, carb: 24.5, protein: 3.2, fat: 0.8, fiber: 2.0, sodium: 3 }, units: [{ name: '1 碗', grams: 200 }, { name: '1 拳', grams: 150 }] },
  { id: 'black-rice-cooked', kind: 'dish', name: '黑米饭（熟）', aliases: ['熟黑米饭'], state: 'cooked', per100g: { kcal: 115, carb: 24.0, protein: 3.5, fat: 0.6, fiber: 1.8, sodium: 3 }, units: [{ name: '1 碗', grams: 200 }, { name: '1 拳', grams: 150 }] },
  { id: 'whole-wheat-bun', kind: 'dish', name: '全麦馒头', aliases: ['杂粮馒头'], per100g: { kcal: 210, carb: 43.0, protein: 8.0, fat: 1.5, fiber: 3.5, sodium: 300 }, units: [{ name: '1 个', grams: 100 }, { name: '1 半', grams: 50 }] },
  { id: 'bagel', kind: 'dish', name: '贝果（原味）', aliases: ['贝果', '原味贝果'], per100g: { kcal: 257, carb: 50.0, protein: 10.0, fat: 1.5, fiber: 2.5, sodium: 430 }, units: [{ name: '1 个', grams: 100 }, { name: '1 半', grams: 50 }] },
  { id: 'soda-cracker', kind: 'dish', name: '苏打饼干', aliases: ['梳打饼干', '咸饼干'], per100g: { kcal: 408, carb: 76.0, protein: 8.0, fat: 7.7, fiber: 2.0, sodium: 600 }, units: [{ name: '1 片', grams: 6 }, { name: '1 包', grams: 30 }] },
  { id: 'buckwheat-noodle-dry', kind: 'ingredient', name: '荞麦面（干）', aliases: ['干荞麦面', '荞麦挂面'], state: 'raw', per100g: { kcal: 340, carb: 70.0, protein: 12.0, fat: 2.3, fiber: 3.5, sodium: 30 }, units: [{ name: '1 把', grams: 80 }, { name: '1 人份', grams: 100 }] },
  { id: 'buckwheat-noodle-cooked', kind: 'dish', name: '荞麦面（熟）', aliases: ['熟荞麦面'], state: 'cooked', per100g: { kcal: 114, carb: 24.4, protein: 5.1, fat: 0.1, fiber: 2.0, sodium: 25 }, units: [{ name: '1 碗', grams: 250 }] },
  { id: 'vermicelli-dry', kind: 'ingredient', name: '粉丝（干）', aliases: ['干粉丝', '绿豆粉丝'], state: 'raw', per100g: { kcal: 338, carb: 83.0, protein: 0.8, fat: 0.2, fiber: 0.5, sodium: 10 }, units: [{ name: '1 把', grams: 50 }] },
  { id: 'oatmeal-milk-bowl', kind: 'dish', name: '燕麦牛奶碗', aliases: ['牛奶燕麦', '燕麦牛奶'], per100g: { kcal: 110, carb: 15.0, protein: 5.0, fat: 3.0, fiber: 1.8, sodium: 60 }, units: [{ name: '1 碗', grams: 300 }] },
  { id: 'peanut-butter', kind: 'dish', name: '花生酱（无糖）', aliases: ['花生酱', '无糖花生酱'], per100g: { kcal: 588, carb: 20.0, protein: 25.0, fat: 50.0, fiber: 6.0, sodium: 15 }, units: [{ name: '1 勺', grams: 15 }, { name: '1 小勺', grams: 8 }] },
  { id: 'mixed-nuts', kind: 'dish', name: '混合坚果', aliases: ['每日坚果', '坚果混合'], per100g: { kcal: 607, carb: 18.0, protein: 20.0, fat: 52.0, fiber: 7.0, sodium: 5 }, units: [{ name: '1 把', grams: 25 }, { name: '1 小袋', grams: 30 }] },
  { id: 'broccoli-boiled', kind: 'dish', name: '西兰花（水煮）', aliases: ['水煮西兰花', '白灼西兰花'], state: 'cooked', per100g: { kcal: 35, carb: 7.0, protein: 2.8, fat: 0.4, fiber: 2.6, sodium: 20 }, units: [{ name: '1 碗', grams: 200 }, { name: '1 棵', grams: 300 }] },
  { id: 'broccoli-raw', kind: 'ingredient', name: '西兰花（生）', aliases: ['生西兰花', '西兰花（鲜）'], state: 'raw', per100g: { kcal: 34, carb: 6.6, protein: 2.8, fat: 0.4, fiber: 2.6, sodium: 18 }, units: [{ name: '1 棵', grams: 300 }, { name: '1 碗', grams: 200 }] },
  { id: 'spinach-boiled', kind: 'dish', name: '菠菜（水煮）', aliases: ['水煮菠菜', '白灼菠菜'], state: 'cooked', per100g: { kcal: 28, carb: 3.5, protein: 3.0, fat: 0.4, fiber: 2.0, sodium: 110 }, units: [{ name: '1 碗', grams: 200 }, { name: '1 把', grams: 150 }] },
  { id: 'spinach-raw', kind: 'ingredient', name: '菠菜（生）', aliases: ['生菠菜', '菠菜（鲜）'], state: 'raw', per100g: { kcal: 28, carb: 4.5, protein: 2.6, fat: 0.3, fiber: 1.7, sodium: 85 }, units: [{ name: '1 把', grams: 150 }] },
  { id: 'shiitake-fresh', kind: 'ingredient', name: '香菇（鲜）', aliases: ['鲜香菇', '冬菇'], state: 'raw', per100g: { kcal: 26, carb: 5.2, protein: 2.2, fat: 0.3, fiber: 3.3, sodium: 2 }, units: [{ name: '1 朵', grams: 20 }, { name: '1 把', grams: 100 }] },
  { id: 'black-fungus-dry', kind: 'ingredient', name: '木耳（干）', aliases: ['干木耳', '黑木耳（干）'], state: 'raw', per100g: { kcal: 265, carb: 65.0, protein: 12.0, fat: 1.5, fiber: 29.9, sodium: 20 }, units: [{ name: '1 小把', grams: 5 }, { name: '1 把', grams: 10 }] },
  { id: 'cherry-tomato', kind: 'ingredient', name: '圣女果', aliases: ['小番茄', '樱桃番茄'], state: 'raw', per100g: { kcal: 25, carb: 5.2, protein: 1.0, fat: 0.2, fiber: 1.8, sodium: 3 }, units: [{ name: '1 个', grams: 15 }, { name: '1 盒', grams: 250 }] },
  { id: 'seaweed-dry', kind: 'ingredient', name: '紫菜（干）', aliases: ['干紫菜', '海苔（干）'], state: 'raw', per100g: { kcal: 250, carb: 44.1, protein: 26.7, fat: 1.1, fiber: 21.6, sodium: 710 }, units: [{ name: '1 张', grams: 5 }, { name: '1 小把', grams: 5 }] },
  { id: 'konjac-noodle', kind: 'ingredient', name: '魔芋丝', aliases: ['魔芋结', '魔芋面'], state: 'raw', per100g: { kcal: 9, carb: 2.0, protein: 0.1, fat: 0.1, fiber: 2.7, sodium: 5 }, units: [{ name: '1 袋', grams: 200 }, { name: '1 碗', grams: 150 }] },
  { id: 'chicken-salad', kind: 'dish', name: '鸡胸肉沙拉', aliases: ['轻食鸡胸沙拉', '鸡胸沙拉'], part: '胸', skin: 'off', state: 'cooked', per100g: { kcal: 120, carb: 5.0, protein: 12.0, fat: 5.5, fiber: 1.5, sodium: 330 }, units: [{ name: '1 盒', grams: 300 }, { name: '1 盘', grams: 250 }] },
  { id: 'chicken-brown-rice', kind: 'dish', name: '鸡胸肉配糙米', aliases: ['鸡胸肉糙米饭', '健身餐（鸡胸糙米）'], part: '胸', skin: 'off', state: 'cooked', per100g: { kcal: 135, carb: 18.0, protein: 9.5, fat: 2.5, fiber: 2.0, sodium: 300 }, units: [{ name: '1 盒', grams: 350 }, { name: '1 碗', grams: 300 }] },
  { id: 'fat-loss-plate', kind: 'dish', name: '减脂餐（一荤两素，少油）', aliases: ['减脂餐', '健身餐（少油）', '轻食餐'], per100g: { kcal: 105, carb: 8.0, protein: 9.0, fat: 3.5, fiber: 2.0, sodium: 360 }, units: [{ name: '1 盒', grams: 400 }, { name: '1 盘', grams: 350 }] },
  { id: 'tuna-salad', kind: 'dish', name: '金枪鱼沙拉', aliases: ['吞拿鱼沙拉'], per100g: { kcal: 110, carb: 6.0, protein: 9.0, fat: 5.0, fiber: 1.2, sodium: 320 }, units: [{ name: '1 盒', grams: 250 }] },
  { id: 'greek-yogurt-bowl', kind: 'dish', name: '希腊酸奶水果碗', aliases: ['酸奶碗', '希腊酸奶碗'], per100g: { kcal: 95, carb: 12.0, protein: 7.0, fat: 1.5, fiber: 1.0, sodium: 45 }, units: [{ name: '1 碗', grams: 250 }, { name: '1 盒', grams: 200 }] },
  { id: 'protein-shake', kind: 'dish', name: '蛋白粉奶昔', aliases: ['乳清蛋白奶昔', '蛋白饮品'], per100g: { kcal: 90, carb: 6.0, protein: 8.0, fat: 3.0, fiber: 0.5, sodium: 80 }, units: [{ name: '1 杯', grams: 300 }] },
  { id: 'black-pepper-steak', kind: 'dish', name: '黑椒牛排（少油）', aliases: ['牛排（少油）', '黑椒牛排'], per100g: { kcal: 190, carb: 2.0, protein: 25.0, fat: 9.0, fiber: 0.3, sodium: 420 }, units: [{ name: '1 块', grams: 200 }, { name: '1 盘', grams: 250 }] },
  { id: 'whey-protein', kind: 'ingredient', name: '乳清蛋白粉', aliases: ['蛋白粉', '乳清蛋白'], per100g: { kcal: 380, carb: 10.0, protein: 75.0, fat: 5.0, fiber: 1.0, sodium: 300 }, units: [{ name: '1 勺', grams: 30 }, { name: '1 小袋', grams: 30 }] },
  { id: 'whey-isolate', kind: 'ingredient', name: '蛋白粉（分离乳清）', aliases: ['分离乳清蛋白', 'ISO 蛋白粉'], per100g: { kcal: 370, carb: 5.0, protein: 80.0, fat: 2.0, fiber: 0.5, sodium: 250 }, units: [{ name: '1 勺', grams: 30 }] },
  { id: 'meal-replacement', kind: 'dish', name: '代餐奶昔', aliases: ['代餐粉', '代餐冲剂'], per100g: { kcal: 110, carb: 12.0, protein: 10.0, fat: 2.5, fiber: 3.0, sodium: 150 }, units: [{ name: '1 瓶', grams: 300 }] },
  { id: 'chicken-meatball', kind: 'dish', name: '鸡胸肉丸', aliases: ['鸡肉丸', '鸡胸肉丸子'], part: '胸', skin: 'off', state: 'cooked', per100g: { kcal: 130, carb: 6.0, protein: 18.0, fat: 4.0, fiber: 0, sodium: 650 }, units: [{ name: '1 个', grams: 15 }, { name: '1 袋', grams: 150 }] },
  { id: 'chicken-sausage', kind: 'dish', name: '鸡胸肉肠', aliases: ['鸡肉肠', '鸡胸肠'], part: '胸', skin: 'off', state: 'cooked', per100g: { kcal: 145, carb: 3.0, protein: 20.0, fat: 6.0, fiber: 0, sodium: 800 }, units: [{ name: '1 根', grams: 50 }] },
  { id: 'chicken-congee', kind: 'dish', name: '鸡胸肉粥', aliases: ['鸡丝粥', '鸡胸粥'], per100g: { kcal: 60, carb: 9.0, protein: 5.0, fat: 0.8, fiber: 0.4, sodium: 300 }, units: [{ name: '1 碗', grams: 350 }] },
  { id: 'protein-bar', kind: 'dish', name: '蛋白棒', aliases: ['能量蛋白棒'], per100g: { kcal: 380, carb: 30.0, protein: 30.0, fat: 14.0, fiber: 5.0, sodium: 200 }, units: [{ name: '1 根', grams: 50 }] },
  { id: 'energy-bar', kind: 'dish', name: '谷物能量棒', aliases: ['谷物棒', '代餐棒'], per100g: { kcal: 400, carb: 55.0, protein: 12.0, fat: 15.0, fiber: 4.0, sodium: 180 }, units: [{ name: '1 根', grams: 40 }] },
  { id: 'chicken-rice-ball', kind: 'dish', name: '鸡胸肉饭团', aliases: ['鸡肉饭团', '饭团（鸡胸）'], part: '胸', state: 'cooked', per100g: { kcal: 150, carb: 26.0, protein: 7.0, fat: 2.0, fiber: 1.0, sodium: 380 }, units: [{ name: '1 个', grams: 130 }] },
  { id: 'shrimp-wonton', kind: 'dish', name: '虾仁馄饨', aliases: ['虾肉馄饨', '鲜虾馄饨'], per100g: { kcal: 150, carb: 20.0, protein: 8.0, fat: 4.0, fiber: 0.8, sodium: 500 }, units: [{ name: '1 个', grams: 20 }, { name: '1 碗', grams: 250 }] },
  { id: 'chicken-dumpling', kind: 'dish', name: '鸡肉饺子', aliases: ['鸡胸肉饺子', '鸡肉水饺'], per100g: { kcal: 180, carb: 24.0, protein: 9.0, fat: 5.0, fiber: 1.0, sodium: 480 }, units: [{ name: '1 个', grams: 20 }, { name: '1 盘', grams: 200 }] },
  // —— v1.7 补全：菌菇 / 蔬菜 / 豆制品 / 豆类杂粮（数值取《中国食物成分表》口径）——
  { id: 'king-oyster-mushroom', kind: 'ingredient', name: '杏鲍菇', aliases: ['刺芹侧耳', '鲍菇', '干贝菇'], state: 'raw', per100g: { kcal: 31, carb: 8.3, protein: 1.3, fat: 0.1, fiber: 2.1, sodium: 3.1 }, units: [{ name: '1 根', grams: 60 }, { name: '1 盘', grams: 150 }, { name: '1 盒', grams: 250 }] },
  { id: 'straw-mushroom', kind: 'ingredient', name: '草菇', aliases: ['大黑头细花草', '兰花菇', '稻草菇'], state: 'raw', per100g: { kcal: 23, carb: 2.7, protein: 2.7, fat: 0.2, fiber: 1.6, sodium: 73 }, units: [{ name: '1 朵', grams: 12 }, { name: '1 盘', grams: 150 }] },
  { id: 'button-mushroom', kind: 'ingredient', name: '蘑菇', aliases: ['鲜蘑', '双孢蘑菇', '洋蘑菇'], state: 'raw', per100g: { kcal: 20, carb: 2.0, protein: 2.7, fat: 0.1, fiber: 2.1, sodium: 8.3 }, units: [{ name: '1 朵', grams: 15 }, { name: '1 盘', grams: 150 }, { name: '1 盒', grams: 200 }] },
  // —— v1.7 补全：蔬菜 ——
  { id: 'asparagus-lettuce', kind: 'ingredient', name: '莴笋', aliases: ['莴苣', '青笋', '香莴笋'], state: 'raw', per100g: { kcal: 14, carb: 2.2, protein: 1.0, fat: 0.1, fiber: 0.6, sodium: 36.5 }, units: [{ name: '1 根', grams: 300 }, { name: '1 盘', grams: 150 }, { name: '1 段', grams: 50 }] },
  { id: 'bamboo-shoot', kind: 'ingredient', name: '竹笋', aliases: ['鲜笋', '笋肉', '竹笋肉'], state: 'raw', per100g: { kcal: 19, carb: 1.8, protein: 2.6, fat: 0.2, fiber: 1.8, sodium: 0.4 }, units: [{ name: '1 根', grams: 100 }, { name: '1 盘', grams: 150 }] },
  { id: 'taro', kind: 'ingredient', name: '芋头', aliases: ['芋艿', '毛芋', '芋头仔'], state: 'raw', per100g: { kcal: 79, carb: 17.1, protein: 2.2, fat: 0.2, fiber: 1.0, sodium: 33.1 }, units: [{ name: '1 个', grams: 100 }, { name: '1 碗', grams: 150 }, { name: '1 盘', grams: 200 }] },
  { id: 'water-chestnut', kind: 'ingredient', name: '荸荠', aliases: ['马蹄', '地栗', '凫茈'], state: 'raw', per100g: { kcal: 59, carb: 13.1, protein: 1.2, fat: 0.2, fiber: 1.1, sodium: 15.7 }, units: [{ name: '1 个', grams: 12 }, { name: '1 把', grams: 100 }] },
  { id: 'gai-lan', kind: 'ingredient', name: '芥蓝', aliases: ['芥兰', '甘蓝菜', '盖蓝菜'], state: 'raw', per100g: { kcal: 19, carb: 1.0, protein: 2.8, fat: 0.4, fiber: 1.6, sodium: 50.5 }, units: [{ name: '1 把', grams: 250 }, { name: '1 盘', grams: 150 }] },
  { id: 'amaranth-green', kind: 'ingredient', name: '苋菜', aliases: ['绿苋菜', '青苋菜', '白苋菜'], state: 'raw', per100g: { kcal: 25, carb: 2.8, protein: 2.8, fat: 0.3, fiber: 2.2, sodium: 32.4 }, units: [{ name: '1 把', grams: 200 }, { name: '1 盘', grams: 150 }] },
  { id: 'amaranth-red', kind: 'ingredient', name: '红苋菜', aliases: ['紫苋菜', '红苋', '紫苋'], state: 'raw', per100g: { kcal: 31, carb: 4.1, protein: 2.8, fat: 0.4, fiber: 1.8, sodium: 42.3 }, units: [{ name: '1 把', grams: 200 }, { name: '1 盘', grams: 150 }] },
  { id: 'cowpea', kind: 'ingredient', name: '豇豆', aliases: ['长豆角', '角豆', '线豆'], state: 'raw', per100g: { kcal: 29, carb: 4.0, protein: 2.7, fat: 0.2, fiber: 1.8, sodium: 4.6 }, units: [{ name: '1 根', grams: 15 }, { name: '1 盘', grams: 150 }, { name: '1 把', grams: 200 }] },
  { id: 'pea-shoot', kind: 'ingredient', name: '豌豆苗', aliases: ['豌豆尖', '豆苗', '豌豆藤尖'], state: 'raw', per100g: { kcal: 34, carb: 2.7, protein: 4.0, fat: 0.8, fiber: 1.9, sodium: 18.5 }, units: [{ name: '1 把', grams: 100 }, { name: '1 盘', grams: 150 }] },
  { id: 'toon', kind: 'ingredient', name: '香椿', aliases: ['香椿芽', '椿芽', '春芽'], state: 'raw', per100g: { kcal: 50, carb: 10.9, protein: 1.7, fat: 0.4, fiber: 1.8, sodium: 4.6 }, units: [{ name: '1 把', grams: 50 }, { name: '1 小把', grams: 30 }] },
  { id: 'choy-sum', kind: 'ingredient', name: '菜心', aliases: ['菜薹', '广东菜心', '白菜薹'], state: 'raw', per100g: { kcal: 25, carb: 2.3, protein: 2.8, fat: 0.5, fiber: 1.7, sodium: 26 }, units: [{ name: '1 把', grams: 200 }, { name: '1 盘', grams: 150 }] },
  { id: 'scallion-large', kind: 'ingredient', name: '大葱', aliases: ['京葱', '青葱', '葱白'], state: 'raw', per100g: { kcal: 30, carb: 5.2, protein: 1.7, fat: 0.3, fiber: 1.3, sodium: 4.8 }, units: [{ name: '1 根', grams: 100 }, { name: '1 段', grams: 10 }] },
  { id: 'chive', kind: 'ingredient', name: '韭菜', aliases: ['韭', '韭叶', '韭菜叶'], state: 'raw', per100g: { kcal: 26, carb: 3.2, protein: 2.4, fat: 0.4, fiber: 1.4, sodium: 8.1 }, units: [{ name: '1 把', grams: 200 }, { name: '1 小把', grams: 100 }] },
  { id: 'hyacinth-bean', kind: 'ingredient', name: '扁豆', aliases: ['月亮菜', '峨眉豆', '藤豆'], state: 'raw', per100g: { kcal: 37, carb: 6.1, protein: 2.7, fat: 0.2, fiber: 2.1, sodium: 3.8 }, units: [{ name: '1 根', grams: 6 }, { name: '1 盘', grams: 150 }] },
  { id: 'sword-bean', kind: 'ingredient', name: '刀豆', aliases: ['大刀豆', '挟剑豆'], state: 'raw', per100g: { kcal: 36, carb: 5.2, protein: 3.1, fat: 0.3, fiber: 1.8, sodium: 8.5 }, units: [{ name: '1 根', grams: 15 }, { name: '1 盘', grams: 150 }] },
  { id: 'watercress', kind: 'ingredient', name: '豆瓣菜', aliases: ['西洋菜', '水田芥'], state: 'raw', per100g: { kcal: 17, carb: 0.3, protein: 2.9, fat: 0.5, fiber: 1.2, sodium: 61.2 }, units: [{ name: '1 把', grams: 150 }, { name: '1 扎', grams: 100 }] },
  { id: 'garlic-scape', kind: 'ingredient', name: '蒜苔', aliases: ['蒜薹', '青蒜苔', '蒜苔段'], state: 'raw', per100g: { kcal: 61, carb: 12.9, protein: 2.0, fat: 0.1, fiber: 2.5, sodium: 3.8 }, units: [{ name: '1 根', grams: 10 }, { name: '1 把', grams: 200 }] },
  { id: 'lettuce-leaf', kind: 'ingredient', name: '莴笋叶', aliases: ['莴苣叶', '莴笋尖'], state: 'raw', per100g: { kcal: 18, carb: 2.6, protein: 1.4, fat: 0.2, fiber: 1.0, sodium: 39.1 }, units: [{ name: '1 把', grams: 150 }, { name: '1 盘', grams: 120 }] },
  // —— v1.7 补全：豆制品 ——
  { id: 'tofu-shreds', kind: 'ingredient', name: '豆腐丝', aliases: ['干丝', '豆腐干丝', '千张丝'], state: 'raw', per100g: { kcal: 201, carb: 5.1, protein: 21.5, fat: 10.5, fiber: 1.1, sodium: 20.6 }, units: [{ name: '1 把', grams: 100 }, { name: '1 盘', grams: 150 }] },
  { id: 'vegetarian-chicken', kind: 'ingredient', name: '素鸡', aliases: ['素鸡腿', '豆制素鸡'], state: 'raw', per100g: { kcal: 192, carb: 3.3, protein: 16.5, fat: 12.5, fiber: 0.9, sodium: 373.8 }, units: [{ name: '1 块', grams: 80 }, { name: '1 片', grams: 30 }] },
  // —— v1.7 补全：豆类与杂粮 ——
  { id: 'black-bean', kind: 'ingredient', name: '黑豆', aliases: ['黑大豆', '乌豆', '黑黄豆'], state: 'raw', per100g: { kcal: 381, carb: 23.4, protein: 36.0, fat: 15.9, fiber: 10.2, sodium: 3 }, units: [{ name: '1 勺', grams: 15 }, { name: '1 杯', grams: 150 }] },
  { id: 'chickpea', kind: 'ingredient', name: '鹰嘴豆', aliases: ['桃尔豆', '鸡豆', '鹰嘴豆（干）'], state: 'raw', per100g: { kcal: 378, carb: 63.0, protein: 20.5, fat: 6.0, fiber: 12.2, sodium: 24 }, units: [{ name: '1 勺', grams: 15 }, { name: '1 杯', grams: 160 }] },
  { id: 'job-tears', kind: 'ingredient', name: '薏米', aliases: ['薏仁', '薏仁米', '苡米'], state: 'raw', per100g: { kcal: 357, carb: 69.1, protein: 12.8, fat: 3.3, fiber: 2.0, sodium: 3.6 }, units: [{ name: '1 勺', grams: 15 }, { name: '1 小把', grams: 30 }, { name: '1 杯', grams: 150 }] },
  { id: 'buckwheat', kind: 'ingredient', name: '荞麦', aliases: ['荞麦米', '甜荞', '乌麦'], state: 'raw', per100g: { kcal: 324, carb: 66.5, protein: 9.3, fat: 2.3, fiber: 6.5, sodium: 4.7 }, units: [{ name: '1 杯', grams: 150 }, { name: '1 把', grams: 80 }] },
  { id: 'glutinous-rice', kind: 'ingredient', name: '糯米', aliases: ['江米', '糯米（生）', '酒米'], state: 'raw', per100g: { kcal: 348, carb: 77.5, protein: 7.3, fat: 1.0, fiber: 0.8, sodium: 1.5 }, units: [{ name: '1 杯', grams: 150 }, { name: '1 勺', grams: 15 }] },
  { id: 'sorghum', kind: 'ingredient', name: '高粱米', aliases: ['蜀黍', '红粮', '高粱'], state: 'raw', per100g: { kcal: 351, carb: 70.4, protein: 10.4, fat: 3.1, fiber: 4.3, sodium: 6.3 }, units: [{ name: '1 杯', grams: 150 }, { name: '1 勺', grams: 15 }] },
  { id: 'white-kidney-bean', kind: 'ingredient', name: '白芸豆', aliases: ['白豆', '大白芸豆', '芸豆（白）'], state: 'raw', per100g: { kcal: 296, carb: 47.4, protein: 23.4, fat: 1.4, fiber: 9.8, sodium: 0 }, units: [{ name: '1 勺', grams: 15 }, { name: '1 杯', grams: 150 }] },
  // —— v1.7 补全：家常菜（按配料折算成品重量，见 tests 里的估算说明）——
  { id: 'king-oyster-pork', kind: 'dish', name: '杏鲍菇炒肉', aliases: ['肉片炒杏鲍菇', '杏鲍菇炒肉片'], state: 'cooked', per100g: { kcal: 86, carb: 6.3, protein: 6.4, fat: 4.6, fiber: 1.4, sodium: 148 }, units: [{ name: '1 盘', grams: 250 }, { name: '1 小盘', grams: 180 }] },
  { id: 'garlic-king-oyster', kind: 'dish', name: '蒜蓉杏鲍菇', aliases: ['蒜香杏鲍菇', '蒜蓉炒杏鲍菇'], state: 'cooked', per100g: { kcal: 60, carb: 8.1, protein: 1.4, fat: 3.4, fiber: 2.0, sodium: 139 }, units: [{ name: '1 盘', grams: 220 }, { name: '1 小盘', grams: 160 }] },
  { id: 'stir-asparagus-lettuce', kind: 'dish', name: '清炒莴笋', aliases: ['炒莴笋', '清炒莴笋丝'], state: 'cooked', per100g: { kcal: 38, carb: 2.3, protein: 1.1, fat: 2.7, fiber: 0.6, sodium: 135 }, units: [{ name: '1 盘', grams: 230 }, { name: '1 小盘', grams: 160 }] },
  { id: 'toon-egg', kind: 'dish', name: '香椿炒蛋', aliases: ['香椿炒鸡蛋', '椿芽炒蛋'], state: 'cooked', per100g: { kcal: 152, carb: 4.4, protein: 9.0, fat: 10.8, fiber: 0.6, sodium: 84 }, units: [{ name: '1 盘', grams: 160 }, { name: '1 小盘', grams: 110 }] },
  { id: 'dry-fried-cowpea', kind: 'dish', name: '干煸豇豆', aliases: ['干煸长豆角', '干煸豇豆角'], state: 'cooked', per100g: { kcal: 86, carb: 3.6, protein: 4.8, fat: 5.8, fiber: 1.5, sodium: 128 }, units: [{ name: '1 盘', grams: 245 }, { name: '1 小盘', grams: 170 }] },
  { id: 'stir-lotus-root', kind: 'dish', name: '清炒藕片', aliases: ['炒藕片', '清炒莲藕'], state: 'cooked', per100g: { kcal: 96, carb: 15.8, protein: 1.9, fat: 3.0, fiber: 1.1, sodium: 152 }, units: [{ name: '1 盘', grams: 210 }, { name: '1 小盘', grams: 150 }] },
  { id: 'steamed-taro', kind: 'dish', name: '蒸芋头', aliases: ['芋头（蒸）', '清蒸芋头'], state: 'cooked', per100g: { kcal: 79, carb: 17.1, protein: 2.2, fat: 0.2, fiber: 1.0, sodium: 33 }, units: [{ name: '1 盘', grams: 200 }, { name: '1 个', grams: 100 }] },

];

// v1.6 常用份量补充：旧条目原本只有一个 unit，这里按 id 补 1–3 个真实份量（新条目已在数据里自带 units）。
// 只做「常见份量的真实近似」，不要用「1 份」这种糊弄值。
const UNITS_BY_ID = {
  rice: [{ name: '1 碗', grams: 200 }, { name: '1 小碗', grams: 150 }, { name: '1 拳', grams: 150 }],
  'brown-rice': [{ name: '1 碗', grams: 200 }, { name: '1 拳', grams: 150 }],
  congee: [{ name: '1 碗', grams: 300 }, { name: '1 小碗', grams: 220 }],
  'millet-congee': [{ name: '1 碗', grams: 300 }, { name: '1 小碗', grams: 220 }],
  'steamed-bun': [{ name: '1 个', grams: 100 }, { name: '1 半', grams: 50 }],
  huajuan: [{ name: '1 个', grams: 80 }, { name: '1 半', grams: 40 }],
  'whole-wheat-bread': [{ name: '1 片', grams: 35 }, { name: '2 片（三明治）', grams: 70 }],
  'white-bread': [{ name: '1 片', grams: 35 }, { name: '2 片（三明治）', grams: 70 }],
  noodles: [{ name: '1 碗', grams: 250 }, { name: '1 小碗', grams: 180 }],
  'dried-noodles': [{ name: '1 把', grams: 80 }, { name: '1 人份', grams: 100 }],
  'rice-noodles': [{ name: '1 碗', grams: 250 }, { name: '1 小碗', grams: 180 }],
  hefen: [{ name: '1 碗', grams: 250 }],
  dumpling: [{ name: '1 个', grams: 20 }, { name: '1 盘（10 个）', grams: 200 }],
  baozi: [{ name: '1 个', grams: 80 }, { name: '1 个（大）', grams: 120 }],
  youtiao: [{ name: '1 根', grams: 60 }, { name: '1 段', grams: 30 }],
  corn: [{ name: '1 根', grams: 200 }, { name: '1 段', grams: 100 }],
  potato: [{ name: '1 个', grams: 150 }, { name: '1 块', grams: 80 }],
  'purple-sweet-potato': [{ name: '1 个', grams: 180 }],
  dami: [{ name: '1 杯（生米）', grams: 180 }, { name: '1 碗（生米）', grams: 150 }],
  mianfen: [{ name: '1 碗（面粉）', grams: 120 }, { name: '1 勺', grams: 10 }],
  'greek-yogurt': [{ name: '1 杯', grams: 150 }, { name: '1 盒', grams: 100 }],
  'egg-white': [{ name: '1 个蛋白', grams: 33 }, { name: '1 碗（约 6 个）', grams: 200 }],
  'egg-yolk': [{ name: '1 个蛋黄', grams: 20 }],
  'chicken-feet': [{ name: '1 只', grams: 35 }, { name: '1 盘', grams: 150 }],
  prawn: [{ name: '1 只', grams: 15 }, { name: '1 盘（10 只）', grams: 150 }],
  'pork-mince': [{ name: '1 勺', grams: 20 }, { name: '1 小碗', grams: 150 }],
  'pork-liver': [{ name: '1 片', grams: 20 }, { name: '1 盘', grams: 150 }],
  'zhurou-paigu': [{ name: '1 块', grams: 40 }, { name: '1 盘', grams: 200 }],
  zhuti: [{ name: '1 只', grams: 250 }],
  zhuliji: [{ name: '1 块', grams: 100 }],
  niujianzi: [{ name: '1 块', grams: 150 }, { name: '1 片（酱牛肉）', grams: 20 }],
  soymilk: [{ name: '1 杯', grams: 250 }, { name: '1 盒（250ml）', grams: 250 }],
  'tofu-firm': [{ name: '1 块', grams: 100 }, { name: '1 盒', grams: 300 }],
  'tofu-dried': [{ name: '1 片', grams: 50 }],
  spinach: [{ name: '1 把', grams: 150 }, { name: '1 盘（炒）', grams: 200 }],
  lettuce: [{ name: '1 把', grams: 100 }, { name: '1 片', grams: 15 }],
  cucumber: [{ name: '1 根', grams: 150 }, { name: '1 段', grams: 50 }],
  tomato: [{ name: '1 个', grams: 150 }, { name: '1 个（小）', grams: 100 }],
  pumpkin: [{ name: '1 块', grams: 100 }],
  kelp: [{ name: '1 张', grams: 50 }, { name: '1 盘（海带丝）', grams: 150 }],
  walnut: [{ name: '1 把', grams: 25 }, { name: '1 个（去壳）', grams: 5 }],
  almond: [{ name: '1 把', grams: 25 }, { name: '1 小把', grams: 10 }],
  butter: [{ name: '1 小块', grams: 10 }, { name: '1 勺', grams: 15 }],
  'olive-oil': [{ name: '1 勺', grams: 10 }, { name: '1 汤匙', grams: 15 }],
  lusun: [{ name: '1 根', grams: 20 }, { name: '1 把', grams: 200 }],
  okra: [{ name: '1 根', grams: 15 }, { name: '1 盘', grams: 150 }],
  'wax-gourd': [{ name: '1 块', grams: 100 }, { name: '1 盘', grams: 250 }],
  enoki: [{ name: '1 把', grams: 100 }, { name: '1 盘', grams: 150 }],
  edamame: [{ name: '1 碗', grams: 150 }, { name: '1 把', grams: 100 }],
  kongxincai: [{ name: '1 把', grams: 250 }, { name: '1 盘', grams: 200 }],
  youmaicai: [{ name: '1 把', grams: 250 }, { name: '1 盘', grams: 200 }],
  longliyu: [{ name: '1 条', grams: 200 }, { name: '1 块', grams: 100 }],
  clam: [{ name: '1 盘（带壳）', grams: 250 }, { name: '1 把', grams: 100 }],
  shenghao: [{ name: '1 只', grams: 30 }, { name: '1 盘', grams: 200 }],
  shanbei: [{ name: '1 只', grams: 20 }, { name: '1 盘', grams: 200 }],
  xueyu: [{ name: '1 块', grams: 100 }, { name: '1 盘', grams: 150 }],
  hairtail: [{ name: '1 段', grams: 50 }, { name: '1 条', grams: 300 }],
  squid: [{ name: '1 条', grams: 150 }, { name: '1 盘（鱿鱼圈）', grams: 200 }],
  'rice-cake': [{ name: '1 块', grams: 30 }, { name: '1 碗', grams: 200 }],
  fantuan: [{ name: '1 个', grams: 120 }],
  'yangrou-chuan': [{ name: '1 串', grams: 60 }, { name: '1 把（10 串）', grams: 300 }],
  'vegetable-salad': [{ name: '1 盒', grams: 200 }, { name: '1 碗', grams: 150 }],
  'tomato-egg': [{ name: '1 盘', grams: 200 }, { name: '1 小盘', grams: 150 }],
  'kung-pao-chicken': [{ name: '1 盘', grams: 250 }, { name: '1 小盘', grams: 180 }],
  'egg-fried-rice': [{ name: '1 盘', grams: 300 }, { name: '1 小碗', grams: 200 }],
  'braised-pork': [{ name: '1 小碗', grams: 150 }, { name: '1 块', grams: 30 }],
  'stir-broccoli': [{ name: '1 盘', grams: 200 }, { name: '1 小盘', grams: 150 }],
};

// 归一化：units 优先；只有 unit 的旧条目补成单元素数组；最后保证 unit 恒等于 units[0]。
for (const food of FOODS) {
  if (!Array.isArray(food.units) || food.units.length === 0) {
    const curated = UNITS_BY_ID[food.id];
    if (curated) food.units = curated.map((u) => ({ name: u.name, grams: u.grams }));
    else if (food.unit) food.units = [{ name: food.unit.name, grams: food.unit.grams }];
  }
  if (Array.isArray(food.units) && food.units.length > 0) {
    food.unit = { name: food.units[0].name, grams: food.units[0].grams };
  }
}

// 份量单位归一化：units 优先 → 旧 unit → 空数组；丢掉克数非有限数或 ≤0 的脏数据。
export function foodUnits(food) {
  if (!food || typeof food !== 'object') return [];
  const source = Array.isArray(food.units) && food.units.length > 0 ? food.units : food.unit ? [food.unit] : [];
  const out = [];
  for (const unit of source) {
    if (!unit || typeof unit !== 'object') continue;
    const name = typeof unit.name === 'string' ? unit.name.trim() : '';
    const grams = Number(unit.grams);
    if (!name || !Number.isFinite(grams) || grams <= 0) continue;
    out.push({ name, grams });
  }
  return out;
}

// 首页热门：常见主食 + 两道最常被拍的家常菜（含用户反馈里点名的菠菜炒鸡蛋）。
const HOT_IDS = ['rice', 'bocai-chao-jidan', 'tomato-egg', 'egg', 'noodles', 'milk', 'banana', 'apple', 'broccoli', 'sweet-potato'];

// 空查询用于「手动添加」首页：先给最常吃的，再按库内顺序补足。
const HOT_FOODS = HOT_IDS.map((id) => FOODS.find((f) => f.id === id)).filter(Boolean);

// 点单/拍照里常出现的修饰词，去掉后才能和库内标准菜名对齐（如「一份红烧茄子」「家常豆腐（小份）」）。
const MODIFIER_PREFIXES = ['一份', '一碗', '一盘', '一碟', '小份', '大份', '半份', '一人份', '两人份', '家常', '自制', '大概', '约', '少许'];
const MODIFIER_SUFFIXES = ['小份', '大份', '半份', '一份', '一人份', '两人份', '家常版', '自制'];

export function stripModifiers(value) {
  let out = String(value ?? '').trim();
  let prev;
  do {
    prev = out;
    for (const m of MODIFIER_PREFIXES) {
      if (out.startsWith(m) && out.length > m.length) {
        out = out.slice(m.length).trim();
        break;
      }
    }
    for (const m of MODIFIER_SUFFIXES) {
      if (out.endsWith(m) && out.length > m.length) {
        out = out.slice(0, -m.length).trim();
        break;
      }
    }
  } while (out && out !== prev);
  return out;
}

// 一条输入可能对应的全部写法：原样 → 去份量 → 去修饰词 → 两者的组合。
function nameKeys(value) {
  const raw = normalizeName(value);
  const out = new Set();
  const push = (v) => {
    const n = normalizeName(v);
    if (n) out.add(n);
  };
  const stripped = normalizeName(stripQuantity(String(value ?? '')));
  push(raw);
  push(stripped);
  push(stripModifiers(raw));
  push(stripModifiers(stripped));
  push(normalizeName(stripQuantity(stripModifiers(raw))));
  return [...out];
}

const isDish = (food) => food.kind === 'dish';

// 检索：分数的含义与旧版一致（0 精确 / 1 前缀 / 2 包含）；同分时菜品排在原料之前。
export function searchFoods(query, limit = 20) {
  const max = Math.max(0, Number(limit) || 0);
  const q = normalizeName(query);
  if (!q) return HOT_FOODS.slice(0, max);
  const scored = [];
  for (let index = 0; index < FOODS.length; index++) {
    const food = FOODS[index];
    const names = [food.name, ...(food.aliases || [])].map(normalizeName).filter(Boolean);
    let score = Infinity;
    for (const n of names) {
      let s = Infinity;
      if (n === q) s = 0;
      else if (n.startsWith(q)) s = 1;
      else if (n.includes(q)) s = 2;
      else if (q.includes(n) && n.length >= 2) s = 3;
      if (s < score) score = s;
    }
    if (score !== Infinity) {
      scored.push({ food, score, index, len: normalizeName(food.name).length, kindRank: isDish(food) ? 0 : 1 });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.kindRank - b.kindRank || a.len - b.len || a.index - b.index);
  return scored.slice(0, max).map((s) => s.food);
}

// 名称解析：精确 → 去修饰词/份量 → 别名 → 包含匹配。
// 菜名能命中时优先返回菜品，避免把「土豆丝」退化成原料「土豆」。
export function findFood(name, options = {}) {
  const keys = nameKeys(name);
  if (!keys.length) return null;
  // 输入里带括号注释时，整名一致（「鸡腿（去皮，熟）」）要压过基础条目「鸡腿」。
  const noteKey = /[（(]/.test(String(name ?? '')) ? normalizeKeepingNotes(stripQuantity(String(name ?? ''))) : '';
  const hint = options && (options.kind === 'dish' || options.kind === 'ingredient') ? options.kind : null;
  let best = null;
  let bestScore = -1;
  for (const food of FOODS) {
    const dish = isDish(food);
    // 名字与别名分开：同分时「条目本名」要压过「别的条目把这句话当别名」（豆腐丝 vs 凉拌豆腐丝）。
    const names = [food.name, ...(food.aliases || [])]
      .map((v, i) => [normalizeName(v), i === 0])
      .filter(([n]) => Boolean(n));
    const noteMatch = noteKey ? [food.name, ...(food.aliases || [])].some((v) => normalizeKeepingNotes(v) === noteKey) : false;
    for (const [n, isOwnName] of names) {
      const nShort = normalizeName(stripQuantity(n)) || n;
      let score = -1;
      for (const k of keys) {
        if (k === n || k === nShort) score = Math.max(score, 1000 + Math.min(n.length, nShort.length) + (isOwnName ? 1 : 0));
        else if (n.length >= 2 && k.includes(n)) score = Math.max(score, 400 + n.length);
        else if (n.length >= 2 && n.includes(k) && k.length >= 2) score = Math.max(score, 200 + k.length + (dish ? 250 : 0));
      }
      if (noteMatch) score = Math.max(score, 1500);
      if (score > 0 && hint && food.kind === hint) score += 60;
      if (score > bestScore) {
        bestScore = score;
        best = food;
      }
    }
  }
  return bestScore >= 0 ? best : null;
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

function inferFromKcal(kcal) {
  return {
    carb: round1((kcal * 0.5) / 4),
    protein: round1((kcal * 0.2) / 4),
    fat: round1((kcal * 0.3) / 9),
  };
}

// 纯函数：不读写请求结果，只按 SPEC 8.3 校准，方便单测与重算。
export function calibrateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('没识别出食物，换个角度重拍或手动添加');
  }
  const out = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name ?? '').trim() || '未命名食物';
    let grams = toNum(raw.grams);
    let confidence = normalizeConfidence(raw.confidence);
    if (!Number.isFinite(grams) || grams <= 0) {
      grams = 50;
      confidence = 'low';
    } else if (grams > 2000) {
      grams = 500;
      confidence = 'low';
    }
    grams = round1(grams);

    // 模型给了 kind 就按它校准名称匹配的期望：说「这是一道菜」时优先命中菜名。
    const modelKind = raw.kind === 'dish' || raw.kind === 'ingredient' ? raw.kind : null;
    const food = findFood(name, modelKind ? { kind: modelKind } : undefined);
    const item = { name, grams };
    if (food) {
      const ratio = grams / 100;
      const p = food.per100g;
      item.kcal = Math.round(p.kcal * ratio);
      item.carb = round1(p.carb * ratio);
      item.protein = round1(p.protein * ratio);
      item.fat = round1(p.fat * ratio);
      if (Number.isFinite(p.fiber)) item.fiber = round1(p.fiber * ratio);
      if (Number.isFinite(p.sodium)) item.sodium = round1(p.sodium * ratio);
      item.foodId = food.id;
      item.kind = food.kind;
    } else {
      let kcal = toNum(raw.kcal);
      let carb = toNum(raw.carb);
      let protein = toNum(raw.protein);
      let fat = toNum(raw.fat);
      const hasMacros = [carb, protein, fat].every(Number.isFinite);
      if (!Number.isFinite(kcal) && hasMacros) kcal = Math.round(carb * 4 + protein * 4 + fat * 9);
      if (Number.isFinite(kcal) && !hasMacros) {
        const inferred = inferFromKcal(kcal);
        carb = inferred.carb;
        protein = inferred.protein;
        fat = inferred.fat;
      }
      item.kcal = Math.max(0, Math.round(kcal || 0));
      item.carb = round1(Math.max(0, carb || 0));
      item.protein = round1(Math.max(0, protein || 0));
      item.fat = round1(Math.max(0, fat || 0));
      const fiber = toNum(raw.fiber);
      if (Number.isFinite(fiber)) item.fiber = round1(Math.max(0, fiber));
      const sodium = toNum(raw.sodium);
      if (Number.isFinite(sodium)) item.sodium = round1(Math.max(0, sodium));
    }
    if (confidence) item.confidence = confidence;
    if (!item.kind && modelKind) item.kind = modelKind;
    out.push(item);
  }
  if (out.length === 0) throw new Error('没识别出食物，换个角度重拍或手动添加');
  return out;
}
