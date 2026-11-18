// 饮水页（SPEC §7「饮水」）：大号进度 + 快捷加量 + 自定义 + 撤销。
import { el, ring, toast, openSheet, confirmDialog, fmtKcal, markBusy } from '../js/ui.js';
import { localDateStr } from '../js/nutrition.js';
import { daySummary, getGoals, addWater } from '../js/store.js';

const go = (hash) => window.HMS.navigate(hash);

export async function render(root) {
  const date = localDateStr();
  const [summary, goals] = await Promise.all([daySummary(date), getGoals()]);
  const water = Number(summary.water) || 0;
  const target = Number(goals.waterMl) || 2000;
  const done = water >= target;

  root.appendChild(el('div', { className: 'row row--between' },
    el('div', { className: 'col' },
      el('div', { className: 'h1', text: '饮水' }),
      el('div', { className: 'muted', text: done ? '今天的目标已完成，继续也欢迎' : `还差 ${target - water} ml 达标` }),
    ),
    el('button', { className: 'btn btn--ghost icon-btn', text: '⚙', attr: { 'aria-label': '设置目标' }, onClick: () => go('#/settings') }),
  ));

  /**
   * 快捷加量 / 撤销。写入本身在 store 层是原子的（同一帧连点两次各记各的，不会互相覆盖），
   * 这里只负责把「正在提交」这件事画出来：按钮在提交期间不可点，操作结束再恢复。
   */
  const apply = async (delta, label, button = null) => {
    const release = markBusy(button);
    try {
      await addWater(date, delta);
      toast(label, 'ok');
      await window.HMS.refresh();
    } catch (err) {
      toast(`操作失败：${err && err.message ? err.message : err}`, 'error');
    } finally {
      release();
    }
  };

  /** 快捷按钮自己当护栏：文本与标签由增量决定，点击时把节点交给 apply。 */
  const quickButton = (text, delta, className) => {
    const button = el('button', { className, text });
    button.addEventListener('click', () => apply(delta, `已记录 ${delta}ml`, button));
    return button;
  };

  const card = el('div', { className: `card col ${done ? 'card--done' : ''}` },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '今日饮水' }),
      el('div', { className: `pill ${done ? 'pill--ok' : ''}`, text: done ? '已达标' : `目标 ${target} ml` }),
    ),
    el('div', { className: 'ring-wrap' }, ring({ value: water, max: target, label: `目标 ${target} ml`, unit: 'ml', color: 'var(--water)' })),
    el('div', { className: 'grid-3' },
      quickButton('+200', 200, 'btn btn--ghost btn--block'),
      quickButton('+250', 250, 'btn btn--primary btn--block'),
      quickButton('+500', 500, 'btn btn--ghost btn--block'),
    ),
  );

  // 「撤销」也要自报家门（按钮在提交期间置灰），所以先建节点、再挂监听、最后入树。
  const undoButton = el('button', { className: 'btn btn--ghost btn--danger', text: '撤销 250ml' });
  undoButton.addEventListener('click', async () => {
    if (water <= 0) {
      toast('今天还没有记录，无法撤销', 'error');
      return;
    }
    await apply(-250, '已撤销 250ml', undoButton);
  });

  card.appendChild(el('div', { className: 'row', style: { marginTop: '4px' } },
    el('button', {
      className: 'btn btn--ghost',
      text: '自定义',
      onClick: async () => {
        const input = el('input', { className: 'input', type: 'number', inputmode: 'numeric', min: '1', step: '50', placeholder: '毫升，例如 350' });
        const value = await openSheet({
          title: '自定义加水量',
          content: el('div', { className: 'col' },
            el('div', { className: 'muted', text: `当前 ${water} ml，目标 ${target} ml` }),
            input,
          ),
          actions: [
            { text: '添加', value: 'add', primary: true },
            { text: '取消', value: null },
          ],
        });
        if (value !== 'add') return;
        const ml = Number(input.value);
        if (!Number.isFinite(ml) || ml <= 0 || ml > 5000) {
          toast('请输入 1~5000 之间的毫升数', 'error');
          return;
        }
        await apply(Math.round(ml), `已记录 ${Math.round(ml)}ml`);
      },
    }),
    undoButton,
  ));
  root.appendChild(card);

  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'row row--between' },
      el('span', { className: 'label', text: `已完成 ${Math.min(100, Math.round((water / target) * 100))}%` }),
      el('span', { className: 'muted', text: `${fmtKcal(water)} / ${fmtKcal(target)} ml` }),
    ),
    el('div', { className: 'muted', text: '建议分配：起床后 300ml、三餐前各 250ml、运动后按需补充。' }),
    el('div', { className: 'divider' }),
    el('div', { className: 'row row--between' },
      el('span', { className: 'label', text: '今日总目标' }),
      el('button', { className: 'btn btn--ghost btn--sm', text: '修改目标', onClick: () => go('#/settings') }),
    ),
  ));
}
