// 内置食物营养库：纯静态、零依赖、可离线。
// 数值为每 100g 可食部的常见公开营养数据，用于校准模型输出与手动录入，不追求实验室精度。

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
  { id: 'rice', name: '米饭', aliases: ['白米饭', '大米饭'], per100g: { kcal: 116, carb: 25.9, protein: 2.6, fat: 0.3, fiber: 0.3, sodium: 2 }, unit: { name: '1 碗', grams: 200 } },
  { id: 'brown-rice', name: '糙米饭', aliases: ['糙米'], per100g: { kcal: 112, carb: 23.5, protein: 2.7, fat: 0.9, fiber: 1.8, sodium: 3 }, unit: { name: '1 碗', grams: 200 } },
  { id: 'congee', name: '白粥', aliases: ['稀饭', '大米粥'], per100g: { kcal: 46, carb: 9.9, protein: 1.1, fat: 0.2, fiber: 0.1, sodium: 2 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'millet-congee', name: '小米粥', aliases: ['小米稀饭'], per100g: { kcal: 46, carb: 8.4, protein: 1.4, fat: 0.7, fiber: 0.3, sodium: 2 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'steamed-bun', name: '馒头', aliases: ['白馒头'], per100g: { kcal: 223, carb: 47.0, protein: 7.0, fat: 1.1, fiber: 1.3, sodium: 130 }, unit: { name: '1 个', grams: 100 } },
  { id: 'huajuan', name: '花卷', aliases: [], per100g: { kcal: 214, carb: 45.6, protein: 6.4, fat: 1.6, fiber: 1.0, sodium: 120 }, unit: { name: '1 个', grams: 80 } },
  { id: 'whole-wheat-bread', name: '全麦面包', aliases: ['全麦吐司'], per100g: { kcal: 246, carb: 47.0, protein: 9.0, fat: 3.2, fiber: 6.0, sodium: 400 }, unit: { name: '1 片', grams: 35 } },
  { id: 'white-bread', name: '白面包', aliases: ['吐司', '面包'], per100g: { kcal: 280, carb: 51.0, protein: 8.5, fat: 4.5, fiber: 2.7, sodium: 450 }, unit: { name: '1 片', grams: 35 } },
  { id: 'noodles', name: '面条', aliases: ['煮面', '汤面', '面'], per100g: { kcal: 110, carb: 22.8, protein: 3.9, fat: 0.5, fiber: 0.8, sodium: 30 }, unit: { name: '1 碗', grams: 250 } },
  { id: 'dried-noodles', name: '挂面', aliases: ['干面条'], per100g: { kcal: 348, carb: 74.0, protein: 10.5, fat: 0.9, fiber: 1.5, sodium: 180 } },
  { id: 'rice-noodles', name: '米粉', aliases: ['米线', '粉'], per100g: { kcal: 109, carb: 24.9, protein: 1.6, fat: 0.2, fiber: 0.4, sodium: 20 }, unit: { name: '1 碗', grams: 250 } },
  { id: 'hefen', name: '河粉', aliases: ['沙河粉'], per100g: { kcal: 109, carb: 24.5, protein: 1.8, fat: 0.3, fiber: 0.5, sodium: 25 }, unit: { name: '1 碗', grams: 250 } },
  { id: 'dumpling', name: '饺子', aliases: ['水饺', '猪肉饺子'], per100g: { kcal: 230, carb: 25.0, protein: 9.0, fat: 9.5, fiber: 1.0, sodium: 500 }, unit: { name: '1 个', grams: 20 } },
  { id: 'baozi', name: '包子', aliases: ['肉包', '肉包子'], per100g: { kcal: 227, carb: 27.0, protein: 8.0, fat: 9.0, fiber: 1.0, sodium: 450 }, unit: { name: '1 个', grams: 80 } },
  { id: 'youtiao', name: '油条', aliases: [], per100g: { kcal: 388, carb: 51.0, protein: 6.9, fat: 17.6, fiber: 1.0, sodium: 580 }, unit: { name: '1 根', grams: 60 } },
  { id: 'corn', name: '玉米', aliases: ['甜玉米', '玉米棒'], per100g: { kcal: 112, carb: 22.8, protein: 4.0, fat: 1.2, fiber: 2.9, sodium: 3 }, unit: { name: '1 根', grams: 200 } },
  { id: 'sweet-potato', name: '红薯', aliases: ['地瓜', '番薯'], per100g: { kcal: 86, carb: 20.1, protein: 1.6, fat: 0.1, fiber: 3.0, sodium: 30 }, unit: { name: '1 个', grams: 200 } },
  { id: 'potato', name: '土豆', aliases: ['马铃薯'], per100g: { kcal: 77, carb: 17.2, protein: 2.0, fat: 0.2, fiber: 2.2, sodium: 6 }, unit: { name: '1 个', grams: 150 } },
  { id: 'purple-sweet-potato', name: '紫薯', aliases: [], per100g: { kcal: 82, carb: 19.0, protein: 1.3, fat: 0.2, fiber: 2.5, sodium: 25 } },
  { id: 'oats', name: '燕麦片', aliases: ['燕麦'], per100g: { kcal: 377, carb: 66.3, protein: 13.0, fat: 6.7, fiber: 10.0, sodium: 4 }, unit: { name: '1 份', grams: 40 } },
  { id: 'pasta', name: '意大利面', aliases: ['意面'], per100g: { kcal: 158, carb: 30.9, protein: 5.8, fat: 0.9, fiber: 1.8, sodium: 6 }, unit: { name: '1 份', grams: 200 } },
  { id: 'rice-cake', name: '年糕', aliases: [], per100g: { kcal: 154, carb: 34.0, protein: 3.3, fat: 0.6, fiber: 0.6, sodium: 30 } },
  { id: 'shaobing', name: '烧饼', aliases: [], per100g: { kcal: 326, carb: 52.0, protein: 8.0, fat: 10.0, fiber: 1.5, sodium: 500 }, unit: { name: '1 个', grams: 100 } },
  { id: 'zongzi', name: '粽子', aliases: [], per100g: { kcal: 195, carb: 35.0, protein: 5.5, fat: 3.9, fiber: 0.9, sodium: 250 }, unit: { name: '1 个', grams: 150 } },

  // —— 肉禽 ——
  { id: 'chicken-breast', name: '鸡胸肉', aliases: ['鸡胸', '鸡脯肉'], per100g: { kcal: 133, carb: 0.5, protein: 24.6, fat: 2.5, fiber: 0, sodium: 45 } },
  { id: 'chicken-leg', name: '鸡腿', aliases: ['鸡腿肉'], per100g: { kcal: 181, carb: 0, protein: 20.0, fat: 11.0, fiber: 0, sodium: 70 }, unit: { name: '1 个', grams: 100 } },
  { id: 'chicken-wing', name: '鸡翅', aliases: ['鸡翅中'], per100g: { kcal: 194, carb: 0.6, protein: 19.0, fat: 12.7, fiber: 0, sodium: 80 }, unit: { name: '1 个', grams: 40 } },
  { id: 'chicken-feet', name: '鸡爪', aliases: ['凤爪'], per100g: { kcal: 254, carb: 2.7, protein: 23.9, fat: 16.4, fiber: 0, sodium: 170 } },
  { id: 'egg', name: '鸡蛋', aliases: ['水煮蛋', '煮鸡蛋', '蛋'], per100g: { kcal: 144, carb: 1.5, protein: 13.3, fat: 8.8, fiber: 0, sodium: 130 }, unit: { name: '1 个', grams: 50 } },
  { id: 'egg-white', name: '蛋清', aliases: ['蛋白', '鸡蛋清'], per100g: { kcal: 60, carb: 2.4, protein: 11.6, fat: 0.1, fiber: 0, sodium: 160 } },
  { id: 'egg-yolk', name: '蛋黄', aliases: ['鸡蛋黄'], per100g: { kcal: 328, carb: 3.6, protein: 15.2, fat: 28.2, fiber: 0, sodium: 50 }, unit: { name: '1 个', grams: 20 } },
  { id: 'pork-lean', name: '猪肉', aliases: ['瘦猪肉', '猪瘦肉'], per100g: { kcal: 143, carb: 1.5, protein: 20.3, fat: 6.2, fiber: 0, sodium: 60 } },
  { id: 'pork-belly', name: '五花肉', aliases: ['猪五花', '肥肉'], per100g: { kcal: 518, carb: 0, protein: 9.3, fat: 53.0, fiber: 0, sodium: 55 } },
  { id: 'pork-mince', name: '猪肉馅', aliases: ['肉末', '肉馅'], per100g: { kcal: 278, carb: 1.0, protein: 15.0, fat: 23.0, fiber: 0, sodium: 80 } },
  { id: 'beef-lean', name: '牛肉', aliases: ['瘦牛肉'], per100g: { kcal: 106, carb: 1.2, protein: 20.2, fat: 2.3, fiber: 0, sodium: 55 } },
  { id: 'beef-brisket', name: '牛腩', aliases: ['牛腩肉'], per100g: { kcal: 154, carb: 0, protein: 17.0, fat: 9.0, fiber: 0, sodium: 60 } },
  { id: 'lamb', name: '羊肉', aliases: ['瘦羊肉'], per100g: { kcal: 118, carb: 0.2, protein: 20.5, fat: 3.9, fiber: 0, sodium: 70 } },
  { id: 'sausage', name: '火腿肠', aliases: ['香肠', '火腿'], per100g: { kcal: 212, carb: 12.0, protein: 13.0, fat: 12.0, fiber: 0, sodium: 800 }, unit: { name: '1 根', grams: 50 } },
  { id: 'bacon', name: '培根', aliases: [], per100g: { kcal: 541, carb: 0.6, protein: 37.0, fat: 42.0, fiber: 0, sodium: 1400 }, unit: { name: '1 片', grams: 15 } },
  { id: 'duck', name: '鸭肉', aliases: ['鸭'], per100g: { kcal: 240, carb: 0.2, protein: 15.5, fat: 19.7, fiber: 0, sodium: 70 } },
  { id: 'roast-duck', name: '烤鸭', aliases: ['北京烤鸭'], per100g: { kcal: 436, carb: 3.0, protein: 16.6, fat: 38.4, fiber: 0, sodium: 600 } },
  { id: 'pork-liver', name: '猪肝', aliases: ['猪肝片'], per100g: { kcal: 126, carb: 5.0, protein: 19.3, fat: 3.5, fiber: 0, sodium: 68 } },

  // —— 水产 ——
  { id: 'salmon', name: '三文鱼', aliases: ['鲑鱼'], per100g: { kcal: 139, carb: 0, protein: 17.2, fat: 7.8, fiber: 0, sodium: 50 } },
  { id: 'hairtail', name: '带鱼', aliases: [], per100g: { kcal: 127, carb: 3.1, protein: 17.7, fat: 4.9, fiber: 0, sodium: 150 } },
  { id: 'grass-carp', name: '草鱼', aliases: [], per100g: { kcal: 113, carb: 0, protein: 16.6, fat: 5.2, fiber: 0, sodium: 46 } },
  { id: 'seabass', name: '鲈鱼', aliases: [], per100g: { kcal: 105, carb: 0, protein: 18.6, fat: 3.4, fiber: 0, sodium: 144 } },
  { id: 'shrimp', name: '虾仁', aliases: ['虾肉'], per100g: { kcal: 48, carb: 0.9, protein: 10.6, fat: 0.4, fiber: 0, sodium: 80 } },
  { id: 'prawn', name: '基围虾', aliases: ['虾', '大虾'], per100g: { kcal: 101, carb: 1.5, protein: 18.2, fat: 2.3, fiber: 0, sodium: 172 }, unit: { name: '1 只', grams: 15 } },
  { id: 'squid', name: '鱿鱼', aliases: ['鱿鱼须'], per100g: { kcal: 75, carb: 1.0, protein: 15.0, fat: 1.1, fiber: 0, sodium: 110 } },
  { id: 'clam', name: '蛤蜊', aliases: ['花蛤', '蛤蜊肉'], per100g: { kcal: 62, carb: 2.8, protein: 10.1, fat: 1.1, fiber: 0, sodium: 425 } },
  { id: 'kelp', name: '海带', aliases: ['海带丝', '昆布'], per100g: { kcal: 13, carb: 2.1, protein: 1.2, fat: 0.1, fiber: 0.5, sodium: 233 } },
  { id: 'nori', name: '紫菜', aliases: ['海苔'], per100g: { kcal: 250, carb: 44.1, protein: 26.7, fat: 1.1, fiber: 21.6, sodium: 710 } },

  // —— 蛋奶 ——
  { id: 'milk', name: '牛奶', aliases: ['纯牛奶', '全脂牛奶'], per100g: { kcal: 54, carb: 3.4, protein: 3.0, fat: 3.2, fiber: 0, sodium: 37 }, unit: { name: '1 杯', grams: 200 } },
  { id: 'lowfat-milk', name: '低脂牛奶', aliases: ['脱脂牛奶'], per100g: { kcal: 42, carb: 5.0, protein: 3.4, fat: 1.0, fiber: 0, sodium: 40 }, unit: { name: '1 杯', grams: 200 } },
  { id: 'yogurt', name: '酸奶', aliases: ['原味酸奶'], per100g: { kcal: 72, carb: 9.3, protein: 2.5, fat: 2.7, fiber: 0, sodium: 40 }, unit: { name: '1 杯', grams: 200 } },
  { id: 'greek-yogurt', name: '希腊酸奶', aliases: [], per100g: { kcal: 59, carb: 3.6, protein: 10.0, fat: 0.4, fiber: 0, sodium: 36 } },
  { id: 'cheese', name: '奶酪', aliases: ['芝士', '干酪'], per100g: { kcal: 328, carb: 3.5, protein: 25.0, fat: 26.0, fiber: 0, sodium: 600 }, unit: { name: '1 片', grams: 20 } },
  { id: 'soymilk', name: '豆浆', aliases: ['无糖豆浆'], per100g: { kcal: 31, carb: 1.2, protein: 3.0, fat: 1.6, fiber: 0.2, sodium: 5 }, unit: { name: '1 杯', grams: 250 } },
  { id: 'milk-powder', name: '奶粉', aliases: ['全脂奶粉'], per100g: { kcal: 478, carb: 51.0, protein: 20.0, fat: 21.0, fiber: 0, sodium: 370 } },

  // —— 豆制品 ——
  { id: 'tofu-firm', name: '豆腐', aliases: ['北豆腐', '老豆腐'], per100g: { kcal: 98, carb: 2.0, protein: 12.2, fat: 4.8, fiber: 0.5, sodium: 7 } },
  { id: 'tofu-silken', name: '内酯豆腐', aliases: ['嫩豆腐', '南豆腐'], per100g: { kcal: 50, carb: 2.9, protein: 5.0, fat: 2.4, fiber: 0.4, sodium: 6 } },
  { id: 'tofu-dried', name: '豆腐干', aliases: ['香干', '豆干'], per100g: { kcal: 140, carb: 6.2, protein: 16.2, fat: 3.6, fiber: 0.8, sodium: 330 } },
  { id: 'tofu-skin', name: '豆腐皮', aliases: ['油豆皮'], per100g: { kcal: 409, carb: 18.8, protein: 44.6, fat: 17.4, fiber: 0.2, sodium: 20 } },
  { id: 'fuzhu', name: '腐竹', aliases: ['腐竹段'], per100g: { kcal: 459, carb: 22.3, protein: 44.6, fat: 21.7, fiber: 1.0, sodium: 27 } },
  { id: 'soybean', name: '黄豆', aliases: ['大豆'], per100g: { kcal: 390, carb: 34.2, protein: 35.0, fat: 16.0, fiber: 15.5, sodium: 2 } },
  { id: 'edamame', name: '毛豆', aliases: ['青豆'], per100g: { kcal: 131, carb: 10.5, protein: 13.1, fat: 5.0, fiber: 4.0, sodium: 3 } },
  { id: 'bean-sprout', name: '豆芽', aliases: ['黄豆芽', '绿豆芽'], per100g: { kcal: 18, carb: 2.1, protein: 2.1, fat: 0.1, fiber: 0.8, sodium: 5 } },
  { id: 'qianzhang', name: '千张', aliases: ['百叶', '豆皮'], per100g: { kcal: 262, carb: 5.5, protein: 24.5, fat: 16.0, fiber: 1.0, sodium: 30 } },

  // —— 蔬菜 ——
  { id: 'broccoli', name: '西兰花', aliases: ['西蓝花'], per100g: { kcal: 36, carb: 4.3, protein: 4.1, fat: 0.6, fiber: 1.6, sodium: 33 } },
  { id: 'spinach', name: '菠菜', aliases: [], per100g: { kcal: 28, carb: 4.5, protein: 2.6, fat: 0.3, fiber: 1.7, sodium: 85 } },
  { id: 'lettuce', name: '生菜', aliases: ['叶用生菜'], per100g: { kcal: 15, carb: 2.0, protein: 1.3, fat: 0.3, fiber: 0.7, sodium: 32 } },
  { id: 'cabbage', name: '白菜', aliases: ['大白菜'], per100g: { kcal: 17, carb: 3.2, protein: 1.5, fat: 0.1, fiber: 0.8, sodium: 57 } },
  { id: 'bok-choy', name: '油菜', aliases: ['小白菜', '青菜'], per100g: { kcal: 23, carb: 3.8, protein: 1.8, fat: 0.5, fiber: 1.1, sodium: 74 } },
  { id: 'celery', name: '芹菜', aliases: ['西芹'], per100g: { kcal: 20, carb: 3.3, protein: 1.2, fat: 0.2, fiber: 1.2, sodium: 159 } },
  { id: 'cucumber', name: '黄瓜', aliases: ['青瓜'], per100g: { kcal: 16, carb: 2.9, protein: 0.8, fat: 0.2, fiber: 0.5, sodium: 5 } },
  { id: 'tomato', name: '番茄', aliases: ['西红柿'], per100g: { kcal: 20, carb: 4.0, protein: 0.9, fat: 0.2, fiber: 0.5, sodium: 5 } },
  { id: 'eggplant', name: '茄子', aliases: [], per100g: { kcal: 23, carb: 4.9, protein: 1.1, fat: 0.2, fiber: 1.3, sodium: 5 } },
  { id: 'green-pepper', name: '青椒', aliases: ['柿子椒', '彩椒'], per100g: { kcal: 22, carb: 5.4, protein: 1.0, fat: 0.2, fiber: 1.4, sodium: 3 } },
  { id: 'carrot', name: '胡萝卜', aliases: ['红萝卜'], per100g: { kcal: 39, carb: 8.8, protein: 1.0, fat: 0.2, fiber: 1.1, sodium: 71 } },
  { id: 'radish', name: '白萝卜', aliases: ['萝卜'], per100g: { kcal: 21, carb: 5.0, protein: 0.9, fat: 0.1, fiber: 1.0, sodium: 62 } },
  { id: 'onion', name: '洋葱', aliases: ['圆葱'], per100g: { kcal: 40, carb: 9.0, protein: 1.1, fat: 0.2, fiber: 0.9, sodium: 4 } },
  { id: 'wood-ear', name: '木耳', aliases: ['黑木耳'], per100g: { kcal: 265, carb: 65.6, protein: 12.1, fat: 1.5, fiber: 29.9, sodium: 48 } },
  { id: 'shiitake', name: '香菇', aliases: ['冬菇'], per100g: { kcal: 26, carb: 5.2, protein: 2.2, fat: 0.3, fiber: 3.3, sodium: 1 } },
  { id: 'enoki', name: '金针菇', aliases: [], per100g: { kcal: 32, carb: 6.0, protein: 2.4, fat: 0.4, fiber: 2.7, sodium: 4 } },
  { id: 'pumpkin', name: '南瓜', aliases: ['倭瓜'], per100g: { kcal: 23, carb: 5.3, protein: 0.7, fat: 0.1, fiber: 0.8, sodium: 1 } },
  { id: 'wax-gourd', name: '冬瓜', aliases: [], per100g: { kcal: 12, carb: 2.6, protein: 0.4, fat: 0.2, fiber: 0.7, sodium: 1 } },
  { id: 'bitter-melon', name: '苦瓜', aliases: ['凉瓜'], per100g: { kcal: 19, carb: 4.3, protein: 0.7, fat: 0.1, fiber: 1.4, sodium: 2 } },
  { id: 'lotus-root', name: '莲藕', aliases: ['藕'], per100g: { kcal: 73, carb: 16.4, protein: 1.9, fat: 0.2, fiber: 1.2, sodium: 44 } },
  { id: 'yam', name: '山药', aliases: ['淮山'], per100g: { kcal: 57, carb: 12.4, protein: 1.9, fat: 0.2, fiber: 0.8, sodium: 18 } },
  { id: 'okra', name: '秋葵', aliases: ['羊角豆'], per100g: { kcal: 37, carb: 7.5, protein: 1.9, fat: 0.2, fiber: 3.2, sodium: 3 } },

  // —— 水果 ——
  { id: 'apple', name: '苹果', aliases: ['红富士'], per100g: { kcal: 53, carb: 13.7, protein: 0.4, fat: 0.2, fiber: 1.7, sodium: 1 }, unit: { name: '1 个', grams: 200 } },
  { id: 'banana', name: '香蕉', aliases: [], per100g: { kcal: 93, carb: 22.0, protein: 1.4, fat: 0.2, fiber: 1.2, sodium: 1 }, unit: { name: '1 根', grams: 120 } },
  { id: 'orange', name: '橙子', aliases: ['橙', '脐橙'], per100g: { kcal: 48, carb: 11.1, protein: 0.8, fat: 0.2, fiber: 2.4, sodium: 1 } },
  { id: 'watermelon', name: '西瓜', aliases: [], per100g: { kcal: 31, carb: 7.9, protein: 0.5, fat: 0.1, fiber: 0.3, sodium: 3 } },
  { id: 'grape', name: '葡萄', aliases: ['提子'], per100g: { kcal: 45, carb: 10.3, protein: 0.4, fat: 0.3, fiber: 0.4, sodium: 2 } },
  { id: 'strawberry', name: '草莓', aliases: [], per100g: { kcal: 32, carb: 7.1, protein: 1.0, fat: 0.2, fiber: 1.1, sodium: 4 } },
  { id: 'pear', name: '梨', aliases: ['雪梨', '鸭梨'], per100g: { kcal: 50, carb: 13.3, protein: 0.4, fat: 0.2, fiber: 3.1, sodium: 2 } },
  { id: 'kiwi', name: '猕猴桃', aliases: ['奇异果'], per100g: { kcal: 61, carb: 14.5, protein: 0.8, fat: 0.6, fiber: 2.6, sodium: 3 } },
  { id: 'blueberry', name: '蓝莓', aliases: [], per100g: { kcal: 57, carb: 14.5, protein: 0.7, fat: 0.3, fiber: 2.4, sodium: 1 } },
  { id: 'mango', name: '芒果', aliases: [], per100g: { kcal: 60, carb: 15.0, protein: 0.8, fat: 0.4, fiber: 1.6, sodium: 1 } },
  { id: 'peach', name: '桃子', aliases: ['水蜜桃'], per100g: { kcal: 42, carb: 10.1, protein: 0.6, fat: 0.1, fiber: 1.3, sodium: 1 } },
  { id: 'dragon-fruit', name: '火龙果', aliases: ['红心火龙果'], per100g: { kcal: 55, carb: 13.3, protein: 1.1, fat: 0.2, fiber: 1.6, sodium: 2 } },
  { id: 'pomelo', name: '柚子', aliases: ['西柚'], per100g: { kcal: 42, carb: 9.5, protein: 0.8, fat: 0.2, fiber: 1.0, sodium: 1 } },
  { id: 'lychee', name: '荔枝', aliases: [], per100g: { kcal: 71, carb: 16.6, protein: 0.8, fat: 0.4, fiber: 1.3, sodium: 1 } },
  { id: 'cherry', name: '樱桃', aliases: ['车厘子'], per100g: { kcal: 46, carb: 10.2, protein: 1.1, fat: 0.2, fiber: 0.3, sodium: 1 } },
  { id: 'avocado', name: '牛油果', aliases: ['鳄梨'], per100g: { kcal: 160, carb: 8.5, protein: 2.0, fat: 14.7, fiber: 6.7, sodium: 7 } },

  // —— 坚果 ——
  { id: 'peanut', name: '花生', aliases: ['花生米'], per100g: { kcal: 574, carb: 16.1, protein: 24.8, fat: 44.3, fiber: 5.5, sodium: 3 } },
  { id: 'walnut', name: '核桃', aliases: ['核桃仁'], per100g: { kcal: 646, carb: 13.7, protein: 14.9, fat: 58.8, fiber: 6.1, sodium: 6 } },
  { id: 'almond', name: '杏仁', aliases: ['巴旦木'], per100g: { kcal: 579, carb: 21.6, protein: 21.2, fat: 49.9, fiber: 12.5, sodium: 1 } },
  { id: 'cashew', name: '腰果', aliases: [], per100g: { kcal: 553, carb: 30.2, protein: 18.2, fat: 43.9, fiber: 3.6, sodium: 12 } },
  { id: 'sunflower-seed', name: '瓜子', aliases: ['葵花籽'], per100g: { kcal: 606, carb: 12.5, protein: 19.1, fat: 52.8, fiber: 4.5, sodium: 5 } },
  { id: 'pistachio', name: '开心果', aliases: [], per100g: { kcal: 562, carb: 27.2, protein: 20.2, fat: 45.3, fiber: 10.6, sodium: 10 } },
  { id: 'sesame', name: '芝麻', aliases: ['黑芝麻', '白芝麻'], per100g: { kcal: 573, carb: 24.0, protein: 17.3, fat: 46.0, fiber: 11.8, sodium: 11 } },
  { id: 'raisin', name: '葡萄干', aliases: [], per100g: { kcal: 341, carb: 83.4, protein: 2.5, fat: 0.4, fiber: 1.6, sodium: 11 } },

  // —— 油与调味 ——
  { id: 'vegetable-oil', name: '植物油', aliases: ['食用油', '大豆油'], per100g: { kcal: 899, carb: 0, protein: 0, fat: 99.9, fiber: 0, sodium: 0 }, unit: { name: '1 勺', grams: 10 } },
  { id: 'peanut-oil', name: '花生油', aliases: [], per100g: { kcal: 899, carb: 0, protein: 0, fat: 99.9, fiber: 0, sodium: 0 }, unit: { name: '1 勺', grams: 10 } },
  { id: 'olive-oil', name: '橄榄油', aliases: [], per100g: { kcal: 899, carb: 0, protein: 0, fat: 99.9, fiber: 0, sodium: 0 }, unit: { name: '1 勺', grams: 10 } },
  { id: 'butter', name: '黄油', aliases: [], per100g: { kcal: 717, carb: 0.1, protein: 0.9, fat: 81.1, fiber: 0, sodium: 643 }, unit: { name: '1 小块', grams: 10 } },
  { id: 'sugar', name: '白砂糖', aliases: ['白糖', '糖'], per100g: { kcal: 400, carb: 99.9, protein: 0, fat: 0, fiber: 0, sodium: 1 }, unit: { name: '1 小勺', grams: 5 } },
  { id: 'honey', name: '蜂蜜', aliases: [], per100g: { kcal: 321, carb: 75.6, protein: 0.4, fat: 1.9, fiber: 0, sodium: 4 }, unit: { name: '1 勺', grams: 15 } },
  { id: 'soy-sauce', name: '酱油', aliases: ['生抽', '老抽'], per100g: { kcal: 63, carb: 10.1, protein: 5.6, fat: 0.1, fiber: 0, sodium: 5757 }, unit: { name: '1 勺', grams: 15 } },
  { id: 'vinegar', name: '醋', aliases: ['米醋', '陈醋'], per100g: { kcal: 31, carb: 4.9, protein: 2.1, fat: 0.3, fiber: 0, sodium: 262 } },

  // —— 饮料 ——
  { id: 'cola', name: '可乐', aliases: ['可口可乐', '汽水'], per100g: { kcal: 43, carb: 10.8, protein: 0, fat: 0, fiber: 0, sodium: 4 }, unit: { name: '1 罐', grams: 330 } },
  { id: 'cola-zero', name: '无糖可乐', aliases: ['零度可乐', '健怡可乐'], per100g: { kcal: 0, carb: 0, protein: 0, fat: 0, fiber: 0, sodium: 10 }, unit: { name: '1 罐', grams: 330 } },
  { id: 'orange-juice', name: '橙汁', aliases: ['果汁'], per100g: { kcal: 45, carb: 10.4, protein: 0.7, fat: 0.2, fiber: 0.2, sodium: 1 }, unit: { name: '1 杯', grams: 250 } },
  { id: 'beer', name: '啤酒', aliases: [], per100g: { kcal: 32, carb: 2.9, protein: 0.3, fat: 0, fiber: 0, sodium: 11 }, unit: { name: '1 罐', grams: 330 } },
  { id: 'latte', name: '拿铁咖啡', aliases: ['拿铁'], per100g: { kcal: 42, carb: 4.0, protein: 2.4, fat: 1.6, fiber: 0, sodium: 30 }, unit: { name: '1 杯', grams: 350 } },
  { id: 'americano', name: '美式咖啡', aliases: ['黑咖啡'], per100g: { kcal: 1, carb: 0, protein: 0.1, fat: 0, fiber: 0, sodium: 2 }, unit: { name: '1 杯', grams: 350 } },
  { id: 'milk-tea', name: '奶茶', aliases: ['珍珠奶茶'], per100g: { kcal: 76, carb: 12.0, protein: 1.2, fat: 2.6, fiber: 0, sodium: 25 }, unit: { name: '1 杯', grams: 500 } },
  { id: 'green-tea', name: '绿茶', aliases: ['无糖茶'], per100g: { kcal: 1, carb: 0, protein: 0.1, fat: 0, fiber: 0, sodium: 1 }, unit: { name: '1 杯', grams: 250 } },

  // —— 常见菜品 / 外卖 ——
  { id: 'kung-pao-chicken', name: '宫保鸡丁', aliases: ['宫爆鸡丁'], per100g: { kcal: 196, carb: 9.5, protein: 13.5, fat: 12.0, fiber: 1.2, sodium: 700 }, unit: { name: '1 份', grams: 250 } },
  { id: 'mapo-tofu', name: '麻婆豆腐', aliases: [], per100g: { kcal: 137, carb: 5.0, protein: 8.5, fat: 9.5, fiber: 0.8, sodium: 750 }, unit: { name: '1 份', grams: 250 } },
  { id: 'yuxiang-pork', name: '鱼香肉丝', aliases: [], per100g: { kcal: 168, carb: 9.0, protein: 9.5, fat: 11.0, fiber: 1.0, sodium: 800 }, unit: { name: '1 份', grams: 250 } },
  { id: 'braised-pork', name: '红烧肉', aliases: [], per100g: { kcal: 472, carb: 5.0, protein: 10.0, fat: 46.0, fiber: 0, sodium: 600 }, unit: { name: '1 份', grams: 150 } },
  { id: 'tomato-egg', name: '番茄炒蛋', aliases: ['西红柿炒鸡蛋'], per100g: { kcal: 86, carb: 4.5, protein: 4.5, fat: 5.5, fiber: 0.6, sodium: 450 }, unit: { name: '1 份', grams: 200 } },
  { id: 'stir-broccoli', name: '清炒西兰花', aliases: ['炒西兰花'], per100g: { kcal: 52, carb: 4.8, protein: 3.0, fat: 2.6, fiber: 1.6, sodium: 320 }, unit: { name: '1 份', grams: 200 } },
  { id: 'stir-greens', name: '炒青菜', aliases: ['清炒时蔬'], per100g: { kcal: 60, carb: 4.0, protein: 1.8, fat: 4.2, fiber: 1.2, sodium: 380 }, unit: { name: '1 份', grams: 200 } },
  { id: 'malatang', name: '麻辣烫', aliases: ['冒菜'], per100g: { kcal: 110, carb: 8.0, protein: 7.0, fat: 6.0, fiber: 1.5, sodium: 900 }, unit: { name: '1 份', grams: 600 } },
  { id: 'beef-noodles', name: '牛肉面', aliases: ['红烧牛肉面'], per100g: { kcal: 127, carb: 17.0, protein: 6.5, fat: 3.5, fiber: 0.8, sodium: 700 }, unit: { name: '1 碗', grams: 600 } },
  { id: 'lanzhou-noodles', name: '兰州拉面', aliases: ['拉面'], per100g: { kcal: 121, carb: 20.0, protein: 6.0, fat: 2.5, fiber: 0.7, sodium: 800 }, unit: { name: '1 碗', grams: 600 } },
  { id: 'fried-rice', name: '炒饭', aliases: ['扬州炒饭'], per100g: { kcal: 163, carb: 24.0, protein: 5.0, fat: 5.5, fiber: 0.6, sodium: 600 }, unit: { name: '1 份', grams: 300 } },
  { id: 'egg-fried-rice', name: '蛋炒饭', aliases: [], per100g: { kcal: 170, carb: 24.5, protein: 5.2, fat: 5.8, fiber: 0.6, sodium: 620 }, unit: { name: '1 份', grams: 300 } },
  { id: 'pizza', name: '披萨', aliases: ['比萨'], per100g: { kcal: 266, carb: 33.0, protein: 11.0, fat: 10.0, fiber: 2.0, sodium: 600 }, unit: { name: '1 块', grams: 100 } },
  { id: 'hamburger', name: '汉堡', aliases: ['汉堡包', '牛肉汉堡'], per100g: { kcal: 250, carb: 28.0, protein: 13.0, fat: 10.0, fiber: 1.5, sodium: 500 }, unit: { name: '1 个', grams: 110 } },
  { id: 'fries', name: '薯条', aliases: ['炸薯条'], per100g: { kcal: 312, carb: 41.0, protein: 3.4, fat: 15.0, fiber: 3.8, sodium: 210 }, unit: { name: '1 份', grams: 100 } },
  { id: 'fried-chicken', name: '炸鸡', aliases: ['炸鸡块'], per100g: { kcal: 279, carb: 11.0, protein: 22.0, fat: 17.0, fiber: 0.5, sodium: 700 }, unit: { name: '1 块', grams: 100 } },
  { id: 'vegetable-salad', name: '蔬菜沙拉', aliases: ['沙拉', '轻食沙拉'], per100g: { kcal: 35, carb: 4.0, protein: 1.5, fat: 1.5, fiber: 1.4, sodium: 150 }, unit: { name: '1 份', grams: 200 } },
  { id: 'sandwich', name: '三明治', aliases: [], per100g: { kcal: 240, carb: 28.0, protein: 12.0, fat: 8.5, fiber: 1.8, sodium: 550 }, unit: { name: '1 个', grams: 150 } },
  { id: 'hot-sour-soup', name: '酸辣汤', aliases: [], per100g: { kcal: 45, carb: 5.0, protein: 2.5, fat: 1.8, fiber: 0.4, sodium: 500 }, unit: { name: '1 碗', grams: 300 } },
  { id: 'xiaolongbao', name: '小笼包', aliases: ['小笼'], per100g: { kcal: 220, carb: 24.0, protein: 9.0, fat: 9.5, fiber: 0.8, sodium: 480 }, unit: { name: '1 个', grams: 30 } },
  { id: 'sushi', name: '寿司', aliases: ['寿司卷'], per100g: { kcal: 150, carb: 28.0, protein: 6.0, fat: 1.5, fiber: 0.6, sodium: 400 }, unit: { name: '1 个', grams: 30 } },
  { id: 'jianbing', name: '煎饼果子', aliases: ['煎饼'], per100g: { kcal: 257, carb: 34.0, protein: 8.0, fat: 9.5, fiber: 1.2, sodium: 550 }, unit: { name: '1 份', grams: 200 } },
  { id: 'pidan-congee', name: '皮蛋瘦肉粥', aliases: ['瘦肉粥'], per100g: { kcal: 48, carb: 7.5, protein: 2.8, fat: 1.0, fiber: 0.1, sodium: 300 }, unit: { name: '1 碗', grams: 300 } },

  // —— 零食 ——
  { id: 'chocolate', name: '巧克力', aliases: ['黑巧克力'], per100g: { kcal: 546, carb: 61.0, protein: 4.9, fat: 31.0, fiber: 3.4, sodium: 24 } },
  { id: 'potato-chips', name: '薯片', aliases: [], per100g: { kcal: 548, carb: 52.9, protein: 6.5, fat: 34.0, fiber: 4.4, sodium: 525 } },
  { id: 'instant-noodles', name: '方便面', aliases: ['泡面'], per100g: { kcal: 472, carb: 61.6, protein: 9.5, fat: 20.0, fiber: 2.0, sodium: 1144 }, unit: { name: '1 包', grams: 100 } },
  { id: 'ice-cream', name: '冰激凌', aliases: ['冰淇淋', '雪糕'], per100g: { kcal: 207, carb: 24.0, protein: 3.5, fat: 11.0, fiber: 0.7, sodium: 80 } },
  { id: 'mooncake', name: '月饼', aliases: [], per100g: { kcal: 400, carb: 60.0, protein: 6.0, fat: 15.0, fiber: 1.0, sodium: 200 }, unit: { name: '1 个', grams: 100 } },
  { id: 'cake', name: '蛋糕', aliases: ['奶油蛋糕'], per100g: { kcal: 348, carb: 50.0, protein: 6.0, fat: 13.0, fiber: 0.8, sodium: 250 }, unit: { name: '1 块', grams: 100 } },
];

const HOT_IDS = ['rice', 'egg', 'chicken-breast', 'milk', 'banana', 'apple', 'noodles', 'tomato', 'broccoli', 'sweet-potato'];

// 空查询用于「手动添加」首页：先给最常吃的，再按库内顺序补足。
const HOT_FOODS = HOT_IDS.map((id) => FOODS.find((f) => f.id === id)).filter(Boolean);

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
    if (score !== Infinity) scored.push({ food, score, index, len: normalizeName(food.name).length });
  }
  scored.sort((a, b) => a.score - b.score || a.len - b.len || a.index - b.index);
  return scored.slice(0, max).map((s) => s.food);
}

export function findFood(name) {
  const raw = normalizeName(name);
  if (!raw) return null;
  const keys = [...new Set([raw, normalizeName(stripQuantity(raw))])].filter(Boolean);
  let best = null;
  let bestScore = -1;
  for (const food of FOODS) {
    const names = [food.name, ...(food.aliases || [])].map(normalizeName).filter(Boolean);
    for (const n of names) {
      const nShort = normalizeName(stripQuantity(n)) || n;
      let score = -1;
      for (const k of keys) {
        if (k === n || k === nShort) score = Math.max(score, 1000 + Math.min(n.length, nShort.length));
        else if (n.length >= 2 && k.includes(n)) score = Math.max(score, 400 + n.length);
        else if (n.length >= 2 && n.includes(k) && k.length >= 2) score = Math.max(score, 200 + k.length);
      }
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

    const food = findFood(name);
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
    out.push(item);
  }
  if (out.length === 0) throw new Error('没识别出食物，换个角度重拍或手动添加');
  return out;
}
