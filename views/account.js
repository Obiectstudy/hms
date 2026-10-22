// 账号页（本机多账号）：登记 / 切换 / 改名 / 删除。
// 隔离原则见 js/accounts.js：一个账号一个 IndexedDB 库，数据只存在这台设备。
// 云同步属于下一阶段，这里只放一个禁用状态的登录入口占位，不做假表单。
import { el, toast, confirmDialog, openSheet, emptyState } from '../js/ui.js';
import {
  listAccounts, getActiveAccount, createAccount, renameAccount, removeAccount,
  dbNameForAccount, LEGACY_DB_NAME, MAX_ACCOUNTS,
} from '../js/accounts.js';
import { currentAccount, switchAccount } from '../js/store.js';
import { dumpAll } from '../js/db.js';

const go = (hash) => window.HMS.navigate(hash);
const refresh = () => window.HMS.refresh();

const messageOf = (error) => (error && error.message ? error.message : String(error));

const isLegacy = (account) => dbNameForAccount(account) === LEGACY_DB_NAME;

/**
 * 数据规模（当前账号）：dumpAll 是数据层唯一只读统计入口
 * （exportJSON 会顺手记一笔「上次备份」，不能拿来当只读用）。
 */
async function readScale() {
  try {
    const dump = await dumpAll();
    return {
      weights: dump.weights.length,
      meals: dump.meals.length,
      exercises: dump.exercises.length,
      waters: dump.waters.length,
    };
  } catch {
    return null; // 统计失败只让数字变成「—」，不能连累整页渲染
  }
}

const SCALE_ROWS = [
  ['weights', '体重'],
  ['meals', '饮食'],
  ['exercises', '运动'],
  ['waters', '饮水'],
];

function createdText(createdAt) {
  const ts = Number(createdAt);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} 创建`;
}

/** 行内 async 流程：异常一律变成一条 toast，不冒泡成未处理的 rejection。 */
function guard(task) {
  return () => {
    Promise.resolve().then(task).catch((error) => toast(messageOf(error), 'error'));
  };
}

function inputBox(props = {}) {
  return el('input', { className: 'input', type: 'text', ...props });
}

function labeled(label, control) {
  return el('label', { className: 'field' }, el('span', { className: 'field__label', text: label }), control);
}

/**
 * 起名弹层：新建与改名共用。
 * onSubmit 抛错时把中文报错原样显示（例如「账号名称不能为空」）并保持弹层打开。
 */
function askName({ title, value, submitText, note, onSubmit }) {
  return openSheet({
    title,
    content: ({ close }) => {
      const input = inputBox({ value: value || '', attr: { maxlength: '20', placeholder: '例如 家人' } });
      const submit = el('button', { className: 'btn btn--primary btn--block', text: submitText });
      submit.addEventListener('click', () => {
        Promise.resolve()
          .then(() => onSubmit(input.value))
          .then((result) => close(result), (error) => toast(messageOf(error), 'error'));
      });
      return el('div', { className: 'col' },
        labeled('账号名称', input),
        note ? el('div', { className: 'muted', text: note }) : null,
        submit,
      );
    },
    actions: [{ text: '取消', value: null }],
  });
}

export async function render(root) {
  const ensured = await currentAccount(); // 幂等：一次都没建过账号时先认领老库
  const accounts = listAccounts();
  const scale = await readScale();
  const current = ensured ?? { id: null, name: '本机', dbName: LEGACY_DB_NAME };
  const activeId = accounts.some((a) => a.id === current.id) ? current.id : null;

  root.appendChild(el('div', { className: 'row row--between' },
    el('div', { className: 'col' },
      el('div', { className: 'h1', text: '账号' }),
      el('div', { className: 'muted', text: '每个账号的数据单独保存' }),
    ),
    el('button', { className: 'btn btn--ghost btn--sm', text: '返回设置', onClick: () => go('#/settings') }),
  ));

  // ---- 当前账号 ----
  const legacyCurrent = isLegacy(current);
  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '当前账号' }),
      el('span', { className: legacyCurrent ? 'pill pill--ok' : 'pill', text: legacyCurrent ? '本机老数据' : '新建的账号' }),
    ),
    el('div', { className: 'account-name', text: String(current.name || '本机') }),
    el('div', { className: 'grid-2 account-stats' },
      SCALE_ROWS.map(([key, label]) => {
        const count = scale ? scale[key] : null;
        const known = Number.isFinite(count);
        return el('div', { className: 'stat' },
          el('div', { className: 'stat__line' },
            el('span', { className: 'stat__value stat__value--sm', text: known ? String(count) : '—' }),
            known ? el('span', { className: 'stat__unit', text: '条' }) : null,
          ),
          el('div', { className: 'stat__label', text: label }),
        );
      }),
    ),
    el('div', { className: 'muted', text: '数据只存在这台设备' }),
  ));

  // ---- 登录 / 注册占位（下一阶段做云同步，这里绝不放假表单） ----
  root.appendChild(el('div', { className: 'card col' },
    el('button', { className: 'btn btn--block', text: '登录 / 注册', disabled: true, attr: { 'aria-disabled': 'true' } }),
    el('div', { className: 'muted', text: '下一阶段开放：登录后可在别的设备恢复数据' }),
  ));

  // ---- 账号列表 ----
  const full = accounts.length >= MAX_ACCOUNTS;
  const listCard = el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '账号列表' }),
      el('div', { className: 'muted', text: `${accounts.length} / ${MAX_ACCOUNTS}` }),
    ),
  );

  const list = el('div', { className: 'account-list' });
  for (const account of accounts) {
    const active = account.id === activeId;
    const legacy = isLegacy(account);
    const identity = legacy ? '本机老数据' : '新建的账号';
    const created = legacy ? '' : createdText(account.createdAt);
    list.appendChild(el('div', { className: active ? 'account-row account-row--active' : 'account-row' },
      el('button', { className: 'account-row__main', onClick: guard(() => selectAccount(account)) },
        el('div', { className: 'account-row__name', text: account.name }),
        el('div', { className: 'account-row__meta', text: [identity, created, active ? '当前使用' : '点一下切换'].filter(Boolean).join(' · ') }),
      ),
      el('div', { className: 'account-row__acts' },
        el('button', { className: 'account-row__btn', text: '改名', onClick: guard(() => renameFlow(account)) }),
        legacy
          ? el('button', { className: 'account-row__btn account-row__btn--danger', text: '删除', disabled: true, attr: { 'aria-disabled': 'true' } })
          : el('button', { className: 'account-row__btn account-row__btn--danger', text: '删除', onClick: guard(() => removeFlow(account)) }),
      ),
      legacy ? el('div', { className: 'account-row__note', text: '本机数据所在账号不能删除' }) : null,
    ));
  }
  listCard.appendChild(accounts.length ? list : emptyState('还没有可切换的账号', '新建账号', guard(createFlow)));
  listCard.appendChild(el('button', {
    className: 'btn btn--primary btn--block account-new',
    text: full ? `已达上限（${MAX_ACCOUNTS} 个）` : '新建账号',
    disabled: full,
    onClick: guard(createFlow),
  }));
  root.appendChild(listCard);

  // ---------- 操作 ----------

  async function selectAccount(account) {
    if (account.id === activeId) {
      toast('已经在这个账号');
      return;
    }
    await switchAccount(account.id); // 换库：库名跟着账号走，页面按新库重画
    await refresh();
    toast(`已切换到 ${account.name}`, 'ok');
  }

  async function createFlow() {
    const created = await askName({
      title: '新建账号',
      value: '',
      submitText: '创建并切换',
      note: '新账号从空数据开始，与现在的数据互不影响',
      onSubmit: (name) => createAccount({ name }),
    });
    if (!created || typeof created !== 'object') return; // 用户取消：什么都没发生
    await switchAccount(created.id);
    await refresh();
    toast('新账号从空数据开始', 'ok');
  }

  async function renameFlow(account) {
    const renamed = await askName({
      title: '重命名账号',
      value: account.name,
      submitText: '保存名称',
      onSubmit: (name) => renameAccount(account.id, name),
    });
    if (!renamed || typeof renamed !== 'object') return;
    await refresh();
    toast(`已改名为 ${renamed.name}`, 'ok');
  }

  async function removeFlow(account) {
    const ok = await confirmDialog({
      title: `删除账号「${account.name}」？`,
      message: '该账号的数据会从本机删除，且无法恢复。',
      okText: '删除',
    });
    if (!ok) return;
    await removeAccount(account.id);
    let next = null;
    if (account.id === activeId) {
      // 删掉的正是当前账号：回到目录里的下一个账号（通常是认领老库的那个）
      next = await currentAccount();
      if (next) await switchAccount(next.id);
    }
    await refresh();
    toast(next ? `已删除「${account.name}」，已切回「${next.name}」` : `已删除「${account.name}」`, 'ok');
  }
}
