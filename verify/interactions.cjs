// 真应用里的冒烟:隔离的 home 起一份已构建的桌面端,库里放一份现做的三页 PDF,把本仓的 main.js 当插件装进去,
// 用真鼠标走一遍「点开 → 选字高亮 → 写评论打标签 → 复制引用 → 下划线(拖着就看得到)→ 便签 → 缩放后还对得上 → 重开还在」。
// 宿主带白板层接口(ctx.ui.mountBoard)时再走形状、点选 / 拖动 / 框选 / 删除 / 撤销、手写、橡皮擦批注、手写笔模式;不带就跳过并写明。
// 不碰开发实例、不碰真实的库。截图落在 .shots/(不进版本库)。
//
// 跑(在 Forsion 仓根;桌面端先 npm run build 出 out/):
//   node .claude/hooks/devlock.cjs run --vehicle=e2e --what="PDF 阅读器插件冒烟" --eta=4 -- node Forsion-Instrumentality-Project/forsion-plugin-pdf-reader/verify/smoke.cjs
// GENESIS_DESKTOP=<桌面端检出> 换一份宿主(默认仓根的 Forsion-Genesis/desktop)。
// UI_ZOOM=1.1 在界面缩放 110% 下跑同一遍(用户的开发实例就是 110%;100% 下看不见偏移类问题)。
// 宿主有共用划线条(ctx.ui.mountSelectionBar,2.13.3 之后)时选区走宿主的条,并多跑 ②h 那几项;没有时走插件自己的浮条 .pr-selpop。
// 两种宿主各跑一遍,旧的那条路才算没坏。
const fs = require('fs'); const os = require('os'); const path = require('path')
const HERE = path.resolve(__dirname, '..')
const DESK = process.env.GENESIS_DESKTOP || path.resolve(HERE, '../../Forsion-Genesis/desktop')
const electron = require(path.join(DESK, 'scripts/lib/launch-electron.cjs'))
const { chromium } = require(path.join(DESK, 'node_modules/playwright-core'))
const { startStubEngine } = require(path.join(DESK, 'scripts/lib/stub-engine.cjs')) // 假后端:让右栏的对话接得上(不跑模型)
const SHOTS = process.env.PDF_INTERACTIONS_OUT || path.join(HERE, '.shots', 'interactions'); fs.mkdirSync(SHOTS, { recursive: true })
// 宿主有共用的划线条(ctx.ui.mountSelectionBar)时,选区浮出的是它;没有(2.13.3 及更早)时是插件自己的浮条 .pr-selpop。
const HOSTBAR = fs.existsSync(path.join(DESK, 'frontend/src/amadeus/plugins/selectionBarSurface.tsx'))
// 宿主能把菜单锚在按钮上(ctx.ui.contextMenu 对象重载 + ctx.ui.popover,2.13.8 起)时,很窄的分栏才把工具折进「⋯」;旧宿主照旧全摆出来。
const HOSTPOP = (() => { try { return fs.readFileSync(path.join(DESK, 'frontend/src/amadeus/plugins/partsSurface.tsx'), 'utf8').includes('openPluginPopover') } catch { return false } })()
const SELPOP = HOSTBAR ? '[data-testid="selection-bar"]' : '.pr-selpop'
const SELDOT = HOSTBAR ? `${SELPOP} .selbar-dot` : '.pr-selpop .pr-dot'
/** 假引擎回的「译文」(划线条上的翻译走 /agent/inline,流式)。 */
const sse = (events) => ({ __buffer: Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')), contentType: 'text/event-stream' })
const PDF = 'Reading Fixture.pdf'; const FOLDER = '文献'
const S1 = 'Annotation pays off when you come back to it.'
const S2 = 'A highlight is a decision that a sentence matters.'
const S3 = 'Notes written in your own words are worth more than copied ones.'
const S4 = 'Forty-eight readers took part.'

/** 等到条件成立(落盘是改完 0.4 秒后的事,窗口不在前台时定时器还会被浏览器放慢)。 */
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; for (;;) { let v; try { v = await fn() } catch { v = null } if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 120)) } }
/** 浮条 / 划线条出来了没有(宿主的条是懒加载的,第一次可能晚一拍)。 */
const shown = (win, sel) => win.locator(sel).first().waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)
const fails = []
const LINKS = process.env.ONLY === 'links'
// ONLY=parity:只走 ⑯(白板的用法:快捷键、自定义颜色、笔尾橡皮、手指连点两下),自己画自己擦,不靠前面留下的东西。
const PARITY = process.env.ONLY === 'parity'
const SELECTION = process.env.ONLY === 'selection'
// ONLY=stage:摆台。起一份**看得见**的隔离实例(库名「ZZ-验收库」,里面一篇四页的论文样张和一条空笔记),装好本仓的插件就停住,
// 不跑任何检查 —— 给人或 computer use 照真实工作流上手体验用。Ctrl-C / 杀掉本进程即收场。建议带 UI_ZOOM=1.1。
const STAGE = process.env.ONLY === 'stage'
// 批注卡的正文:宿主 2.13.8+ 是 Amadeus 编辑器(.pr-card-md 里的 contenteditable),更早是文本框
const CARD_BODY = '.pr-card textarea, .pr-card .pr-card-md [contenteditable="true"]'
/** 往批注卡里写一段(换掉原来的):文本框直接 fill;宿主编辑器(ProseMirror)不认 fill,全选后真打字。 */
const fillCard = async (win, text) => {
  const body = win.locator(CARD_BODY).first()
  if (await body.evaluate((n) => n.tagName === 'TEXTAREA')) return body.fill(text)
  await body.click(); await win.keyboard.press('ControlOrMeta+a'); await win.keyboard.type(text)
}
/** 目录卡上的「目录 / 缩略图」:宿主有分段控件(ctx.ui.mountControl)时是它的 [role=tab],旧宿主是插件自己的 .pr-sidetab。 */
const SIDETAB = (v) => `.pr-sidetabs :is(.pr-sidetab[data-v="${v}"], [role="tab"][aria-label="${v === 'toc' ? '目录' : '缩略图'}"])`
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`); if (!ok) fails.push(name) }

/** 摆台用的样张:一篇像样的四页短论文(标题、摘要、各节、一张表、参考文献),内容是现编的。 */
async function makePaper(file) {
  const fill = [
    'Readers who annotate tend to remember the structure of an argument better than those who only read, yet the benefit depends heavily on what happens after the first pass.',
    'In most reading tools a highlight is cheap to make and expensive to find again; the mark stays inside the document, far from the place where the reader later writes.',
    'We therefore treat every annotation as a small note with an address: a page, a position on that page, the quoted words, and whatever the reader added in their own voice.',
    'The cost of returning to a passage should be one click from the note that cites it, and the note itself should survive the document being renamed or moved.',
    'Handwriting behaves differently from typed comments. It is faster for diagrams and arrows, slower for anything that must be searched, and it is rarely revisited unless it sits next to the text it refers to.',
    'Participants were free to choose their own colours. Several built private schemes within minutes, for example one colour for claims, another for evidence and a third for doubts.',
  ]
  const body = (n, from = 0) => Array.from({ length: n }, (_, i) => `<p>${fill[(from + i) % fill.length]} ${fill[(from + i + 2) % fill.length]}</p>`).join('')
  const sec = (title, n, from) => `<h2>${title}</h2>${body(n, from)}`
  const html = `<html><body style="font: 14px/1.65 Georgia, serif; margin: 0">
    <h1 style="font-size: 26px; line-height: 1.25">Marks That Come Back: Annotation, Handwriting and the Second Visit</h1>
    <p style="color:#555">A. Reader, B. Writer and C. Margin — Department of Reading Studies</p>
    <h2>Abstract</h2><p><b>Annotation pays off only when the reader returns to it.</b> We compare three ways of marking a document — highlights, typed notes and handwriting — across forty-eight readers and two sessions one week apart. Delayed recall was highest when notes were written in the reader's own words and could be reopened from the place they were cited. Handwriting helped for figures and spatial relations but not for definitions.</p>
    ${sec('1. Introduction', 4, 0)}${sec('2. Related work', 4, 3)}
    ${sec('3. Method', 3, 1)}<h3>3.1 Participants</h3><p>Forty-eight readers took part. Each read the same nine-page document twice, one week apart.</p>
    <h3>3.2 Conditions</h3><table style="border-collapse: collapse; margin: 8px 0" border="1" cellpadding="6"><tr><th>Condition</th><th>Tool</th><th>Readers</th><th>Recall (%)</th></tr><tr><td>Highlight only</td><td>Marker</td><td>16</td><td>41</td></tr><tr><td>Typed notes</td><td>Comment card</td><td>16</td><td>63</td></tr><tr><td>Handwriting</td><td>Pen</td><td>16</td><td>55</td></tr></table>${body(2, 4)}
    ${sec('4. Results', 5, 2)}${sec('5. Discussion', 5, 5)}${sec('6. Limitations', 2, 1)}
    <h2>References</h2><ol><li>Margin, C. (2019). The address of a note. <i>Journal of Reading Tools</i>, 12(3), 45–61.</li><li>Writer, B. (2021). Colour schemes that readers invent. <i>Notes &amp; Queries in HCI</i>, 7, 101–118.</li><li>Reader, A. (2023). Why the second visit is expensive. <i>Reading Studies Quarterly</i>, 30(1), 1–19.</li></ol></body></html>`
  const b = await chromium.launch()
  try {
    const p = await b.newPage()
    await p.setContent(html)
    fs.writeFileSync(file, await p.pdf({ format: 'A4', margin: { top: '22mm', bottom: '22mm', left: '22mm', right: '22mm' }, outline: true, tagged: true }))
  } finally { await b.close() }
}

async function makePdf(file) {
  const para = (s) => `<p>${s} Readers mark up documents all the time, and most of those marks are never looked at again. The point of a reading tool is to make the second visit cheap.</p>`
  const html = `<html><body style="font: 15px/1.7 Georgia, serif; margin: 0">
    <h1>Reading Fixture</h1>${para(S1)}${para(S2)}${para(S3)}${SELECTION ? '<p style="margin-top:130px">Formula start: where the <i>n</i>! and <i>m</i>! factors give <i>x</i><sup>n</sup><i>y</i><sup>m</sup>.</p>' : ''}
    <h1 style="page-break-before: always">Methods</h1>${para(S4)}${para('Each read the same nine-page document.')}
    <h1 style="page-break-before: always">Results</h1>${para('Delayed recall was highest for readers who revisited their notes.')}</body></html>`
  const b = await chromium.launch()
  try {
    const p = await b.newPage()
    await p.setContent(html)
    fs.writeFileSync(file, await p.pdf({ format: 'Letter', margin: { top: '1in', bottom: '1in', left: '1in', right: '1in' }, outline: true, tagged: true }))
  } finally { await b.close() }
}

async function launch(home, vault, backend) {
  const userData = path.join(home, 'userdata')
  // 未打包时 userData 是 `<dir>-dev`,两处都种上,否则会打开本机真实的开发库。
  for (const d of [userData, `${userData}-dev`]) {
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: backend, token: 'fixture' }))
    for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) fs.writeFileSync(path.join(d, f), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2))
  }
  const app = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=zh-CN', DESK], cwd: DESK,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: backend, ...(STAGE ? null : { TANGU_HARNESS_QUIET: '1' }) }, // 摆台要看得见窗口
  })
  const win = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1512, 950) })
  await win.waitForSelector('#root', { timeout: 30_000 }); await win.waitForTimeout(2500)
  // UI_ZOOM=1.1:走宿主自己的界面缩放(⌘+ 存的就是这个键)。台架默认 100%,而用户的开发实例常年 110% —— 偏移类问题只在这里看得见。
  if (process.env.UI_ZOOM) {
    await win.evaluate((z) => localStorage.setItem('forsion_ui_zoom', z), process.env.UI_ZOOM)
    await win.reload(); await win.waitForSelector('#root', { timeout: 30_000 }); await win.waitForTimeout(3500) // 等开屏结束再点
  }
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
const sentenceBox = (win, needle, page = 1) => win.evaluate(([needle, page]) => {
  const tl = document.querySelector(`.pr-root .page[data-page-number="${page}"] .textLayer`)
  const w = document.createTreeWalker(tl, NodeFilter.SHOW_TEXT); const map = []; let s = ''
  for (let n = w.nextNode(); n; n = w.nextNode()) for (let i = 0; i < n.data.length; i++) if (!/\s/.test(n.data[i])) { s += n.data[i]; map.push([n, i]) }
  const k = needle.replace(/\s/g, ''); const at = s.indexOf(k); if (at < 0) return null
  const r = document.createRange(); r.setStart(map[at][0], map[at][1]); const e = map[at + k.length - 1]; r.setEnd(e[0], e[1] + 1)
  const rs = [...r.getClientRects()].filter((c) => c.width > 1 && c.height > 4)
  const a = rs[0], z = rs[rs.length - 1]
  return { x0: a.left + 1, y0: a.top + a.height / 2, x1: z.right - 1, y1: z.top + z.height / 2, left: Math.min(...rs.map((c) => c.left)), right: Math.max(...rs.map((c) => c.right)), top: a.top, bottom: z.bottom }
}, [needle, page])

async function dragSelect(win, needle, page = 1) {
  const b = await sentenceBox(win, needle, page); if (!b) throw new Error(`原文没找到:${needle}`)
  await win.mouse.move(b.x0, b.y0); await win.mouse.down(); await win.mouse.move((b.x0 + b.x1) / 2, b.y0, { steps: 4 }); await win.mouse.move(b.x1, b.y1, { steps: 6 }); await win.mouse.up()
  await win.waitForTimeout(250)
  return b
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-pdf-interactions-'))
  const vault = path.join(home, 'Vault'); fs.mkdirSync(path.join(vault, FOLDER), { recursive: true })
  await makePdf(path.join(vault, FOLDER, PDF))
  const plugin = path.join(home, 'plugins', 'pdf-reader'); fs.mkdirSync(plugin, { recursive: true })
  for (const file of ['main.js', 'manifest.json']) fs.copyFileSync(path.join(HERE, file), path.join(plugin, file))
  const sidecar = path.join(vault, FOLDER, `.${PDF}.annot.json`)
  const read = () => fs.existsSync(sidecar) ? JSON.parse(fs.readFileSync(sidecar, 'utf8')) : null
  const ink = () => Object.values(read()?.ink ?? {}).flat()
  const original = fs.readFileSync(path.join(vault, FOLDER, PDF))
  const stub = await startStubEngine(), errors = [], results = []
  const record = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); check(name, !!ok, typeof detail === 'string' ? detail : JSON.stringify(detail)) }
  let app, win
  const boot = async () => { ({ app, win } = await launch(home, vault, stub.url)); win.on('pageerror', e => errors.push(String(e))); win.on('console', m => { if (m.type() === 'error' && /pdf-reader|pdfjs|Worker/i.test(m.text())) errors.push(m.text()) }) }
  const tool = async () => win.locator('.pr-root').getAttribute('data-tool')
  const button = value => win.locator(`.pr-toolbar [data-act="tool"][data-v="${value}"]`)
  const shapes = () => ink().filter(e => e.type === 'rectangle')
  const draw = async (offset = 0) => {
    const page = await win.locator('.pr-root .page').first().boundingBox()
    const x = page.x + page.width * .3 + offset, y = Math.max(page.y + 255, 330) + offset
    await win.mouse.move(x, y); await win.mouse.down(); await win.mouse.move(x + 100, y + 60, { steps: 12 }); await win.mouse.up(); await win.waitForTimeout(450)
    return { x, y }
  }
  try {
    await boot()
    await dragSelect(win, S1)
    record('selection bar exposes three action/color split arrows', await win.locator(`${SELPOP} [data-menu-for]`).count() === 3)
    await win.locator(`${SELPOP} [data-act="underline"]`).click()
    await until(() => read()?.annots?.length === 1)
    record('primary underline uses its last color and consumes exactly one selection', read()?.annots?.[0]?.type === 'underline' && read().annots[0].color === '#ffd400')
    await dragSelect(win, S2)
    await win.locator(`${SELPOP} [data-menu-for="underline"]`).click()
    await win.locator('.pr-color-menu [data-v="#2ea8e5"]').click()
    await until(() => read()?.annots?.length === 2)
    record('underline color submenu applies captured selection and records its own color', read()?.annots?.[1]?.type === 'underline' && read().annots[1].color === '#2ea8e5')
    await button('underline').click()
    record('toolbar shows only current color and arrow, not a fixed color row', await win.locator('.pr-toolbar .pr-color-current').count() === 1 && await win.locator('.pr-toolbar .pr-dot').count() === 0)
    await win.locator('.pr-toolbar [data-act="tool-color"]').click(); await win.waitForTimeout(200)
    await win.screenshot({ path: path.join(SHOTS, 'color-submenu.png') })
    await win.keyboard.press('Escape')
    record('Escape closes color submenu without applying another annotation', await win.locator('.plugin-popover .pr-color-menu').count() === 0 && read().annots.length === 2)
    await button('hand').click(); await button('highlight').click(); await dragSelect(win, S3)
    await until(async () => await tool() === 'hand')
    record('single-use highlight returns to previous hand after a successful mark', await tool() === 'hand' && read().annots.length === 3 && read().annots[2].color === '#ffd400')
    await button('highlight').dblclick(); await dragSelect(win, S1)
    await until(() => read()?.annots?.length === 4)
    record('double-click keeps the tool without creating an extra mark', await tool() === 'highlight' && read().annots.length === 4 && await win.locator('.pr-toolbar [data-act="tool-menu"].on').count() === 1, { tool: await tool(), annots: read().annots.length, locked: await win.locator('.pr-toolbar [data-act="tool-menu"].on').count() })
    await win.keyboard.press('Escape'); record('Escape exits kept tool to previous hand', await tool() === 'hand')
    await button('shape').click()
    const pg = await win.locator('.pr-root .page').first().boundingBox(); await win.mouse.click(pg.x + pg.width * .5, Math.max(pg.y + 350, 420)); await win.waitForTimeout(350)
    record('empty shape gesture does not complete a once tool', await tool() === 'shape' && shapes().length === 0)
    const first = await draw(); await until(() => shapes().length === 1)
    record('new rectangles are sharp and return to previous hand after commit', shapes().length === 1 && !shapes()[0].roundness && await tool() === 'hand')
    await button('shape').click(); await win.locator('.pr-toolbar [data-act="roundness"][data-v="round"]').click(); const second = await draw(130)
    await until(() => shapes().length === 2)
    record('round mode affects the new rectangle without rewriting existing sharp rectangle', shapes().length === 2 && !shapes()[0].roundness && !!shapes()[1].roundness)
    await button('select').click(); await win.mouse.click(second.x + 50, second.y); await win.waitForTimeout(250)
    await win.locator('.pr-toolbar [data-act="roundness"][data-v="sharp"]').click(); await until(() => shapes().every(e => !e.roundness))
    record('selected old rectangle can be changed to sharp independently', shapes().length === 2 && shapes().every(e => !e.roundness))
    await win.keyboard.press('ControlOrMeta+z'); await until(() => !!shapes()[1]?.roundness)
    record('Undo reverts only the corner edit, not rectangle creation', shapes().length === 2 && !!shapes()[1].roundness && !shapes()[0].roundness)
    await win.keyboard.press('ControlOrMeta+Shift+z'); await until(() => shapes().every(e => !e.roundness))
    record('Redo reapplies the corner edit without changing other geometry', shapes().length === 2 && shapes().every(e => !e.roundness))
    await win.locator('.pr-toolbar [data-act="roundness"][data-v="round"]').click(); await until(() => !!shapes()[1]?.roundness)
    await win.screenshot({ path: path.join(SHOTS, 'corners.png') })
    record('editing old corner style preserves its other rectangle and annotations', !shapes()[0].roundness && !!shapes()[1].roundness && read().annots.length === 4)
    // A touch hold opens the explicit menu; cancellation does not draw anything.
    const hold = button('underline'); await hold.dispatchEvent('pointerdown', { pointerId: 80, pointerType: 'touch', button: 0 }); await win.waitForTimeout(600); await hold.dispatchEvent('pointerup', { pointerId: 80, pointerType: 'touch', button: 0 })
    record('touch hold exposes explicit use-once/keep-tool menu', await win.locator('.ctx-menu button').filter({ hasText: '保持工具' }).count() === 1)
    await win.keyboard.press('Escape')
    await button('shape').click(); await win.locator('.pr-toolbar [data-act="shape"][data-v="line"]').click()
    const linearPage = await win.locator('.pr-root .page').first().boundingBox(), lineX = linearPage.x + 220, lineY = Math.max(linearPage.y + 440, 520)
    await win.mouse.click(lineX, lineY); await win.mouse.move(lineX + 100, lineY + 10, { steps: 8 }); await win.waitForTimeout(450)
    record('point-by-point line preview does not consume a temporary shape tool', await tool() === 'shape')
    await win.mouse.click(lineX + 100, lineY + 10); await win.keyboard.press('Enter'); await until(async () => await tool() === 'select')
    record('Enter finalizes a point-by-point line before returning to navigation', await tool() === 'select' && ink().some(e => e.type === 'line'), { tool: await tool(), types: ink().map(e => e.type) })
    await button('ink').click(); await draw(15); record('freehand tool remains continuous', await tool() === 'ink', { tool: await tool() })
    await button('eraser').click(); await win.mouse.click(first.x + 220, first.y + 140); record('eraser remains continuous', await tool() === 'eraser', { tool: await tool() })
    await win.keyboard.press('Escape'); await app.close(); app = null
    const stored = read(); await boot()
    record('save/reopen preserves sharp and round rectangles plus all text annotations', JSON.stringify(read()) === JSON.stringify(stored) && shapes().length === 2 && !shapes()[0].roundness && !!shapes()[1].roundness)
    await button('select').click()
    const beforeColors = read().annots.map(a => ({ id: a.id, color: a.color })), cardAt = await sentenceBox(win, S1)
    await win.mouse.click((cardAt.left + cardAt.right) / 2, cardAt.y0); await win.locator('.pr-card').waitFor({ state: 'visible', timeout: 5000 })
    await win.locator('.pr-card [data-pop="color-menu"]').click(); await win.locator('.pr-card .pr-dot[data-v="#a28ae5"]').click()
    await until(() => read().annots.some(a => a.color === '#a28ae5'))
    const changedColors = read().annots.filter(a => a.color !== beforeColors.find(b => b.id === a.id)?.color)
    record('annotation card shares the palette and changes only its annotation without closing the parent', changedColors.length === 1 && changedColors[0].color === '#a28ae5' && await win.locator('.pr-card').isVisible())
    await win.screenshot({ path: path.join(SHOTS, 'annotation-colors.png') }); await win.keyboard.press('Escape')
    await button('underline').click(); record('per-tool color survives app restart', await win.locator('.pr-toolbar .pr-color-current').evaluate(e => getComputedStyle(e).backgroundColor) === 'rgb(46, 168, 229)')
    await win.keyboard.press('Escape')
    await win.locator('.pr-toolbar [data-act="more"]').click(); await win.locator('.ctx-menu button').filter({ hasText: '导出带批注的 PDF' }).click()
    const exports = () => fs.readdirSync(path.join(vault, FOLDER)).filter(f => f !== PDF && f.endsWith('.pdf'))
    await until(() => exports().length === 1, 10000)
    const out = exports()[0], bytes = out ? fs.readFileSync(path.join(vault, FOLDER, out)) : Buffer.alloc(0)
    record('export saves a separate annotated PDF and leaves original unchanged', !!out && bytes.length > original.length && Buffer.compare(original, fs.readFileSync(path.join(vault, FOLDER, PDF))) === 0)
    await win.screenshot({ path: path.join(SHOTS, 'after-reopen.png') })
    await win.evaluate(() => localStorage.setItem('forsion_theme_pref', 'dark')); await app.close(); app = null; await boot(); await win.waitForTimeout(600)
    await win.screenshot({ path: path.join(SHOTS, 'dark.png') })
    await win.evaluate(() => { localStorage.setItem('forsion_theme_pref', 'light'); localStorage.setItem('forsion_theme_skin', 'sage'); localStorage.setItem('forsion_theme_bg', 'sage') }); await app.close(); app = null; await boot(); await win.waitForTimeout(600)
    await win.screenshot({ path: path.join(SHOTS, 'sage.png') })
    if (out) {
      const fileRow = win.locator('.t2s-srow').filter({ has: win.locator('.t2s-srow-title', { hasText: out }) }).first()
      await fileRow.click()
      await win.waitForSelector('.pr-root:visible .textLayer span', { timeout: 15000 }); await win.waitForTimeout(500)
      await win.screenshot({ path: path.join(SHOTS, 'exported.png') })
      record('exported PDF opens independently without a sidecar overlay', await win.locator('.pr-root:visible .page canvas').count() > 0 && !fs.existsSync(path.join(vault, FOLDER, `.${out}.annot.json`)))
    }
    record('no renderer page errors or PDF/plugin console errors', errors.length === 0, errors)
  } catch (error) {
    record('scenario completed without uncaught exception', false, String(error)); if (win) await win.screenshot({ path: path.join(SHOTS, 'failure.png') }).catch(() => {})
    throw error
  } finally {
    if (app) await app.close().catch(() => {}); await stub.close?.()
    fs.writeFileSync(path.join(SHOTS, 'report.json'), JSON.stringify({ home, vault, results, errors }, null, 2)); console.log('Evidence:', SHOTS, 'isolated home:', home)
  }
  process.exit(fails.length ? 1 : 0)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
