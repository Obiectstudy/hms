// 设置页（SPEC §7「设置」）：档案 / 目标 / 视觉识别 / 数据 / 关于。
import { el, toast, confirmDialog, fmt1 } from '../js/ui.js';
import { localDateStr, ageFromBirthday, GUIDE, dailyTargets, mealTargetsOf } from '../js/nutrition.js';
import {
  getProfile, saveProfile, getGoals, saveGoals,
  getSettings, saveSettings, currentAccount, recentWeights,
  exportJSON, exportCSV, importJSON, clearAllData, exportStatus,
} from '../js/store.js';
import { testConnection, MODEL_CANDIDATES, DEFAULT_BASE_URL, DEFAULT_MODEL } from '../js/vision.js';
import {
  checkForUpdate, clearDismissed, installUpdate, isInstallAvailable,
  versionLabel, webUpdateGuidance,
} from '../js/update.js';

const ACTIVITIES = [
  { value: 'sedentary', label: '久坐（基本不运动）' },
  { value: 'light', label: '轻度（每周 1~3 次）' },
  { value: 'moderate', label: '中等（每周 3~5 次）' },
  { value: 'active', label: '活跃（每周 6~7 次）' },
  { value: 'very_active', label: '高强度（体力工作/训练）' },
];

/** 目标方向（决定蛋白质 g/kg 档位与热量调整）：值必须落在 store / nutrition 认的三档里。 */
export const GOAL_KIND_OPTIONS = [
  { value: 'cut', label: '减脂（热量 −20%）' },
  { value: 'maintain', label: '维持（热量不变）' },
  { value: 'bulk', label: '增肌（热量 +10%）' },
];

export const GOAL_KIND_LABELS = { cut: '减脂', maintain: '维持', bulk: '增肌' };

/** 三餐供能比（早 30 / 午 40 / 晚 30），供显示用；数值来自 GUIDE.mealSlotPct。 */
const MEAL_SLOT_LABELS = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' };

/**
 * 由档案 + 当前体重算出「按指南该吃多少」的入参（纯函数，不碰 DOM / 存储，可直接单测）。
 * 表单里已填的纤维 / 钠 / 目标体重优先（用户手改过就按手改的算）；档案缺项交给 dailyTargets 兜底。
 */
export function targetInputFrom(profile, currentWeightKg, goalKind, form = {}) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const f = form && typeof form === 'object' ? form : {};
  // 空串 / 全空白 / null / undefined = 「没填」，不是 0（输入框清空就等于没表态）
  const asNum = (v) => {
    if (v == null || typeof v === 'string' && v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const weight = asNum(currentWeightKg);
  const formTarget = asNum(f.weightTargetKg);
  const profileTarget = asNum(p.weightTargetKg);
  const fiber = asNum(f.fiberG);
  const sodium = asNum(f.sodiumMg);
  return {
    sex: p.sex,
    weightKg: weight != null && weight > 0 ? weight : undefined,
    heightCm: asNum(p.heightCm) ?? undefined,
    age: p.birthday ? ageFromBirthday(p.birthday) : undefined,
    activity: p.activity,
    weightTargetKg: formTarget != null ? formTarget : profileTarget,
    goalKind,
    // 已显式设过的 g/kg 要沿用（用户手填过就不再被档位中值覆盖）
    proteinGPerKg: asNum(f.proteinGPerKg) ?? asNum(p.proteinGPerKg) ?? undefined,
    fiberG: fiber != null && fiber > 0 ? fiber : undefined,
    sodiumMg: sodium != null && sodium > 0 ? sodium : undefined,
  };
}

/**
 * 作息偏移档位（分钟）：整数分钟，全部落在 store 的 clamp 区间 -180..240 内。
 * 用下拉而不是数字输入：档位有限（早/正常/新疆作息），用户不需要填分钟数，
 * 也就没有「填了 37 这种数」的校验分支与非法态。
 */
export const SLOT_OFFSET_OPTIONS = [
  { value: 0, label: '不偏移（默认）' },
  { value: 60, label: '+1 小时' },
  { value: 90, label: '+1.5 小时' },
  { value: 120, label: '+2 小时（新疆常见）' },
  { value: 150, label: '+2.5 小时' },
  { value: 180, label: '+3 小时' },
  { value: -60, label: '-1 小时（作息偏早）' },
];

export const SLOT_OFFSET_HINT = '按你的用餐时间整体后移：选 +2 小时，14:00 的午饭按 12:00 判定（记为午餐），21:30 的晚饭也还算晚餐。只影响「现在该记哪一餐」的默认选择，不改任何已有记录的日期。';

/** 分钟 -> 「+2 小时 / -1 小时 / 不偏移」，给不在档位里的历史值兜底显示。 */
function slotOffsetLabel(minutes) {
  const m = Number(minutes) || 0;
  if (!m) return '不偏移';
  const hours = Math.round((m / 60) * 10) / 10;
  return `${hours > 0 ? '+' : ''}${hours} 小时`;
}

const go = (hash) => window.HMS.navigate(hash);

function inputBox(props = {}) {
  return el('input', { className: 'input', ...props });
}

function selectBox(options, value) {
  const node = el('select', { className: 'select' },
    options.map((o) => el('option', { value: o.value, text: o.label })),
  );
  if (value != null) node.value = String(value);
  return node;
}

function labeled(label, control) {
  return el('label', { className: 'field' }, el('span', { className: 'field__label', text: label }), control);
}

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * 全量 JSON 备份下载：设置页与今日页提醒条共用这一份实现。
 * exportJSON() 内部会记下备份时间，调用方只管下载与提示。
 */
export async function exportBackupJSON() {
  const payload = await exportJSON();
  download(`hms-${localDateStr()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  return payload;
}

/** 「今天」比「0 天前」更像人话；从未备份时直说。 */
export function backupStatusText(status) {
  const s = status || {};
  if (!s.lastExportedAt) return '从未备份';
  const days = Number(s.days);
  if (!Number.isFinite(days) || days <= 0) return '今天';
  return `${Math.round(days)} 天前`;
}

export async function render(root) {
  const [profileRaw, goals, settings, account] = await Promise.all([
    getProfile(), getGoals(), getSettings(),
    // 账号名只用来显示；取不到也不该让整页渲染失败
    currentAccount().catch(() => null),
  ]);
  const profile = profileRaw || {};
  const currentSettings = settings || {};

  root.appendChild(el('div', { className: 'row row--between' },
    el('div', { className: 'col' },
      el('div', { className: 'h1', text: '设置' }),
      el('div', { className: 'muted', text: '数据只保存在本机浏览器' }),
    ),
    el('button', { className: 'btn btn--ghost btn--sm', text: '返回今日', onClick: () => go('#/') }),
  ));

  // ---- 账号（本机多账号的入口，右侧显示当前是谁） ----
  root.appendChild(el('div', { className: 'card' },
    el('button', { className: 'account-entry', onClick: () => go('#/account') },
      el('span', { className: 'account-entry__label', text: '账号' }),
      el('span', { className: 'account-entry__value', text: account && account.name ? account.name : '本机' }),
      el('span', { className: 'account-entry__caret', text: '›' }),
    ),
  ));

  // ---- 个人档案 ----
  const nickname = inputBox({ type: 'text', value: profile.nickname || '', placeholder: '怎么称呼你' });
  const sexSelect = selectBox([{ value: 'male', label: '男' }, { value: 'female', label: '女' }], profile.sex || 'male');
  const birthday = inputBox({ type: 'date', value: profile.birthday || '' });
  const heightCm = inputBox({ type: 'number', inputmode: 'numeric', min: '80', max: '250', step: '1', value: profile.heightCm != null ? String(profile.heightCm) : '', placeholder: '例如 172' });
  const activity = selectBox(ACTIVITIES, profile.activity || 'light');
  const weightTarget = inputBox({ type: 'number', inputmode: 'decimal', step: '0.1', value: profile.weightTargetKg != null ? String(profile.weightTargetKg) : '', placeholder: '可选' });

  const profileSave = el('button', { className: 'btn btn--primary btn--block', text: '保存档案' });
  profileSave.addEventListener('click', async () => {
    const h = Number(heightCm.value);
    if (!Number.isFinite(h) || h < 80 || h > 250) {
      toast('身高请填写 80~250 cm', 'error');
      heightCm.focus();
      return;
    }
    if (!birthday.value) {
      toast('请选择出生日期', 'error');
      birthday.focus();
      return;
    }
    profileSave.disabled = true;
    try {
      await saveProfile({
        nickname: nickname.value.trim(),
        sex: sexSelect.value,
        birthday: birthday.value,
        heightCm: h,
        activity: activity.value,
        weightTargetKg: numberOrNull(weightTarget.value) || undefined,
      });
      toast('档案已保存', 'ok');
      await window.HMS.refresh();
    } catch (err) {
      toast(`保存失败：${err && err.message ? err.message : err}`, 'error');
      profileSave.disabled = false;
    }
  });

  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '个人档案' }),
      el('div', { className: 'muted', text: '用于估算基础代谢' }),
    ),
    labeled('昵称', nickname),
    el('div', { className: 'grid-2' }, labeled('性别', sexSelect), labeled('出生日期', birthday)),
    el('div', { className: 'grid-2' }, labeled('身高 (cm)', heightCm), labeled('目标体重 (kg)', weightTarget)),
    labeled('活动水平', activity),
    profileSave,
  ));

  // ---- 每日目标（《中国居民膳食指南(2022)》口径：比例 + 克数都给） ----
  const calorieTarget = inputBox({ type: 'number', inputmode: 'numeric', step: '10', value: String(goals.calorieTarget || '') });
  const carbPct = inputBox({ type: 'number', inputmode: 'numeric', step: '1', value: String(goals.carbPct || '') });
  const proteinPct = inputBox({ type: 'number', inputmode: 'numeric', step: '1', value: String(goals.proteinPct || '') });
  const fatPct = inputBox({ type: 'number', inputmode: 'numeric', step: '1', value: String(goals.fatPct || '') });
  const waterMl = inputBox({ type: 'number', inputmode: 'numeric', step: '50', value: String(goals.waterMl || '') });
  const fiberG = inputBox({ type: 'number', inputmode: 'decimal', step: '1', value: String(goals.fiberG != null ? goals.fiberG : GUIDE.fiberDefaultG) });
  const sodiumMg = inputBox({ type: 'number', inputmode: 'numeric', step: '50', value: String(goals.sodiumMg != null ? goals.sodiumMg : GUIDE.sodiumMaxMg) });
  const goalWeightTarget = inputBox({ type: 'number', inputmode: 'decimal', step: '0.1', value: goals.weightTargetKg != null ? String(goals.weightTargetKg) : '' });
  const goalKind = selectBox(GOAL_KIND_OPTIONS, goals.goalKind || 'maintain');
  const ratioHint = el('div', { className: 'muted', text: '' });
  const basisLine = el('div', { className: 'muted', text: '' });
  const planBox = el('div', { className: 'col' });
  const basis = el('div', { className: 'col' });

  const sumRatio = () => Number(carbPct.value) + Number(proteinPct.value) + Number(fatPct.value);
  const updateRatioHint = () => {
    const sum = sumRatio();
    ratioHint.textContent = `碳水 + 蛋白质 + 脂肪 = ${Number.isFinite(sum) ? Math.round(sum) : 0}%（应为 100%）`;
  };
  for (const node of [carbPct, proteinPct, fatPct]) node.addEventListener('input', updateRatioHint);
  updateRatioHint();

  // 目标方向 → 蛋白质 g/kg 档位（界面直接写出档位系数，用户不必猜）
  const proteinBand = () => GUIDE.proteinGPerKg[goalKind.value] || GUIDE.proteinGPerKg.maintain;

  /**
   * 界面用的目标推算：一律走 nutrition.js 的 dailyTargets()（与 store 同一口径）。
   * 优先用表单里当前的值（用户切档位时立刻能看到新目标），档案/体重兜底。只读、不落库。
   */
  const computeTargets = async (kind = goalKind.value) => {
    // 最新体重：读取失败（无 IDB / 新用户）就交给 dailyTargets 的安全默认
    const track = await recentWeights(1).catch(() => []);
    const latest = Array.isArray(track) && track.length ? track[0] : null;
    return dailyTargets(targetInputFrom(profileRaw, latest && latest.weightKg, kind, {
      weightTargetKg: goalWeightTarget.value,
      proteinGPerKg: goals.proteinGPerKg != null ? goals.proteinGPerKg : undefined,
      fiberG: fiberG.value,
      sodiumMg: sodiumMg.value,
    }));
  };

  /** 一行营养素的「克数 · 占多少 %」；ratio 由 caller 传入（蛋白要带 g/kg 档位说明）。 */
  const targetRow = (label, grams, ratio, unit = 'g') =>
    el('div', { className: 'row row--between' },
      el('span', { text: label }),
      el('span', { className: 'muted', text: `${fmt1(grams)} ${unit} · 占 ${ratio}` }),
    );

  const renderPlan = (t) => {
    planBox.textContent = '';
    planBox.appendChild(el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '每日营养目标（比例 + 克数）' }),
      el('div', { className: 'muted', text: `${Math.round(t.calorieTarget)} kcal` }),
    ));
    planBox.appendChild(targetRow('热量', t.calorieTarget, '100%', 'kcal'));
    planBox.appendChild(targetRow('蛋白质', t.protein.g, `${t.protein.pct}% · 按 ${fmt1(t.protein.gPerKg)} g/kg（${GOAL_KIND_LABELS[t.basis.goalKind] || ''}）`));
    planBox.appendChild(targetRow('碳水', t.carb.g, `${t.carb.pct}%（指南 50~65%）`));
    planBox.appendChild(targetRow('脂肪', t.fat.g, `${t.fat.pct}%（指南 20~30%）`));
    planBox.appendChild(targetRow('膳食纤维', t.fiber.g, `指南 ${GUIDE.fiberMinG}~${GUIDE.fiberMaxG} g`));
    planBox.appendChild(targetRow('钠', t.sodium.mg, `不超过 ${GUIDE.sodiumMaxMg} mg（盐 <${GUIDE.saltMaxG} g）`, 'mg'));
    planBox.appendChild(targetRow('饮水', t.water.ml, '按 35ml/kg 与指南基线取大', 'ml'));
    const meals = Object.keys(MEAL_SLOT_LABELS).map((slot) => {
      const m = mealTargetsOf(t, slot);
      return m ? `${MEAL_SLOT_LABELS[slot]} ${m.kcal} kcal（碳 ${fmt1(m.carbG)} / 蛋 ${fmt1(m.proteinG)} / 脂 ${fmt1(m.fatG)} 克）` : '';
    });
    planBox.appendChild(el('div', { className: 'muted', text: meals.filter(Boolean).join(' · ') }));
    planBox.appendChild(el('div', { className: 'muted', text: '加餐不单独分配，从三餐里匀。' }));
  };

  const renderBasis = (t) => {
    const b = t.basis;
    const kcalRound = (v) => Math.round(Number(v) || 0);
    basisLine.textContent = `推算：基础代谢 ${kcalRound(b.bmr)} kcal → 每日消耗 ${kcalRound(b.tdee)} kcal → 按「${GOAL_KIND_LABELS[b.goalKind] || b.goalKind}」调整 ${b.calorieAdjustPct >= 0 ? '+' : ''}${b.calorieAdjustPct}% = ${t.calorieTarget} kcal`;
    basis.textContent = '';
    basis.appendChild(basisLine);
    basis.appendChild(el('div', { className: 'muted', text: `蛋白质档位：${GOAL_KIND_LABELS[b.goalKind] || b.goalKind} ${fmt1(proteinBand().min)}~${fmt1(proteinBand().max)} g/kg，实际按 ${fmt1(b.gPerKg)} g/kg（体重 × 系数）。` }));
    basis.appendChild(el('div', { className: 'muted', text: `依据《中国居民膳食指南(2022)》：碳水 ${GUIDE.carbPctMin}~${GUIDE.carbPctMax}%、脂肪 ${GUIDE.fatPctMin}~${GUIDE.fatPctMax}%、纤维 ${GUIDE.fiberMinG}~${GUIDE.fiberMaxG} g、钠 ≤${GUIDE.sodiumMaxMg} mg（盐 <${GUIDE.saltMaxG} g）、三餐供能比早 30 / 午 40 / 晚 30。` }));
  };

  let lastTargets = null;

  /** 重算并刷新整块目标卡（切档位 / 改体重目标 / 点估算都走这里）。 */
  const refreshTargets = async (kind = goalKind.value) => {
    try {
      const t = await computeTargets(kind);
      lastTargets = t;
      renderPlan(t);
      renderBasis(t);
    } catch (err) {
      basis.textContent = '';
      basis.appendChild(el('div', { className: 'muted', text: '目标推算失败，可手动填写下面的数值。' }));
      toast(`目标推算失败：${err && err.message ? err.message : err}`, 'error');
    }
  };

  // 切档位：立刻把推算结果填进输入框（蛋白质百分比随档位变，热量也随之变），记得保存才落库
  /** 把推算结果灌进输入框（手改入口仍然是这些框，保留「估算 → 微调 → 保存」的既有流程）。 */
  const fillInputs = (computed) => {
    lastTargets = computed;
    calorieTarget.value = String(computed.calorieTarget);
    carbPct.value = String(computed.carb.pct);
    proteinPct.value = String(computed.protein.pct);
    fatPct.value = String(computed.fat.pct);
    waterMl.value = String(computed.water.ml);
    fiberG.value = String(computed.fiber.g);
    sodiumMg.value = String(computed.sodium.mg);
    updateRatioHint();
  };

  goalKind.addEventListener('change', async () => {
    try {
      fillInputs(await computeTargets(goalKind.value));
      await refreshTargets(goalKind.value);
      toast(`已按「${GOAL_KIND_LABELS[goalKind.value] || goalKind.value}」重算，记得保存`, 'info');
    } catch (err) {
      toast(`重算失败：${err && err.message ? err.message : err}`, 'error');
    }
  });
  // 改目标体重会改变档位推断（目标低于当前 → 减脂），输入框里的占比也要跟着走
  goalWeightTarget.addEventListener('change', async () => {
    try {
      fillInputs(await computeTargets(goalKind.value));
    } catch {
      /* 推算失败就让用户手填，不打断 */
    }
    await refreshTargets(goalKind.value);
  });

  const estimateBtn = el('button', { className: 'btn btn--ghost btn--block', text: '按档案自动估算' });
  estimateBtn.addEventListener('click', async () => {
    try {
      const computed = await computeTargets(goalKind.value);
      fillInputs(computed);
      renderPlan(computed);
      renderBasis(computed);
      toast('已按 BMR/TDEE 估算，记得保存', 'info');
    } catch (err) {
      toast(`估算失败：${err && err.message ? err.message : err}`, 'error');
    }
  });

  const goalsSave = el('button', { className: 'btn btn--primary btn--block', text: '保存目标' });
  goalsSave.addEventListener('click', async () => {
    const calories = Number(calorieTarget.value);
    if (!Number.isFinite(calories) || calories < 800 || calories > 6000) {
      toast('热量目标请填写 800~6000 kcal', 'error');
      return;
    }
    const sum = sumRatio();
    if (!Number.isFinite(sum) || Math.abs(sum - 100) > 2) {
      toast('三项比例之和需为 100%', 'error');
      return;
    }
    const water = Number(waterMl.value);
    if (!Number.isFinite(water) || water < 500 || water > 6000) {
      toast('饮水目标请填写 500~6000 ml', 'error');
      return;
    }
    goalsSave.disabled = true;
    try {
      await saveGoals({
        calorieTarget: Math.round(calories),
        carbPct: Math.round(Number(carbPct.value)),
        proteinPct: Math.round(Number(proteinPct.value)),
        fatPct: Math.round(Number(fatPct.value)),
        waterMl: Math.round(water),
        weightTargetKg: numberOrNull(goalWeightTarget.value) || undefined,
        goalKind: goalKind.value,
        // 落库的是「实际生效的档位系数」（切档后 = 该档中值），下次打开界面依据行才对得上
        proteinGPerKg: (goals.proteinGPerKg != null
          ? goals.proteinGPerKg
          : (lastTargets ? lastTargets.basis.gPerKg : undefined)),
        fiberG: numberOrNull(fiberG.value) || undefined,
        sodiumMg: numberOrNull(sodiumMg.value) || undefined,
      });
      toast('目标已保存', 'ok');
      await window.HMS.refresh();
    } catch (err) {
      toast(`保存失败：${err && err.message ? err.message : err}`, 'error');
      goalsSave.disabled = false;
    }
  });

  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '每日目标' }),
      el('div', { className: 'muted', text: `当前 ${fmt1(goals.calorieTarget)} kcal` }),
    ),
    labeled('目标方向', goalKind),
    labeled('热量目标 (kcal)', calorieTarget),
    el('div', { className: 'grid-3' }, labeled('碳水 %', carbPct), labeled('蛋白质 %', proteinPct), labeled('脂肪 %', fatPct)),
    ratioHint,
    el('div', { className: 'grid-2' }, labeled('膳食纤维 (g)', fiberG), labeled('钠 (mg)', sodiumMg)),
    el('div', { className: 'grid-2' }, labeled('饮水目标 (ml)', waterMl), labeled('目标体重 (kg)', goalWeightTarget)),
    planBox,
    basis,
    estimateBtn,
    goalsSave,
  ));

  // 首屏先渲染一次推算结果（异步，不阻塞其它卡片）
  refreshTargets(goals.goalKind || 'maintain');

  // ---- 作息偏移（紧挨「每日目标」：同属「按什么标准记账」，但不归 goals 管） ----
  const offsetOptions = SLOT_OFFSET_OPTIONS.slice();
  const savedOffset = Number(currentSettings.slotOffsetMinutes) || 0;
  // 手改 / 历史数据里的非档位值也要显示得出来，否则下拉框会静默跳回「不偏移」
  if (savedOffset && !offsetOptions.some((o) => o.value === savedOffset)) {
    offsetOptions.unshift({ value: savedOffset, label: `${slotOffsetLabel(savedOffset)}（当前）` });
  }
  const slotOffset = selectBox(offsetOptions, savedOffset);

  const slotOffsetSave = el('button', { className: 'btn btn--primary btn--block', text: '保存作息偏移' });
  slotOffsetSave.addEventListener('click', async () => {
    slotOffsetSave.disabled = true;
    try {
      await saveSettings({ slotOffsetMinutes: Number(slotOffset.value) });
      toast('作息偏移已保存', 'ok');
      await window.HMS.refresh();
    } catch (err) {
      toast(`保存失败：${err && err.message ? err.message : err}`, 'error');
      slotOffsetSave.disabled = false;
    }
  });

  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '作息偏移' }),
      el('div', { className: 'muted', text: '影响「现在算哪一餐」的默认选择' }),
    ),
    labeled('作息偏移', slotOffset),
    el('div', { className: 'muted', text: SLOT_OFFSET_HINT }),
    slotOffsetSave,
  ));

  // ---- 视觉识别 ----
  const modelOptions = MODEL_CANDIDATES.map((m) => ({ value: m, label: m }));
  if (currentSettings.model && !MODEL_CANDIDATES.includes(currentSettings.model)) {
    modelOptions.unshift({ value: currentSettings.model, label: `${currentSettings.model}（当前）` });
  }
  const apiKey = inputBox({ type: 'password', value: currentSettings.apiKey || '', placeholder: 'sk-...', attr: { autocomplete: 'off' } });
  const model = selectBox(modelOptions, currentSettings.model || DEFAULT_MODEL);
  const baseUrl = inputBox({ type: 'text', value: currentSettings.baseUrl || DEFAULT_BASE_URL, placeholder: DEFAULT_BASE_URL });
  const testResult = el('div', { className: 'result muted', text: 'Key 只存本机，用于浏览器直连 DashScope。' });

  const settingsSave = el('button', { className: 'btn btn--primary btn--block', text: '保存识别设置' });
  settingsSave.addEventListener('click', async () => {
    settingsSave.disabled = true;
    try {
      await saveSettings({
        apiKey: apiKey.value.trim(),
        model: model.value,
        baseUrl: baseUrl.value.trim() || DEFAULT_BASE_URL,
      });
      toast('识别设置已保存', 'ok');
      await window.HMS.refresh();
    } catch (err) {
      toast(`保存失败：${err && err.message ? err.message : err}`, 'error');
      settingsSave.disabled = false;
    }
  });

  const testBtn = el('button', { className: 'btn btn--ghost btn--block', text: '测试连接' });
  testBtn.addEventListener('click', async () => {
    const key = apiKey.value.trim();
    if (!key) {
      toast('请先填写 API Key', 'error');
      apiKey.focus();
      return;
    }
    testBtn.disabled = true;
    testResult.className = 'result muted';
    testResult.textContent = '正在测试连接…';
    try {
      const result = await testConnection({
        apiKey: key,
        model: model.value,
        baseUrl: baseUrl.value.trim() || DEFAULT_BASE_URL,
      });
      testResult.className = `result ${result && result.ok ? 'result--ok' : 'result--fail'}`;
      testResult.textContent = `${result && result.ok ? '✓ ' : '✗ '}${(result && result.message) || '没有返回信息'}${result && result.model ? `（模型 ${result.model}）` : ''}`;
    } catch (err) {
      testResult.className = 'result result--fail';
      testResult.textContent = `✗ ${err && err.message ? err.message : err}`;
    } finally {
      testBtn.disabled = false;
    }
  });

  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '视觉识别（阿里百炼）' }),
      el('div', { className: 'muted', text: 'DashScope OpenAI 兼容模式' }),
    ),
    labeled('API Key', apiKey),
    labeled('模型', model),
    labeled('Base URL', baseUrl),
    testBtn,
    testResult,
    settingsSave,
  ));

  // ---- 数据 ----
  const backupLine = el('div', { className: 'muted backup-line', text: '上次备份：读取中…' });
  const refreshBackupLine = async () => {
    try {
      backupLine.textContent = `上次备份：${backupStatusText(await exportStatus())}`;
    } catch {
      backupLine.textContent = '上次备份：读取失败';
    }
  };

  const exportJsonBtn = el('button', { className: 'btn btn--ghost btn--block', text: '导出 JSON（全量备份）' });
  exportJsonBtn.addEventListener('click', async () => {
    exportJsonBtn.disabled = true;
    try {
      await exportBackupJSON();
      toast('已开始下载 JSON', 'ok');
      await refreshBackupLine();
    } catch (err) {
      toast(`导出失败：${err && err.message ? err.message : err}`, 'error');
    } finally {
      exportJsonBtn.disabled = false;
    }
  });

  const exportCsvBtn = el('button', { className: 'btn btn--ghost btn--block', text: '导出 CSV（明细表格）' });
  exportCsvBtn.addEventListener('click', async () => {
    exportCsvBtn.disabled = true;
    try {
      const csv = await exportCSV();
      // BOM 让 Excel 正确识别 UTF-8 中文表头。
      download(`hms-${localDateStr()}.csv`, `\uFEFF${csv}`, 'text/csv');
      toast('已开始下载 CSV', 'ok');
    } catch (err) {
      toast(`导出失败：${err && err.message ? err.message : err}`, 'error');
    } finally {
      exportCsvBtn.disabled = false;
    }
  });

  const fileInput = el('input', { className: 'input', type: 'file', accept: '.json,application/json' });
  const modeSelect = selectBox([
    { value: 'merge', label: '合并（保留现有数据）' },
    { value: 'replace', label: '覆盖（先清空现有数据）' },
  ], 'merge');
  const importBtn = el('button', { className: 'btn btn--ghost btn--block', text: '导入 JSON' });
  let pending = null;
  fileInput.addEventListener('change', async () => {
    pending = null;
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') throw new Error('文件内容不是对象');
      pending = parsed;
      toast(`已读取 ${file.name}`, 'ok');
    } catch (err) {
      toast(`读取失败：${err && err.message ? err.message : err}`, 'error');
      fileInput.value = '';
    }
  });
  importBtn.addEventListener('click', async () => {
    if (!pending) {
      toast('请先选择要导入的 JSON 文件', 'error');
      return;
    }
    const mode = modeSelect.value;
    const ok = await confirmDialog({
      title: mode === 'replace' ? '确认覆盖导入？' : '确认合并导入？',
      message: mode === 'replace'
        ? '覆盖导入会先清空现有的体重、饮食、运动、饮水记录，且无法撤销。建议先导出备份。'
        : '合并导入会按日期/编号去重后写入，现有记录保持不变。',
      okText: mode === 'replace' ? '清空并导入' : '合并导入',
    });
    if (!ok) return;
    importBtn.disabled = true;
    try {
      const result = await importJSON(pending, mode);
      const counts = result && typeof result === 'object'
        ? `体重 ${result.weights || 0}、饮食 ${result.meals || 0}、运动 ${result.exercises || 0}、饮水 ${result.waters || 0}`
        : '';
      toast(`导入完成${counts ? '：' + counts : ''}`, 'ok');
      pending = null;
      fileInput.value = '';
      await window.HMS.refresh();
    } catch (err) {
      toast(`导入失败：${err && err.message ? err.message : err}`, 'error');
      importBtn.disabled = false;
    }
  });

  const clearBtn = el('button', { className: 'btn btn--danger btn--block', text: '清空所有健康数据' });
  clearBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '清空所有健康数据？',
      message: '将删除全部体重、饮食、运动、饮水记录和照片。档案、目标、API Key 会保留。此操作无法撤销，建议先导出 JSON 备份。',
      okText: '确认清空',
    });
    if (!ok) return;
    clearBtn.disabled = true;
    try {
      await clearAllData();
      toast('数据已清空', 'ok');
      await window.HMS.refresh();
    } catch (err) {
      toast(`清空失败：${err && err.message ? err.message : err}`, 'error');
      clearBtn.disabled = false;
    }
  });

  refreshBackupLine();

  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '数据' }),
      el('div', { className: 'muted', text: '全部在本机' }),
    ),
    el('div', { className: 'grid-2' }, exportJsonBtn, exportCsvBtn),
    backupLine,
    el('div', { className: 'divider' }),
    labeled('选择备份文件', fileInput),
    labeled('导入方式', modeSelect),
    importBtn,
    el('div', { className: 'divider' }),
    el('button', { className: 'btn btn--ghost btn--block', text: '打开自检页', onClick: () => go('#/debug') }),
    clearBtn,
  ));

  // ---- 关于 / 更新 ----
  // 「检查更新」必须能就地更新：不能再把用户指回今日页（今日页的提示条可能正因为
  // 「稍后」的抑制状态不出现 —— 那条死路就是这次修的 bug）。
  const updateResult = el('div', { className: 'col update-check' });
  let updateBusy = false;

  const showUpdateText = (text) => {
    updateResult.textContent = '';
    updateResult.appendChild(el('div', { className: 'muted', text }));
  };

  /** 发现新版：能装就给一个真能点的安装入口；装不了就直说怎么更新，不放死按钮。 */
  const showUpdateAction = (remote) => {
    const version = versionLabel(remote);
    updateResult.textContent = '';
    updateResult.appendChild(el('div', {
      className: 'update-check__title',
      text: version ? `发现新版本 ${version}` : '发现新版本',
    }));
    if (!isInstallAvailable()) {
      updateResult.appendChild(el('div', { className: 'muted', text: webUpdateGuidance() }));
      return;
    }
    const installBtn = el('button', { className: 'btn btn--primary btn--block update-check__install', text: '下载并安装' });
    installBtn.addEventListener('click', () => {
      if (installBtn.disabled) return;
      installBtn.disabled = true;
      installBtn.textContent = '准备中…';
      // 与今日页「立即更新」同一个入口（js/update.js 的 installUpdate），不另写下载/安装逻辑。
      const result = installUpdate(remote);
      if (result && result.ok === false) {
        installBtn.disabled = false;
        installBtn.textContent = '下载并安装';
        toast(`更新失败：${result.reason || '未知错误'}`, 'error');
      }
    });
    updateResult.appendChild(installBtn);
    updateResult.appendChild(el('div', { className: 'muted', text: '下载与安装由系统完成，装完应用会重启。' }));
  };

  const checkUpdateNow = async () => {
    if (updateBusy) return;
    updateBusy = true;
    showUpdateText('正在检查更新…');
    try {
      const result = await checkForUpdate();
      if (result.status === 'unavailable') { showUpdateText(webUpdateGuidance()); return; }
      if (result.status === 'timeout') { showUpdateText('检查超时，请确认网络后重试'); return; }
      if (result.status === 'error') { showUpdateText(`检查失败：${result.error || '未知错误'}`); return; }
      if (result.status === 'latest') {
        const current = result.local && result.local.versionName ? `（当前 ${result.local.versionName}）` : '';
        showUpdateText(`已是最新版本${current}`);
        return;
      }
      // 用户是主动来查更新的：先清掉「稍后」留下的抑制状态，免得今日页也跟着不弹。
      clearDismissed();
      showUpdateAction(result.remote);
    } catch (error) {
      showUpdateText(`检查失败：${error && error.message ? error.message : '未知错误'}`);
    } finally {
      updateBusy = false;
    }
  };

  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'card__title', text: '关于' }),
    el('div', { className: 'row row--between' }, el('span', { className: 'label', text: '版本' }), el('span', { className: 'muted', text: buildVersionLabel() })),
    el('button', { className: 'btn btn--ghost btn--block', text: '检查更新', onClick: checkUpdateNow }),
    updateResult,
    el('div', { className: 'divider' }),
    el('div', { className: 'muted', text: '隐私说明：所有健康数据只保存在本机浏览器的 IndexedDB，不上传任何服务器。只有使用拍照识别时，照片会直接发送到你配置的阿里百炼接口。' }),
    el('div', { className: 'muted', text: '建议定期在「数据」里导出 JSON 备份；清除浏览器数据会丢失记录。' }),
  ));
}

/**
 * 版本号：APK 里取原生桥的真实版本；PWA 里没有构建号，直接标网页版。
 */
function buildVersionLabel() {
  try {
    if (typeof window !== 'undefined' && window.HmsBridge && typeof window.HmsBridge.version === 'function') {
      const info = JSON.parse(window.HmsBridge.version());
      if (info && info.versionName) return 'v' + info.versionName + '（' + info.versionCode + '）';
    }
  } catch { /* 桥坏了不该影响设置页渲染 */ }
  return '网页版（自动更新）';
}

