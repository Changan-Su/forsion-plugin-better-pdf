// 真应用里的冒烟:隔离的 home 起一份已构建的桌面端,库里放一份现做的三页 PDF,把本仓的 main.js 当插件装进去,
// 用真鼠标走一遍「点开 → 选字高亮 → 写评论打标签 → 复制引用 → 下划线(拖着就看得到)→ 便签 → 缩放后还对得上 → 重开还在」。
// 宿主带白板层接口(ctx.ui.mountBoard)时再走形状、点选 / 拖动 / 框选 / 删除 / 撤销、手写、橡皮擦批注、手写笔模式;不带就跳过并写明。
// 不碰开发实例、不碰真实的库。截图落在 .shots/(不进版本库)。
//
// 跑(在 Forsion 仓根;桌面端先 npm run build 出 out/):
//   node .claude/hooks/devlock.cjs run --vehicle=e2e --what="PDF 阅读器插件冒烟" --eta=4 -- node Forsion-Instrumentality-Project/forsion-plugin-pdf-reader/verify/smoke.cjs
// GENESIS_DESKTOP=<桌面端检出> 换一份宿主(默认仓根的 Forsion-Genesis/desktop)。
// UI_ZOOM=1.1 在界面缩放 110% 下跑同一遍(用户的开发实例就是 110%;100% 下看不见偏移类问题)。
const fs = require('fs'); const os = require('os'); const path = require('path')
const HERE = path.resolve(__dirname, '..')
const DESK = process.env.GENESIS_DESKTOP || path.resolve(HERE, '../../Forsion-Genesis/desktop')
const electron = require(path.join(DESK, 'scripts/lib/launch-electron.cjs'))
const { chromium } = require(path.join(DESK, 'node_modules/playwright-core'))
const { startStubEngine } = require(path.join(DESK, 'scripts/lib/stub-engine.cjs')) // 假后端:让右栏的对话接得上(不跑模型)
const SHOTS = path.join(HERE, '.shots'); fs.mkdirSync(SHOTS, { recursive: true })
const PDF = 'Reading Fixture.pdf'; const FOLDER = '文献'
const S1 = 'Annotation pays off when you come back to it.'
const S2 = 'A highlight is a decision that a sentence matters.'
const S3 = 'Notes written in your own words are worth more than copied ones.'
const S4 = 'Forty-eight readers took part.'

/** 等到条件成立(落盘是改完 0.4 秒后的事,窗口不在前台时定时器还会被浏览器放慢)。 */
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; for (;;) { let v; try { v = await fn() } catch { v = null } if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 120)) } }
const fails = []
const LINKS = process.env.ONLY === 'links'
// ONLY=parity:只走 ⑯(白板的用法:快捷键、自定义颜色、笔尾橡皮、手指连点两下),自己画自己擦,不靠前面留下的东西。
const PARITY = process.env.ONLY === 'parity'
// ONLY=stage:摆台。起一份**看得见**的隔离实例(库名「ZZ-验收库」,里面一篇八页的论文样张和一条空笔记),装好本仓的插件就停住,
// 不跑任何检查 —— 给人或 computer use 照真实工作流上手体验用。Ctrl-C / 杀掉本进程即收场。建议带 UI_ZOOM=1.1。
const STAGE = process.env.ONLY === 'stage'
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`); if (!ok) fails.push(name) }

/** 摆台用的样张:一篇像样的八页短论文(标题、摘要、各节、一张表、参考文献),内容是现编的。 */
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
    <h1>Reading Fixture</h1>${para(S1)}${para(S2)}${para(S3)}
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-pdfreader-'))
  const vault = path.join(home, STAGE ? 'ZZ-验收库' : 'Vault'); fs.mkdirSync(path.join(vault, FOLDER), { recursive: true })
  await (STAGE ? makePaper : makePdf)(path.join(vault, FOLDER, PDF))
  // 第一条:把 PDF 拖进笔记得到的不带页码的链接(⑭);后两条:「复制引用」贴出来的带页码的链接、聊天引用那种带引语的(⑮)。
  fs.writeFileSync(path.join(vault, '选题.md'), `# 选题\n\n[[${PDF}]]\n\n[[${PDF}#page=3|第 3 页]]\n\n[[${PDF}#page=2&q=nine-page%20document|引语]]\n`)
  // PLUGIN_DIR / PLUGIN_SRC:照商店的装法放(目录叫安装名 better-pdf、整个仓原样解进去),缺省是只放 main.js + 清单、目录叫插件 id。
  const plug = path.join(home, 'plugins', process.env.PLUGIN_DIR || 'pdf-reader'); fs.mkdirSync(plug, { recursive: true })
  if (process.env.PLUGIN_SRC) fs.cpSync(process.env.PLUGIN_SRC, plug, { recursive: true })
  else for (const f of ['main.js', 'manifest.json']) fs.copyFileSync(path.join(HERE, f), path.join(plug, f))
  const sidecar = path.join(vault, FOLDER, `.${PDF}.annot.json`)
  let hasInk = false
  const readSidecar = () => (fs.existsSync(sidecar) ? JSON.parse(fs.readFileSync(sidecar, 'utf8')) : null)
  const pdfBefore = fs.readFileSync(path.join(vault, FOLDER, PDF))
  const errors = []

  const stub = await startStubEngine()
  let { app, win } = await launch(home, vault, stub.url)
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => { if (m.type() === 'error' && /pdf-reader|pdfjs|Worker/i.test(m.text())) errors.push(m.text()) })
  if (STAGE) {
    fs.writeFileSync(path.join(vault, '读后记.md'), '# 读后记\n\n')
    console.log(`摆好了。库:${vault}\n旁挂批注文件:${sidecar}\n页面错误会接着打在下面;收场:结束本进程。`)
    win.on('pageerror', (e) => console.log(`[pageerror] ${e}`)); win.on('console', (m) => { if (m.type() === 'error') console.log(`[console.error] ${m.text()}`) })
    await new Promise((r) => { app.on('close', r); process.on('SIGINT', r); process.on('SIGTERM', r) })
    await app.close().catch(() => {}); await stub.close?.(); return
  }
  try {
    // ONLY=links:只走最后的链接几项(⑭ ⑮),改路由 / 落点时用,一分钟内跑完(两段主流程各跳过一次)。
    full: {
    if (LINKS || PARITY) break full
    // ① 接管:是我们的阅读器,不是内置的
    check('① 点开 PDF 由插件打开', await win.locator('.pr-root .pdfViewer .page').count() === 3 && await win.locator('.amx-pdfview').count() === 0)
    check('① 刚装好没有任何批注', readSidecar() === null && await win.locator('.pr-marks > *').count() === 0)
    const tabs = await win.locator('[data-pdfmock], .pr-panel').count()
    check('① 右栏开出了批注列表', tabs >= 1 && await win.locator('.pr-listhead').count() === 1)
    hasInk = await win.locator('.pr-toolbar [data-act="tool"][data-v="ink"]').count() === 1

    // ② 选中一句 → 浮条 → 点第一颗颜色 = 高亮
    const b1 = await dragSelect(win, S1)
    check('② 选中文字浮出浮条', await win.locator('.pr-selpop').isVisible())
    const near = async (sel, box) => { const r = await win.locator(sel).boundingBox(); return !!r && r.x < box.right && r.x + r.width > box.left && Math.min(Math.abs(r.y + r.height - box.top), Math.abs(r.y - box.bottom)) < 40 ? true : JSON.stringify(r) }
    const selNear = await near('.pr-selpop', b1)
    check('② 浮条贴着选区(上下 40px 内、左右有交叠)', selNear === true, selNear === true ? '' : `${selNear} vs ${JSON.stringify(b1)}`)
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
    await win.waitForTimeout(500) // 刚划完 0.35 秒内的点击阅读器故意不理(那是划选收尾的那一下)
    await win.mouse.click((b1.left + b1.right) / 2, b1.y0); await win.waitForTimeout(300)
    check('③ 点高亮弹出批注卡', await win.locator('.pr-card').isVisible())
    const cardNear = await near('.pr-card', b1)
    check('③ 批注卡贴着那条高亮', cardNear === true, cardNear === true ? '' : `${cardNear} vs ${JSON.stringify(b1)}`)
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

    // ④ 引用:复制到剪贴板(到笔记里自己粘贴);不再有读书笔记
    // 剪贴板换成页面里的一个变量:台架不碰这台机器上真的剪贴板。
    await win.evaluate(() => { window.__clip = null; Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (s) => { window.__clip = s } }) })
    await win.locator('.pr-card [data-pop="cite"]').click()
    const clip = await until(() => win.evaluate(() => window.__clip))
    check('④ 引用复制到剪贴板:引文、页码链接和评论', !!clip && clip.includes(`> ${S1}`) && clip.includes(`[[${PDF}#page=1|`) && clip.includes('核心论点'), String(clip))
    await win.waitForTimeout(600)
    const mds = fs.readdirSync(vault, { recursive: true }).map(String).filter((f) => f.endsWith('.md'))
    check('④ 没有读书笔记:工具栏上没有那颗按钮,库里也没多出笔记', await win.locator('.pr-toolbar [data-act="note"]').count() === 0 && !readSidecar().note && mds.join() === '选题.md', mds.join(' | '))
    await win.keyboard.press('Escape')

    // ④b 问 Tangu:右栏切到对话,原文挂成输入框上方的引用(不替用户发送;后端是假引擎,不跑模型)
    await win.mouse.click((b1.left + b1.right) / 2, b1.y0); await win.waitForTimeout(300)
    await win.locator('.pr-card [data-pop="ask"]').click()
    const quoted = await until(() => win.evaluate((s) => !!document.querySelector('.pr-chat') && document.querySelector('.pr-chat').innerText.includes(s.slice(0, 24)), S1), 8000)
    check('④b 问 Tangu:引文递进右栏的对话', !!quoted, await win.evaluate(() => (document.querySelector('.pr-chat')?.innerText ?? '(没有对话视图)').slice(0, 160)))
    await win.screenshot({ path: path.join(SHOTS, '2b-ask.png') })
    // ④c 大纲:右栏的第二个标签
    const tab = win.locator('.dv-tab [title="大纲"], .dv-tab[title="大纲"], .dv-tab [aria-label="大纲"], .dv-tab:has([aria-label="大纲"])').first()
    if (await tab.count()) {
      await tab.click(); const n = await until(() => win.locator('.pr-outline button').count().then((c) => c >= 3 && c), 5000)
      check('④c 大纲列出 PDF 的目录', n >= 3, `条目 ${n}`)
      await win.locator('.pr-outline button').nth(1).click(); await win.waitForTimeout(700)
      check('④c 点目录跳到那一页', await win.locator('.pr-pageinput').inputValue() === '2')
      await win.locator('.pr-pageinput').fill('1'); await win.locator('.pr-pageinput').press('Enter'); await win.waitForTimeout(600)
    } else console.log('SKIP  ④c 大纲:没找到右栏的标签(标签条的结构变了?)', await win.evaluate(() => [...document.querySelectorAll('.dv-tab')].map((t) => t.outerHTML.slice(0, 160)).join(' || ')))
    await win.locator('.pr-toolbar [data-act="panel"]').click(); await win.waitForSelector('.pr-listhead', { timeout: 8000 })

    // ④d 查找 + 缩略图
    await win.locator('.pr-toolbar [data-act="find"]').click(); await win.locator('.pr-findinput').fill('nine-page'); await win.locator('.pr-findinput').press('Enter')
    const found = await until(() => win.locator('.pr-findcount').innerText().then((t) => /1 \/ 1/.test(t) && t), 6000)
    check('④d 查找:数出命中并跳到那一页', !!found && await win.locator('.pr-pageinput').inputValue() === '2', String(found))
    await win.locator('.pr-findbar [data-act="find-close"]').click()
    await win.locator('.pr-toolbar [data-act="thumbs"]').click()
    const thumbs = await until(() => win.evaluate(() => { const c = [...document.querySelectorAll('.pr-thumb canvas')]; return c.length === 3 && c[0].width > 100 && c.length }), 6000)
    check('④d 缩略图栏画出三页', thumbs === 3)
    await win.locator('.pr-thumb').first().click(); await win.waitForTimeout(500)
    await win.locator('.pr-toolbar [data-act="thumbs"]').click(); await win.waitForTimeout(800)

    // ⑤ 下划线工具:拖着的时候就画出来,松手即成
    await win.locator('.pr-toolbar [data-v="underline"]').click()
    const b5 = await sentenceBox(win, S2)
    await win.mouse.move(b5.x0, b5.y0); await win.mouse.down(); await win.mouse.move((b5.x0 + b5.x1) / 2, b5.y0, { steps: 4 }); await win.mouse.move(b5.x1, b5.y1, { steps: 6 }); await win.waitForTimeout(200)
    const live = await win.evaluate(() => { const g = [...document.querySelectorAll('.pr-ghosts .pr-ul')].map((e) => e.getBoundingClientRect()); return { n: g.length, left: Math.min(...g.map((r) => r.left)), right: Math.max(...g.map((r) => r.right)), selBg: getComputedStyle(document.querySelector('.pr-root .textLayer span'), '::selection').backgroundColor } })
    await win.screenshot({ path: path.join(SHOTS, '2c-underline-live.png') })
    check('⑤ 下划线还没松手就画出来了,盖在拖过的那句上', live.n >= 1 && Math.abs(live.left - b5.left) < 4 && Math.abs(live.right - b5.right) < 4 && readSidecar().annots.every((a) => a.type !== 'underline'), JSON.stringify({ ...live, want: [b5.left, b5.right] }))
    check('⑤ 拖的时候浏览器自己的选区底色是藏着的', /rgba\(0, 0, 0, 0\)|transparent/.test(live.selBg), live.selBg)
    await win.mouse.up(); await until(() => readSidecar().annots.some((a) => a.type === 'underline'))
    check('⑤ 下划线工具选完即划,预览收走', await win.locator('.pr-marks:not(.pr-ghosts) > .pr-ul').count() >= 1 && await win.locator('.pr-ghosts').count() === 0 && readSidecar().annots.some((a) => a.type === 'underline' && a.text === S2))
    await win.locator('.pr-toolbar [data-v="underline"]').click() // 再点一次 = 回到选择

    // ⑥ 便签
    const page1 = await win.locator('.pr-root .page[data-page-number="1"]').boundingBox()
    await win.locator('.pr-toolbar [data-v="note"]').click()
    await win.mouse.click(page1.x + page1.width - 60, page1.y + 120); await win.waitForTimeout(300)
    await win.keyboard.type('这里要回头核对样本量'); await win.keyboard.press('Escape')
    await until(() => readSidecar().annots.some((a) => a.comment === '这里要回头核对样本量'))
    sc = readSidecar()
    check('⑥ 便签落盘', sc.annots.some((a) => a.type === 'note' && a.comment === '这里要回头核对样本量'), JSON.stringify(sc.annots.map((a) => [a.type, a.rect])))

    // ⑥b 形状(白板元素):默认方框、不填充,拖的时候引擎自己画;画完工具不跳走(和别的工具一样)
    const px = page1.width / 612 // 一个 pt 合多少客户区像素
    const rectOnDisk = () => (readSidecar().ink?.['0'] ?? []).find((e) => e.type === 'rectangle')
    const pageBox = () => win.locator('.pr-root .page[data-page-number="1"]').boundingBox()
    /** 方框这会儿在客户区里的位置。每次现算:换工具时工具栏可能折成两行,页面跟着挪。 */
    const rectBox = async () => { const pg = await pageBox(), r = rectOnDisk(); return { x: pg.x + r.x * px, y: pg.y + r.y * px, w: r.width * px, h: r.height * px } }
    let R = null
    if (hasInk) {
      await win.locator('.pr-toolbar [data-v="shape"]').click(); await win.waitForSelector('.pr-root.pr-inking', { timeout: 20_000 }); await win.waitForTimeout(600)
      check('⑥b 形状工具默认是方框', await win.locator('.pr-toolbar [data-act="shape"][data-v="rectangle"].on').count() === 1)
      const pgS = await pageBox() // 进了形状工具再量(工具栏这时可能多出一行)
      R = { x: pgS.x + 120, y: pgS.y + pgS.height * 0.48, w: 240, h: 90 }
      await win.mouse.move(R.x, R.y); await win.mouse.down(); await win.mouse.move(R.x + R.w / 2, R.y + R.h / 2, { steps: 4 }); await win.waitForTimeout(150)
      await win.screenshot({ path: path.join(SHOTS, '2d-shape-live.png') }) // 还没松手:框已经在了
      await win.mouse.move(R.x + R.w, R.y + R.h, { steps: 4 }); await win.mouse.up()
      const rect = await until(() => { const r = rectOnDisk(); return r && Math.abs(r.width - R.w / px) < 4 && r }) || rectOnDisk() // 拖到一半停下截图时也会存一次,等最后那一份
      check('⑥b 方框是白板元素:不填充,存页内坐标', !!rect && rect.backgroundColor === 'transparent' && Math.abs(rect.x - 120 / px) < 4 && Math.abs(rect.y - 792 * 0.48) < 4 && Math.abs(rect.width - R.w / px) < 4 && Math.abs(rect.height - R.h / px) < 4, JSON.stringify(rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height, bg: rect.backgroundColor, c: rect.strokeColor } : null))
      await win.waitForTimeout(400) // 以前是抬起后下一拍才跳走的:等过这一拍再看
      check('⑥b 画完一个形状还留在形状工具(不自动跳回选择)', await win.locator('.pr-toolbar [data-act="tool"][data-v="shape"].on').count() === 1 && await win.locator('.pr-toolbar [data-act="tool"][data-v="select"].on').count() === 0)
      await win.locator('.pr-toolbar [data-act="tool"][data-v="select"]').click(); await win.waitForTimeout(500)

      // ⑪ 选择工具:白板层挂着也照样能选字
      await dragSelect(win, S3)
      check('⑪ 有笔迹之后,选择工具照样选得中文字', await win.locator('.pr-selpop').isVisible())
      await win.keyboard.press('Escape'); await win.evaluate(() => window.getSelection().removeAllRanges())
      // ⑪a 点中方框的边、拖动:存下来的位置跟着走
      const x0 = rectOnDisk().x
      R = await rectBox()
      await win.mouse.move(R.x + R.w / 2, R.y, { steps: 3 }); await win.waitForTimeout(120)
      await win.mouse.down(); await win.mouse.move(R.x + R.w / 2 + 20, R.y + 10, { steps: 4 }); await win.mouse.move(R.x + R.w / 2 + 40, R.y + 30, { steps: 4 }); await win.mouse.up()
      const movedTo = await until(() => { const r = rectOnDisk(); return r && Math.abs(r.x - (x0 + 40 / px)) < 3 && r }, 4000)
      check('⑪a 选择工具点中方框的边就能拖动', !!movedTo, JSON.stringify({ from: x0, now: rectOnDisk()?.x, want: x0 + 40 / px }))
      // 引擎按下时把键盘焦点收到自己的容器上:记下是哪个元素,⑪b 要把焦点塞回去
      const eng = await win.evaluate(() => { const a = document.activeElement; window.__eng = a; return a ? { cls: String(a.className).slice(0, 60), inBoard: !!a.closest('.pr-board') } : null })
      R = await rectBox()
      await win.screenshot({ path: path.join(SHOTS, '2e-shape-selected.png') })
      // ⑪a2 换一种形状:画个圆把第三段开头圈起来;选中这个圆之后,圈里的字照样能选(让给白板的只是外框那一圈)
      await win.locator('.pr-toolbar [data-v="shape"]').click(); await win.locator('.pr-toolbar [data-act="shape"][data-v="ellipse"]').click(); await win.waitForTimeout(300)
      const e3 = await sentenceBox(win, S3)
      const E = { x: e3.left - 44, y: e3.top - 22, w: 330, h: 70 }
      await win.mouse.move(E.x, E.y); await win.mouse.down(); await win.mouse.move(E.x + E.w, E.y + E.h, { steps: 6 }); await win.mouse.up()
      const ell = await until(() => (readSidecar().ink?.['0'] ?? []).find((e) => e.type === 'ellipse' && Math.abs(e.width - E.w / px) < 4))
      await win.locator('.pr-toolbar [data-act="tool"][data-v="select"]').click(); await win.waitForTimeout(400)
      const f3 = await sentenceBox(win, S3) // 回到选择后工具栏变回一行,页面又挪了
      await win.mouse.move(f3.left - 44 + E.w / 2, f3.top - 22, { steps: 3 }); await win.waitForTimeout(120); await win.mouse.down(); await win.mouse.up(); await win.waitForTimeout(250)
      await dragSelect(win, S3)
      check('⑪a2 选中圈住一句话的圆之后,圈里的字照样能选', !!ell && await win.locator('.pr-selpop').isVisible(), JSON.stringify(ell ? { w: ell.width, h: ell.height } : null))
      await win.screenshot({ path: path.join(SHOTS, '2e2-ellipse-text.png') })
      await win.keyboard.press('Escape'); await win.evaluate(() => window.getSelection().removeAllRanges())
      // ⑪b 这时引擎选中着刚才点的那个圆。去点文字:引擎得把它放下(把键盘焦点塞回白板再按删除,画上去的东西一个都不该少)
      const b3 = await sentenceBox(win, S3)
      const shapes0 = (readSidecar().ink?.['0'] ?? []).map((e) => e.type).sort().join()
      await win.mouse.click(b3.x0 + 40, b3.y0); await win.waitForTimeout(400)
      const refocused = await win.evaluate(() => { window.__eng?.focus(); return document.activeElement === window.__eng })
      await win.keyboard.press('Delete'); await win.waitForTimeout(700)
      const shapes1 = (readSidecar().ink?.['0'] ?? []).map((e) => e.type).sort().join()
      check('⑪b 点到页面上之后,画上去的东西不再是选中的(焦点塞回白板再按删除,一个都没少)', !!eng?.inBoard && refocused && shapes0 === 'ellipse,rectangle' && shapes1 === shapes0, JSON.stringify({ eng, refocused, before: shapes0, after: shapes1 }))
      // ⑪c 框选:从页边的空白拖一个框,把高亮、下划线和方框都框进去
      const b1b = await sentenceBox(win, S1)
      R = await rectBox()
      const m0 = [page1.x + 28, b1b.top - 14], m1 = [Math.max(R.x + R.w, b3.left + 300) + 40, R.y + R.h + 30]
      await win.mouse.move(m0[0], m0[1], { steps: 3 }); await win.waitForTimeout(120)
      await win.mouse.down(); await win.mouse.move((m0[0] + m1[0]) / 2, (m0[1] + m1[1]) / 2, { steps: 5 }); await win.waitForTimeout(120)
      await win.screenshot({ path: path.join(SHOTS, '2f-marquee.png') })
      await win.mouse.move(m1[0], m1[1], { steps: 5 }); await win.mouse.up(); await win.waitForTimeout(300)
      const picked = await win.evaluate(() => ({ hl: document.querySelectorAll('.pr-hl.sel').length, ul: document.querySelectorAll('.pr-ul.sel').length, note: document.querySelectorAll('.pr-note.sel').length }))
      check('⑪c 框选选中了框里的高亮和下划线(没框住的便签不算)', picked.hl >= 1 && picked.ul >= 1 && picked.note === 0, JSON.stringify(picked))
      await win.screenshot({ path: path.join(SHOTS, '2g-marquee-done.png') })
      // ⑪d 删除:批注和方框一起没;撤销:一起回来
      const before = readSidecar().annots.map((a) => a.id).sort().join()
      await win.keyboard.press('Delete')
      await until(() => !rectOnDisk() && readSidecar().annots.every((a) => a.type === 'note'), 4000)
      check('⑪d 框选后按删除:高亮、下划线、方框都删了,便签还在', !rectOnDisk() && readSidecar().annots.length === 1 && readSidecar().annots[0].type === 'note', JSON.stringify({ annots: readSidecar().annots.map((a) => a.type), ink: Object.keys(readSidecar().ink ?? {}) }))
      await win.keyboard.press('ControlOrMeta+z')
      await until(() => rectOnDisk() && readSidecar().annots.length === 3, 4000)
      const back = readSidecar()
      check('⑪d 撤销:三样都回来,评论和标签没丢', !!rectOnDisk() && back.annots.map((a) => a.id).sort().join() === before && back.annots.some((a) => a.comment === '核心论点,回看才值钱。' && a.tags?.[0] === '核心'), JSON.stringify({ annots: back.annots.map((a) => [a.type, a.comment]), rect: !!rectOnDisk() }))
      // ⑪e 撤销回来之后改了评论,再重做(又删掉)、再撤销:回来的得是改过的那一份,不是最早删掉时的旧样子
      const b1c = await sentenceBox(win, S1)
      await win.mouse.click((b1c.left + b1c.right) / 2, b1c.y0); await win.waitForSelector('.pr-card textarea', { timeout: 5000 })
      await win.locator('.pr-card textarea').fill('撤销之后改过的评论'); await until(() => readSidecar().annots.some((a) => a.comment === '撤销之后改过的评论'))
      await win.keyboard.press('Escape'); await win.waitForTimeout(200)
      await win.keyboard.press('ControlOrMeta+Shift+z'); await until(() => readSidecar().annots.length === 1, 4000)
      const redone = readSidecar().annots.length
      await win.keyboard.press('ControlOrMeta+z'); await until(() => readSidecar().annots.length === 3, 4000)
      check('⑪e 重做再撤销:撤销后新写的评论没丢', redone === 1 && readSidecar().annots.some((a) => a.comment === '撤销之后改过的评论'), JSON.stringify({ redone, comments: readSidecar().annots.map((a) => a.comment) }))
      await win.mouse.click(b3.x0 + 40, b3.y0); await win.waitForTimeout(300); await win.keyboard.press('Escape')
    } else console.log('SKIP  ⑥b ⑪ 形状 / 点选 / 框选:这份宿主没有 ctx.ui.mountBoard')

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
      // 白板层正好铺满手写区:界面缩放 ≠ 100% 时不许多盖出去(多出来的那圈会吃掉旁边面板的点击),也不许盖不满
      const cover = await win.evaluate(() => { const o = document.querySelector('.pr-board').getBoundingClientRect(), i = document.querySelector('.pr-board .am-plugin-board').getBoundingClientRect(); return [o.width, o.height, i.width, i.height].map((v) => Math.round(v * 10) / 10) })
      check('⑧ 白板层正好铺满手写区(误差 < 1.5px)', Math.abs(cover[0] - cover[2]) < 1.5 && Math.abs(cover[1] - cover[3]) < 1.5, JSON.stringify(cover))
      const p = await win.locator('.pr-root .page[data-page-number="1"]').boundingBox()
      const sx = p.x + p.width * 0.55, sy = p.y + p.height * 0.5
      await win.mouse.move(sx, sy); await win.mouse.down()
      for (let i = 1; i <= 24; i++) await win.mouse.move(sx + i * 7, sy + Math.sin(i / 3) * 22)
      await win.mouse.up(); await win.waitForTimeout(900)
      await win.screenshot({ path: path.join(SHOTS, '3-ink-live.png') })
      await win.locator('.pr-toolbar [data-v="ink"]').click(); await until(() => readSidecar().ink?.['0']?.length); await win.waitForTimeout(1200)
      sc = readSidecar()
      const stroke = (sc.ink?.['0'] ?? []).find((e) => e.type === 'freedraw')
      // 存的是页内坐标(pt):起笔点应该在页宽 55%、页高 50% 附近。
      check('⑧ 笔迹是白板元素,按页存页内坐标', !!stroke && stroke.type === 'freedraw' && Math.abs(stroke.x - 612 * 0.55) < 6 && Math.abs(stroke.y - 792 * 0.5) < 6 && !!stroke.customData?.strokeOptions, JSON.stringify(stroke ? { type: stroke.type, x: stroke.x, y: stroke.y, n: stroke.points?.length, cd: Object.keys(stroke.customData ?? {}) } : null))
      // ⑧b 手写时照常滚动 / 缩放(滚轮交回给阅读器),滚到第 2 页、放大之后再画:笔迹仍然落在指针所在的页内位置
      await win.locator('.pr-toolbar [data-v="ink"]').click(); await win.waitForSelector('.pr-board canvas', { timeout: 20_000 }); await win.waitForTimeout(800)
      const top0 = await win.evaluate(() => document.querySelector('.pr-container').scrollTop)
      await win.mouse.move(p.x + p.width / 2, p.y + 300); await win.mouse.wheel(0, 950); await win.waitForTimeout(500)
      const top1 = await win.evaluate(() => document.querySelector('.pr-container').scrollTop)
      check('⑧b 手写时滚轮照常滚页面', top1 - top0 > 600, `${top0} → ${top1}`)
      const scale0 = await win.evaluate(() => getComputedStyle(document.querySelector('.pr-root .pdfViewer')).getPropertyValue('--scale-factor'))
      // 缩放锚在指针下面:指针指着的那个页内位置(占页宽 / 页高的比例),缩放前后应该是同一个
      const wx = p.x + p.width * 0.7, wy = p.y + 420
      const under = () => win.evaluate(([x, y]) => { for (const pg of document.querySelectorAll('.pr-root .page')) { const r = pg.getBoundingClientRect(); if (y >= r.top && y <= r.bottom) return [pg.dataset.pageNumber, (x - r.left) / r.width, (y - r.top) / r.height] } return null }, [wx, wy])
      await win.mouse.move(wx, wy); const u0 = await under()
      await win.keyboard.down('Control'); await win.mouse.wheel(0, -60); await win.keyboard.up('Control'); await win.waitForTimeout(900)
      const u1 = await under()
      const scale1 = await win.evaluate(() => getComputedStyle(document.querySelector('.pr-root .pdfViewer')).getPropertyValue('--scale-factor'))
      check('⑧b 手写时 Ctrl + 滚轮照常缩放', Number(scale1) > Number(scale0) * 1.1, `${scale0} → ${scale1}`)
      check('⑧b 缩放锚在指针下面(页内位置漂移 < 1.5%)', !!u0 && !!u1 && u0[0] === u1[0] && Math.abs(u0[1] - u1[1]) < 0.015 && Math.abs(u0[2] - u1[2]) < 0.015, JSON.stringify([u0, u1]))
      const p2 = await win.locator('.pr-root .page[data-page-number="2"]').boundingBox()
      await win.locator('.pr-toolbar [data-act="pen"][data-v="highlighter"]').click(); await win.waitForTimeout(200)
      const hx = p2.x + p2.width * 0.3, hy = p2.y + p2.height * 0.2
      await win.mouse.move(hx, hy); await win.mouse.down(); for (let i = 1; i <= 12; i++) await win.mouse.move(hx + i * 12, hy); await win.mouse.up(); await win.waitForTimeout(500)
      await win.screenshot({ path: path.join(SHOTS, '3b-ink-page2-zoomed.png') })
      // ⑧c 撤销 / 重做、橡皮:再画一笔 → 撤销它 → 重做 → 用橡皮擦掉
      await win.locator('.pr-toolbar [data-act="pen"][data-v="default"]').click()
      const ex = p2.x + p2.width * 0.3, ey = p2.y + p2.height * 0.35
      await win.mouse.move(ex, ey); await win.mouse.down(); for (let i = 1; i <= 10; i++) await win.mouse.move(ex + i * 12, ey); await win.mouse.up()
      const inkCount = async () => (await until(() => readSidecar().ink?.['1']), (readSidecar().ink?.['1'] ?? []).length)
      await until(() => readSidecar().ink?.['1']?.length === 2); const n2 = await inkCount()
      await win.locator('.pr-toolbar [data-act="undo"]').click(); await until(() => readSidecar().ink?.['1']?.length === 1); const n1 = await inkCount()
      await win.locator('.pr-toolbar [data-act="redo"]').click(); await until(() => readSidecar().ink?.['1']?.length === 2); const n2b = await inkCount()
      await win.locator('.pr-toolbar [data-v="eraser"]').click(); await win.waitForTimeout(300)
      const eb = await win.evaluate(() => { const n = (q) => document.querySelectorAll(`.pr-toolbar ${q}`).length; return { pen: n('[data-act="pen"]'), color: n('[data-act="ink-color"]'), width: n('[data-act="ink-width"]'), undo: n('[data-act="undo"]'), redo: n('[data-act="redo"]') } })
      check('⑧c 橡皮下面没有笔 / 颜色 / 粗细那一排,只留撤销和重做', eb.pen === 0 && eb.color === 0 && eb.width === 0 && eb.undo === 1 && eb.redo === 1, JSON.stringify(eb))
      // 橡皮的工具栏短,可能从两行变回一行,页面跟着挪:重新量
      const p2e = await win.locator('.pr-root .page[data-page-number="2"]').boundingBox(), ex2 = p2e.x + p2e.width * 0.3, ey2 = p2e.y + p2e.height * 0.35
      await win.mouse.move(ex2 + 60, ey2 - 14); await win.mouse.down(); await win.mouse.move(ex2 + 60, ey2 + 14, { steps: 6 }); await win.mouse.up()
      await until(() => readSidecar().ink?.['1']?.length === 1); const n1b = await inkCount()
      check('⑧c 撤销 / 重做 / 橡皮都作用在笔迹上', n2 === 2 && n1 === 1 && n2b === 2 && n1b === 1, JSON.stringify({ n2, n1, n2b, n1b }))
      await win.locator('.pr-toolbar [data-v="eraser"]').click(); await win.waitForTimeout(1200) // 再点一次 = 回到选择
      // ⑧d 进手写之前就选好的笔和颜色,进去第一笔就是它(引擎装载初始内容时不许把笔冲掉)
      await win.locator('.pr-toolbar [data-v="ink"]').click(); await win.waitForSelector('.pr-board canvas', { timeout: 20_000 }); await win.waitForTimeout(600)
      await win.locator('.pr-toolbar [data-act="pen"][data-v="marker"]').click(); await win.locator('.pr-toolbar [data-act="ink-color"][data-v="#e03131"]').click()
      await win.locator('.pr-toolbar [data-v="ink"]').click(); await win.waitForTimeout(800)
      await win.locator('.pr-toolbar [data-v="ink"]').click(); await win.waitForSelector('.pr-board canvas', { timeout: 20_000 }); await win.waitForTimeout(1200)
      const mx = p2.x + p2.width * 0.3, my = p2.y + p2.height * 0.5
      await win.mouse.move(mx, my); await win.mouse.down(); for (let i = 1; i <= 10; i++) await win.mouse.move(mx + i * 12, my); await win.mouse.up()
      const first = await until(() => (readSidecar().ink?.['1'] ?? []).find((e) => Math.abs(e.y - 792 * 0.5) < 6))
      check('⑧d 进手写前选好的笔和颜色,第一笔就用上', !!first && first.strokeColor === '#e03131' && !!first.customData?.strokeOptions, JSON.stringify(first ? { c: first.strokeColor, bg: first.backgroundColor, w: first.strokeWidth, cd: Object.keys(first.customData ?? {}) } : null))
      await win.locator('.pr-toolbar [data-v="ink"]').click(); await win.waitForTimeout(1200)
      const hlStroke = (readSidecar().ink?.['1'] ?? []).find((e) => e.customData?.strokeOptions?.highlighter)
      check('⑧b 第 2 页、放大后画的笔迹,存的还是那一页的页内坐标', !!hlStroke && Math.abs(hlStroke.x - 612 * 0.3) < 4 && Math.abs(hlStroke.y - 792 * 0.2) < 4 && hlStroke.customData?.strokeOptions?.highlighter === true, JSON.stringify(hlStroke ? { x: hlStroke.x, y: hlStroke.y, w: hlStroke.width } : null))
      await win.screenshot({ path: path.join(SHOTS, '3c-ink-static-page2.png') })
      await win.locator('.pr-zoomsel').selectOption('page-width'); await win.waitForTimeout(600)
      await win.evaluate(() => { document.querySelector('.pr-container').scrollTop = 0 }); await win.waitForTimeout(900)
      // ⑧f 橡皮也擦批注:扫过那条下划线 → 先变淡,抬起才删;撤销能回来
      await win.locator('.pr-toolbar [data-v="eraser"]').click(); await win.waitForTimeout(400)
      const bu = await sentenceBox(win, S2)
      const ulBefore = readSidecar().annots.find((a) => a.type === 'underline')
      // ⑧f0 鼠标按着橡皮不动,另一支笔从下划线另一头悬停划过:不能把两点之间连成一道擦痕
      const hover = await win.context().newCDPSession(win)
      await win.mouse.move(bu.left - 60, bu.y0); await win.mouse.down(); await win.waitForTimeout(80)
      await hover.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bu.right + 30, y: bu.y1, button: 'none', buttons: 0, pointerType: 'pen' }); await win.waitForTimeout(120)
      const strayFade = await win.locator('.pr-ul.erasing').count()
      await win.mouse.up(); await win.waitForTimeout(600)
      check('⑧f0 橡皮只认按下的那一个指针(别的笔悬停划过不算擦)', strayFade === 0 && readSidecar().annots.some((a) => a.type === 'underline'), JSON.stringify({ strayFade, annots: readSidecar().annots.map((a) => a.type) }))
      await win.mouse.move(bu.x0 + 30, bu.top - 12); await win.mouse.down(); await win.mouse.move(bu.x0 + 30, bu.top + 26, { steps: 6 }); await win.waitForTimeout(120)
      const fading = await win.locator('.pr-ul.erasing').count()
      await win.mouse.up(); await until(() => readSidecar().annots.every((a) => a.type !== 'underline'), 4000)
      const erased = readSidecar().annots.every((a) => a.type !== 'underline')
      await win.locator('.pr-toolbar [data-act="undo"]').click(); await until(() => readSidecar().annots.some((a) => a.type === 'underline'), 4000)
      const ulBack = readSidecar().annots.find((a) => a.type === 'underline')
      check('⑧f 橡皮擦得掉划线(先变淡、抬起才删),撤销能回来', fading >= 1 && erased && !!ulBack && ulBack.id === ulBefore.id && ulBack.text === S2, JSON.stringify({ fading, erased, back: ulBack?.id, was: ulBefore?.id }))
      // ⑧g 橡皮工具下点底栏:底栏身后正好有一条高亮,它不能被擦掉;挪开之后扫过它才擦掉
      await win.locator('.pr-toolbar [data-v="highlight"]').click()
      await win.locator('.pr-pageinput').fill('2'); await win.locator('.pr-pageinput').press('Enter'); await win.waitForTimeout(900)
      await dragSelect(win, S4, 2); await until(() => readSidecar().annots.some((a) => a.page === 1 && a.type === 'highlight'), 4000)
      const onP2 = () => readSidecar().annots.some((a) => a.page === 1 && a.type === 'highlight')
      const madeP2 = onP2()
      await win.locator('.pr-toolbar [data-v="eraser"]').click(); await win.waitForTimeout(400)
      const bar = await win.locator('.pr-bottombar').boundingBox(), kz = Number(process.env.UI_ZOOM) || 1
      let b4 = await sentenceBox(win, S4, 2)
      await win.evaluate((dy) => document.querySelector('.pr-container').scrollBy(0, dy), (b4.y0 - (bar.y + bar.height / 2)) / kz); await win.waitForTimeout(700)
      b4 = await sentenceBox(win, S4, 2)
      const bx = bar.x + 3, by = bar.y + bar.height / 2 // 底栏左边的留白:点它没有别的副作用
      const behind = bx > b4.left && bx < b4.right && Math.abs(b4.y0 - by) < 8
      await win.mouse.click(bx, by); await win.waitForTimeout(700)
      const survived = onP2()
      await win.evaluate((dy) => document.querySelector('.pr-container').scrollBy(0, dy), 160 / kz); await win.waitForTimeout(700)
      b4 = await sentenceBox(win, S4, 2)
      await win.mouse.move(b4.x0 + 30, b4.top - 12); await win.mouse.down(); await win.mouse.move(b4.x0 + 30, b4.top + 26, { steps: 6 }); await win.mouse.up()
      await until(() => !onP2(), 4000)
      check('⑧g 橡皮工具下点底栏,擦不到它身后的高亮;挪开后扫过才擦掉', madeP2 && behind && survived && !onP2(), JSON.stringify({ madeP2, behind, survived, erasedAfter: !onP2(), bar: [Math.round(bx), Math.round(by)], s4: [b4.left, b4.right, b4.y0].map(Math.round) }))
      await win.locator('.pr-toolbar [data-v="eraser"]').click(); await win.waitForTimeout(600) // 再点一次 = 回到选择
      await win.evaluate(() => { document.querySelector('.pr-container').scrollTop = 0 }); await win.waitForTimeout(900)

      // ⑫ 手写笔模式:笔一落下就自动打开;开着的时候手指在白板层上是滚页面,不是画
      const cdp = await win.context().newCDPSession(win)
      const pen = async (type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'pen' })
      const touch = async (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y]) => ({ x, y, id: 1 })) })
      const inkN = () => Object.values(readSidecar().ink ?? {}).reduce((n, l) => n + l.length, 0)
      const top = () => win.evaluate(() => document.querySelector('.pr-container').scrollTop)
      await win.locator('.pr-toolbar [data-v="ink"]').click(); await win.waitForTimeout(600)
      check('⑫ 没见过手写笔时,工具栏上没有手写笔模式的开关', await win.locator('.pr-toolbar [data-act="penmode"]').count() === 0)
      const q1 = await win.locator('.pr-root .page[data-page-number="1"]').boundingBox()
      const nx = q1.x + q1.width * 0.25, ny = q1.y + q1.height * 0.42, k0 = inkN()
      await pen('mouseMoved', nx, ny, 0); await pen('mousePressed', nx, ny, 1)
      for (let i = 1; i <= 8; i++) await pen('mouseMoved', nx + i * 10, ny + (i % 2) * 6, 1)
      await pen('mouseReleased', nx + 80, ny, 0)
      await until(() => inkN() === k0 + 1, 4000)
      check('⑫ 笔一落下:画出一笔,手写笔模式自动打开', inkN() === k0 + 1 && await win.locator('.pr-toolbar [data-act="penmode"].on').count() === 1, JSON.stringify({ ink: [k0, inkN()], btn: await win.locator('.pr-toolbar [data-act="penmode"]').count() }))
      const t0 = await top(), k1 = inkN(), tx = q1.x + q1.width * 0.5, ty = q1.y + q1.height * 0.6
      await touch('touchStart', [[tx, ty]]); for (let i = 1; i <= 8; i++) await touch('touchMove', [[tx, ty - i * 20]]); await touch('touchEnd', [])
      await win.waitForTimeout(900)
      const t1 = await top()
      check('⑫ 手写笔模式下,手指在页面上拖是滚动,不留笔迹', t1 - t0 > 100 && inkN() === k1, JSON.stringify({ scroll: [t0, t1], ink: [k1, inkN()] }))
      // 关掉:手指又能画了
      await win.locator('.pr-toolbar [data-act="penmode"]').click(); await win.waitForTimeout(1500)
      const t2 = await top(), k2 = inkN()
      await touch('touchStart', [[tx, ty - 60]]); for (let i = 1; i <= 8; i++) await touch('touchMove', [[tx + i * 12, ty - 60]]); await touch('touchEnd', [])
      await until(() => inkN() === k2 + 1, 4000)
      check('⑫ 关掉手写笔模式:手指又能画,页面不跟着滚', inkN() === k2 + 1 && Math.abs(await top() - t2) < 2 && await win.locator('.pr-toolbar [data-act="penmode"]:not(.on)').count() === 1, JSON.stringify({ ink: [k2, inkN()], scroll: [t2, await top()] }))
      await win.locator('.pr-toolbar [data-v="ink"]').click(); await win.waitForTimeout(600)
      await win.evaluate(() => { document.querySelector('.pr-container').scrollTop = 0 }); await win.waitForTimeout(900)
      // ⑫b 选择工具下的手指:鼠标刚在空白处停过(白板层这时收着指针),手指直接去点一条高亮 —— 得点得开它的批注卡
      const bt = await sentenceBox(win, S1), pgT = await win.locator('.pr-root .page[data-page-number="1"]').boundingBox()
      await win.mouse.move(pgT.x + 28, bt.top - 14, { steps: 3 }); await win.waitForTimeout(150)
      const armed = await win.evaluate(() => document.querySelector('.pr-board').style.pointerEvents)
      await touch('touchStart', [[(bt.left + bt.right) / 2, bt.y0]]); await touch('touchEnd', [])
      const tapped = await until(() => win.locator('.pr-card').isVisible(), 3000)
      check('⑫b 选择工具下手指轻点一条高亮:点得开批注卡(哪怕白板层这时正收着指针)', armed === 'auto' && !!tapped, JSON.stringify({ armed, tapped }))
      await win.keyboard.press('Escape')
      // 第 1 页的静态图(一页一张,含方框和笔迹)应该正好盖住存下来的那些元素(左上角对得上,宽度对得上)
      const ink = await win.evaluate(() => { const e = document.querySelector('.pr-root .page[data-page-number="1"] .pr-ink'); const pg = document.querySelector('.pr-root .page[data-page-number="1"]').getBoundingClientRect(); const r = e?.getBoundingClientRect(); return r ? [(r.left - pg.left) / pg.width, (r.top - pg.top) / pg.height, r.width / pg.width] : null })
      const ext = (readSidecar().ink?.['0'] ?? []).reduce((b, e) => { const xs = e.points ? e.points.map((q) => e.x + q[0]) : [e.x, e.x + e.width], ys = e.points ? e.points.map((q) => e.y + q[1]) : [e.y, e.y + e.height]; return [Math.min(b[0], ...xs), Math.min(b[1], ...ys), Math.max(b[2], ...xs)] }, [Infinity, Infinity, -Infinity])
      check('⑧ 静态笔迹盖在存下来的那些元素上(误差 < 页宽的 3%)', !!ink && Math.abs(ink[0] - ext[0] / 612) < 0.03 && Math.abs(ink[1] - ext[1] / 792) < 0.03 && Math.abs(ink[2] - (ext[2] - ext[0]) / 612) < 0.04, JSON.stringify({ ink, want: [ext[0] / 612, ext[1] / 792, (ext[2] - ext[0]) / 612] }))
    } else console.log('SKIP  ⑧ 手写:这份宿主没有 ctx.ui.mountBoard(工具栏上不出现手写 / 橡皮,符合预期)')

    await win.mouse.move(700, 880)
    await win.screenshot({ path: path.join(SHOTS, '4-overview.png') })

    // ⑨ 导出带批注的 PDF
    await win.locator('.pr-toolbar [data-act="more"]').click(); await win.locator('.pr-menu [data-pop="export"]').click()
    const findExport = () => fs.readdirSync(path.join(vault, FOLDER)).find((f) => f.startsWith('Reading Fixture') && f !== PDF && f.endsWith('.pdf'))
    await until(findExport, 10_000); await win.waitForTimeout(400)
    const exported = findExport()
    const exBytes = exported ? fs.readFileSync(path.join(vault, FOLDER, exported)) : Buffer.alloc(0)
    // 点开导出的那份看一眼(它也由本插件打开;原生注释由 pdf.js 画,笔迹在页面内容里)
    await win.locator('.t2s-srow', { has: win.locator('.t2s-srow-title', { hasText: exported || '___' }) }).first().click().catch(() => {})
    await win.waitForTimeout(2500); await win.screenshot({ path: path.join(SHOTS, '6-exported.png') })
    // ⑨b 再导出一次:不覆盖上一份,另起一个编号的名字
    const origRow = () => win.locator('.t2s-srow', { has: win.locator('.t2s-srow-title', { hasText: PDF }) }).first()
    await origRow().click(); await win.waitForSelector('.pr-hl', { timeout: 15_000 }); await win.waitForTimeout(600)
    await win.locator('.pr-toolbar [data-act="more"]').click(); await win.locator('.pr-menu [data-pop="export"]').click()
    const exportsNow = () => fs.readdirSync(path.join(vault, FOLDER)).filter((f) => f.startsWith('Reading Fixture') && f !== PDF && f.endsWith('.pdf'))
    await until(() => exportsNow().length === 2, 10_000)
    check('⑨b 再导出一次不覆盖上一份', exportsNow().length === 2 && !!exported && Buffer.compare(exBytes, fs.readFileSync(path.join(vault, FOLDER, exported))) === 0, exportsNow().join(' | '))
    // ⑧e 画完一笔马上落盘:不等 0.3 秒的攒批和 0.4 秒的防抖(退出应用时宿主不等渲染层,留在定时器里的就丢了)
    if (hasInk) {
      await win.locator('.pr-toolbar [data-v="ink"]').click(); await win.waitForSelector('.pr-board canvas', { timeout: 20_000 }); await win.waitForTimeout(1200)
      const q = await win.locator('.pr-root .page[data-page-number="1"]').boundingBox()
      const lx = q.x + q.width * 0.2, ly = q.y + q.height * 0.35 // 0.8 那么低的地方在窗口外面,鼠标事件到不了页面
      const lastOnDisk = () => (readSidecar().ink?.['0'] ?? []).some((e) => Math.abs(e.y - 792 * 0.35) < 8)
      await win.mouse.move(lx, ly); await win.mouse.down(); for (let i = 1; i <= 8; i++) await win.mouse.move(lx + i * 10, ly); await win.mouse.up()
      const t0 = Date.now(); let ms = -1
      while (Date.now() - t0 < 3000) { if (lastOnDisk()) { ms = Date.now() - t0; break } await new Promise((r) => setTimeout(r, 10)) }
      check('⑧e 画完一笔 0.25 秒内就在盘上', ms >= 0 && ms < 250, ms >= 0 ? `${ms}ms` : '3 秒内都没落盘(这一笔根本没画上?)')
    }
    check('⑨ 另存出一份带批注的 PDF,原件不变', !!exported && ['/Highlight', '/Underline', '/Text'].every((k) => exBytes.includes(k)) && Buffer.compare(pdfBefore, fs.readFileSync(path.join(vault, FOLDER, PDF))) === 0, `${exported} ${exBytes.length}`)
    } // full
  } finally { await app.close() }

  // ⑩ 重开:批注还在
  ;({ app, win } = await launch(home, vault, stub.url))
  try {
    full: {
    if (LINKS || PARITY) break full
    await win.waitForSelector('.pr-hl', { timeout: 15_000 }).catch(() => {})
    const n = { hl: await win.locator('.pr-hl').count(), ul: await win.locator('.pr-ul').count(), note: await win.locator('.pr-note').count(), items: await win.locator('.pr-item').count() }
    check('⑩ 关掉重开,批注都还在', n.hl >= 1 && n.ul >= 1 && n.note === 1 && n.items >= (hasInk ? 4 : 3), JSON.stringify(n))
    if (hasInk) {
      // 文档里有笔迹:不用先点「手写」,白板层自己挂上(选择工具下就能点选画上去的东西)
      const up = await win.waitForSelector('.pr-root.pr-inking', { timeout: 20_000 }).then(() => true, () => false)
      check('⑩ 重开后方框还在,白板层自己挂上', up && (readSidecar().ink?.['0'] ?? []).some((e) => e.type === 'rectangle'), JSON.stringify(Object.fromEntries(Object.entries(readSidecar().ink ?? {}).map(([p, l]) => [p, l.map((e) => e.type)]))))
    }
    await win.screenshot({ path: path.join(SHOTS, '5-reopened.png') })
    await win.evaluate(() => { const r = document.documentElement; r.dataset.mode = 'dark'; r.classList.add('dark') }); await win.waitForTimeout(500)
    await win.mouse.click(600, 232); await win.waitForTimeout(400) // 点开那条高亮的批注卡,暗色下一起看
    await win.screenshot({ path: path.join(SHOTS, '7-dark.png') })
    } // full

    // ⑯ 白板的用法:工具的字母键(E 橡皮再按回到上一个工具)、任意颜色、笔尾的橡皮、手写笔模式下手指连点两下。
    //    白板层的工具由插件定死,引擎自己的这几样因此都不生效(笔尾橡皮按下去会拿当前的笔照画),得插件来接。
    parity: {
    if (LINKS) break parity
    const inkOn = await win.locator('.pr-toolbar [data-act="tool"][data-v="ink"]').count() === 1
    const tool = () => win.evaluate(() => document.querySelector('.pr-root').dataset.tool)
    const press = async (k) => { await win.keyboard.press(k); await win.waitForTimeout(150); return tool() }
    const annN = () => (readSidecar()?.annots ?? []).length
    const inkN = () => Object.values(readSidecar()?.ink ?? {}).reduce((n, l) => n + l.length, 0)
    await win.evaluate(() => { const r = document.documentElement; delete r.dataset.mode; r.classList.remove('dark') })
    await win.keyboard.press('Escape'); await win.waitForTimeout(200)
    let pg = await win.locator('.pr-root .page[data-page-number="1"]').boundingBox()
    await win.mouse.click(pg.x + 20, pg.y + pg.height * 0.3); await win.waitForTimeout(300) // 点一下页边:键盘焦点进阅读器
    // ⑯a 字母键
    const seq = []; for (const k of ['h', 'u', 'n', 't', 'v']) seq.push(await press(k))
    check('⑯a 字母键换工具:H 高亮、U 下划线、N 便签、T 文字、V 选择', seq.join() === 'highlight,underline,note,text,select', seq.join())
    const tip = await win.locator('.pr-toolbar [data-act="tool"][data-v="highlight"]').evaluate((b) => [b.title, b.getAttribute('aria-label'), b.getAttribute('aria-keyshortcuts')])
    check('⑯a 按钮提示上写着键,读屏念的仍是名字', tip[0] === '高亮 (H)' && tip[1] === '高亮' && tip[2] === 'H', JSON.stringify(tip))
    if (inkOn) {
      const s2 = []; for (const k of ['p', 'e', 'e', 'x', 'r']) s2.push(await press(k))
      const rect = await win.locator('.pr-toolbar [data-act="shape"][data-v="rectangle"].on').count()
      s2.push(await press('o')); const ell = await win.locator('.pr-toolbar [data-act="shape"][data-v="ellipse"].on').count()
      for (const k of ['e', 'e', '8', '8', 'Shift+E', 'r', '1']) s2.push(await press(k))
      check('⑯a P / X 手写,E 橡皮、再按 E 回到上一个工具(不是回到选择),R O 形状,数字键按工具栏顺序,Shift+E 不算', s2.join() === 'ink,eraser,ink,ink,shape,shape,eraser,shape,eraser,shape,shape,shape,select' && rect === 1 && ell === 1, JSON.stringify({ s2: s2.join(), rect, ell }))
    }
    await win.keyboard.press('ControlOrMeta+f'); await win.waitForTimeout(250); await win.keyboard.type('pe'); await win.waitForTimeout(250)
    const typed = await win.locator('.pr-findbar input').inputValue(), tAfter = await tool()
    await win.keyboard.press('Escape'); await win.waitForTimeout(250)
    check('⑯a 在输入框里打字不换工具', typed === 'pe' && tAfter === 'select', JSON.stringify({ typed, tAfter }))

    // ⑯b 任意颜色:选区浮条、批注卡、工具栏各有一颗取色器;挑过的留在色点后面
    const C1 = '#123456', C2 = '#abcdef', C3 = '#0a7f5c', SENT = 'most of those marks are never looked at again.'
    const a0 = annN()
    const sb = await dragSelect(win, SENT)
    await win.locator('.pr-selpop input[type="color"]').fill(C1); await until(() => annN() === a0 + 1, 4000)
    const made = (readSidecar()?.annots ?? []).find((a) => a.color === C1)
    check('⑯b 选区浮条上用取色器挑一种:高亮就是这个颜色', annN() === a0 + 1 && made?.type === 'highlight', JSON.stringify({ n: [a0, annN()], made: made && { type: made.type, color: made.color } }))
    await win.waitForTimeout(500); await win.mouse.click((sb.left + sb.right) / 2, sb.y0); await win.waitForSelector('.pr-card', { timeout: 4000 }).catch(() => {})
    const cardDot = await win.locator(`.pr-card .pr-dot.on[data-v="${C1}"]`).count()
    await win.locator('.pr-card input[type="color"]').fill(C2); await until(() => (readSidecar()?.annots ?? []).some((a) => a.id === made?.id && a.color === C2), 4000)
    check('⑯b 批注卡上认得这种颜色,再用取色器换一种:这条批注跟着换', cardDot === 1 && (readSidecar()?.annots ?? []).some((a) => a.id === made?.id && a.color === C2) && await win.locator(`.pr-card .pr-dot.on[data-v="${C2}"]`).count() === 1, JSON.stringify({ cardDot }))
    await win.screenshot({ path: path.join(SHOTS, '12-custom-colour-card.png') })
    await win.keyboard.press('Escape'); await win.waitForTimeout(250)
    check('⑯b 批注卡上换完颜色,Esc 照样关得掉它(那一排色点重画之后键盘焦点没有掉出去)', await win.locator('.pr-card').count() === 0)
    await win.locator('.pr-toolbar input[type="color"][data-color="color"]').fill(C3); await win.waitForTimeout(250)
    const bar = await win.evaluate(() => ({ on: document.querySelector('.pr-toolbar .pr-dot.on')?.dataset.v, dots: [...document.querySelectorAll('.pr-toolbar .pr-dot[data-v]')].map((d) => d.dataset.v), rows: Math.round(document.querySelector('.pr-toolbar').getBoundingClientRect().height / document.querySelector('.pr-toolbar .pr-tool').getBoundingClientRect().height), kept: localStorage.getItem('forsion-pdf-reader.colors') }))
    check('⑯b 工具栏上挑的成了当前颜色;最近挑过的三种排在固定色点后面,记得住;工具栏仍是一行', bar.on === C3 && bar.dots.slice(-3).join() === [C3, C2, C1].join() && bar.dots.length === 8 && bar.rows === 1 && bar.kept === JSON.stringify([C3, C2, C1]), JSON.stringify(bar))
    await win.locator('.pr-toolbar .pr-dot[data-act="color"]').first().click(); await win.waitForTimeout(150)
    // 点过工具栏之后按键还得有人听(工具栏整条重画,被点的那颗按钮带着键盘焦点一起没了)
    await win.locator('.pr-toolbar [data-act="tool"][data-v="underline"]').click(); await win.waitForTimeout(150)
    const afterClick = [await press('h'), await win.evaluate(() => !!document.activeElement?.closest('.pr-root'))]
    check('⑯a 点过工具栏上的按钮之后,快捷键照样管用(焦点没有掉出阅读器)', afterClick[0] === 'highlight' && afterClick[1] === true, JSON.stringify(afterClick))
    await press('v')

    if (inkOn) {
      // 笔尾橡皮、手指连点:页面右下的空白处先用鼠标画一道横线(手写的取色器顺带挑一种颜色),再拿「笔尾」竖着扫过去
      await press('p'); await win.waitForSelector('.pr-board canvas', { timeout: 20_000 }); await win.waitForTimeout(1200)
      await win.locator('.pr-toolbar input[type="color"][data-color="ink-color"]').fill('#ff00aa'); await win.waitForTimeout(250)
      const inkRows = await win.evaluate(() => Math.round(document.querySelector('.pr-toolbar').getBoundingClientRect().height / document.querySelector('.pr-toolbar .pr-tool').getBoundingClientRect().height))
      await win.screenshot({ path: path.join(SHOTS, '13-custom-colour-ink.png') })
      pg = await win.locator('.pr-root .page[data-page-number="1"]').boundingBox()
      const lx = pg.x + pg.width * 0.6, ly = pg.y + pg.height * 0.59, k0 = inkN()
      await win.mouse.move(lx, ly); await win.mouse.down(); for (let i = 1; i <= 10; i++) await win.mouse.move(lx + i * 12, ly); await win.mouse.up()
      await until(() => inkN() === k0 + 1, 5000)
      const drawn = Object.values(readSidecar()?.ink ?? {}).flat().find((e) => e.strokeColor === '#ff00aa')
      check('⑯b 手写的取色器:画出来就是挑的那种颜色', inkN() === k0 + 1 && drawn?.type === 'freedraw', JSON.stringify({ n: [k0, inkN()], drawn: drawn && drawn.type }))
      const pal = await win.evaluate(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(), a = r('.pr-palette'), v = r('.pr-viewport'); return { rows: inkRowsOf(), inside: a.top >= v.top && a.left >= v.left - 1 && a.right <= v.right + 1, h: Math.round(a.height) }; function inkRowsOf() { return Math.round(r('.pr-toolbar').height / r('.pr-toolbar .pr-tool').height) } })
      check('⑯e 手写那一排浮在页面上方:工具栏仍是一行(换工具时页面不跳),面板没伸出阅读区', inkRows === 1 && pal.rows === 1 && pal.inside, JSON.stringify({ inkRows, ...pal }))
      // 刚画完,键盘焦点在白板上:查找和 Esc 不能被引擎吃掉(它把 ⌘F 当成自己的「搜索画布」,在这里没有界面)
      const where = await win.evaluate(() => !!document.activeElement?.closest('.pr-board'))
      await win.keyboard.press('ControlOrMeta+f'); await win.waitForTimeout(300)
      const findOpen = await win.evaluate(() => !document.querySelector('.pr-findbar').hidden && !!document.activeElement?.closest('.pr-findbar'))
      await win.keyboard.press('Escape'); await win.waitForTimeout(250)
      await win.mouse.move(lx, ly + 40); await win.mouse.down(); await win.mouse.move(lx + 30, ly + 40, { steps: 3 }); await win.mouse.up(); await until(() => inkN() === k0 + 2, 5000)
      const escTool = await press('Escape')
      await win.keyboard.press('ControlOrMeta+z'); await until(() => inkN() === k0 + 1, 5000)
      check('⑯a 焦点在白板上时:⌘/Ctrl+F 照样打开查找条,Esc 照样回到选择工具', where && findOpen && escTool === 'select' && inkN() === k0 + 1, JSON.stringify({ where, findOpen, escTool, ink: [k0, inkN()] }))
      await press('p'); await win.waitForTimeout(500)
      // 合成的笔事件(CDP 发不出 5 号键):按下 → 等一拍 → 扫过去 → 抬起。指针号用鼠标那个(它一直在场,引擎抓指针时不会报错)。
      const tail = (pts, midKey) => win.evaluate(async ([pts, midKey]) => {
        const fire = (type, [x, y], button, buttons) => (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, pointerId: 1, pointerType: 'pen', isPrimary: true, button, buttons, pressure: buttons ? 0.5 : 0 }))
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        fire('pointerdown', pts[0], 5, 32); await wait(150)
        const root = document.querySelector('.pr-root'), lit = () => !!document.querySelector('.pr-toolbar [data-v="eraser"]') && getComputedStyle(document.querySelector('.pr-toolbar [data-v="eraser"]')).borderTopColor !== 'rgba(0, 0, 0, 0)'
        const during = [root.dataset.tool, 'tail' in root.dataset, lit()].join()
        for (const p of pts.slice(1)) { fire('pointermove', p, -1, 32); await wait(20) }
        if (midKey) { document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: midKey, bubbles: true, cancelable: true })); await wait(60) }
        fire('pointerup', pts[pts.length - 1], 5, 0); await wait(500)
        return { during, after: [root.dataset.tool, 'tail' in root.dataset, lit()].join() }
      }, [pts, midKey])
      const down = (x, y0, y1) => Array.from({ length: 9 }, (_, i) => [x, y0 + ((y1 - y0) * i) / 8])
      const k1 = inkN()
      const t1 = await tail(down(lx + 60, ly - 22, ly + 22)); await until(() => inkN() === k1 - 1, 5000)
      check('⑯c 手写时用笔尾扫过那道线:线被擦掉,没有多画出一笔;按着的时候工具栏上橡皮亮着,手上的工具不换(工具栏不重排)', t1.during === 'ink,true,true' && t1.after === 'ink,false,false' && inkN() === k1 - 1, JSON.stringify({ ...t1, ink: [k1, inkN()] }))
      await win.keyboard.press('ControlOrMeta+z'); await until(() => inkN() === k1, 5000); const u1 = inkN()
      await win.keyboard.press('ControlOrMeta+Shift+z'); await until(() => inkN() === k1 - 1, 5000); const r1 = inkN()
      await win.keyboard.press('ControlOrMeta+z'); await until(() => inkN() === k1, 5000)
      const back = Object.values(readSidecar()?.ink ?? {}).flat().find((e) => e.strokeColor === '#ff00aa')
      check('⑯c 撤销:擦掉的那道线回来(还在原来的位置);重做:又擦掉;再撤销:又回来', u1 === k1 && r1 === k1 - 1 && inkN() === k1 && !!back && Math.abs(back.x - drawn.x) < 0.01 && Math.abs(back.y - drawn.y) < 0.01, JSON.stringify({ u1, r1, now: inkN(), at: back && [back.x, back.y], was: [drawn.x, drawn.y] }))
      // 笔尾擦到一半按键换了工具:已经擦掉的那道线照样记了账,撤销得回来
      const t3 = await tail(down(lx + 60, ly - 22, ly + 22), 'v'); await until(() => inkN() === k1 - 1, 5000); const m1 = inkN()
      await win.keyboard.press('ControlOrMeta+z'); await until(() => inkN() === k1, 5000)
      check('⑯c 笔尾擦到一半按 V 换了工具:擦掉的那道线撤销得回来,橡皮的亮灯也收了', t3.after === 'select,false,false' && m1 === k1 - 1 && inkN() === k1, JSON.stringify({ ...t3, ink: [k1, m1, inkN()] }))
      // 高亮工具下(白板层这时不收指针,按下去落在页面上)用笔尾扫过刚才那条高亮:批注也擦得掉,抬起回到高亮
      await press('h'); await win.waitForTimeout(400)
      const hb = await sentenceBox(win, SENT), a1 = annN()
      const t2 = await tail(down((hb.left + hb.right) / 2, hb.top - 14, hb.bottom + 14)); await until(() => annN() === a1 - 1, 5000)
      const sel2 = await win.evaluate(() => window.getSelection().isCollapsed)
      await win.keyboard.press('ControlOrMeta+z'); await until(() => annN() === a1, 5000); const a2 = annN()
      await win.keyboard.press('ControlOrMeta+Shift+z'); await until(() => annN() === a1 - 1, 5000)
      check('⑯c 高亮工具下用笔尾扫过一条高亮:擦掉了,工具还是高亮,没有顺手选中文字;撤销回来,重做又没', t2.during === 'highlight,true,true' && t2.after === 'highlight,false,false' && sel2 && a2 === a1 && annN() === a1 - 1, JSON.stringify({ ...t2, sel2, annots: [a1, a2, annN()] }))
      const penOn = await win.locator('.pr-toolbar [data-act="penmode"].on').count()
      // ⑯d 手写笔模式开着(刚才那支「笔」打开的):手写时手指连点两下 = 橡皮,再连点两下 = 回到手写;慢慢点两下不算
      await press('p'); await win.waitForTimeout(600)
      const cdp = await win.context().newCDPSession(win)
      const tap = async (x, y) => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }) }
      const twice = async (gap) => { await tap(lx + 30, ly + 60); await win.waitForTimeout(gap); await tap(lx + 30, ly + 60); await win.waitForTimeout(300); return tool() }
      const k2 = inkN(), d1 = await twice(60), d2 = await twice(60), d3 = await twice(600)
      check('⑯d 手写笔模式下手指连点两下:橡皮和手写来回换;慢点两下不换;都不留笔迹', penOn === 1 && d1 === 'eraser' && d2 === 'ink' && d3 === 'ink' && inkN() === k2, JSON.stringify({ penOn, d1, d2, d3, ink: [k2, inkN()] }))
      await win.locator('.pr-toolbar [data-act="penmode"]').click(); await win.waitForTimeout(1500)
    }
    await press('v'); await win.evaluate(() => window.getSelection().removeAllRanges())
    } // parity

    full: {
    if (LINKS || PARITY) break full
    // ⑬ 把标签移到新窗口:那个窗口没有右栏。PDF 得照样在 —— 插件第一次挂上时会去开批注面板,
    //    没有右栏的窗口里宿主把它开进主区、就地顶掉 PDF 这个标签(用户看到的是「移过去是空的,点退回才回来」)。
    await win.keyboard.press('Escape'); await win.waitForTimeout(200)
    await win.locator('.wb-tab', { has: win.locator('.wb-tab-name', { hasText: PDF }) }).first().click({ button: 'right' }) // 标签名带后缀
    const [w2] = await Promise.all([app.waitForEvent('window', { timeout: 20_000 }), win.locator('.ctx-menu button', { hasText: '移到新窗口' }).click()])
    const shown = await w2.waitForSelector('.pr-root .page canvas', { timeout: 30_000 }).then(() => true, () => false)
    await w2.waitForTimeout(1500) // 面板是挂上之后才去开的:多等一拍,被顶掉的话这时已经换走了
    const st = await w2.evaluate(() => ({ reader: !!document.querySelector('.pr-root .page canvas'), hl: document.querySelectorAll('.pr-hl').length, panelBtn: document.querySelectorAll('.pr-toolbar [data-act="panel"]').length, kind: new URLSearchParams(location.search).get('window') }))
    check('⑬ 标签移到新窗口后 PDF 还在(没被批注面板顶掉);那边没有右栏,工具栏上不放「面板」按钮', shown && st.reader && st.hl >= 1 && st.panelBtn === 0 && st.kind === 'detached', JSON.stringify({ shown, ...st }))
    await w2.screenshot({ path: path.join(SHOTS, '8-new-window.png') }).catch(() => {})
    } // full
    links: {
    if (PARITY) break links
    // ⑭ 在笔记里点 [[x.pdf]](不带页码):也该由插件打开。用户把 PDF 拖进笔记、再点那条链接,走的就是这条路;
    //    桌面 2.13.2 及更早把笔记里的 PDF 链接直接交给内置阅读器、不问「默认打开方式」—— 在那些版本上这一项是红的。
    await win.bringToFront().catch(() => {})
    await win.locator('.t2s-srow', { has: win.locator('.t2s-srow-title', { hasText: /^选题$/ }) }).first().click(); await win.waitForTimeout(1500)
    const linkAt = () => win.evaluate((name) => {
      const hit = [...document.querySelectorAll('.dv-groupview *')].filter((e) => !e.closest('.t2s-srow, .wb-tab, .pr-root') && e.children.length === 0 && (e.textContent || '').includes(name.replace(/\.pdf$/, '')))
      const r = hit[0]?.getBoundingClientRect(); return r && r.width > 0 ? { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2, tag: hit[0].tagName, cls: String(hit[0].className).slice(0, 60) } : null
    }, PDF)
    const link = await until(linkAt, 8000)
    const opened = async () => ({ plugin: await win.locator('.pr-root .pdfViewer .page').count() > 0, builtin: await win.locator('.amx-pdfview').count() > 0 })
    if (link) { await win.mouse.click(link.x, link.y); await until(async () => { const o = await opened(); return o.plugin || o.builtin }, 8000) }
    let via = await opened()
    if (link && !via.plugin && !via.builtin) { await win.mouse.click(link.x, link.y, { modifiers: ['ControlOrMeta'] }); await until(async () => { const o = await opened(); return o.plugin || o.builtin }, 8000); via = await opened() } // 光标恰好落在链接里时,单击只是放光标
    await win.screenshot({ path: path.join(SHOTS, '9-note-link.png') })
    check('⑭ 在笔记里点 [[x.pdf]]:由插件打开,不是内置阅读器', !!link && via.plugin && !via.builtin, JSON.stringify({ link, ...via }))
    // ⑮ 带页码 / 带引语的链接:也由插件打开,并落在那一页(「批注 → 复制引用 → 贴进笔记 → 点回去」这一圈要合得上)。
    //    宿主经 file.onGoto 把落点交给插件;桌面 2.13.2 及更早没有这个接口、这类链接进内置阅读器 —— 在那些版本上这三项是红的。
    const noteRow = win.locator('.t2s-srow', { has: win.locator('.t2s-srow-title', { hasText: /^选题$/ }) }).first()
    const front = () => win.evaluate(() => {
      const r = [...document.querySelectorAll('.pr-root')].find((e) => e.offsetParent !== null)
      return r ? { page: r.querySelector('.pr-pageinput')?.value || '', mark: r.dataset.smoke || '', find: r.querySelector('.pr-findinput')?.value || '', findOpen: !r.querySelector('.pr-findbar')?.hidden, hits: r.querySelectorAll('.textLayer .highlight').length, builtin: document.querySelectorAll('.amx-pdfview').length } : { builtin: document.querySelectorAll('.amx-pdfview').length }
    })
    const clickNoteLink = async (text, ok) => {
      await noteRow.click({ modifiers: ['ControlOrMeta'] }); await win.waitForTimeout(1200) // 笔记开在旁边的标签里,PDF 那个标签留着
      const at = await until(() => win.evaluate((x) => {
        const e = [...document.querySelectorAll('.dv-groupview *')].find((n) => !n.closest('.t2s-srow, .wb-tab, .pr-root') && n.children.length === 0 && (n.textContent || '').trim() === x && n.getBoundingClientRect().width > 0)
        const r = e?.getBoundingClientRect(); return r ? { x: r.left + Math.min(r.width / 2, 20), y: r.top + r.height / 2 } : null
      }, text), 8000)
      if (!at) return null
      await win.mouse.click(at.x, at.y)
      if (!(await until(async () => ok(await front()), 6000))) { await win.mouse.click(at.x, at.y, { modifiers: ['ControlOrMeta'] }); await until(async () => ok(await front()), 8000) } // 同 ⑭:单击只落了光标时再点一次
      return front()
    }
    await win.evaluate(() => { const r = [...document.querySelectorAll('.pr-root')].find((e) => e.offsetParent !== null); if (r) r.dataset.smoke = 'kept' })
    const a15 = await clickNoteLink('第 3 页', (f) => f?.page === '3')
    check('⑮ 已开着时点带页码的链接:插件跳到第 3 页,阅读器没有重挂', a15?.page === '3' && a15.mark === 'kept' && !a15.builtin, JSON.stringify(a15))
    const b15 = await clickNoteLink('引语', (f) => f?.page === '2' && f.hits > 0)
    check('⑮b 带引语的链接:跳到第 2 页,引语在文字层上标出来,查找条开着', b15?.page === '2' && b15.findOpen && b15.find === 'nine-page document' && b15.hits > 0 && !b15.builtin, JSON.stringify(b15))
    await win.screenshot({ path: path.join(SHOTS, '10-quote-link.png') })
    const d15 = await clickNoteLink('第 3 页', (f) => f?.page === '3' && !f.findOpen)
    check('⑮d 引语还标着时再点不带引语的链接:到第 3 页,上一条的引语撤掉、查找条收起', d15?.page === '3' && !d15.findOpen && d15.hits === 0 && d15.find === '' && d15.mark === 'kept', JSON.stringify(d15))
    // 冷开:PDF 没开着时点带页码的链接(更常见的走法;落点比文档先到,插件要记着、排好页再跳)。
    await win.locator('.wb-tab', { has: win.locator('.wb-tab-name', { hasText: PDF }) }).first().click({ button: 'right' })
    await win.locator('.ctx-menu button', { hasText: '关闭' }).first().click()
    const closed = await until(async () => (await win.locator('.pr-root').count()) === 0, 6000)
    const c15 = await clickNoteLink('第 3 页', (f) => f?.page === '3')
    check('⑮c 没开着时点带页码的链接:插件打开并落在第 3 页', !!closed && c15?.page === '3' && c15.mark === '' && !c15.builtin, JSON.stringify({ closed: !!closed, ...c15 }))
    await win.screenshot({ path: path.join(SHOTS, '11-page-link-cold.png') })
    } // links
  } finally { await app.close() }

  await stub.close?.()
  check('全程没有页面错误', errors.length === 0, errors.slice(0, 4).join(' | '))
  console.log(fails.length ? `\n${fails.length} 项没过:${fails.join(';')}` : '\n全部通过')
  process.exit(fails.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
