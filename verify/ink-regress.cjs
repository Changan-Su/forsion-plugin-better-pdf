// 手写回归:11-16 手写 / 批注跟手那轮改动碰到的路径,每条都按真实用法走一遍(真 Electron、隔离库、CDP 笔事件)。
//   R1 一笔一存:抬笔后 1.5 秒内批注文件里就有这一笔
//   R2 刚画完马上关窗:重开还在
//   R3 撤销 / 重做:笔迹数跟着变,存进文件
//   R4 橡皮:擦掉一笔,存进文件
//   R5 手写时缩放刚停、笔不悬停直接落下:这一下不画(白板层还没跟上),再落一次画对位置;静态图 / 白板层都露着正确的那一份
//   R6 笔先悬停再落下:缩放刚停也能直接画,位置对
//   R7 手写时缩放还没收尾就换工具再换回来:白板层露着(没卡在藏着),下一笔位置对
//   R8 选择工具下滚动还没收尾就换手写、马上缩放:收尾后白板层露着、能画(Codex 评审抓到的定时器互相取消)
// 跑(在 Forsion 仓根;桌面端先 npm run build):
//   node .claude/hooks/devlock.cjs run --vehicle=e2e --what="Better PDF 手写回归" --eta=4 -- node Forsion-Instrumentality-Project/forsion-plugin-pdf-reader/verify/ink-regress.cjs
// GENESIS_DESKTOP / UI_ZOOM 同 ink-latency.cjs。
const fs = require('fs'); const os = require('os'); const path = require('path')
const { launch, openRow, sleep } = require('./ink-latency.cjs')
const { makePdf, PDF } = require('./ink-follow.cjs')
const HERE = path.resolve(__dirname, '..')
const fails = []
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`); if (!ok) fails.push(name) }

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-inkreg-'))
  const vault = path.join(home, 'Vault'); fs.mkdirSync(vault, { recursive: true })
  await makePdf(path.join(vault, PDF))
  const plug = path.join(home, 'plugins', 'pdf-reader'); fs.mkdirSync(plug, { recursive: true })
  // PLUGIN_FROM=<插件检出>:拿别的版本跑(比如没改之前的 main,当基线)
  for (const f of ['main.js', 'manifest.json']) fs.copyFileSync(path.join(process.env.PLUGIN_FROM || HERE, f), path.join(plug, f))
  const sidecar = path.join(vault, `.${PDF}.annot.json`)
  const strokes = () => { try { return Object.values(JSON.parse(fs.readFileSync(sidecar, 'utf8')).ink ?? {}).flat() } catch { return [] } }
  const until = async (fn, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v || Date.now() > end) return v; await sleep(100) } }

  let { app, win, cdp } = await launch(home, vault)
  const open = async () => {
    await openRow(win, PDF); await win.waitForSelector('.pr-root .textLayer span', { timeout: 25000 }); await sleep(900)
    await win.locator('.pr-zoomsel').selectOption('page-width'); await sleep(800)
  }
  const tool = async (v) => { await win.locator(`.pr-toolbar [data-v="${v}"]`).first().click(); await sleep(400) }
  const pen = (type, x, y, b, mods = 0) => cdp.send('Input.dispatchMouseEvent', { type, x, y, modifiers: mods, button: type === 'mouseMoved' && !b ? 'none' : 'left', buttons: b, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'pen' })
  /** 画一笔(hover = 先悬停一下再落)。返回起笔点。 */
  const draw = async (x, y, hover = true) => {
    if (hover) { await pen('mouseMoved', x - 3, y, 0); await pen('mouseMoved', x, y, 0) }
    await pen('mousePressed', x, y, 1)
    for (let i = 1; i <= 10; i++) await pen('mouseMoved', x + i * 4, y + (i % 2) * 6, 1)
    await pen('mouseReleased', x + 40, y, 0)
    return [x, y]
  }
  /** 屏幕点 → 第 1 页页内 pt。 */
  const toPage = async ([x, y]) => { const p = await win.locator('.pr-root .page[data-page-number="1"]').boundingBox(); const k = p.width / 612; return [(x - p.x) / k, (y - p.y) / k] }
  /** 最新一笔的起点(页内 pt)和画在哪一页上的位置误差。 */
  const lastAt = async (at) => { const s = strokes(); const e = s[s.length - 1]; const [px, py] = await toPage(at); return e ? Math.hypot(e.x + e.points[0][0] - px, e.y + e.points[0][1] - py) : Infinity }
  const zoom = async (x, y, steps, dy) => { for (let i = 0; i < steps; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, modifiers: 2 }); await sleep(16) } }
  const classes = () => win.evaluate(() => [...document.querySelector('.pr-root').classList].filter((c) => /pr-(scrolling|zooming|inking)/.test(c)).join(' '))
  const area = async () => { const p = await win.locator('.pr-root .page[data-page-number="1"]').boundingBox(); const c = await win.locator('.pr-container').boundingBox(); return { x: p.x + p.width * 0.3, y: Math.max(p.y, c.y) + 200 } }

  try {
    await open()
    await tool('ink')
    let a = await area()
    // R1
    await draw(a.x, a.y)
    check('R1 抬笔后 1.5 秒内这一笔已写进批注文件', !!await until(() => strokes().length === 1, 1500), `n=${strokes().length}`)
    // R2
    await draw(a.x, a.y + 40)
    await sleep(80)
    await app.close()
    ;({ app, win, cdp } = await launch(home, vault))
    await open()
    check('R2 刚画完 80ms 就关窗,重开两笔都在', strokes().length === 2, `n=${strokes().length}`)
    await tool('ink')
    a = await area()
    // R3(撤销账只记这一程的手势:重开之后先画一笔再撤)
    await draw(a.x, a.y + 80); await until(() => strokes().length === 3, 1500)
    await win.locator('.pr-toolbar [data-act="undo"]').click(); await until(() => strokes().length === 2, 2500)
    const afterUndo = strokes().length
    await win.locator('.pr-toolbar [data-act="redo"]').click(); await until(() => strokes().length === 3, 2500)
    check('R3 撤销少一笔、重做回来,都写进文件', afterUndo === 2 && strokes().length === 3, `undo→${afterUndo} redo→${strokes().length}`)
    // R4
    await tool('eraser')
    // 照文件里第二笔的实际位置擦(页面可能滚过,不能用画它时的屏幕坐标)
    const pg = await win.locator('.pr-root .page[data-page-number="1"]').boundingBox(), kk = pg.width / 612, tgt = strokes()[1]
    const [ex, ey] = [pg.x + (tgt.x + tgt.width / 2) * kk, pg.y + (tgt.y + tgt.height / 2) * kk - 3]
    await pen('mouseMoved', ex - 30, ey, 0); await pen('mousePressed', ex - 30, ey, 1)
    for (let i = 1; i <= 15; i++) await pen('mouseMoved', ex - 30 + i * 4, ey + 3, 1)
    await pen('mouseReleased', ex + 30, ey + 3, 0)
    check('R4 橡皮擦掉一笔,写进文件', !!await until(() => strokes().length === 2, 2000), `n=${strokes().length}`)
    await tool('ink')
    // R5(停笔 1.5 秒:静态图补出来了,缩放才会换静态图 —— 刚写完就缩放走的是一路推视口的老路,不会吞)
    await sleep(1500)
    a = await area()
    await zoom(a.x, a.y, 6, -6); await sleep(40)
    const n5 = strokes().length
    await draw(a.x + 60, a.y, false)
    await sleep(700)
    const swallowed = strokes().length === n5
    const at5 = await draw(a.x + 60, a.y + 30, false)
    await until(() => strokes().length === n5 + 1, 1500)
    const err5 = await lastAt(at5)
    check('R5 缩放刚停、笔不悬停就落:第一下不画,再落一次画对位置(误差 < 12pt)', swallowed && strokes().length === n5 + 1 && err5 < 12, JSON.stringify({ swallowed, n: [n5, strokes().length], err: Math.round(err5) }))
    // R6
    await zoom(a.x, a.y, 6, 6); await sleep(40)
    const n6 = strokes().length
    const at6 = await draw(a.x + 60, a.y + 60, true)
    await until(() => strokes().length === n6 + 1, 1500)
    const err6 = await lastAt(at6)
    check('R6 缩放刚停、笔先悬停再落:直接画,位置对(误差 < 12pt)', strokes().length === n6 + 1 && err6 < 12, JSON.stringify({ n: [n6, strokes().length], err: Math.round(err6) }))
    // R7
    await zoom(a.x, a.y, 5, -6)
    await tool('select'); await tool('ink')
    const c7 = await classes()
    const n7 = strokes().length
    a = await area()
    const at7 = await draw(a.x + 80, a.y + 90, false)
    await until(() => strokes().length === n7 + 1, 1500)
    const err7 = await lastAt(at7)
    check('R7 缩放没收尾就换工具再换回:白板层露着,下一笔直接画对', !/scrolling|zooming/.test(c7) && strokes().length === n7 + 1 && err7 < 12, JSON.stringify({ classes: c7, n: [n7, strokes().length], err: Math.round(err7) }))
    // R8
    await tool('select')
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: a.x, y: a.y, deltaX: 0, deltaY: 60, modifiers: 0 }); await sleep(30)
    await tool('ink')
    await zoom(a.x, a.y, 4, 6)
    await sleep(800)
    const c8 = await classes()
    const n8 = strokes().length
    a = await area()
    const at8 = await draw(a.x + 100, a.y + 120, true)
    await until(() => strokes().length === n8 + 1, 1500)
    const err8 = await lastAt(at8)
    check('R8 选择工具滚动没收尾就换手写再缩放:收尾后白板层露着、能画对', !/scrolling|zooming/.test(c8) && /inking/.test(c8) && strokes().length === n8 + 1 && err8 < 12, JSON.stringify({ classes: c8, n: [n8, strokes().length], err: Math.round(err8) }))
  } finally { await app.close().catch(() => {}) }
  console.log(fails.length ? `\n${fails.length} 项没过` : '\n全部通过')
  process.exit(fails.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
