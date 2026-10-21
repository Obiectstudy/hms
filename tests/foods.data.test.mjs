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
