// 真应用里的冒烟:隔离的 home 起一份已构建的桌面端,库里放一份现做的三页 PDF,把本仓的 main.js 当插件装进去,
// 用真鼠标走一遍「点开 → 选字高亮 → 写评论打标签 → 下划线 → 便签 → 区域 → 引用到笔记 → 缩放后还对得上 → 重开还在」。
// 宿主带白板层接口(ctx.ui.mountBoard)时再走手写;不带就跳过那一段并写明。
// 不碰开发实例、不碰真实的库。截图落在 .shots/(不进版本库)。
//
// 跑(在 Forsion 仓根;桌面端先 npm run build 出 out/):
//   node .claude/hooks/devlock.cjs run --vehicle=e2e --what="PDF 阅读器插件冒烟" --eta=4 -- node Forsion-Instrumentality-Project/forsion-plugin-pdf-reader/verify/smoke.cjs
// GENESIS_DESKTOP=<桌面端检出> 换一份宿主(默认仓根的 Forsion-Genesis/desktop)。
const fs = require('fs'); const os = require('os'); const path = require('path')
const HERE = path.resolve(__dirname, '..')
const DESK = process.env.GENESIS_DESKTOP || path.resolve(HERE, '../../Forsion-Genesis/desktop')
const electron = require(path.join(DESK, 'scripts/lib/launch-electron.cjs'))
const { chromium } = require(path.join(DESK, 'node_modules/playwright-core'))
const SHOTS = path.join(HERE, '.shots'); fs.mkdirSync(SHOTS, { recursive: true })
const PDF = 'Reading Fixture.pdf'; const FOLDER = '文献'
const S1 = 'Annotation pays off when you come back to it.'
const S2 = 'A highlight is a decision that a sentence matters.'

/** 等到条件成立(落盘是改完 0.4 秒后的事,窗口不在前台时定时器还会被浏览器放慢)。 */
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; for (;;) { let v; try { v = await fn() } catch { v = null } if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 120)) } }
const fails = []
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`); if (!ok) fails.push(name) }

async function makePdf(file) {
  const para = (s) => `<p>${s} Readers mark up documents all the time, and most of those marks are never looked at again. The point of a reading tool is to make the second visit cheap.</p>`
  const html = `<html><body style="font: 15px/1.7 Georgia, serif; margin: 0">
    <h1>Reading Fixture</h1>${para(S1)}${para(S2)}${para('Notes written in your own words are worth more than copied ones.')}
    <h1 style="page-break-before: always">Methods</h1>${para('Forty-eight readers took part.')}${para('Each read the same nine-page document.')}
    <h1 style="page-break-before: always">Results</h1>${para('Delayed recall was highest for readers who revisited their notes.')}</body></html>`
  const b = await chromium.launch()
  try {
    const p = await b.newPage()
    await p.setContent(html)
    fs.writeFileSync(file, await p.pdf({ format: 'Letter', margin: { top: '1in', bottom: '1in', left: '1in', right: '1in' }, outline: true, tagged: true }))
  } finally { await b.close() }
}

async function launch(home, vault) {
  const userData = path.join(home, 'userdata')
  // 未打包时 userData 是 `<dir>-dev`,两处都种上,否则会打开本机真实的开发库。
  for (const d of [userData, `${userData}-dev`]) {
    fs.mkdirSync(d, { recursive: true })
    for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) fs.writeFileSync(path.join(d, f), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2))
  }
  const app = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=zh-CN', DESK], cwd: DESK,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1', TANGU_HARNESS_QUIET: '1' },
  })
  const win = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1512, 950) })
  await win.waitForSelector('#root', { timeout: 30_000 }); await win.waitForTimeout(2500)
  for (const label of ['跳过引导', 'Skip']) { const b = win.locator(`text=${label}`).first(); if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break } }
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await win.locator('.rb-space[aria-label="笔记"], .rb-space[aria-label="Note"]').first().click({ timeout: 15_000 })
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const row = (title) => win.locator('.t2s-srow', { has: win.locator('.t2s-srow-title', { hasText: new RegExp(`^${esc(title)}$`) }) }).first()
  const folder = win.locator('.t2s-group', { has: win.locator('.t2s-group-label', { hasText: new RegExp(`^${esc(FOLDER)}$`) }) }).first()
  await folder.waitFor({ timeout: 15_000 })
  if (!(await row(PDF).isVisible().catch(() => false))) await folder.locator('.t2s-folder-row').click()
  await row(PDF).click()
  await win.waitForSelector('.pr-root .textLayer span', { timeout: 25_000 }); await win.waitForTimeout(900)
  return { app, win }
}

/** 一句原文在文本层里的客户区矩形(第一行的左端、最后一行的右端),用来让真鼠标拖着选。 */
const sentenceBox = (win, needle) => win.evaluate((needle) => {
  const tl = document.querySelector('.pr-root .page[data-page-number="1"] .textLayer')
  const w = document.createTreeWalker(tl, NodeFilter.SHOW_TEXT); const map = []; let s = ''
  for (let n = w.nextNode(); n; n = w.nextNode()) for (let i = 0; i < n.data.length; i++) if (!/\s/.test(n.data[i])) { s += n.data[i]; map.push([n, i]) }
  const k = needle.replace(/\s/g, ''); const at = s.indexOf(k); if (at < 0) return null
  const r = document.createRange(); r.setStart(map[at][0], map[at][1]); const e = map[at + k.length - 1]; r.setEnd(e[0], e[1] + 1)
  const rs = [...r.getClientRects()].filter((c) => c.width > 1 && c.height > 4)
  const a = rs[0], z = rs[rs.length - 1]
  return { x0: a.left + 1, y0: a.top + a.height / 2, x1: z.right - 1, y1: z.top + z.height / 2, left: Math.min(...rs.map((c) => c.left)), right: Math.max(...rs.map((c) => c.right)), top: a.top, bottom: z.bottom }
}, needle)

async function dragSelect(win, needle) {
  const b = await sentenceBox(win, needle); if (!b) throw new Error(`原文没找到:${needle}`)
  await win.mouse.move(b.x0, b.y0); await win.mouse.down(); await win.mouse.move((b.x0 + b.x1) / 2, b.y0, { steps: 4 }); await win.mouse.move(b.x1, b.y1, { steps: 6 }); await win.mouse.up()
  await win.waitForTimeout(250)
  return b
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-pdfreader-'))
  const vault = path.join(home, 'Vault'); fs.mkdirSync(path.join(vault, FOLDER), { recursive: true })
  await makePdf(path.join(vault, FOLDER, PDF))
  fs.writeFileSync(path.join(vault, '选题.md'), '# 选题\n')
  const plug = path.join(home, 'plugins', 'pdf-reader'); fs.mkdirSync(plug, { recursive: true })
  for (const f of ['main.js', 'manifest.json']) fs.copyFileSync(path.join(HERE, f), path.join(plug, f))
  const sidecar = path.join(vault, FOLDER, `.${PDF}.annot.json`)
  const readSidecar = () => (fs.existsSync(sidecar) ? JSON.parse(fs.readFileSync(sidecar, 'utf8')) : null)
  const pdfBefore = fs.readFileSync(path.join(vault, FOLDER, PDF))
  const errors = []

  let { app, win } = await launch(home, vault)
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => { if (m.type() === 'error' && /pdf-reader|pdfjs|Worker/i.test(m.text())) errors.push(m.text()) })
  try {
    // ① 接管:是我们的阅读器,不是内置的
    check('① 点开 PDF 由插件打开', await win.locator('.pr-root .pdfViewer .page').count() === 3 && await win.locator('.amx-pdfview').count() === 0)
    check('① 刚装好没有任何批注', readSidecar() === null && await win.locator('.pr-marks > *').count() === 0)
    const tabs = await win.locator('[data-pdfmock], .pr-panel').count()
    check('① 右栏开出了批注列表', tabs >= 1 && await win.locator('.pr-listhead').count() === 1)
    const hasInk = await win.locator('.pr-toolbar [data-act="tool"][data-v="ink"]').count() === 1

    // ② 选中一句 → 浮条 → 点第一颗颜色 = 高亮
    const b1 = await dragSelect(win, S1)
    check('② 选中文字浮出浮条', await win.locator('.pr-selpop').isVisible())
    await win.screenshot({ path: path.join(SHOTS, '1-selection.png') })
    await win.locator('.pr-selpop .pr-dot').first().click(); await until(() => readSidecar()?.annots?.length === 1)
    const hl = await win.evaluate(() => [...document.querySelectorAll('.pr-hl')].map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom] }))
    const cover = hl.length && Math.abs(Math.min(...hl.map((r) => r[0])) - b1.left) < 3 && Math.abs(Math.max(...hl.map((r) => r[2])) - b1.right) < 3 && Math.abs(hl[0][1] - b1.top) < 4
    check('② 高亮盖在那句话上(误差 < 4px)', !!cover, JSON.stringify({ hl: hl.map((r) => r.map(Math.round)), want: [b1.left, b1.top, b1.right, b1.bottom].map(Math.round) }))
    let sc = readSidecar()
    const q = sc?.annots?.[0]?.quads?.[0]
    // Letter 页 612×792pt、页边距 1in:坐标必须落在 PDF 用户空间里(不是屏幕像素)。
    check('② 旁挂文件里是 PDF 坐标 + 原文', !!q && q[0] >= 70 && q[2] <= 545 && q[1] > q[5] && q[1] < 792 && sc.annots[0].text === S1, JSON.stringify(sc?.annots?.[0] ?? null).slice(0, 220))
    check('② PDF 文件一个字节没动', Buffer.compare(pdfBefore, fs.readFileSync(path.join(vault, FOLDER, PDF))) === 0)

    // ③ 点这条高亮 → 批注卡:写评论、打标签、换色
    await win.mouse.click((b1.left + b1.right) / 2, b1.y0); await win.waitForTimeout(300)
    check('③ 点高亮弹出批注卡', await win.locator('.pr-card').isVisible())
    await win.locator('.pr-card textarea').fill('核心论点,回看才值钱。')
    await win.locator('.pr-card .pr-tag.add').click(); await win.keyboard.type('核心'); await win.keyboard.press('Enter')
    await win.locator('.pr-card .pr-dot').nth(3).click()
    const saved = (a) => a && a.comment === '核心论点,回看才值钱。' && a.tags?.[0] === '核心' && a.color === '#2ea8e5'
    await until(() => saved(readSidecar()?.annots?.[0]))
    await win.screenshot({ path: path.join(SHOTS, '2-card.png') })
    sc = readSidecar()
    check('③ 评论 / 标签 / 颜色都存下了', !!saved(sc.annots[0]), JSON.stringify({ ...sc.annots[0], quads: undefined }))
    const item = win.locator('.pr-item').first()
    check('③ 右栏列表同步出这一条', (await item.innerText()).includes(S1) && (await item.innerText()).includes('#核心'))

    // ④ 引用到笔记
    await win.locator('.pr-card [data-pop="cite"]').click(); await until(() => readSidecar()?.note)
    const notePath = readSidecar().note; await until(() => notePath && fs.existsSync(path.join(vault, notePath)) && fs.readFileSync(path.join(vault, notePath), 'utf8').includes('核心论点'))
    const note = notePath && fs.existsSync(path.join(vault, notePath)) ? fs.readFileSync(path.join(vault, notePath), 'utf8') : ''
    check('④ 读书笔记里有引文、页码链接和评论', note.includes(`> ${S1}`) && note.includes(`[[${PDF}#page=1|`) && note.includes('核心论点'), `${notePath}\n${note}`)
    await win.keyboard.press('Escape')

    // ⑤ 下划线工具:选完直接成
    await win.locator('.pr-toolbar [data-v="underline"]').click()
    await dragSelect(win, S2); await until(() => readSidecar().annots.some((a) => a.type === 'underline'))
    check('⑤ 下划线工具选完即划', await win.locator('.pr-ul').count() >= 1 && readSidecar().annots.some((a) => a.type === 'underline' && a.text === S2))
    await win.locator('.pr-toolbar [data-v="underline"]').click() // 再点一次 = 回到选择

    // ⑥ 便签 + 区域
    const page1 = await win.locator('.pr-root .page[data-page-number="1"]').boundingBox()
    await win.locator('.pr-toolbar [data-v="note"]').click()
    await win.mouse.click(page1.x + page1.width - 60, page1.y + 120); await win.waitForTimeout(300)
    await win.keyboard.type('这里要回头核对样本量'); await win.keyboard.press('Escape')
    await win.locator('.pr-toolbar [data-v="area"]').click()
    await win.mouse.move(page1.x + 120, page1.y + page1.height * 0.62); await win.mouse.down(); await win.mouse.move(page1.x + 380, page1.y + page1.height * 0.62 + 110, { steps: 6 }); await win.mouse.up(); await win.waitForTimeout(300)
    await win.keyboard.press('Escape')
    await until(() => readSidecar().annots.some((a) => a.type === 'area') && readSidecar().annots.some((a) => a.comment === '这里要回头核对样本量'))
    sc = readSidecar()
    const area = sc.annots.find((a) => a.type === 'area')
    check('⑥ 便签和区域都落盘', sc.annots.some((a) => a.type === 'note' && a.comment === '这里要回头核对样本量') && !!area && area.rect[2] - area.rect[0] > 100, JSON.stringify(sc.annots.map((a) => [a.type, a.rect])))

    // ⑦ 放大一档:高亮仍然盖在那句话上(位置跟着 pdf.js 的缩放系数走,不重算)
    await win.locator('.pr-bottombar [data-act="zoom-in"]').click(); await win.waitForTimeout(1500)
    const b2 = await sentenceBox(win, S1)
    const hl2 = await win.evaluate(() => [...document.querySelectorAll('.pr-hl')].map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom] }))
    check('⑦ 缩放后高亮还对得上(误差 < 4px)', hl2.length > 0 && Math.abs(Math.min(...hl2.map((r) => r[0])) - b2.left) < 4 && Math.abs(hl2[0][1] - b2.top) < 5 && Math.abs(Math.max(...hl2.map((r) => r[2])) - b2.right) < 4, JSON.stringify({ hl: hl2.map((r) => r.map(Math.round)), want: [b2.left, b2.top, b2.right, b2.bottom].map(Math.round) }))
    await win.locator('.pr-zoomsel').selectOption('page-width'); await win.waitForTimeout(1200)

    // ⑧ 手写(宿主有白板层接口才有)
    if (hasInk) {
      await win.locator('.pr-toolbar [data-v="ink"]').click()
      await win.waitForSelector('.pr-board canvas', { timeout: 20_000 }); await win.waitForTimeout(1200)
      await win.locator('.pr-toolbar [data-act="pen"][data-v="fountain"]').click(); await win.waitForTimeout(200)
      const p = await win.locator('.pr-root .page[data-page-number="1"]').boundingBox()
      const sx = p.x + p.width * 0.55, sy = p.y + p.height * 0.5
      await win.mouse.move(sx, sy); await win.mouse.down()
      for (let i = 1; i <= 24; i++) await win.mouse.move(sx + i * 7, sy + Math.sin(i / 3) * 22)
      await win.mouse.up(); await win.waitForTimeout(900)
      await win.screenshot({ path: path.join(SHOTS, '3-ink-live.png') })
      await win.locator('.pr-toolbar [data-v="ink"]').click(); await until(() => readSidecar().ink?.['0']?.length); await win.waitForTimeout(1200)
      sc = readSidecar()
      const stroke = sc.ink?.['0']?.[0]
      // 存的是页内坐标(pt):起笔点应该在页宽 55%、页高 50% 附近。
      check('⑧ 笔迹是白板元素,按页存页内坐标', !!stroke && stroke.type === 'freedraw' && Math.abs(stroke.x - 612 * 0.55) < 6 && Math.abs(stroke.y - 792 * 0.5) < 6 && !!stroke.customData?.strokeOptions, JSON.stringify(stroke ? { type: stroke.type, x: stroke.x, y: stroke.y, n: stroke.points?.length, cd: Object.keys(stroke.customData ?? {}) } : null))
      const ink = await win.evaluate(() => { const e = document.querySelector('.pr-ink'); const pg = document.querySelector('.pr-root .page[data-page-number="1"]').getBoundingClientRect(); const r = e?.getBoundingClientRect(); return r ? [(r.left - pg.left) / pg.width, (r.top - pg.top) / pg.height, r.width / pg.width] : null })
      check('⑧ 退出手写后静态笔迹留在原位', !!ink && Math.abs(ink[0] - 0.55) < 0.03 && ink[2] > 0.2 && ink[2] < 0.35, JSON.stringify(ink))
    } else console.log('SKIP  ⑧ 手写:这份宿主没有 ctx.ui.mountBoard(工具栏上不出现手写 / 橡皮,符合预期)')

    await win.mouse.move(700, 880)
    await win.screenshot({ path: path.join(SHOTS, '4-overview.png') })

    // ⑨ 导出带批注的 PDF
    await win.locator('.pr-toolbar [data-act="more"]').click(); await win.locator('.pr-menu [data-pop="export"]').click()
    const findExport = () => fs.readdirSync(path.join(vault, FOLDER)).find((f) => f.startsWith('Reading Fixture') && f !== PDF && f.endsWith('.pdf'))
    await until(findExport, 10_000); await win.waitForTimeout(400)
    const exported = findExport()
    const exBytes = exported ? fs.readFileSync(path.join(vault, FOLDER, exported)) : Buffer.alloc(0)
    check('⑨ 另存出一份带批注的 PDF,原件不变', !!exported && ['/Highlight', '/Underline', '/Square', '/Text'].every((k) => exBytes.includes(k)) && Buffer.compare(pdfBefore, fs.readFileSync(path.join(vault, FOLDER, PDF))) === 0, `${exported} ${exBytes.length}`)
  } finally { await app.close() }

  // ⑩ 重开:批注还在
  ;({ app, win } = await launch(home, vault))
  try {
    await win.waitForSelector('.pr-hl', { timeout: 15_000 }).catch(() => {})
    const n = { hl: await win.locator('.pr-hl').count(), ul: await win.locator('.pr-ul').count(), note: await win.locator('.pr-note').count(), area: await win.locator('.pr-area').count(), items: await win.locator('.pr-item').count() }
    check('⑩ 关掉重开,批注都还在', n.hl >= 1 && n.ul >= 1 && n.note === 1 && n.area === 1 && n.items >= 4, JSON.stringify(n))
    await win.screenshot({ path: path.join(SHOTS, '5-reopened.png') })
  } finally { await app.close() }

  check('全程没有页面错误', errors.length === 0, errors.slice(0, 4).join(' | '))
  console.log(fails.length ? `\n${fails.length} 项没过:${fails.join(';')}` : '\n全部通过')
  process.exit(fails.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
