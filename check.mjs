/**
 * 自检:`node check.mjs`(不起应用)。四组:
 *  1. 构建产物过得了宿主的装载闸,且和 src 是同步的(市场装 zip 不构建,忘了重打就是发旧代码)。
 *  2. 插件的形状:不声明 fileExtensions(.pdf 是「接管」内置类型,不是自有类型)、装好是空的、样式不外溢。
 *  3. 文案:每条都有中英两种,英文里不夹汉字,占位符两边一致。
 *  4. 批注存取的几条保命路径(读不出来的旧文件绝不覆盖、新版本写的文件只读、改名后认回来、没批注不留空文件)
 *     和选区几何 —— 用内存里的假宿主跑。
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
  for (const k of ['kind.ink', 'kind.highlight', 'tool.eraser', 'pen.thin-thick-thin', 'list.noMatch', 'chat.unavailable']) A.ok(MESSAGES[k], k) // 拼出来的键
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
    app: { readBytes: async (p) => files.get(p) ?? null, writeBytes: async (p, b) => { files.set(p, b) } },
  }
  return { files, notes }
}
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
await t('选区几何:同一行的碎块并成一条,分栏不连', async () => {
  const G = await load('src/geom.ts')
  const r = G.mergeLineRects([{ left: 0, top: 0, right: 40, bottom: 10 }, { left: 44, top: 1, right: 90, bottom: 11 }, { left: 300, top: 0, right: 340, bottom: 10 }, { left: 0, top: 20, right: 50, bottom: 30 }])
  A.deepEqual(r.map((x) => [x.left, x.right, x.top]), [[0, 90, 0], [300, 340, 0], [0, 50, 20]])
})

console.log(fail.length ? `\n${fail.length} 项没过:${fail.join(';')}` : '\n全部通过')
process.exit(fail.length ? 1 : 0)
