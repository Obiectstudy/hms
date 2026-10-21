// 设置页（SPEC §7「设置」）：档案 / 目标 / 视觉识别 / 数据 / 关于。
import { el, toast, confirmDialog, fmt1 } from '../js/ui.js';
import { localDateStr } from '../js/nutrition.js';
import {
  getProfile, saveProfile, getGoals, saveGoals, computeDefaultGoals,
  getSettings, saveSettings,
  exportJSON, exportCSV, importJSON, clearAllData, exportStatus,
} from '../js/store.js';
import { testConnection, MODEL_CANDIDATES, DEFAULT_BASE_URL, DEFAULT_MODEL } from '../js/vision.js';

const ACTIVITIES = [
  { value: 'sedentary', label: '久坐（基本不运动）' },
  { value: 'light', label: '轻度（每周 1~3 次）' },
  { value: 'moderate', label: '中等（每周 3~5 次）' },
  { value: 'active', label: '活跃（每周 6~7 次）' },
  { value: 'very_active', label: '高强度（体力工作/训练）' },
];

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
  const [profileRaw, goals, settings] = await Promise.all([getProfile(), getGoals(), getSettings()]);
  const profile = profileRaw || {};
  const currentSettings = settings || {};

  root.appendChild(el('div', { className: 'row row--between' },
    el('div', { className: 'col' },
      el('div', { className: 'h1', text: '设置' }),
      el('div', { className: 'muted', text: '数据只保存在本机浏览器' }),
    ),
    el('button', { className: 'btn btn--ghost btn--sm', text: '返回今日', onClick: () => go('#/') }),
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

  // ---- 每日目标 ----
  const calorieTarget = inputBox({ type: 'number', inputmode: 'numeric', step: '10', value: String(goals.calorieTarget || '') });
  const carbPct = inputBox({ type: 'number', inputmode: 'numeric', step: '1', value: String(goals.carbPct || '') });
  const proteinPct = inputBox({ type: 'number', inputmode: 'numeric', step: '1', value: String(goals.proteinPct || '') });
  const fatPct = inputBox({ type: 'number', inputmode: 'numeric', step: '1', value: String(goals.fatPct || '') });
  const waterMl = inputBox({ type: 'number', inputmode: 'numeric', step: '50', value: String(goals.waterMl || '') });
  const goalWeightTarget = inputBox({ type: 'number', inputmode: 'decimal', step: '0.1', value: goals.weightTargetKg != null ? String(goals.weightTargetKg) : '' });
  const ratioHint = el('div', { className: 'muted', text: '' });

  const sumRatio = () => Number(carbPct.value) + Number(proteinPct.value) + Number(fatPct.value);
  const updateRatioHint = () => {
    const sum = sumRatio();
    ratioHint.textContent = `碳水 + 蛋白质 + 脂肪 = ${Number.isFinite(sum) ? Math.round(sum) : 0}%（应为 100%）`;
  };
  for (const node of [carbPct, proteinPct, fatPct]) node.addEventListener('input', updateRatioHint);
  updateRatioHint();

  const estimateBtn = el('button', { className: 'btn btn--ghost btn--block', text: '按档案自动估算' });
  estimateBtn.addEventListener('click', async () => {
    try {
      const computed = await computeDefaultGoals(profileRaw);
      calorieTarget.value = String(computed.calorieTarget);
      carbPct.value = String(computed.carbPct);
      proteinPct.value = String(computed.proteinPct);
      fatPct.value = String(computed.fatPct);
      waterMl.value = String(computed.waterMl);
      if (computed.weightTargetKg != null) goalWeightTarget.value = String(computed.weightTargetKg);
      updateRatioHint();
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
    labeled('热量目标 (kcal)', calorieTarget),
    el('div', { className: 'grid-3' }, labeled('碳水 %', carbPct), labeled('蛋白质 %', proteinPct), labeled('脂肪 %', fatPct)),
    ratioHint,
    el('div', { className: 'grid-2' }, labeled('饮水目标 (ml)', waterMl), labeled('目标体重 (kg)', goalWeightTarget)),
    estimateBtn,
    goalsSave,
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

  // ---- 关于 ----
  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'card__title', text: '关于' }),
    el('div', { className: 'row row--between' }, el('span', { className: 'label', text: '版本' }), el('span', { className: 'muted', text: buildVersionLabel() })),
    el('button', { className: 'btn btn--ghost btn--block', text: '检查更新', onClick: checkUpdateNow }),
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

/**
 * 手动检查更新：把结果直接告诉用户，避免"没反应"这种无法诊断的状态。
 * 原生回调走 window.__hmsUpdate，这里临时接管，用完立刻还原给今日页的提示条逻辑。
 */
function checkUpdateNow() {
  if (typeof window === 'undefined' || !window.HmsBridge || typeof window.HmsBridge.checkUpdate !== 'function') {
    toast('网页版会自动更新，不需要手动检查');
    return;
  }
  const previous = window.__hmsUpdate;
  let settled = false;
  const restore = () => { window.__hmsUpdate = previous; };
  window.__hmsUpdate = (raw) => {
    if (settled) return;
    settled = true;
    restore();
    let info = null;
    try { info = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { info = null; }
    if (!info) { toast('检查失败：返回内容无法解析'); return; }
    if (info.ok) toast('发现新版本 ' + info.versionName + '，回今日页点「立即更新」');
    else toast(info.error || '已是最新版本');
  };
  try { window.HmsBridge.checkUpdate(); }
  catch (error) { settled = true; restore(); toast('检查失败：' + (error && error.message ? error.message : '未知错误')); return; }
  setTimeout(() => {
    if (settled) return;
    settled = true;
    restore();
    toast('检查超时，请确认网络后重试');
  }, 15000);
}
