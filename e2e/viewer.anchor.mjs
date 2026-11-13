// 查看器冒烟测试的锚点与重排步骤，原样从 viewer.mjs 移出。
export async function checkAnchors({ wd, until, exec, click, check, base, image }) {
  const anchor = await exec(`const wall = document.querySelector('.wall'); wall.scrollTop = 720; wall.dispatchEvent(new Event('scroll'));
    const top = wall.getBoundingClientRect().top; const cards = [...wall.querySelectorAll('.card')].map(c => ({ id: c.dataset.id, r: c.getBoundingClientRect() })).filter(c => c.r.bottom > top + 8 && c.r.top < top + wall.clientHeight).sort((a,b) => a.r.top - b.r.top || a.r.left - b.r.left);
    return { id: cards[0].id, offset: cards[0].r.top - top };`);
  const reading = await exec(`const wall = document.querySelector('.wall'); const top = wall.getBoundingClientRect().top;
    const card = [...wall.querySelectorAll('.card')].find(c => { const r = c.getBoundingClientRect(); return r.top >= top && r.bottom <= top + wall.clientHeight; });
    card.focus({preventScroll:true}); return { id: card.dataset.id, top: wall.scrollTop };`);
  const key = async (value) => wd("POST", `${base}/actions`, { actions: [{type:"key",id:"keyboard",actions:[{type:"keyDown",value},{type:"keyUp",value}]}] });
  await key("\uE007"); // Enter
  await until("键盘打开查看器", image);
  await key("\uE00C"); // Escape
  await until("键盘返回图片墙", () => exec("return !document.querySelector('.viewer')"));
  // 查看时选择跟着这张图（#179）：返回后这张图仍在视口里并获得焦点。
  check(await exec(`const c = document.activeElement, wall = document.querySelector('.wall'), w = wall.getBoundingClientRect(), r = c?.getBoundingClientRect();
    return c?.dataset.id === arguments[0].id && c.getAttribute('aria-selected') === 'true' && r.bottom > w.top && r.top < w.bottom;`, [reading]), "滚动后用回车查看，Esc 返回后那张图在视口里、仍选中并获得焦点");
  const anchorOffset = () => exec(`const c = document.querySelector('[data-id="' + arguments[0] + '"]'); const wall = document.querySelector('.wall'); if (!c || c.getAnimations().some(a => a.playState === 'running')) return null; return c.getBoundingClientRect().top - wall.getBoundingClientRect().top;`, [anchor.id]);
  const anchorStable = async () => {
    const moving = await exec("return document.querySelector('.sidebar-slot').getAnimations().some(a => a.playState === 'running')");
    const offset = await anchorOffset();
    return !moving && offset !== null && Math.abs(offset - anchor.offset) < 1;
  };
  await click("收起侧栏");
  await until("收起侧栏锚点稳定", anchorStable);
  await click("展开侧栏");
  await until("展开侧栏锚点稳定", anchorStable);
  check(true, "侧栏往返重排保持同一张图的偏移");
  await wd("POST", `${base}/window/rect`, { width: 1050, height: 800 });
  await until("窗口变窄锚点稳定", anchorStable);
  await wd("POST", `${base}/window/rect`, { width: 1280, height: 800 });
  await until("窗口变宽锚点稳定", anchorStable);
  check(true, "原生窗口宽度往返保持同一张图的偏移");
  return { anchor, reading };
}
