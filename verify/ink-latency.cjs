// 手写手感探针:同一组合成的手写笔画,分别画在 Better PDF 的白板层和宿主自己的白板视图里,量主线程开销。
// 两边是同一个白板引擎、同一支笔;差多少就是插件那一层多出来的。
//
// 量什么(每种条件各一遍):
//   - 落笔 / 抬笔:CDP 派发一次笔事件到渲染层处理完的往返(ms);Event Timing 报的 > 16ms 的指针事件(处理耗时)
//   - 落笔过程中的移动:同上的往返;每帧间隔(rAF)里最大的那几帧;长任务(> 50ms)
//   - 写盘:笔画过程中(按下到抬起之间)批注文件 / 白板文件被写了几次,整轮一共写了几次
//   - 丢点:长笔画送了多少个移动点,引擎里那一笔收到多少个点
// 条件:笔迹空的文档 / 已有很多笔迹的文档(HEAVY 条,缺省 600 笔 × 40 点),PDF × 白板。
//
// 跑(在 Forsion 仓根;桌面端先 npm run build 出 out/):
//   node .claude/hooks/devlock.cjs run --vehicle=e2e --what="PDF 手写手感探针" --eta=6 -- node Forsion-Instrumentality-Project/forsion-plugin-pdf-reader/verify/ink-latency.cjs
// GENESIS_DESKTOP=<桌面端检出> 换宿主;CPU=4 把渲染层主线程放慢 4 倍(近似平板);UI_ZOOM=1.1 按用户开发实例的界面缩放跑;HEAVY=<笔数> 改重文档的笔数(0 = 不跑重文档)。
// 结果:表格打在终端,原始数据落 .shots/ink-latency/results.json(不进版本库)。
const fs = require('fs'); const os = require('os'); const path = require('path')
const HERE = path.resolve(__dirname, '..')
const DESK = process.env.GENESIS_DESKTOP || path.resolve(HERE, '../../Forsion-Genesis/desktop')
const electron = require(path.join(DESK, 'scripts/lib/launch-electron.cjs'))
const { chromium } = require(path.join(DESK, 'node_modules/playwright-core'))
const { skipOnboarding } = require(path.join(DESK, 'scripts/lib/skip-onboarding.cjs'))
const OUT = process.env.OUT_DIR || path.join(HERE, '.shots', 'ink-latency'); fs.mkdirSync(OUT, { recursive: true })
const HEAVY = Number(process.env.HEAVY ?? 600)
const PDF = 'Ink Fixture.pdf', BOARD = '手写白板', BOARD_HEAVY = '满白板'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function makePdf(file) {
  const para = '<p>Readers mark up documents all the time, and most of those marks are never looked at again. The point of a reading tool is to make the second visit cheap. '.repeat(3) + '</p>'
  const b = await chromium.launch()
  try {
    const p = await b.newPage()
    await p.setContent(`<html><body style="font: 15px/1.7 Georgia, serif; margin: 0"><h1>Ink Fixture</h1>${para}${para}
      <h1 style="page-break-before: always">Two</h1>${para}<h1 style="page-break-before: always">Three</h1>${para}</body></html>`)
    fs.writeFileSync(file, await p.pdf({ format: 'Letter', margin: { top: '1in', bottom: '1in', left: '1in', right: '1in' } }))
  } finally { await b.close() }
}
const drawing = (els) => ['---', '', 'excalidraw-plugin: parsed', 'tags: [excalidraw]', '', '---', '', '', '## Drawing', '```json',
  JSON.stringify({ type: 'excalidraw', version: 2, source: 'Forsion Amadeus', elements: els, appState: { viewBackgroundColor: '#ffffff' }, files: {} }), '```', '%%'].join('\n')

/** 照一笔真画出来的笔迹做 n 笔假笔迹,每笔 40 个点(像写字时的一笔)。place(i) 给出第 i 笔的左上角(和所在页)。 */
function synthStrokes(template, n, place) {
  const out = []
  for (let i = 0; i < n; i++) {
    const pts = []; const pr = []
    for (let k = 0; k < 40; k++) { pts.push([k * 0.9, Math.sin(k / 4 + i) * 7 + (k % 7)]); pr.push(0.5) }
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
    const { x, y, page } = place(i)
    const e = { ...template, id: `synth-${i}`, x, y, points: pts, pressures: pr, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
      seed: 1000 + i, version: 2, versionNonce: 7000 + i, updated: 1, isDeleted: false, groupIds: [], boundElements: null }
    delete e.index
    out.push({ page, e })
  }
  return out
}

async function launch(home, vault) {
  const userData = path.join(home, 'userdata')
  for (const d of [userData, `${userData}-dev`]) {
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: 'http://127.0.0.1:1', token: 'fixture' }))
    for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) fs.writeFileSync(path.join(d, f), JSON.stringify({ lastVault: vault, localVault: vault }))
  }
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', DESK], cwd: DESK,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1', TANGU_HARNESS_QUIET: '1', PI_CU_SOCKET_PATH: path.join(home, 'bridge.sock') } })
  const win = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1512, 950) })
  await win.waitForSelector('.dv-groupview', { timeout: 30000, state: 'attached' })
  if (process.env.UI_ZOOM) {
    await win.evaluate((z) => localStorage.setItem('forsion_ui_zoom', z), process.env.UI_ZOOM)
    await win.reload(); await win.waitForSelector('.dv-groupview', { timeout: 30000, state: 'attached' })
  }
  if (!await skipOnboarding(win)) throw new Error('首启引导没点掉')
  await win.locator('.rb-space[aria-label="笔记"], .rb-space[aria-label="Note"]').first().click({ timeout: 15000 })
  const cdp = await win.context().newCDPSession(win)
  // CPU=4:主线程放慢 4 倍,近似平板 / 安卓机(本机 Mac 太快,毛病可能显不出来)
  if (Number(process.env.CPU) > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.CPU) })
  return { app, win, cdp }
}
const openRow = async (win, title) => {
  const row = win.locator('.t2s-srow', { has: win.locator('.t2s-srow-title', { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first()
  await row.click({ timeout: 15000 })
}

/** 页面里装观测:Event Timing(> 16ms 的指针事件)、长任务、每帧间隔。window.__probe 收数,__probeMark 打区段。 */
const INSTALL = () => {
  const p = window.__probe = { events: [], long: [], frames: [], on: false }
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (p.on && e.name.startsWith('pointer')) p.events.push({ n: e.name, d: e.duration, proc: e.processingEnd - e.processingStart }) })
    .observe({ type: 'event', durationThreshold: 16, buffered: false })
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (p.on) p.long.push(e.duration) }).observe({ type: 'longtask', buffered: false })
  let last = 0
  const tick = (t) => { if (p.on && last) p.frames.push(t - last); last = t; requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  window.__probeStart = () => { p.events = []; p.long = []; p.frames = []; p.on = true }
  window.__probeStop = () => { p.on = false; return { events: p.events, long: p.long, frames: p.frames } }
}
/** 当前露着的那块白板引擎(PDF 的白板层或白板视图)里最后一笔自由画的点数。 */
const LAST_POINTS = (sel) => {
  const el = [...document.querySelectorAll(sel)].find((e) => e.offsetParent)
  if (!el) return null
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber'))
  let f = el[key]
  while (f && !(f.stateNode && f.stateNode.state && f.stateNode.state.zoom && f.stateNode.scene)) f = f.return
  if (!f) return null
  const els = f.stateNode.scene.getNonDeletedElements().filter((e) => e.type === 'freedraw')
  return { n: els.length, last: els.length ? els[els.length - 1].points.length : 0 }
}

/** 文件写入记录(Node 这边的时钟):watch 一个目录,按文件名过滤,相隔 < 15ms 的算同一次。 */
function watchWrites(dir, match) {
  const t = []
  const w = fs.watch(dir, (_, f) => { if (f && match(String(f))) { const now = Date.now(); if (!t.length || now - t[t.length - 1] > 15) t.push(now) } })
  return { t, close: () => w.close() }
}

const q = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
const r1 = (v) => Math.round(v * 10) / 10

/** 一轮:写字(STROKES 笔短画,每笔 12 个移动点,点距 8ms,笔间停 70ms)+ 一条 2 秒的长笔画。区域是客户区像素框。 */
async function run(win, cdp, box, writes, engineSel) {
  const pen = (type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'pen', force: buttons ? 0.5 : 0 })
  const timed = async (arr, fn) => { const t = performance.now(); await fn(); const d = performance.now() - t; arr.push(d); return d }
  const STROKES = 40, rows = 5, cols = 8
  const down = [], move = [], up = [], strokeWrites = []
  const stamp = async (sx, sy, nMoves, step, shape) => {
    const before = writes.t.length; const t0 = Date.now()
    await pen('mouseMoved', sx, sy, 0)
    await timed(down, () => pen('mousePressed', sx, sy, 1))
    let next = performance.now()
    for (let i = 1; i <= nMoves; i++) {
      next += step; const [dx, dy] = shape(i)
      await timed(move, () => pen('mouseMoved', sx + dx, sy + dy, 1))
      const wait = next - performance.now(); if (wait > 0) await sleep(wait)
    }
    const [ex, ey] = shape(nMoves)
    const t1 = Date.now()
    await timed(up, () => pen('mouseReleased', sx + ex, sy + ey, 0))
    strokeWrites.push(writes.t.filter((t) => t >= t0 && t < t1).length)
    return writes.t.length - before
  }
  // 热身一笔(引擎第一次见到笔会开笔模式、JIT 也热一下),不计
  await stamp(box.x + 10, box.y + 10, 12, 8, (i) => [i * 3, (i % 3) * 4])
  await sleep(800)
  await win.evaluate(() => window.__probeStart())
  const w0 = writes.t.length
  for (let s = 0; s < STROKES; s++) {
    const cx = box.x + 20 + (s % cols) * (box.w - 60) / cols, cy = box.y + 30 + Math.floor(s / cols) % rows * (box.h - 60) / rows
    await stamp(cx, cy, 12, 8, (i) => [i * 3, Math.sin(i / 2 + s) * 8])
    await sleep(70)
  }
  await sleep(1200)
  const writeStats = await win.evaluate(() => window.__probeStop())
  const shortWrites = writes.t.length - w0
  // 长笔画:250 个点 × 8ms,画一圈圈的线
  await win.evaluate(() => window.__probeStart())
  const lDown = down.length, lMove = move.length
  const longBefore = writes.t.length
  const LONG = 250
  await stamp(box.x + box.w * 0.3, box.y + box.h * 0.5, LONG, 8, (i) => [i * 1.6, Math.sin(i / 6) * 30])
  await sleep(300)
  const pts = await win.evaluate(LAST_POINTS, engineSel)
  await sleep(1200)
  const longStats = await win.evaluate(() => window.__probeStop())
  const longMidWrites = strokeWrites[strokeWrites.length - 1]
  const longWrites = writes.t.length - longBefore
  const shortMove = move.slice(0, lMove), longMove = move.slice(lMove)
  const sum = (s) => ({
    longTasks: s.long.length, longMax: r1(Math.max(0, ...s.long)),
    slowEvents: s.events.length, slowEventMax: r1(Math.max(0, ...s.events.map((e) => e.proc))), slowByType: s.events.reduce((m, e) => ((m[e.n] = (m[e.n] ?? 0) + 1), m), {}),
    frameP95: r1(q(s.frames, 0.95)), frameMax: r1(Math.max(0, ...s.frames)), framesOver33: s.frames.filter((f) => f > 33.4).length,
  })
  return {
    write: { strokes: STROKES, down: { p50: r1(q(down.slice(1, lDown), 0.5)), p95: r1(q(down.slice(1, lDown), 0.95)), max: r1(Math.max(...down.slice(1, lDown))) },
      up: { p50: r1(q(up.slice(1, lDown), 0.5)), p95: r1(q(up.slice(1, lDown), 0.95)), max: r1(Math.max(...up.slice(1, lDown))) },
      move: { p50: r1(q(shortMove.slice(12), 0.5)), p95: r1(q(shortMove.slice(12), 0.95)), max: r1(Math.max(...shortMove.slice(12))) },
      fileWrites: shortWrites, writesWhilePenDown: strokeWrites.slice(1, -1).reduce((a, b) => a + b, 0), ...sum(writeStats) },
    long: { moves: LONG, pointsInEngine: pts?.last ?? null, move: { p50: r1(q(longMove, 0.5)), p95: r1(q(longMove, 0.95)), max: r1(Math.max(...longMove)) },
      writesWhilePenDown: longMidWrites, fileWrites: longWrites, ...sum(longStats) },
  }
}

async function pdfCondition(win, cdp, vault, label) {
  await openRow(win, PDF)
  await win.waitForSelector('.pr-root .textLayer span', { timeout: 25000 }); await sleep(900)
  await win.locator('.pr-toolbar [data-v="ink"]').click()
  await win.waitForSelector('.pr-board canvas', { timeout: 20000 }); await sleep(1200)
  await win.locator('.pr-toolbar [data-act="pen"][data-v="default"]').click(); await sleep(200)
  await win.evaluate(INSTALL)
  const pg = await win.locator('.pr-root .page[data-page-number="1"]').boundingBox()
  const vp = await win.locator('.pr-container').boundingBox()
  const y0 = Math.max(pg.y, vp.y) + 40, y1 = Math.min(pg.y + pg.height, vp.y + vp.height) - 40
  const box = { x: pg.x + 40, y: y0, w: pg.width - 80, h: y1 - y0 }
  const writes = watchWrites(vault, (f) => f.includes('annot.json'))
  try {
    const res = await run(win, cdp, box, writes, '.pr-board .excalidraw')
    await win.screenshot({ path: path.join(OUT, `${label}.png`) }).catch(() => {})
    return res
  } finally { writes.close() }
}

async function boardCondition(win, cdp, vault, title, label) {
  await openRow(win, `${title}.excalidraw`)
  await win.waitForSelector('.amx-drawview .excalidraw canvas.interactive', { timeout: 30000 }); await sleep(2000)
  await win.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-drawview .excalidraw')].find((e) => e.offsetParent)
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber'))
    let f = el[key]; while (f && !(f.stateNode && f.stateNode.setActiveTool && f.stateNode.state?.zoom)) f = f.return
    f.stateNode.setActiveTool({ type: 'freedraw' })
  })
  await sleep(300)
  await win.evaluate(INSTALL)
  const c = await win.locator('.amx-drawview .excalidraw canvas.interactive').first().boundingBox()
  // 避开上面的工具岛和下面的缩放条
  const box = { x: c.x + c.width * 0.2, y: c.y + c.height * 0.2, w: c.width * 0.6, h: c.height * 0.6 }
  const writes = watchWrites(vault, (f) => f.startsWith(title))
  try {
    const res = await run(win, cdp, box, writes, '.amx-drawview .excalidraw')
    await win.screenshot({ path: path.join(OUT, `${label}.png`) }).catch(() => {})
    return res
  } finally { writes.close() }
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-inklat-'))
  const vault = path.join(home, 'Vault'); fs.mkdirSync(vault, { recursive: true })
  await makePdf(path.join(vault, PDF))
  fs.writeFileSync(path.join(vault, `${BOARD}.excalidraw.md`), drawing([]))
  const plug = path.join(home, 'plugins', 'pdf-reader'); fs.mkdirSync(plug, { recursive: true })
  for (const f of ['main.js', 'manifest.json']) fs.copyFileSync(path.join(HERE, f), path.join(plug, f))
  const sidecar = path.join(vault, `.${PDF}.annot.json`)
  const results = { meta: { desk: DESK, uiZoom: process.env.UI_ZOOM || '1', cpu: Number(process.env.CPU) || 1, heavy: HEAVY, at: new Date().toISOString() } }

  let { app, win, cdp } = await launch(home, vault)
  try {
    results['pdf/空'] = await pdfCondition(win, cdp, vault, 'pdf-empty')
    results['白板/空'] = await boardCondition(win, cdp, vault, BOARD, 'board-empty')
  } finally { await app.close().catch(() => {}) }

  if (HEAVY > 0) {
    // 照刚才真画的一笔做重文档:PDF 三页均摊,白板放同样多的笔
    const sc = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
    const template = Object.values(sc.ink).flat().find((e) => e.type === 'freedraw')
    if (!template) throw new Error('批注文件里没有笔迹,做不了重文档')
    sc.ink = {}
    for (const { page, e } of synthStrokes(template, HEAVY, (i) => ({ page: i % 3, x: 60 + (i * 37) % 460, y: 60 + (Math.floor(i / 3) * 11) % 660 }))) (sc.ink[page] ??= []).push(e)
    fs.writeFileSync(sidecar, JSON.stringify(sc, null, 1))
    const bEls = synthStrokes(template, HEAVY, (i) => ({ x: (i * 37) % 900, y: (Math.floor(i / 3) * 11) % 700 })).map(({ e }) => e)
    fs.writeFileSync(path.join(vault, `${BOARD_HEAVY}.excalidraw.md`), drawing(bEls))
    results.meta.sidecarKB = Math.round(fs.statSync(sidecar).size / 1024)
    results.meta.boardKB = Math.round(fs.statSync(path.join(vault, `${BOARD_HEAVY}.excalidraw.md`)).size / 1024)
    ;({ app, win, cdp } = await launch(home, vault))
    try {
      results[`pdf/${HEAVY}笔`] = await pdfCondition(win, cdp, vault, 'pdf-heavy')
      results[`白板/${HEAVY}笔`] = await boardCondition(win, cdp, vault, BOARD_HEAVY, 'board-heavy')
    } finally { await app.close().catch(() => {}) }
  }

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))
  const conds = Object.keys(results).filter((k) => k !== 'meta')
  const row = (name, f) => console.log(name.padEnd(34) + conds.map((c) => String(f(results[c])).padStart(16)).join(''))
  console.log(`\n界面缩放 ${results.meta.uiZoom};CPU 降速 ${results.meta.cpu}×;重文档 ${HEAVY} 笔(批注文件 ${results.meta.sidecarKB ?? '-'} KB / 白板文件 ${results.meta.boardKB ?? '-'} KB)`)
  console.log(''.padEnd(34) + conds.map((c) => c.padStart(16)).join(''))
  console.log('— 写字(40 笔短画) —')
  row('落笔往返 p50/p95/max ms', (r) => `${r.write.down.p50}/${r.write.down.p95}/${r.write.down.max}`)
  row('抬笔往返 p50/p95/max ms', (r) => `${r.write.up.p50}/${r.write.up.p95}/${r.write.up.max}`)
  row('移动往返 p50/p95/max ms', (r) => `${r.write.move.p50}/${r.write.move.p95}/${r.write.move.max}`)
  row('>16ms 指针事件 次数/最长处理', (r) => `${r.write.slowEvents}/${r.write.slowEventMax}`)
  row('长任务 次数/最长 ms', (r) => `${r.write.longTasks}/${r.write.longMax}`)
  row('帧间隔 p95/max ms、>33ms 帧数', (r) => `${r.write.frameP95}/${r.write.frameMax}/${r.write.framesOver33}`)
  row('写盘 次数(其中笔按着时)', (r) => `${r.write.fileWrites}(${r.write.writesWhilePenDown})`)
  console.log('— 长笔画(2 秒 250 点) —')
  row('移动往返 p50/p95/max ms', (r) => `${r.long.move.p50}/${r.long.move.p95}/${r.long.move.max}`)
  row('引擎收到的点 / 送出', (r) => `${r.long.pointsInEngine}/${r.long.moves}`)
  row('长任务 次数/最长 ms', (r) => `${r.long.longTasks}/${r.long.longMax}`)
  row('帧间隔 p95/max ms、>33ms 帧数', (r) => `${r.long.frameP95}/${r.long.frameMax}/${r.long.framesOver33}`)
  row('写盘 笔按着时 / 整笔', (r) => `${r.long.writesWhilePenDown}/${r.long.fileWrites}`)
  console.log(`\n原始数据:${path.join(OUT, 'results.json')}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
