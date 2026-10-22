// 运动页（SPEC §7「运动」）：MET 估算净消耗（不含基础代谢），可手改。
import { el, clear, toast, confirmDialog, emptyState, fmtKcal, fmtDateCN, fmtTime } from '../js/ui.js';
import { localDateStr, EXERCISE_TYPES, estimateBurn } from '../js/nutrition.js';
import { daySummary, logExercise, deleteExercise, recentWeights } from '../js/store.js';

/* ---------- 类型 / 强度 ---------- */

function findType(value) {
  return EXERCISE_TYPES.find((t) => t && t.value === value) || null;
}

/** 类型按 group 分组；组与组内顺序都照 EXERCISE_TYPES 的声明顺序（optgroup 用）。 */
export function groupExerciseTypes(types) {
  const groups = new Map();
  for (const type of Array.isArray(types) ? types : []) {
    if (!type || !type.value) continue;
    const key = type.group || '其他';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(type);
  }
  return [...groups.entries()].map(([label, list]) => ({ label, list }));
}

/** 该类型的强度档位；没有 intensities 的类型返回空数组（界面就不出强度下拉）。 */
export function intensitiesOf(type) {
  const hit = findType(type);
  return hit && Array.isArray(hit.intensities) ? hit.intensities : [];
}

/** 默认档位：met 与该类型默认 met 相同的那一档（数据侧默认就是中档），没有就第一档。 */
export function defaultIntensityOf(type) {
  const list = intensitiesOf(type);
  if (!list.length) return '';
  const hit = findType(type);
  const same = list.find((item) => Number(item.met) === Number(hit.met));
  return (same || list[0]).value;
}

const INTENSITY_MEMO_PREFIX = 'hms.ex.intensity.';

/**
 * 记住每个运动类型上次选的强度档位。
 * 常骑车的人均速基本固定（比如城市里 15–18km/h 对应通勤档），
 * 不该每次记一次运动都重新选一遍。
 */
export function rememberedIntensity(type) {
  try {
    const saved = globalThis.localStorage && globalThis.localStorage.getItem(INTENSITY_MEMO_PREFIX + type);
    if (saved && intensitiesOf(type).some((item) => item.value === saved)) return saved;
  } catch {
    // 隐私模式或存储被禁用：退回默认档，不影响记录。
  }
  return '';
}

export function rememberIntensity(type, intensity) {
  try {
    if (intensity) globalThis.localStorage.setItem(INTENSITY_MEMO_PREFIX + type, intensity);
  } catch {
    // 存不下就算了，功能本身不依赖它。
  }
}

/** 标签：旧记录（walk/jog/bike/swim/strength/other）照样查得到中文；带档位时补上档位名。 */
export function exerciseLabel(type, intensity) {
  const hit = findType(type);
  const base = hit ? hit.label : '运动';
  const found = intensitiesOf(type).find((item) => item.value === intensity);
  return found ? `${base} · ${found.label}` : base;
}

export async function render(root) {
  const date = localDateStr();
  const [summary, weights] = await Promise.all([daySummary(date), recentWeights(1)]);
  const latest = (Array.isArray(weights) && weights.length)
    ? weights.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]
    : null;
  // 没有体重数据时用 65kg 兜底，否则估算会变成 0 让用户以为功能坏了。
  const weightKg = latest && Number(latest.weightKg) > 0 ? Number(latest.weightKg) : 65;

  root.appendChild(el('div', { className: 'col' },
    el('div', { className: 'h1', text: '运动' }),
    el('div', { className: 'muted', text: `按当前体重 ${weightKg} kg 估算净消耗（不含基础代谢），可手动修改` }),
  ));

  const typeSelect = el('select', { className: 'select' },
    groupExerciseTypes(EXERCISE_TYPES).map((group) => el('optgroup', { attr: { label: group.label } },
      group.list.map((type) => el('option', { value: type.value, text: type.label })),
    )),
  );
  // 初值必须写死：空值会掉进「未知类型」的兜底 MET，估算就跟界面显示的类型对不上。
  if (EXERCISE_TYPES.length) typeSelect.value = EXERCISE_TYPES[0].value;

  const minutesInput = el('input', { className: 'input', type: 'number', inputmode: 'numeric', min: '1', max: '600', step: '1', placeholder: '例如 30' });
  const kcalInput = el('input', { className: 'input', type: 'number', inputmode: 'numeric', min: '0', step: '1', placeholder: '自动估算' });
  const noteInput = el('input', { className: 'input', type: 'text', placeholder: '可选，如「晚饭后快走」' });
  const estimateHint = el('div', { className: 'muted estimate-hint', text: '' });
  const intensitySlot = el('div', { className: 'intensity-slot' });
  let intensitySelect = null;

  const intensityValue = () => (intensitySelect ? intensitySelect.value : '');

  const estimate = () => {
    const minutes = Number(minutesInput.value);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    return estimateBurn({ type: typeSelect.value, minutes, weightKg, intensity: intensityValue() });
  };

  const refreshEstimate = () => {
    const kcal = estimate();
    kcalInput.placeholder = kcal == null ? '自动估算' : `自动估算 ${kcal} kcal`;
    estimateHint.textContent = kcal == null
      ? '填写时长后按净消耗估算'
      : `估算 ${kcal} kcal（${exerciseLabel(typeSelect.value, intensityValue())} · ${minutesInput.value} 分钟 · 净消耗）`;
  };

  /** 选中类型有档位才出现下拉；每次按新类型重算默认档位，不留上一个类型的档位。 */
  const syncIntensity = () => {
    clear(intensitySlot);
    intensitySelect = null;
    const list = intensitiesOf(typeSelect.value);
    if (!list.length) return;
    const select = el('select', { className: 'select' },
      list.map((item) => el('option', { value: item.value, text: item.label })),
    );
    select.value = rememberedIntensity(typeSelect.value) || defaultIntensityOf(typeSelect.value);
    select.addEventListener('change', () => {
      rememberIntensity(typeSelect.value, select.value);
      refreshEstimate();
    });
    intensitySelect = select;
    intensitySlot.appendChild(el('label', { className: 'field intensity-field' },
      el('span', { className: 'field__label', text: '强度 / 配速' }), select));
  };

  typeSelect.addEventListener('change', () => { syncIntensity(); refreshEstimate(); });
  minutesInput.addEventListener('input', refreshEstimate);
  syncIntensity();
  refreshEstimate();

  const saveBtn = el('button', { className: 'btn btn--primary btn--block', text: '保存运动' });
  saveBtn.addEventListener('click', async () => {
    const minutes = Number(minutesInput.value);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 600) {
      toast('时长请填写 1~600 分钟', 'error');
      minutesInput.focus();
      return;
    }
    const auto = estimate();
    const manual = kcalInput.value === '' ? null : Number(kcalInput.value);
    const kcalBurned = Number.isFinite(manual) ? Math.max(0, Math.round(manual)) : (auto == null ? 0 : auto);
    saveBtn.disabled = true;
    try {
      await logExercise({
        date,
        type: typeSelect.value,
        minutes,
        kcalBurned,
        note: noteInput.value.trim() || undefined,
        intensity: intensityValue() || undefined,
      });
      toast('运动已记录', 'ok');
      await window.HMS.refresh();
    } catch (err) {
      toast(`保存失败：${err && err.message ? err.message : err}`, 'error');
      saveBtn.disabled = false;
    }
  });

  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '记录运动' }),
      el('div', { className: 'muted', text: fmtDateCN(date) }),
    ),
    el('label', { className: 'field type-field' }, el('span', { className: 'field__label', text: '类型' }), typeSelect),
    intensitySlot,
    el('div', { className: 'grid-2' },
      el('label', { className: 'field' }, el('span', { className: 'field__label', text: '时长 (分钟)' }), minutesInput),
      el('label', { className: 'field' }, el('span', { className: 'field__label', text: '消耗 (kcal)' }), kcalInput),
    ),
    estimateHint,
    el('label', { className: 'field' }, el('span', { className: 'field__label', text: '备注' }), noteInput),
    saveBtn,
  ));

  const exercises = Array.isArray(summary.exercises) ? summary.exercises : [];
  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '今日合计' }),
      el('div', { className: 'stat__line' },
        el('span', { className: 'stat__value', text: fmtKcal(summary.burned) }),
        el('span', { className: 'stat__unit', text: 'kcal' }),
      ),
    ),
  ));

  const listCard = el('div', { className: 'card' },
    el('div', { className: 'card__head' },
      el('div', { className: 'card__title', text: '今日记录' }),
      el('div', { className: 'muted', text: `${exercises.length} 条` }),
    ),
  );
  if (!exercises.length) {
    listCard.appendChild(emptyState('今天还没有运动记录', '填一条', () => minutesInput.focus()));
  } else {
    const list = el('div', { className: 'list' });
    for (const item of exercises.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))) {
      // 类型标签按 EXERCISE_TYPES 查，旧记录里的 walk/jog/bike… 仍然显示中文。
      const label = exerciseLabel(item.type, item.intensity);
      const del = el('button', { className: 'btn btn--ghost btn--sm btn--danger', text: '删除' });
      del.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: '删除这条运动记录？',
          message: `${label} · ${item.minutes} 分钟`,
          okText: '删除',
        });
        if (!ok) return;
        try {
          await deleteExercise(item.id);
          toast('已删除', 'ok');
          await window.HMS.refresh();
        } catch (err) {
          toast(`删除失败：${err && err.message ? err.message : err}`, 'error');
        }
      });
      list.appendChild(el('div', { className: 'list__item' },
        el('div', { className: 'list__item--main' },
          el('div', { className: 'strong', text: `${label} · ${fmtKcal(item.kcalBurned)} kcal` }),
          el('div', {
            className: 'list__item--meta',
            text: [item.minutes ? `${item.minutes} 分钟` : '', item.createdAt ? fmtTime(item.createdAt) : '', item.note || ''].filter(Boolean).join(' · '),
          }),
        ),
        del,
      ));
    }
    listCard.appendChild(list);
  }
  root.appendChild(listCard);
}