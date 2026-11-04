/**
 * 目录:打开时现算,只记在内存里(按文档指纹),不写进批注文件。三级来源,先有先用:
 *  ① PDF 自带的书签;② 文档里那一页「Contents / 目录」(按缩进分级、印的页码换算成第几页);
 *  ③ 按字号推:正文 = 字最多的那个字号,大两成以上算标题,最大的两档 = 一 / 二级。
 * 只依赖 pdf.js 的文档对象(numPages / getOutline / getDestination / getPageIndex / getPage / getPageLabels),
 * 不碰宿主,check.mjs 拿假文档测。
 */
export interface TocItem {
  title: string
  /** 0 起。 */
  level: number
  /** 0 起的页序号。 */
  page: number
  /** 标题那一行顶边在 PDF 坐标里的 y(原点在页底);不知道就是 null,跳到页顶。 */
  top: number | null
}
export interface Toc { items: TocItem[]; source: 'bookmarks' | 'contents' | 'fonts' | 'none'; contentsPage?: number }

interface Line { text: string; x: number; y: number; size: number; end: number }

/** 一页的文字按行并好(同一基线 ± 两成字号)。上下标是另起的短行,不会混进标题。 */
async function readLines(pdf: any, i: number): Promise<Line[]> {
  const tc = await (await pdf.getPage(i + 1)).getTextContent()
  const rows: Line[] = []
  for (const it of tc.items as any[]) {
    const s: string = it.str ?? ''
    if (!s.trim()) continue
    const x = it.transform[4], y = it.transform[5], size = it.height || Math.hypot(it.transform[2], it.transform[3]) || 1
    // 挑最近的那一行;容差按两边较小的字号算,下标(l₀ 的「0」)才不会把后半句吸过去。
    let r: Line | undefined
    for (let k = rows.length - 1; k >= Math.max(0, rows.length - 4); k--) {
      const dy = Math.abs(rows[k].y - y)
      if (dy <= Math.max(1, Math.min(size, rows[k].size) * 0.15) && (!r || dy < Math.abs(r.y - y))) r = rows[k]
    }
    if (!r) { rows.push({ text: s, x, y, size, end: x + (it.width ?? 0) }); continue }
    // 字和字之间隔开了才补空格:中文的字常常一字一段,补了就成了「目 录」。
    r.text += (x - r.end > size * 0.2 && !r.text.endsWith(' ') && !s.startsWith(' ') ? ' ' : '') + s
    r.x = Math.min(r.x, x); r.end = Math.max(r.end, x + (it.width ?? 0)); r.size = Math.max(r.size, size)
  }
  for (const r of rows) r.text = r.text.replace(/\s+/g, ' ').trim()
  return rows
}

/** 只留字母(含汉字),用来在正文里认回目录里那一条。 */
const letters = (s: string): string => s.toLowerCase().replace(/[^\p{L}]/gu, '')
const hasWords = (s: string): boolean => (s.match(/\p{L}/gu)?.length ?? 0) >= 2

// ── ① 书签 ───────────────────────────────────────────────────────────────────────
async function fromBookmarks(pdf: any): Promise<TocItem[]> {
  const raw: any[] | null = await pdf.getOutline().catch(() => null)
  const out: TocItem[] = []
  const walk = async (list: any[], level: number): Promise<void> => {
    for (const it of list) {
      try {
        const d = typeof it.dest === 'string' ? await pdf.getDestination(it.dest) : it.dest
        if (Array.isArray(d)) {
          const page = typeof d[0] === 'number' ? d[0] : await pdf.getPageIndex(d[0])
          const kind = d[1]?.name
          const top = kind === 'XYZ' ? d[3] : kind === 'FitH' || kind === 'FitBH' ? d[2] : null
          out.push({ title: String(it.title || '').trim(), level: Math.min(level, 5), page, top: typeof top === 'number' ? top : null })
        }
      } catch { /* 指向不存在的页:跳过这一条 */ }
      if (it.items?.length) await walk(it.items, level + 1)
    }
  }
  if (raw?.length) await walk(raw, 0)
  return out
}

// ── ② 文档自带的目录页 ─────────────────────────────────────────────────────────────
const CONTENTS = /^(table of contents|contents|目\s*录|目\s*次)$/i
/** 「1.1 Introduction . . . . 3」→ 标题 + 印的页码(点线、省略号都当分隔)。 */
const ENTRY = /^(.*?\p{L}.*?)\s+(\d{1,4})$/u
const entryOf = (l: Line): { title: string; n: number } | null => {
  const m = ENTRY.exec(l.text.replace(/(\s*[.·…_](\s*[.·…_])+\s*)/g, ' ').trim())
  return m ? { title: m[1].trim(), n: Number(m[2]) } : null
}

async function fromContents(pdf: any, lines: (i: number) => Promise<Line[]>): Promise<{ items: TocItem[]; at: number } | null> {
  const n = pdf.numPages as number
  let at = -1
  for (let i = 0; i < Math.min(n, 15) && at < 0; i++) if ((await lines(i)).some((l) => CONTENTS.test(l.text))) at = i
  if (at < 0) return null
  // 目录可能跨好几页:往后读到某一页认不出三条为止。
  const raw: (Line & { title: string; n: number })[] = []
  let last = at
  for (let i = at; i < Math.min(n, at + 8); i++) {
    const got = (await lines(i)).map((l) => { const e = entryOf(l); return e && { ...l, ...e } }).filter((e): e is Line & { title: string; n: number } => !!e)
    if (i > at && got.length < 3) break
    raw.push(...got); last = i
  }
  if (raw.length < 3) return null
  // 分级按缩进:左边起点聚成几档(相差 4 个单位以内算同一档),第几档就是第几级。
  const cols: number[] = []
  for (const x of raw.map((e) => e.x).sort((a, b) => a - b)) if (!cols.length || x - cols[cols.length - 1] > 4) cols.push(x)
  const level = (x: number): number => Math.min(2, cols.filter((c) => c <= x + 4).length - 1)
  // 印的页码 → 第几页:书的正文常从第 5、第 11 页才开始印「1」。挑几条去那一页找标题行(整行基本就是这个标题,
  // 不是正文里顺带提到),对上最多的偏移就是;一样多取小的(页眉印着本章标题,偏大的偏移也会对上一些)。
  const sample = [...new Set([0, Math.floor(raw.length / 3), Math.floor((raw.length * 2) / 3), raw.length - 1])].map((k) => raw[k])
  const headOn = async (title: string, p: number): Promise<Line | undefined> => {
    const key = letters(title)
    if (key.length < 3 || p < 0 || p >= n || (p >= at && p <= last)) return undefined
    return (await lines(p)).find((l) => { const k = letters(l.text); return k.includes(key.slice(0, 24)) && k.length <= key.length + 12 })
  }
  let offset: number | null = null, best = 0
  for (let off = 0; off <= Math.min(60, n) && best < sample.length; off++) {
    let hit = 0
    for (const e of sample) if (await headOn(e.title, e.n - 1 + off)) hit++
    if (hit > best) { best = hit; offset = off }
  }
  if (offset == null || best < Math.min(2, sample.length)) return null
  const items: TocItem[] = []
  for (const e of raw) {
    const page = e.n - 1 + offset
    if (page < 0 || page >= n) continue
    const head = await headOn(e.title, page)
    items.push({ title: e.title, level: level(e.x), page, top: head ? head.y + head.size : null })
  }
  return items.length >= 3 ? { items, at } : null
}

// ── ③ 按字号推 ───────────────────────────────────────────────────────────────────
// ponytail: 只看前 400 页;更长的文档后面的标题不进目录,真遇到再分批读。
async function fromFonts(pdf: any, lines: (i: number) => Promise<Line[]>): Promise<TocItem[]> {
  const n = Math.min(pdf.numPages as number, 400)
  const pages: Line[][] = []
  const chars = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    const ls = await lines(i)
    pages.push(ls)
    for (const l of ls) { const s = Math.round(l.size * 2) / 2; chars.set(s, (chars.get(s) ?? 0) + l.text.length) }
  }
  if (!chars.size) return []
  const body = [...chars].sort((a, b) => b[1] - a[1])[0][0]
  // 每页都有的页眉页脚、书名不算标题。
  const seen = new Map<string, number>()
  for (const ls of pages) for (const k of new Set(ls.map((l) => letters(l.text)))) seen.set(k, (seen.get(k) ?? 0) + 1)
  type Cand = Line & { page: number }
  const cands: Cand[] = []
  pages.forEach((ls, page) => {
    for (const l of ls) {
      if (l.size < body * 1.22 || l.text.length > 120 || !hasWords(l.text) || (seen.get(letters(l.text)) ?? 0) > 2) continue
      // 同一页上紧挨着、同字号的两行是一个标题折了行(「Chapter 1」+「Special Relativity」)。
      const prev = cands[cands.length - 1]
      if (prev && prev.page === page && Math.abs(prev.size - l.size) < 0.5 && prev.y - l.y <= l.size * 1.8) { prev.text += ` ${l.text}`; prev.y = l.y; continue }
      cands.push({ ...l, page, end: l.y + l.size })
    }
  })
  const sizes = [...new Set(cands.map((c) => Math.round(c.size * 2) / 2))].sort((a, b) => b - a).slice(0, 2)
  let items = cands.filter((c) => sizes.includes(Math.round(c.size * 2) / 2))
    .map((c) => ({ title: c.text, level: sizes.indexOf(Math.round(c.size * 2) / 2), page: c.page, top: c.end }))
  if (items.length > 300) items = items.filter((i) => i.level === 0)
  return items
}

// ponytail: 只记最近 20 份,按指纹;重开同一份不再算。
const cache = new Map<string, Promise<Toc>>()

export function buildOutline(pdf: any): Promise<Toc> {
  const key = String(pdf.fingerprints?.[0] ?? '')
  const hit = key ? cache.get(key) : undefined
  if (hit) return hit
  const run = (async (): Promise<Toc> => {
    const memo = new Map<number, Promise<Line[]>>()
    const lines = (i: number): Promise<Line[]> => {
      let p = memo.get(i)
      if (!p) { p = readLines(pdf, i).catch(() => []); memo.set(i, p) }
      return p
    }
    const marks = await fromBookmarks(pdf)
    if (marks.length >= 2) return { items: marks, source: 'bookmarks' }
    const contents = await fromContents(pdf, lines)
    if (contents) return { items: contents.items, source: 'contents', contentsPage: contents.at }
    const fonts = await fromFonts(pdf, lines)
    if (fonts.length >= 2) return { items: fonts, source: 'fonts' }
    return marks.length ? { items: marks, source: 'bookmarks' } : { items: [], source: 'none' }
  })()
  if (key) {
    cache.set(key, run)
    if (cache.size > 20) cache.delete(cache.keys().next().value!)
    run.catch(() => cache.delete(key))
  }
  return run
}

/** 当前这一节:最后一个起点在视线之上的(页 + 页内高度;y 是 PDF 坐标,越大越靠上)。 */
export function currentIndex(items: TocItem[], page: number, y: number | null): number {
  let at = -1
  items.forEach((it, i) => { if (it.page < page || (it.page === page && (y == null || it.top == null || it.top >= y))) at = i })
  return at
}
