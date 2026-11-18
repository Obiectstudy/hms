/**
 * 食物库数据闸门（调度者独立校验，不依赖实现方自己的测试）。
 * 只验结构与自洽性，不评判"某道菜 180 kcal 是否真的准确"——那需要专业营养师。
 */
const foodMod = await import('../js/foods.js');
const { FOODS, searchFoods, findFood, calibrateItems } = foodMod;
const foodUnits = typeof foodMod.foodUnits === 'function' ? foodMod.foodUnits : null;

const TOL_RATIO = 0.30;
const TOL_ABS = 30;

async function run() {
  const failures = [];
  let passed = 0;
  const check = (name, ok, detail = '') => {
    if (ok) { passed++; return; }
    failures.push({ name, error: detail || '断言失败' });
  };

  check('FOODS 已导出为数组', Array.isArray(FOODS), `实际类型 ${typeof FOODS}`);
  if (!Array.isArray(FOODS)) return { passed, failed: failures.length, failures };

  check('总条数 ≥ 450', FOODS.length >= 450, `实际 ${FOODS.length}`);
  const dishes = FOODS.filter((f) => f.kind === 'dish');
  const ingredients = FOODS.filter((f) => f.kind !== 'dish');
  check('成品菜（kind=dish）≥ 250', dishes.length >= 250, `实际 ${dishes.length}`);
  check('原料（kind!=dish）≥ 150', ingredients.length >= 150, `实际 ${ingredients.length}`);

  // 唯一性
  const dupId = FOODS.map((f) => f.id).filter((v, i, a) => a.indexOf(v) !== i);
  const dupName = FOODS.map((f) => f.name).filter((v, i, a) => a.indexOf(v) !== i);
  check('id 无重复', dupId.length === 0, `重复: ${[...new Set(dupId)].slice(0, 5).join(',')}`);
  check('name 无重复', dupName.length === 0, `重复: ${[...new Set(dupName)].slice(0, 5).join(',')}`);

  // 逐条字段与自洽性
  const bad = { missing: [], nonFinite: [], kcalOff: [], macroSum: [], kcalRange: [], unit: [] };
  for (const f of FOODS) {
    if (!f || typeof f.name !== 'string' || !f.name.trim() || typeof f.id !== 'string' || !f.id.trim() || !f.per100g) {
      bad.missing.push(f?.name ?? '(无名)');
      continue;
    }
    const p = f.per100g;
    const nums = [p.kcal, p.carb, p.protein, p.fat];
    if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
      bad.nonFinite.push(f.name);
      continue;
    }
    const calc = p.carb * 4 + p.protein * 4 + p.fat * 9;
    const tol = Math.max(TOL_ABS, p.kcal * TOL_RATIO);
    if (Math.abs(calc - p.kcal) > tol) bad.kcalOff.push(`${f.name}(标${p.kcal}/算${Math.round(calc)})`);
    if (p.carb + p.protein + p.fat > 100.5) bad.macroSum.push(`${f.name}(${(p.carb + p.protein + p.fat).toFixed(1)})`);
    if (p.kcal > 920) bad.kcalRange.push(`${f.name}(${p.kcal})`);
    if (f.unit) {
      const g = f.unit.grams;
      if (typeof g !== 'number' || !Number.isFinite(g) || g < 5 || g > 1000 || typeof f.unit.name !== 'string') {
        bad.unit.push(`${f.name}(${JSON.stringify(f.unit)})`);
      }
    }
    if (f.aliases !== undefined) {
      if (!Array.isArray(f.aliases) || f.aliases.some((a) => typeof a !== 'string' || !a.trim())) bad.missing.push(`${f.name}(aliases 非法)`);
    }
    if (f.kind !== undefined && f.kind !== 'dish' && f.kind !== 'ingredient') bad.missing.push(`${f.name}(kind=${f.kind})`);
  }
  check('字段齐全（name/id/per100g）', bad.missing.length === 0, bad.missing.slice(0, 6).join(', '));
  check('营养值均为有限非负数', bad.nonFinite.length === 0, bad.nonFinite.slice(0, 6).join(', '));
  check('kcal 与 4/4/9 自洽（±30% 或 ±30kcal）', bad.kcalOff.length === 0, `${bad.kcalOff.length} 条: ${bad.kcalOff.slice(0, 6).join(', ')}`);
  check('碳水+蛋白+脂肪 ≤ 100g/100g', bad.macroSum.length === 0, bad.macroSum.slice(0, 6).join(', '));
  check('kcal ≤ 920（纯油上限）', bad.kcalRange.length === 0, bad.kcalRange.slice(0, 6).join(', '));
  check('份量单位克数合理（5–1000g）', bad.unit.length === 0, bad.unit.slice(0, 6).join(', '));

  // 用户当场试过的那些菜必须在库里
  const mustHave = ['菠菜炒鸡蛋', '番茄炒蛋', '宫保鸡丁', '麻婆豆腐', '红烧肉', '蛋炒饭', '鱼香肉丝', '青椒炒肉'];
  const missingDish = mustHave.map((n) => [n, findFood(n)]).filter(([, f]) => !f);
  check('必备家常菜命中', missingDish.length === 0, missingDish.map(([n]) => n).join(', '));

  // 菜名检索与别名
  const a = findFood('菠菜炒鸡蛋');
  const b = findFood('菠菜炒蛋');
  check('findFood("菠菜炒鸡蛋") 命中', !!a, '未命中');
  check('别名 "菠菜炒蛋" 指向同一道菜', !!a && !!b && a.id === b.id, `a=${a?.name} b=${b?.name}`);
  const withSuffix = findFood('宫保鸡丁（小份）');
  check('带括号修饰仍能命中', !!withSuffix, '未命中');

  const stir = searchFoods('炒', 30);
  const firstIngredient = stir.findIndex((f) => f.kind !== 'dish');
  const lastDish = stir.map((f) => f.kind === 'dish').lastIndexOf(true);
  check('searchFoods 菜品优先排序', firstIngredient === -1 || lastDish < firstIngredient, `首个原料在下标 ${firstIngredient}，末个菜在下标 ${lastDish}`);
  check('searchFoods("米饭") 非空', searchFoods('米饭').length > 0, '空结果');

  // 校准：整份菜走库值，而不是原料相加
  if (a) {
    const out = calibrateItems([{ name: '菠菜炒鸡蛋', grams: 300, kcal: 999, carb: 0, protein: 0, fat: 0, confidence: 'high' }]);
    const expect = Math.round(a.per100g.kcal * 3);
    check('整份菜校准使用库值', out.length === 1 && Math.abs(out[0].kcal - expect) <= 5, `返回 ${JSON.stringify(out[0]?.kcal)}，期望≈${expect}`);
    check('校准结果带 foodId', !!out[0]?.foodId, '无 foodId');
  }

  // ---------- v1.6：份量单位与颗粒度 ----------
  check('导出 foodUnits()', typeof foodUnits === 'function', '缺少 foodUnits');

  const withUnits = FOODS.filter((f) => Array.isArray(f.units) && f.units.length > 0);
  check('带常用份量的食物 ≥ 200 条', withUnits.length >= 200, `实际 ${withUnits.length}`);

  const badUnits = [];
  for (const f of withUnits) {
    const seen = new Set();
    for (const u of f.units) {
      if (!u || typeof u.name !== 'string' || !u.name.trim()) { badUnits.push(`${f.name}(单位名空)`); continue; }
      if (typeof u.grams !== 'number' || !Number.isFinite(u.grams) || u.grams < 5 || u.grams > 1000) {
        badUnits.push(`${f.name}(${u.name}=${u.grams})`);
      }
      const key = u.name.trim();
      if (seen.has(key)) badUnits.push(`${f.name}(单位重名 ${key})`);
      seen.add(key);
    }
    if (f.unit && f.units[0] && (f.unit.name !== f.units[0].name || f.unit.grams !== f.units[0].grams)) {
      badUnits.push(`${f.name}(unit 与 units[0] 不一致)`);
    }
  }
  check('份量单位合法（名称/克数/不重名/与 unit 一致）', badUnits.length === 0, badUnits.slice(0, 6).join(', '));

  if (foodUnits) {
    const norm = foodUnits({ name: 'x', per100g: {}, units: [{ name: '1 只', grams: 90 }] });
    check('foodUnits 优先用 units', norm.length === 1 && norm[0].grams === 90, JSON.stringify(norm));
    const fallback = foodUnits({ name: 'y', per100g: {}, unit: { name: '1 碗', grams: 200 } });
    check('foodUnits 回落 unit', fallback.length === 1 && fallback[0].grams === 200, JSON.stringify(fallback));
    const empty = foodUnits({ name: 'z', per100g: {} });
    check('foodUnits 无单位返回空数组', Array.isArray(empty) && empty.length === 0, JSON.stringify(empty));
    const dirty = foodUnits({ name: 'w', per100g: {}, units: [{ name: '坏', grams: 0 }, { name: '好', grams: 50 }] });
    check('foodUnits 过滤非法份量', dirty.length === 1 && dirty[0].grams === 50, JSON.stringify(dirty));
  }

  // 颗粒度：去皮鸡腿必须能单独命中，且热量必须低于带皮
  const skinOff = findFood('去皮鸡腿');
  check('findFood("去皮鸡腿") 命中', !!skinOff, '未命中');
  if (skinOff) {
    check('去皮鸡腿被标为 skin=off', skinOff.skin === 'off' || /去皮/.test(skinOff.name), `name=${skinOff.name} skin=${skinOff.skin}`);
    const skinOn = FOODS.find((f) => /鸡腿/.test(f.name) && (f.skin === 'on' || /带皮/.test(f.name)));
    if (skinOn) check('去皮鸡腿热量低于带皮', skinOff.per100g.kcal < skinOn.per100g.kcal, `去皮 ${skinOff.per100g.kcal} vs 带皮 ${skinOn.per100g.kcal}`);
    else check('库内同时存在带皮鸡腿', false, '未找到带皮版本');
  }
  check('findFood("鸡胸肉") 命中', !!findFood('鸡胸肉'), '未命中');
  const rawCooked = FOODS.filter((f) => f.state === 'raw' || f.state === 'cooked');
  check('至少 10 条标注生/熟', rawCooked.length >= 10, `实际 ${rawCooked.length}`);
  const withPart = FOODS.filter((f) => typeof f.part === 'string' && f.part.trim());
  check('至少 30 条标注部位', withPart.length >= 30, `实际 ${withPart.length}`);

  // ---------- v1.7：食物库系统性补全 ----------
  // 新增条目的 id 清单（改数据必须同步改这里，防止「悄悄删条目」也能过测试）
  const V17_IDS = [
    'king-oyster-mushroom', 'straw-mushroom', 'button-mushroom',
    'asparagus-lettuce', 'bamboo-shoot', 'taro', 'water-chestnut', 'gai-lan',
    'amaranth-green', 'amaranth-red', 'cowpea', 'pea-shoot', 'toon', 'choy-sum',
    'scallion-large', 'chive', 'hyacinth-bean', 'sword-bean', 'watercress',
    'garlic-scape', 'lettuce-leaf',
    'tofu-shreds', 'vegetarian-chicken',
    'black-bean', 'chickpea', 'job-tears', 'buckwheat', 'glutinous-rice', 'sorghum', 'white-kidney-bean',
    'king-oyster-pork', 'garlic-king-oyster', 'stir-asparagus-lettuce', 'toon-egg',
    'dry-fried-cowpea', 'stir-lotus-root', 'steamed-taro',
  ];
  const v17 = FOODS.filter((f) => V17_IDS.includes(f.id));
  check('新增条目数 ≥ 30', v17.length >= 30, `实际 ${v17.length}`);
  check('新增条目 id 全部在库', v17.length === V17_IDS.length,
    `缺失 id: ${V17_IDS.filter((id) => !FOODS.some((f) => f.id === id)).join(',')}`);
  check('新增条目 id 均为英文小写短横线', v17.every((f) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.id)),
    v17.filter((f) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.id)).map((f) => f.id).join(','));
  check('新增菜品 ≥ 5 条', v17.filter((f) => f.kind === 'dish').length >= 5, `实际 ${v17.filter((f) => f.kind === 'dish').length}`);

  // 新增条目必须自带 fiber / sodium / aliases / 实用份量
  const badNew = [];
  for (const f of v17) {
    const p = f.per100g || {};
    if (typeof p.fiber !== 'number' || !Number.isFinite(p.fiber)) badNew.push(`${f.name}(缺 fiber)`);
    if (typeof p.sodium !== 'number' || !Number.isFinite(p.sodium)) badNew.push(`${f.name}(缺 sodium)`);
    if (!Array.isArray(f.aliases) || f.aliases.length < 2) badNew.push(`${f.name}(别名不足)`);
    const units = Array.isArray(f.units) ? f.units : [];
    if (units.length === 0) badNew.push(`${f.name}(无 units)`);
    for (const u of units) {
      if (!(Number(u.grams) > 0) || !String(u.name || '').trim()) badNew.push(`${f.name}(份量非法)`);
    }
  }
  check('新增条目字段完整（fiber/sodium/aliases/units）', badNew.length === 0, badNew.slice(0, 6).join(', '));

  // 用户点名的「杏鲍菇」
  const kingOyster = FOODS.find((f) => f.name === '杏鲍菇');
  check('库内有「杏鲍菇」', !!kingOyster, '未找到');
  check('searchFoods("杏鲍菇") 首位命中', searchFoods('杏鲍菇')[0]?.name === '杏鲍菇', `实际 ${searchFoods('杏鲍菇')[0]?.name}`);
  check('searchFoods("鲍菇") 命中杏鲍菇（部分词）', searchFoods('鲍菇').some((f) => f.name === '杏鲍菇'), '未命中');
  check('findFood("杏鲍菇") 命中', findFood('杏鲍菇')?.name === '杏鲍菇', `实际 ${findFood('杏鲍菇')?.name}`);
  check('杏鲍菇 别名覆盖「鲍菇」', (kingOyster?.aliases || []).includes('鲍菇'), JSON.stringify(kingOyster?.aliases));
  if (kingOyster) {
    const k = kingOyster.per100g;
    check('杏鲍菇 热量落在 25–45 kcal/100g', k.kcal >= 25 && k.kcal <= 45, `实际 ${k.kcal}`);
    check('杏鲍菇 带膳食纤维', typeof k.fiber === 'number' && k.fiber > 0 && k.fiber <= 4, `实际 ${k.fiber}`);
    check('杏鲍菇 份量含「1 根 ≈ 60g」', (kingOyster.units || []).some((u) => u.name === '1 根' && u.grams === 60), JSON.stringify(kingOyster.units));
  }

  // 部分词检索：单字、双字片段都要能命中
  check('searchFoods("莴") 命中莴笋', searchFoods('莴').some((f) => f.name === '莴笋'), '未命中');
  check('searchFoods("豆干") 命中豆腐干', searchFoods('豆干')[0]?.name === '豆腐干', `实际 ${searchFoods('豆干')[0]?.name}`);
  check('searchFoods("香椿") 命中香椿', searchFoods('香椿')[0]?.name === '香椿', `实际 ${searchFoods('香椿')[0]?.name}`);

  // 缺口清单：这 10 条本轮已补齐（原来库内完全没有）
  const FILLED_GAPS = ['杏鲍菇', '芋头', '莴笋', '竹笋', '黑豆', '鹰嘴豆'];
  const stillMissing = FILLED_GAPS.filter((n) => !findFood(n));
  check('本轮补齐的缺口全部可解析', stillMissing.length === 0, `仍未命中: ${stillMissing.join(',')}`);
  // 这 3 条原本靠别名即可命中，不新增重复条目，只验证仍然可用
  const aliasCovered = [['豆干', '豆腐干'], ['豆皮', '千张'], ['鸡腿肉', '鸡腿']];
  const aliasLost = aliasCovered.filter(([q, expect]) => findFood(q)?.name !== expect);
  check('豆干/豆皮/鸡腿肉 仍由既有别名命中', aliasLost.length === 0, aliasLost.map(([q]) => q).join(','));
  // 成分表无条目、暂无权威来源：显式记录，不编数值；一旦补上就要删掉这里的名字
  const PENDING_GAPS = ['茶树菇', '白玉菇', '蟹味菇', '海鲜菇'];
  const filledPending = PENDING_GAPS.filter((n) => FOODS.some((f) => f.name === n || (f.aliases || []).includes(n)));
  check('待补缺口尚未被无来源数据填充', filledPending.length === 0, `已出现: ${filledPending.join(',')}，请补来源并更新 PENDING_GAPS`);

  // 全库自洽：4/4/9 与 kcal 的偏差（严格口径：±15% 或 ±20 kcal）
  const whitelist = ['紫菜', '紫菜（干）', '木耳', '木耳（干）'];
  const offStrict = [];
  for (const f of FOODS) {
    const p = f.per100g;
    if (!p || ![p.kcal, p.carb, p.protein, p.fat].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    const calc = p.carb * 4 + p.protein * 4 + p.fat * 9;
    const tol = Math.max(20, p.kcal * 0.15);
    if (Math.abs(calc - p.kcal) > tol) offStrict.push(f.name);
  }
  const unexpected = offStrict.filter((n) => !whitelist.includes(n));
  check('全库 4/4/9 自洽（严格 ±15% / ±20kcal）', unexpected.length === 0, `超阈值: ${unexpected.join(',')}`);

  // 膳食纤维覆盖：基线为 0 条缺失，新增不许把它变差
  const noFiber = FOODS.filter((f) => !f.per100g || typeof f.per100g.fiber !== 'number');
  check('全库 fiber 缺失条目 = 0', noFiber.length === 0, `缺失: ${noFiber.map((f) => f.name).slice(0, 6).join(',')}`);

  // 别名与其它条目 name 冲突：只允许已知的「菜品别名 → 原料名」
  const KNOWN_ALIAS_CONFLICTS = ['五香素鸡->素鸡', '凉拌豆腐丝->豆腐丝', '原味酸奶（全脂）->酸奶', '燕麦片（熟，冲调）->燕麦粥'];
  const nameSet = new Set(FOODS.map((f) => f.name));
  const clashes = [];
  for (const f of FOODS) for (const a of f.aliases || []) if (nameSet.has(a)) clashes.push(`${f.name}->${a}`);
  const newClash = clashes.filter((c) => !KNOWN_ALIAS_CONFLICTS.includes(c));
  check('别名不新增与其他条目 name 的冲突', newClash.length === 0, newClash.slice(0, 6).join(', '));

  // 份量克数：全库每项 name 非空、grams > 0
  const badAllUnits = [];
  for (const f of FOODS) {
    for (const u of f.units || []) {
      if (!u || typeof u.name !== 'string' || !u.name.trim() || !(Number(u.grams) > 0)) badAllUnits.push(f.name);
    }
  }
  check('全库份量单位 name 非空且 grams > 0', badAllUnits.length === 0, [...new Set(badAllUnits)].slice(0, 6).join(', '));


  // ---------- v1.8：健身人群常见饮食（补剂 / 高蛋白 / 慢碳 / 果蔬 / 脂肪 / 健身餐） ----------
  // 新增条目的 id 清单：改数据必须同步改这里，防止「悄悄删条目」也能过测试。
  const V18_BASELINE = 688; // v1.7 收工时的库容量
  const V18_SUPP = ['yeast-protein', 'whey-concentrate', 'whey-hydrolysate', 'casein-powder', 'pea-protein', 'soy-protein-isolate', 'plant-protein-blend', 'rice-protein', 'egg-white-powder', 'milk-protein-powder', 'mass-gainer', 'protein-bar-lowcarb', 'protein-wafer', 'protein-cookie', 'protein-granola', 'protein-crisps', 'protein-icecream', 'protein-rtd', 'yogurt-protein-drink', 'collagen-peptide', 'creatine-monohydrate', 'bcaa', 'glutamine', 'maltodextrin', 'electrolyte-powder', 'energy-gel', 'glucose-powder'];
  const V18_PROTEIN = ['turkey-breast-raw', 'turkey-breast-cooked', 'beef-round-lean', 'tilapia', 'skyr', 'cottage-cheese', 'mozzarella-lowfat', 'skim-milk-powder', 'lowfat-cheese-slice', 'chickpea-cooked', 'lentil-cooked', 'chicken-breast-instant-blackpepper', 'chicken-breast-instant-spicy', 'smoked-salmon', 'tuna-water-drained', 'cod-cooked', 'sardine-canned', 'egg-white-liquid', 'chicken-breast-mince'];
  const V18_CARB = ['ww-pasta-dry', 'ww-pasta-cooked', 'rye-bread', 'ww-tortilla', 'purple-sweet-potato-steamed', 'yam-steamed', 'sweet-potato-roasted', 'hummus', 'cornmeal', 'barley-raw', 'red-bean-cooked', 'whole-wheat-flour', 'oat-groats', 'whole-wheat-bagel', 'konjac-knot', 'protein-bread'];
  const V18_PRODUCE = ['cauliflower', 'bell-pepper', 'kale', 'brussels-sprouts', 'raspberry', 'grapefruit', 'papaya', 'cauliflower-rice', 'edamame-cooked'];
  const V18_FAT = ['flaxseed', 'chia-seed', 'coconut-oil', 'pumpkin-seed', 'macadamia', 'pine-nut', 'hazelnut', 'sesame-paste', 'flaxseed-oil', 'pecan'];
  const V18_MEAL = ['protein-oat-bowl', 'quinoa-chicken-bowl', 'beef-brown-rice-bowl', 'salmon-asparagus-plate', 'whole-wheat-chicken-sandwich', 'tuna-whole-wheat-wrap', 'overnight-oats-whey', 'protein-pancake', 'banana-protein-shake', 'avocado-egg-toast', 'shrimp-broccoli-plate', 'chicken-quinoa-salad', 'greek-yogurt-berry-bowl', 'egg-white-omelette', 'chicken-purple-potato-box', 'tuna-quinoa-bowl', 'beef-broccoli-lowoil', 'steamed-cod-broccoli', 'salmon-brown-rice', 'chicken-whole-wheat-wrap', 'protein-latte', 'egg-avocado-salad', 'quinoa-avocado-salad', 'tuna-egg-white-salad'];
  const V18_IDS = [...V18_SUPP, ...V18_PROTEIN, ...V18_CARB, ...V18_PRODUCE, ...V18_FAT, ...V18_MEAL];
  const v18 = FOODS.filter((f) => V18_IDS.includes(f.id));

  check('v1.8 新增清单 ≥ 100 条', V18_IDS.length >= 100, `清单只有 ${V18_IDS.length} 条`);
  check('v1.8 新增条目全部在库', v18.length === V18_IDS.length,
    `缺失 id: ${V18_IDS.filter((id) => !FOODS.some((f) => f.id === id)).join(',')}`);
  check('v1.8 库内总数 = 基线 + 新增（只增不减）', FOODS.length === V18_BASELINE + V18_IDS.length,
    `库 ${FOODS.length}，应为 ${V18_BASELINE} + ${V18_IDS.length} = ${V18_BASELINE + V18_IDS.length}`);
  check('v1.8 库内总数 ≥ 788（688 基线 + 100 新增）', FOODS.length >= V18_BASELINE + 100, `实际 ${FOODS.length}`);
  check('v1.8 新增 id 均为英文小写短横线',
    v18.every((f) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.id)),
    v18.filter((f) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.id)).map((f) => f.id).join(','));
  check('v1.8 新增 id 清单本身不重复', new Set(V18_IDS).size === V18_IDS.length,
    `${V18_IDS.length} 条里有 ${V18_IDS.length - new Set(V18_IDS).size} 个重复`);
  const v18DupName = v18.map((f) => f.name).filter((v, i, a) => a.indexOf(v) !== i);
  check('v1.8 新增 name 不重复', v18DupName.length === 0, [...new Set(v18DupName)].slice(0, 5).join(','));

  const v18NoFiber = v18.filter((f) => !f.per100g || typeof f.per100g.fiber !== 'number' || !Number.isFinite(f.per100g.fiber));
  check('v1.8 新增条目全部带 fiber（0 也要写 0）', v18NoFiber.length === 0,
    `缺失 ${v18NoFiber.length} 条: ${v18NoFiber.map((f) => f.name).slice(0, 6).join(',')}`);

  const v18Off = [];
  for (const f of v18) {
    const p = f.per100g || {};
    if (![p.kcal, p.carb, p.protein, p.fat].every((n) => typeof n === 'number' && Number.isFinite(n))) {
      v18Off.push(`${f.name}(数值缺失)`);
      continue;
    }
    const calc = p.carb * 4 + p.protein * 4 + p.fat * 9;
    const tol = Math.max(20, p.kcal * 0.15);
    if (Math.abs(calc - p.kcal) > tol) v18Off.push(`${f.name}(标${p.kcal}/算${Math.round(calc)})`);
  }
  check('v1.8 新增条目 4/4/9 自洽（严格 ±15% 或 ±20kcal，0 例外）', v18Off.length === 0,
    `超阈值 ${v18Off.length} 条: ${v18Off.slice(0, 6).join(', ')}`);

  // 蛋白粉：用户实际按「1 勺」记录，克数必须落在 20–40g
  const V18_POWDER = ['yeast-protein', 'whey-concentrate', 'whey-hydrolysate', 'casein-powder', 'pea-protein',
    'soy-protein-isolate', 'plant-protein-blend', 'rice-protein', 'egg-white-powder', 'milk-protein-powder', 'mass-gainer'];
  const v18PowderBad = [];
  for (const id of V18_POWDER) {
    const f = FOODS.find((x) => x.id === id);
    if (!f) { v18PowderBad.push(`${id}(不在库)`); continue; }
    const scoop = (f.units || []).find((u) => /勺/.test(String(u.name)));
    if (!scoop) { v18PowderBad.push(`${f.name}(没有「1 勺」)`); continue; }
    const g = Number(scoop.grams);
    if (!(g >= 20 && g <= 40)) v18PowderBad.push(`${f.name}(1 勺 ${g}g 越界)`);
  }
  check('v1.8 蛋白粉类都有「1 勺」且克数 20–40g', v18PowderBad.length === 0, v18PowderBad.slice(0, 6).join(', '));
  check('v1.8 蛋白粉类 ≥ 10 条且全部属于本轮新增',
    V18_POWDER.length >= 10 && V18_POWDER.every((id) => V18_IDS.includes(id)), `${V18_POWDER.length} 条`);
  const v18PowderThin = V18_POWDER.filter((id) => id !== 'mass-gainer')
    .map((id) => FOODS.find((x) => x.id === id))
    .filter(Boolean)
    .filter((f) => !(f.per100g.protein >= 60 && f.per100g.kcal >= 320 && f.per100g.kcal <= 420))
    .map((f) => `${f.name}(蛋白 ${f.per100g.protein}/${f.per100g.kcal}kcal)`);
  check('v1.8 蛋白粉类蛋白 ≥ 60g 且能量 320–420 kcal（增肌粉除外）', v18PowderThin.length === 0, v18PowderThin.join(', '));

  // 用户点名的检索路径
  check('searchFoods("酵母蛋白粉") 首位命中酵母蛋白粉', searchFoods('酵母蛋白粉')[0]?.id === 'yeast-protein',
    `实际 ${searchFoods('酵母蛋白粉')[0]?.name}`);
  const v18HitFen = searchFoods('蛋白粉', 20).map((f) => f.id);
  check('searchFoods("蛋白粉") 命中酵母/浓缩乳清/分离乳清/蛋清蛋白粉',
    ['yeast-protein', 'whey-concentrate', 'whey-isolate', 'egg-white-powder'].every((id) => v18HitFen.includes(id)), v18HitFen.join(','));
  const v18HitRu = searchFoods('乳清', 20).map((f) => f.id);
  check('searchFoods("乳清") 命中乳清蛋白粉与乳清蛋白粉（浓缩）',
    v18HitRu.includes('whey-protein') && v18HitRu.includes('whey-concentrate'), v18HitRu.join(','));
  check('findFood("酵母蛋白") 由别名命中酵母蛋白粉', findFood('酵母蛋白')?.id === 'yeast-protein',
    `实际 ${findFood('酵母蛋白')?.name}`);

  // 必含项：按标准名逐条在库
  const V18_MUST = ['酵母蛋白粉', '乳清蛋白粉（浓缩）', '水解乳清蛋白粉', '酪蛋白粉（缓释）', '豌豆蛋白粉', '大豆分离蛋白粉',
    '植物蛋白粉（混合）', '增肌粉（碳水型）', '低糖蛋白棒', '即饮蛋白饮', '胶原蛋白肽', '火鸡胸肉（生）', '牛后腿肉（瘦）',
    '罗非鱼', '冰岛酸奶（Skyr）', '茅屋奶酪（低脂）', '低脂马苏里拉奶酪', '脱脂奶粉', '菜花（花椰菜）', '彩椒（甜椒）',
    '羽衣甘蓝', '抱子甘蓝', '树莓', '西柚（葡萄柚）', '亚麻籽', '奇亚籽', '椰子油', '南瓜籽（仁）', '夏威夷果', '松子（仁）',
    '榛子', '碧根果', '全麦意面（干）', '黑麦面包', '全麦卷饼', '紫薯（蒸，熟）', '山药（蒸，熟）', '红薯（烤）',
    '鹰嘴豆泥（无糖）', '大麦（生）', '魔芋结（水煮）', '蛋白燕麦碗', '藜麦鸡胸饭', '牛肉糙米饭', '香煎三文鱼配芦笋',
    '全麦鸡胸三明治', '金枪鱼全麦卷', '希腊酸奶莓果碗', '蛋白蛋卷（鸡蛋白）'];
  const v18MustMissing = V18_MUST.filter((n) => !FOODS.some((f) => f.name === n));
  check('v1.8 必含项逐条按标准名在库', v18MustMissing.length === 0, `缺少: ${v18MustMissing.join(',')}`);
  // 巴沙鱼不单列：库里既有「龙利鱼」已把「巴沙鱼」当别名（市售鱼柳的通称），单列必然撞名
  check('v1.8「巴沙鱼」由既有「龙利鱼」别名命中，不另立重复条目', findFood('巴沙鱼')?.name === '龙利鱼',
    `实际 ${findFood('巴沙鱼')?.name}`);

  // 分类计数：任一分类塌了都要红
  check('v1.8 分类覆盖：补剂 ≥ 20', FOODS.filter((f) => V18_SUPP.includes(f.id)).length >= 20, `${V18_SUPP.length}`);
  check('v1.8 分类覆盖：高蛋白食材 ≥ 15', FOODS.filter((f) => V18_PROTEIN.includes(f.id)).length >= 15, `${V18_PROTEIN.length}`);
  check('v1.8 分类覆盖：慢碳主食 ≥ 12', FOODS.filter((f) => V18_CARB.includes(f.id)).length >= 12, `${V18_CARB.length}`);
  check('v1.8 分类覆盖：蔬菜水果 ≥ 6', FOODS.filter((f) => V18_PRODUCE.includes(f.id)).length >= 6, `${V18_PRODUCE.length}`);
  check('v1.8 分类覆盖：健康脂肪 ≥ 8', FOODS.filter((f) => V18_FAT.includes(f.id)).length >= 8, `${V18_FAT.length}`);
  check('v1.8 分类覆盖：健身餐 ≥ 20', FOODS.filter((f) => V18_MEAL.includes(f.id)).length >= 20, `${V18_MEAL.length}`);

  // 份量 1–3 个、unit 与 units[0] 一致、别名 ≥ 2、健身餐写明 recipe
  const v18BadUnits = [];
  for (const f of v18) {
    const units = Array.isArray(f.units) ? f.units : [];
    if (units.length === 0 || units.length > 3) { v18BadUnits.push(`${f.name}(${units.length} 个份量)`); continue; }
    if (!f.unit || f.unit.name !== units[0].name || f.unit.grams !== units[0].grams) v18BadUnits.push(`${f.name}(unit 与 units[0] 不一致)`);
  }
  check('v1.8 新增条目份量 1–3 个且 unit 与 units[0] 一致', v18BadUnits.length === 0, v18BadUnits.slice(0, 6).join(', '));
  const v18BadAlias = v18.filter((f) => !Array.isArray(f.aliases) || f.aliases.length < 2);
  check('v1.8 新增条目至少 2 个别名（俗称 + 英文）', v18BadAlias.length === 0, v18BadAlias.map((f) => f.name).slice(0, 6).join(','));
  const v18NoRecipe = FOODS.filter((f) => V18_MEAL.includes(f.id)).filter((f) => typeof f.recipe !== 'string' || !f.recipe.trim());
  check('v1.8 健身餐都写明配方（recipe 非空）', v18NoRecipe.length === 0, v18NoRecipe.map((f) => f.name).join(','));

  return {
    passed,
    failed: failures.length,
    failures,
    stats: { total: FOODS.length, dishes: dishes.length, ingredients: ingredients.length, withUnits: withUnits.length },
  };
}

const isMain = process.argv?.[1] && process.argv[1].endsWith('foods.data.test.mjs');
if (isMain) {
  const r = await run();
  for (const f of r.failures) console.log(`  ✗ ${f.name}: ${f.error}`);
  console.log(`[foods.data] ${r.passed} passed / ${r.failed} failed  (总 ${r.stats?.total} · 菜 ${r.stats?.dishes} · 原料 ${r.stats?.ingredients})`);
  if (r.failed) process.exitCode = 1;
}

export { run };
