/**
 * 自检:`node check.mjs`(不起应用)。四组:
 *  1. 构建产物过得了宿主的装载闸,且和 src 是同步的(市场装 zip 不构建,忘了重打就是发旧代码)。
 *  2. 插件的形状:不声明 fileExtensions(.pdf 是「接管」内置类型,不是自有类型)、装好是空的、样式不外溢。
 *  3. 文案:每条都有中英两种,英文里不夹汉字,占位符两边一致。
 *  4. 批注存取的几条保命路径(读不出来的旧文件绝不覆盖、新版本写的文件只读、改名后认回来、没批注不留空文件、
 *     两个窗口不互相盖、没存上的留着重试、刚关又开不丢、窗口要关时同步写、一次删几条再撤销)
 *     和选区 / 白板元素的几何 —— 用内存里的假宿主跑。
 * 界面交互要真应用:见 verify/smoke.cjs。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { strict as A } from 'node:assert'
import { build } from 'esbuild'
import { options } from './build.mjs'

const fail = []
const t = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`) } catch (e) { fail.push(name); console.log(`FAIL  ${name}\n      ${String(e.message).split('\n')[0]}`) }
}
const read = (f) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')
/** 把一个源文件打成 ESM 再 import 进来(它里面的 `ctx` 是全局自由变量,由下面的假宿主提供)。 */
const load = async (entry) => {
  const r = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}#${Math.random()}`)
}

const main = read('main.js')
const manifest = JSON.parse(read('manifest.json'))
const pkg = JSON.parse(read('package.json'))
const css = read('src/style.css')

// ── 1. 构建产物 ──
await t('main.js 是裸 setup 体(顶层无 import/export),能被 new Function 构造', () => {
  A.ok(!/^\s*(import|export)\s/m.test(main))
  new Function('ctx', main)
})
await t('main.js 和 src 同步(改了源码要重跑 node build.mjs)', async () => {
  const r = await build({ ...options, write: false, logLevel: 'silent' })
  A.ok(r.outputFiles[0].text === main, 'src 改过了但 main.js 没重打')
})
for (const [what, needle] of [['接管 .pdf', 'override:!0'], ['右栏视图', 'registerView'], ['白板层探测', 'mountBoard'], ['旁挂文件', '.annot.json'], ['pdf.js 样式作用域', '@scope (.pr-root)']]) {
  await t(`产物里有:${what}`, () => A.ok(main.includes(needle), `找不到 ${needle}`))
}

// ── 2. 形状 ──
await t('manifest 不声明 fileExtensions(.pdf 是接管,不是自有类型)', () => A.equal(manifest.fileExtensions, undefined))
await t('manifest / package.json 版本一致,且写了 minAppVersion', () => { A.equal(manifest.version, pkg.version); A.ok(manifest.minAppVersion) })
await t('装好是空的:仓里不带 PDF、不带批注文件', () => {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name === '.git' || e.name === '.shots' ? [] : e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]))
  A.deepEqual(walk('.').filter((f) => /\.pdf$|\.annot\.json/i.test(f)), [])
})
await t('样式不外溢:每条规则都落在 .pr- 下,不写 ::-webkit-scrollbar', () => {
  A.ok(!css.includes('::-webkit-scrollbar'))
  A.ok(!/dashed/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), '界面里不画虚线边框(宿主 DESIGN §6)')
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((r) => r.split('{')[0].trim()).filter(Boolean)
  // 先把 :is(…) 之类括号里的逗号拿掉,再按逗号拆成单条选择器
  const loose = selectors.flatMap((s) => s.replace(/\([^()]*\)/g, '()').split(',')).map((s) => s.trim()).filter((s) => s && !s.includes('.pr-'))
  A.deepEqual(loose, [])
})

// ── 3. 文案 ──
globalThis.ctx = { getLocale: () => 'zh' }
const { MESSAGES, t: tr } = await load('src/i18n.ts')
await t(`文案 ${Object.keys(MESSAGES).length} 条:中英成对、英文不夹汉字、占位符一致`, () => {
  for (const [k, [zh, en]] of Object.entries(MESSAGES)) {
    A.ok(zh && en, `${k} 缺一种语言`)
    A.ok(!/[一-鿿]/.test(en), `${k} 的英文里有汉字:${en}`)
    A.deepEqual((en.match(/\{\w+\}/g) ?? []).sort(), (zh.match(/\{\w+\}/g) ?? []).sort(), `${k} 的占位符两边不一致`)
  }
  A.equal(tr('card.page', { n: 3 }), '第 3 页')
})
await t('源码里用到的文案键都在表里', () => {
  const used = new Set()
  for (const f of readdirSync('src').filter((f) => f.endsWith('.ts'))) for (const m of read(`src/${f}`).matchAll(/\bt\('([a-z]+\.[\w.-]+)'/g)) used.add(m[1])
  A.deepEqual([...used].filter((k) => !MESSAGES[k]), [])
  for (const k of ['kind.ink', 'kind.highlight', 'kind.area', 'tool.eraser', 'tool.shape', 'pen.thin-thick-thin', 'shape.rectangle', 'shape.line', 'list.noMatch', 'chat.unavailable']) A.ok(MESSAGES[k], k) // 拼出来的键
})

// ── 4. 批注存取 + 选区几何(假宿主:内存里的库) ──
const enc = new TextEncoder(), dec = new TextDecoder()
function fakeHost() {
  const files = new Map(), notes = []
  let data = null
  globalThis.ctx = {
    getLocale: () => 'zh',
    notify: (m) => notes.push(m),
    loadData: async () => data,
    saveData: async (v) => { data = JSON.parse(JSON.stringify(v)) },
    app: {
      readBytes: async (p) => files.get(p) ?? null,
      writeBytes: async (p, b) => { if (host.failWrite?.(p)) throw new Error('写不进去'); files.set(p, b) },
    },
  }
  const host = { files, notes, failWrite: null, seen: () => data?.seen ?? {} }
  return host
}
const saved = (files, p) => JSON.parse(dec.decode(files.get(p)))
const A1 = { type: 'highlight', page: 0, color: '#ffd400', quads: [[1, 2, 3, 2, 1, 0, 3, 0]], text: 'x' }

await t('没批注过的 PDF 不留空文件;加一条之后落盘,内容读得回来', async () => {
  const { files } = fakeHost()
  const S = await load('src/store.ts')
  const d = await S.acquire('文献/A.pdf', 'fp-a')
  d.changed(); await d.flush()
  A.equal(files.size, 0)
  d.add(A1); await d.flush()
  const saved = JSON.parse(dec.decode(files.get('文献/.A.pdf.annot.json')))
  A.equal(saved.fingerprint, 'fp-a'); A.equal(saved.annots[0].text, 'x'); A.ok(saved.annots[0].id && saved.annots[0].created)
})
await t('读不出来的旧文件绝不覆盖:原样另存一份,再从空白开始', async () => {
  const { files, notes } = fakeHost()
  files.set('.B.pdf.annot.json', enc.encode('{ 坏掉的 json'))
  const S = await load('src/store.ts')
  const d = await S.acquire('B.pdf', 'fp-b')
  const kept = [...files.keys()].find((k) => k.startsWith('.B.pdf.annot.json.broken-'))
  A.ok(kept, '没有另存'); A.equal(dec.decode(files.get(kept)), '{ 坏掉的 json'); A.equal(notes.length, 1)
  d.add(A1); await d.flush()
  A.equal(JSON.parse(dec.decode(files.get('.B.pdf.annot.json'))).annots.length, 1)
  A.equal(dec.decode(files.get(kept)), '{ 坏掉的 json')
})
await t('更新版本的插件写的文件:只读,改了也不落盘', async () => {
  const { files } = fakeHost()
  const newer = JSON.stringify({ version: 99, fingerprint: 'fp-c', annots: [{ ...A1, id: 'k', created: '', modified: '' }], ink: {}, future: true })
  files.set('.C.pdf.annot.json', enc.encode(newer))
  const S = await load('src/store.ts')
  const d = await S.acquire('C.pdf', 'fp-c')
  A.equal(d.readonly, true); A.equal(d.data.annots.length, 1)
  d.add(A1); await d.flush()
  A.equal(dec.decode(files.get('.C.pdf.annot.json')), newer)
})
await t('别的程序写进批注文件的东西不能进页面的 HTML:id 不像样的条目不收,颜色不像样的换回黄色', async () => {
  const { files } = fakeHost()
  const evil = '#fff"><img src=x onerror="alert(1)">'
  files.set('.X.pdf.annot.json', enc.encode(JSON.stringify({ version: 1, fingerprint: 'fp-x', ink: {}, annots: [
    { ...A1, id: 'ok-1', color: evil, created: '', modified: '' }, { ...A1, id: 'ok_2', color: '#12AB34', created: '', modified: '' },
    { ...A1, id: 'x" onmouseover="alert(1)', created: '', modified: '' }, { ...A1, id: 7, created: '', modified: '' }, null,
  ] })))
  const d = await (await load('src/store.ts')).acquire('X.pdf', 'fp-x')
  A.deepEqual(d.data.annots.map((a) => [a.id, a.color]), [['ok-1', '#ffd400'], ['ok_2', '#12AB34']])
})

await t('PDF 改名 / 挪走之后按指纹把批注认回来,原处那份不动', async () => {
  const { files } = fakeHost()
  const S = await load('src/store.ts')
  const d = await S.acquire('旧/D.pdf', 'fp-d'); d.add(A1); await d.flush(); S.release(d); await d.flush()
  const moved = await S.acquire('新/D2.pdf', 'fp-d')
  A.equal(moved.data.annots.length, 1)
  await moved.flush()
  A.ok(files.has('新/.D2.pdf.annot.json'), '新位置没落一份'); A.ok(files.has('旧/.D.pdf.annot.json'))
})
await t('同一份 PDF 开两个标签共用一份批注(各写各的会互相盖掉)', async () => {
  fakeHost()
  const S = await load('src/store.ts')
  const [a, b] = await Promise.all([S.acquire('E.pdf', 'fp-e'), S.acquire('E.pdf', 'fp-e')])
  A.equal(a, b); A.equal(a.refs, 2)
})
await t('两个窗口各开同一份 PDF:各写各的不互相盖,删掉的也不被对方带回来', async () => {
  const { files } = fakeHost()
  const W1 = await load('src/store.ts'), W2 = await load('src/store.ts') // 两个模块实例 = 两个窗口,共用同一个盘
  const a = await W1.acquire('F.pdf', 'fp-f'), b = await W2.acquire('F.pdf', 'fp-f')
  const x = a.add({ ...A1, text: '甲' }); await a.flush()
  b.add({ ...A1, text: '乙' }); b.data.ink = { 0: [{ id: 's1', version: 1, x: 1, y: 2 }] }; b.changed(); await b.flush()
  A.deepEqual(saved(files, '.F.pdf.annot.json').annots.map((n) => n.text).sort(), ['乙', '甲'])
  A.deepEqual(b.data.annots.map((n) => n.text).sort(), ['乙', '甲'], '乙窗口内存里没并进甲写的')
  a.remove(x.id); await a.flush()
  const end = saved(files, '.F.pdf.annot.json')
  A.deepEqual(end.annots.map((n) => n.text), ['乙']); A.equal(end.ink[0][0].id, 's1')
  b.patch(b.data.annots[0].id, { comment: '改' }); await b.flush()
  A.deepEqual(saved(files, '.F.pdf.annot.json').annots.map((n) => n.text), ['乙'], '甲删掉的被乙带回来了')
})
await t('读不出来的旧文件又没能另存:整份只读,原件一个字节不动', async () => {
  const host = fakeHost()
  host.files.set('.G.pdf.annot.json', enc.encode('{ 坏'))
  host.failWrite = (p) => p.includes('.broken-')
  const S = await load('src/store.ts')
  const d = await S.acquire('G.pdf', 'fp-g')
  A.equal(d.readonly, true)
  d.add(A1); await d.flush()
  A.equal(dec.decode(host.files.get('.G.pdf.annot.json')), '{ 坏'); A.equal(host.files.size, 1)
})
await t('没存上的不算存了:关标签时再试,还不成就留在内存里,重开还在', async () => {
  const host = fakeHost()
  const S = await load('src/store.ts')
  const d = await S.acquire('H.pdf', 'fp-h')
  host.failWrite = () => true
  d.add(A1); await d.flush()
  A.equal(d.dirty, true); A.equal(host.files.size, 0)
  S.release(d); await d.flush(); await new Promise((r) => setTimeout(r))
  const again = await S.acquire('H.pdf', 'fp-h')
  A.equal(again, d, '没存上的那份被丢了'); A.equal(again.data.annots.length, 1)
  host.failWrite = null
  S.release(again); await again.flush()
  A.equal(saved(host.files, '.H.pdf.annot.json').annots.length, 1)
})
await t('刚关又开:还在落盘的那份不被提前丢掉,两次的批注都在', async () => {
  const { files } = fakeHost()
  const S = await load('src/store.ts')
  const d = await S.acquire('I.pdf', 'fp-i')
  d.add({ ...A1, text: '一' }); S.release(d)
  const d2 = await S.acquire('I.pdf', 'fp-i')
  A.equal(d2, d)
  d2.add({ ...A1, text: '二' }); S.release(d2)
  const d3 = await S.acquire('I.pdf', 'fp-i')
  await d3.flush()
  A.deepEqual(d3.data.annots.map((n) => n.text), ['一', '二']); A.deepEqual(saved(files, '.I.pdf.annot.json').annots.map((n) => n.text), ['一', '二'])
})
await t('认领只认指纹对得上的;新位置没落成之前,记的路径不改', async () => {
  const host = fakeHost()
  const S = await load('src/store.ts')
  const d = await S.acquire('旧/J.pdf', 'fp-j'); d.add(A1); await d.flush(); await new Promise((r) => setTimeout(r))
  A.equal(host.seen()['fp-j'], '旧/.J.pdf.annot.json')
  host.failWrite = (p) => p.startsWith('新/')
  const moved = await S.acquire('新/J.pdf', 'fp-j'); await moved.flush()
  A.equal(moved.data.annots.length, 1); A.equal(host.seen()['fp-j'], '旧/.J.pdf.annot.json', '新位置没写成,却把记的路径改了')
  // 旧路径上现在是另一篇文档的批注:不认
  host.files.set('旧/.J.pdf.annot.json', enc.encode(JSON.stringify({ version: 1, fingerprint: 'fp-别的', annots: [{ ...A1, id: 'z', created: '', modified: '' }], ink: {} })))
  const S2 = await load('src/store.ts')
  A.equal((await S2.acquire('别处/J.pdf', 'fp-j')).data.annots.length, 0)
})
await t('窗口要关时的最后一写是同步发出去的(不等定时器、不等别的 Promise)', async () => {
  const host = fakeHost()
  const S = await load('src/store.ts')
  const d = await S.acquire('K.pdf', 'fp-k')
  d.add(A1)
  let called = false
  const w = globalThis.ctx.app.writeBytes
  globalThis.ctx.app.writeBytes = (p, b) => { called = true; return w(p, b) }
  S.flushAllNow()
  A.equal(called, true); await 0
  A.equal(saved(host.files, '.K.pdf.annot.json').annots.length, 1)
})
await t('一次删几条再撤销:原样放回(id、评论都在),不重复放,删和放都马上落盘', async () => {
  const host = fakeHost()
  const S = await load('src/store.ts')
  const d = await S.acquire('U.pdf', 'fp-u')
  const a = d.add({ ...A1, comment: '留着' }), b = d.add(A1), c = d.add(A1)
  const gone = d.removeMany([a.id, c.id, 'nope'])
  A.deepEqual(gone.map((x) => x.id), [a.id, c.id])
  await d.flush()
  A.deepEqual(saved(host.files, '.U.pdf.annot.json').annots.map((x) => x.id), [b.id])
  d.restore(gone); d.restore(gone)
  await d.flush()
  const back = saved(host.files, '.U.pdf.annot.json').annots
  A.deepEqual(back.map((x) => x.id).sort(), [a.id, b.id, c.id].sort())
  A.equal(back.find((x) => x.id === a.id).comment, '留着')
})
await t('点没点中画上去的东西:线看距离,没填充的方框 / 圆只认边线,填了色的整块算,转过的按转回去算', async () => {
  const G = await load('src/geom.ts')
  const rect = { type: 'rectangle', x: 0, y: 0, width: 100, height: 60, backgroundColor: 'transparent' }
  A.ok(G.hits(rect, 50, 1, 4) && G.hits(rect, 102, 30, 4), '边线上该算中')
  A.ok(!G.hits(rect, 50, 30, 4), '没填充的方框里面不算中(里面的字要能选)')
  A.ok(!G.hits(rect, 120, 30, 4), '框外不算')
  A.ok(G.hits({ ...rect, backgroundColor: '#ffd43b' }, 50, 30, 4), '填了色的整块算')
  const el = { type: 'ellipse', x: 0, y: 0, width: 100, height: 60, backgroundColor: 'transparent' }
  A.ok(G.hits(el, 100, 30, 4) && G.hits(el, 50, 0, 4) && !G.hits(el, 50, 30, 4) && !G.hits(el, 2, 2, 4), '圆只认那一圈')
  const line = { type: 'line', x: 10, y: 10, width: 80, height: 40, strokeWidth: 1, points: [[0, 0], [80, 40]] }
  A.ok(G.hits(line, 50, 31, 4) && !G.hits(line, 50, 10, 4), '线看离线多远,不看外框')
  A.deepEqual(G.boundsOf({ x: 10, y: 10, points: [[0, 0], [-20, 5], [30, -8]] }), [-10, 2, 40, 15])
  // 转 90°:原来的上边线转到了右边(绕中心 50,30:点 (80,30) 转回去是 (50,0),在上边线上)
  A.ok(G.hits({ ...rect, angle: Math.PI / 2 }, 80, 30, 4) && !G.hits({ ...rect, angle: Math.PI / 2 }, 50, 1, 4), '转过的元素按转回去算')
})
await t('选区几何:同一行的碎块并成一条,分栏不连', async () => {
  const G = await load('src/geom.ts')
  const r = G.mergeLineRects([{ left: 0, top: 0, right: 40, bottom: 10 }, { left: 44, top: 1, right: 90, bottom: 11 }, { left: 300, top: 0, right: 340, bottom: 10 }, { left: 0, top: 20, right: 50, bottom: 30 }])
  A.deepEqual(r.map((x) => [x.left, x.right, x.top]), [[0, 90, 0], [300, 340, 0], [0, 50, 20]])
})

console.log(fail.length ? `\n${fail.length} 项没过:${fail.join(';')}` : '\n全部通过')
process.exit(fail.length ? 1 : 0)
