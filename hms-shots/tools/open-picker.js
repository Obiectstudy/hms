// 预加载：手动添加 → 点第一行的「选择」→ 截取份量 chip 详情层
(function () {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const clickText = (text, exact) => {
    const all = Array.from(document.querySelectorAll('button, a, div, span'));
    const hit = all.find((n) => {
      const t = (n.textContent || '').trim();
      return exact ? t === text : t.includes(text);
    });
    if (hit) { hit.click(); return true; }
    return false;
  };
  (async () => {
    for (let i = 0; i < 60; i++) {
      const v = document.querySelector('#view');
      if (v && v.childElementCount > 0) break;
      await wait(150);
    }
    await wait(400);
    clickText('手动添加');
    await wait(900);
    // 第一行右侧的「选择」
    const ok = clickText('选择', true);
    if (!ok) {
      const row = document.querySelector('.pick-item');
      if (row) row.click();
    }
  })();
})();
