// 批注跟手探针:滚动 / 缩放的时候,高亮和笔迹有没有跟着页面走、落后几像素、有没有闪没。
// 量的是真画面:CDP 录屏(Page.startScreencast)逐帧取下来,在帧里找三个色块 ——
//   蓝方块:PDF 页面本身印的(pdf.js 画的,就是「页面在哪」);
//   红笔迹:一笔手写(白板层或每页静态图画的);
//   绿高亮:一条高亮(页面里的批注层画的)。
// 三个色块在页内是并排的一行。每帧算笔迹 / 高亮相对蓝方块的偏移(按方块边长归一,所以缩放时也能比),
// 和静止时的差就是「没跟上」的像素;方块露着、该在那儿的色块却没有 = 闪没了。另记每帧间隔和长任务(卡顿)。
// 条件:选择工具 / 手写工具 × 只有这三块 / 再加 HEAVY 笔笔迹(缺省 600)× 滚动 / 缩放。
//
// 跑(在 Forsion 仓根;桌面端先 npm run build 出 out/):
//   node .claude/hooks/devlock.cjs run --vehicle=e2e --what="PDF 批注跟手探针" --eta=8 -- node Forsion-Instrumentality-Project/forsion-plugin-pdf-reader/verify/ink-follow.cjs
// GENESIS_DESKTOP / UI_ZOOM / CPU / HEAVY 同 ink-latency.cjs。
// ⚠️ 笔迹色块是照真笔迹改了点位拼出来的,粗笔下它在白板层和静态图里的轮廓会差十几像素(真笔画只差 ~2px,11-16 实画验过),所以只用缺省粗细。结果打在终端,原始数据和每个场景的一张截图落 .shots/ink-follow/。
const fs = require('fs'); const os = require('os'); const path = require('path')
const { launch, openRow, INSTALL, synthStrokes, sleep, q, r1, chromium, topSelf } = require('./ink-latency.cjs')
const HERE = path.resolve(__dirname, '..')
const OUT = process.env.OUT_DIR || path.join(HERE, '.shots', 'ink-follow'); fs.mkdirSync(OUT, { recursive: true })
const HEAVY = Number(process.env.HEAVY ?? 600)
const PDF = 'Ink Fixture.pdf'
// 第 2 页(第 1 页顶上没法往上滚出空间)页内 pt(y 向下):蓝方块 72,72 边长 30,品红方块 372,72;笔迹在 140;高亮在 220–280
const SQ = { x: 72, y: 72, s: 30 }

async function makePdf(file) {
  const para = '<p>Readers mark up documents all the time, and most of those marks are never looked at again. The point of a reading tool is to make the second visit cheap. '.repeat(4) + '</p>'
  const b = await chromium.launch()
  try {
    const p = await b.newPage()
    await p.setContent(`<html><body style="font: 15px/1.7 Georgia, serif; margin: 0"><h1>Ink Fixture</h1>${para.repeat(3)}<div style="page-break-before: always;position:relative;height:40px"><div style="position:absolute;left:0;width:40px;height:40px;background:#0000ff"></div><div style="position:absolute;left:400px;width:40px;height:40px;background:#ff00ff"></div></div><h1 style="margin-top:30px">Two</h1>${para.repeat(4)}<h1 style="page-break-before: always">Three</h1>${para.repeat(4)}</body></html>`)
    fs.writeFileSync(file, await p.pdf({ format: 'Letter', printBackground: true, margin: { top: '1in', bottom: '1in', left: '1in', right: '1in' } }))
  } finally { await b.close() }
}

/** 一笔红色的密集折线,当「笔迹色块」。 */
function inkMarker(template) {
  const pts = []
  for (let k = 0; k <= 40; k++) pts.push([k, (k % 2) * 26])
  return { ...template, id: 'mk-ink', x: 140, y: 74, points: pts, pressures: pts.map(() => 0.5), width: 40, height: 26, strokeColor: '#e03131',
    seed: 4242, version: 3, versionNonce: 4243, updated: 1, isDeleted: false, groupIds: [], boundElements: null }
}
const hlMarker = () => {
  const now = new Date().toISOString(), top = 792 - 72, bot = 792 - 102
  return { id: 'mk-hl', type: 'highlight', page: 1, color: '#40c057', quads: [[220, top, 280, top, 220, bot, 280, bot]], text: 'marker', created: now, modified: now }
}

/** 帧分析器:一个无头页面,拿 JPEG 解码后在客户区矩形里找三种颜色的外接框。 */
async function analyzer() {
  const b = await chromium.launch(); const p = await b.newPage()
  const scan = (frame) => p.evaluate(async ({ data, rect, k }) => {
    const img = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${data}`)).blob())
    const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d'); g.drawImage(img, 0, 0)
    const x0 = Math.max(0, Math.round(rect.x * k)), y0 = Math.max(0, Math.round(rect.y * k))
    const w = Math.min(img.width - x0, Math.round(rect.w * k)), h = Math.min(img.height - y0, Math.round(rect.h * k))
    const d = g.getImageData(x0, y0, w, h).data
    const box = () => ({ n: 0, t: Infinity, b: -Infinity, l: Infinity, r: -Infinity })
    const B = { sq: box(), mg: box(), ink: box(), hl: box() }
    const add = (o, x, y) => { o.n++; if (y < o.t) o.t = y; if (y > o.b) o.b = y; if (x < o.l) o.l = x; if (x > o.r) o.r = x }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, R = d[i], G = d[i + 1], Bl = d[i + 2]
      if (Bl > 150 && R < 90 && G < 90) add(B.sq, x, y)
      else if (R > 180 && Bl > 180 && G < 90) add(B.mg, x, y)
      else if (R > 170 && G < 110 && Bl < 110) add(B.ink, x, y)
      else if (G > 150 && G - R > 35 && G - Bl > 25) add(B.hl, x, y)
    }
    const f = (o) => (o.n < 20 ? null : { n: o.n, t: (o.t + y0) / k, b: (o.b + y0) / k, l: (o.l + x0) / k, r: (o.r + x0) / k })
    return { sq: f(B.sq), mg: f(B.mg), ink: f(B.ink), hl: f(B.hl), top: rect.y, bottom: rect.y + rect.h, left: rect.x, right: rect.x + rect.w }
  }, frame)
  return { scan, close: () => b.close() }
}

/** 逐帧结果 → 每种色块的跟随误差。基准是开录后第一帧(静止)。 */
function follow(frames) {
  // 尺子:蓝方块到品红方块的距离(页内 300pt)。比方块边长长十倍,1px 的取整误差不会被放大
  const ok = frames.filter((f) => f.sq && f.mg && f.sq.t > f.top + 1 && f.sq.b < f.bottom - 1 && f.sq.l > f.left + 1 && f.mg.r < f.right - 1)
  const R = (v) => Math.round(v)
  const out = { frames: frames.length, usable: ok.length,
    trace: frames.map((f) => [f.sq ? [R(f.sq.t), R(f.sq.l), R(f.sq.b - f.sq.t)] : null, f.ink ? [R(f.ink.t), R(f.ink.l)] : null, f.hl ? [R(f.hl.t), R(f.hl.l)] : null]) }
  for (const key of ['ink', 'hl']) {
    const base = ok.find((f) => f[key])
    if (!base) { out[key] = { missingAll: true }; continue }
    const H0 = base.mg.l - base.sq.l, rx = (base[key].l - base.sq.l) / H0, ry = (base[key].t - base.sq.t) / H0
    const drift = []; let missing = 0
    for (const f of ok) {
      const H = f.mg.l - f.sq.l, ex = f.sq.l + rx * H, ey = f.sq.t + ry * H
      if (ey < f.top || ey + 40 > f.bottom) continue // 这一帧它该在的位置出了视口
      if (!f[key]) { missing++; continue }
      drift.push(Math.hypot(f[key].l - ex, f[key].t - ey))
    }
    out[key] = { p50: r1(q(drift, 0.5)), p95: r1(q(drift, 0.95)), max: r1(Math.max(0, ...drift)), over2: drift.filter((v) => v > 2).length, missing, n: drift.length + missing }
  }
  return out
}

async function scenario(win, cdp, an, kind) {
  const cr = await win.locator('.pr-container').boundingBox()
  const page = await win.locator('.pr-root .page[data-page-number="2"]').boundingBox()
  const at = { x: page.x + page.width * (SQ.x + SQ.s / 2) / 612, y: page.y + page.height * (SQ.y + SQ.s / 2) / 792 }
  // 摆位:滚动时让方块从视口下方往上走;缩放时放在视口上三分之一
  const want = kind === 'scroll' ? cr.y + cr.height * 0.78 : cr.y + cr.height * 0.3
  await win.evaluate((d) => { document.querySelector('.pr-container').scrollTop += d }, at.y - want)
  await sleep(1500)
  const p2 = await win.locator('.pr-root .page[data-page-number="2"]').boundingBox()
  const sq = { x: p2.x + p2.width * (SQ.x + SQ.s / 2) / 612, y: p2.y + p2.height * (SQ.y + SQ.s / 2) / 792 }
  const frames = []
  const onFrame = (f) => { frames.push({ ts: f.metadata.timestamp, data: f.data, dw: f.metadata.deviceWidth }); cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}) }
  cdp.on('Page.screencastFrame', onFrame)
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1512, maxHeight: 950, everyNthFrame: 1 })
  await sleep(400)
  await win.evaluate(() => window.__probeStart())
  const wheel = (dy, mods) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: sq.x, y: sq.y, deltaX: 0, deltaY: dy, modifiers: mods })
  const burst = async (n, dy, mods) => { let next = Date.now(); for (let i = 0; i < n; i++) { await wheel(dy, mods); next += 16; const w = next - Date.now(); if (w > 0) await sleep(w) } }
  if (kind === 'scroll') { await burst(12, 40, 0); await sleep(500); await burst(12, -40, 0) } // 每 16ms 40px ≈ 2500px/s,触控板正常一划的速度
  else { await burst(25, -4, 2); await sleep(700); await burst(25, 4, 2) }
  await sleep(900)
  const stats = await win.evaluate(() => window.__probeStop())
  await cdp.send('Page.stopScreencast'); cdp.off('Page.screencastFrame', onFrame)
  // 只扫页面露着的那一块:浮在上面的工具栏 / 色板(带红绿蓝色点)和底栏都切掉
  const band = await win.evaluate(() => {
    const vis = (q) => [...document.querySelectorAll(q)].map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height)
    return { top: Math.max(0, ...vis('.pr-toolbar, .pr-palette').map((r) => r.bottom)) + 4, bottom: Math.min(1e9, ...vis('.pr-bottombar').map((r) => r.top)) - 4 }
  })
  const y0 = Math.max(cr.y, band.top), y1 = Math.min(cr.y + cr.height, band.bottom)
  const rect = { x: cr.x, y: y0, w: cr.width - 16, h: y1 - y0 } // 右边让出滚动条
  const scanned = []
  for (const f of frames) { const img = await an.scan({ data: f.data, rect, k: 1512 / f.dw }); scanned.push(img) }
  if (frames.length) fs.writeFileSync(path.join(OUT, `last-${kind}.jpg`), Buffer.from(frames[Math.floor(frames.length / 2)].data, 'base64'))
  return {
    ...follow(scanned),
    frameP95: r1(q(stats.frames, 0.95)), frameMax: r1(Math.max(0, ...stats.frames)), framesOver33: stats.frames.filter((v) => v > 33.4).length,
    longTasks: stats.long.length, longMax: r1(Math.max(0, ...stats.long)),
  }
}

async function condition(home, vault, label) {
  const { app, win, cdp } = await launch(home, vault)
  const an = await analyzer()
  const res = {}
  try {
    await openRow(win, PDF)
    await win.waitForSelector('.pr-root .textLayer span', { timeout: 25000 }); await sleep(1500)
    await win.waitForSelector('.pr-board canvas', { timeout: 20000, state: 'attached' }) // 文档里有笔迹:白板层自己挂上
    await win.evaluate(INSTALL)
    for (const tool of ['select', 'ink']) {
      if (tool === 'ink') { await win.locator('.pr-toolbar [data-v="ink"]').click(); await sleep(1200) }
      for (const kind of ['scroll', 'zoom']) {
        await win.locator('.pr-zoomsel').selectOption('page-width'); await sleep(1200)
        const name = `${label}/${tool === 'select' ? '选择' : '手写'}/${kind === 'scroll' ? '滚动' : '缩放'}`
        // PROFILE=<条件名>(如 600笔/选择/缩放):这一场景录一份 CPU profile
        const prof = process.env.PROFILE === name
        if (prof) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start') }
        res[name] = await scenario(win, cdp, an, kind)
        if (prof) topSelf((await cdp.send('Profiler.stop')).profile, name.replace(/\//g, '-'))
      }
    }
  } finally { await an.close(); await app.close().catch(() => {}) }
  return res
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-inkfollow-'))
  const vault = path.join(home, 'Vault'); fs.mkdirSync(vault, { recursive: true })
  await makePdf(path.join(vault, PDF))
  const plug = path.join(home, 'plugins', 'pdf-reader'); fs.mkdirSync(plug, { recursive: true })
  for (const f of ['main.js', 'manifest.json']) fs.copyFileSync(path.join(HERE, f), path.join(plug, f))
  const sidecar = path.join(vault, `.${PDF}.annot.json`)

  // 第一趟:画一笔,拿到批注文件(带文档指纹)和一份真笔迹当模板
  {
    const { app, win, cdp } = await launch(home, vault)
    try {
      await openRow(win, PDF)
      await win.waitForSelector('.pr-root .textLayer span', { timeout: 25000 }); await sleep(900)
      await win.locator('.pr-toolbar [data-v="ink"]').click(); await win.waitForSelector('.pr-board canvas', { timeout: 20000 }); await sleep(1200)
      const p = await win.locator('.pr-root .page[data-page-number="1"]').boundingBox()
      const pen = (type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'pen' })
      const x = p.x + p.width * 0.5, y = p.y + p.height * 0.6
      await pen('mouseMoved', x, y, 0); await pen('mousePressed', x, y, 1)
      for (let i = 1; i <= 12; i++) await pen('mouseMoved', x + i * 4, y + (i % 3) * 4, 1)
      await pen('mouseReleased', x + 48, y, 0)
      for (let i = 0; i < 40 && !fs.existsSync(sidecar); i++) await sleep(150)
    } finally { await app.close().catch(() => {}) }
  }
  const sc = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
  const template = Object.values(sc.ink).flat().find((e) => e.type === 'freedraw')
  if (!template) throw new Error('第一趟没画出笔迹')
  const write = (heavy) => {
    sc.annots = [hlMarker()]
    sc.ink = { 1: [inkMarker(template)] }
    // 重文档的笔迹放在色块那一行以下,不挡色块
    if (heavy) for (const { page, e } of synthStrokes(template, heavy, (i) => ({ page: i % 3, x: 60 + (i * 37) % 460, y: 130 + (Math.floor(i / 3) * 11) % 600 }))) (sc.ink[page] ??= []).push(e)
    fs.writeFileSync(sidecar, JSON.stringify(sc, null, 1))
  }

  const results = { meta: { uiZoom: process.env.UI_ZOOM || '1', cpu: Number(process.env.CPU) || 1, heavy: HEAVY, at: new Date().toISOString() } }
  write(0); Object.assign(results, await condition(home, vault, '轻'))
  if (HEAVY > 0) { write(HEAVY); Object.assign(results, await condition(home, vault, `${HEAVY}笔`)) }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))

  console.log(`\n界面缩放 ${results.meta.uiZoom};CPU 降速 ${results.meta.cpu}×;偏差单位:屏幕像素(相对页面上印的方块)`)
  console.log('条件'.padEnd(18) + '帧(可用)'.padStart(10) + '笔迹偏差 p50/p95/max'.padStart(24) + '>2px/闪没'.padStart(12) + '高亮偏差 p50/p95/max'.padStart(24) + '>2px/闪没'.padStart(12) + '帧间隔p95/max/>33'.padStart(22) + '长任务'.padStart(10))
  for (const [k, v] of Object.entries(results)) {
    if (k === 'meta') continue
    const f = (o) => (o.missingAll ? ['全程没找到', '-'] : [`${o.p50}/${o.p95}/${o.max}`, `${o.over2}/${o.missing}`])
    const [i1, i2] = f(v.ink), [h1, h2] = f(v.hl)
    console.log(k.padEnd(18) + `${v.frames}(${v.usable})`.padStart(10) + i1.padStart(24) + i2.padStart(12) + h1.padStart(24) + h2.padStart(12) + `${v.frameP95}/${v.frameMax}/${v.framesOver33}`.padStart(22) + `${v.longTasks}/${v.longMax}`.padStart(10))
  }
  console.log(`\n原始数据:${path.join(OUT, 'results.json')}`)
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1) })
module.exports = { makePdf, inkMarker, hlMarker, PDF }
