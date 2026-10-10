// 批注的存取:每份 PDF 一个旁挂文件,和 PDF 放在同一个文件夹(点开头,文件树里不显示),PDF 本身一个字节不动。
// 坐标一律存 PDF 用户空间(pt,y 向上),所以缩放、换设备都对得上;手写按页存白板元素原样(页内 pt,y 向下)。
import { t } from './i18n'

export type AnnotType = 'highlight' | 'underline' | 'strike' | 'note' | 'text' | 'area'

export interface Annot {
  id: string
  type: AnnotType
  /** 页序号,从 0 起。 */
  page: number
  color: string
  /** highlight / underline / strike:每行一条 [x1,y1(左上), x2,y2(右上), x3,y3(左下), x4,y4(右下)]。 */
  quads?: number[][]
  /** note(图标左上角,x0=x1、y0=y1)/ text(左上角)/ area:[x0, y0, x1, y1]。 */
  rect?: [number, number, number, number]
  /** 划到的原文;text 类型是用户写在页面上的那段字。 */
  text?: string
  comment?: string
  tags?: string[]
  created: string
  modified: string
}

export interface Sidecar {
  version: 1
  /** pdf.js 给的文档指纹:PDF 改名 / 挪走之后凭它把批注认回来。 */
  fingerprint: string
  /** 这份 PDF 的读书笔记路径(第一次引用时定下,之后不随界面语言变)。 */
  note?: string
  annots: Annot[]
  /** 页序号 → 白板元素(手写)。 */
  ink: Record<string, any[]>
}

const VERSION = 1
const enc = new TextEncoder()
const dec = new TextDecoder()

export const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
export const baseOf = (p: string): string => p.split('/').pop() || p
export const stemOf = (p: string): string => baseOf(p).replace(/\.pdf$/i, '')
export const sidecarOf = (pdfPath: string): string => `${dirOf(pdfPath) ? `${dirOf(pdfPath)}/` : ''}.${baseOf(pdfPath)}.annot.json`
export const newId = (): string => crypto.randomUUID().slice(0, 8)

const blank = (fingerprint: string): Sidecar => ({ version: VERSION, fingerprint, annots: [], ink: {} })
const isEmpty = (d: Sidecar): boolean => !d.annots.length && !d.note && !Object.values(d.ink).some((a) => a.length)
const readText = async (p: string): Promise<string | null> => { const b = await ctx.app.readBytes!(p); return b ? dec.decode(b) : null }
/** 读不成批注的(坏 JSON / 形状不对)→ null。 */
function parse(text: string): Partial<Sidecar> | null {
  try {
    const d = JSON.parse(text)
    return d && typeof d === 'object' && Array.isArray(d.annots) ? d : null
  } catch { return null }
}

/** 三方合并一组带 id 的条目:base = 上次盘上那份,ours = 内存里的,theirs = 盘上现在的(别的窗口写的)。
 *  两边各自新加的都留;一边删了另一边没动的 → 删;两边都改了同一条 → 留我们的。 */
function merge3<T>(base: T[], ours: T[], theirs: T[], id: (x: T) => string, stamp: (x: T) => string): T[] {
  const b = new Map(base.map((x) => [id(x), x])), o = new Set(ours.map(id)), th = new Map(theirs.map((x) => [id(x), x]))
  const out: T[] = []
  for (const x of ours) {
    const bx = b.get(id(x)), tx = th.get(id(x)), mine = !bx || stamp(bx) !== stamp(x) // 我们新加的 / 改过的
    if (tx) out.push(mine ? x : tx)
    else if (mine) out.push(x)
  }
  for (const x of theirs) if (!o.has(id(x)) && !b.has(id(x))) out.push(x)
  return out
}
type Ink = { page: string; el: any }
const inkList = (ink: Record<string, any[]> | undefined): Ink[] => Object.entries(ink ?? {}).flatMap(([page, els]) => (Array.isArray(els) ? els : []).map((el) => ({ page, el })))
function mergeSidecar(base: Partial<Sidecar> | null, ours: Sidecar, theirs: Partial<Sidecar>): Sidecar {
  const ink: Record<string, any[]> = {}
  for (const { page, el } of merge3(inkList(base?.ink), inkList(ours.ink), inkList(theirs.ink), (x) => String(x.el?.id), (x) => `${x.page}:${x.el?.version}:${x.el?.x}:${x.el?.y}`)) (ink[page] ??= []).push(el)
  return {
    version: VERSION, fingerprint: ours.fingerprint, note: ours.note ?? theirs.note, ink,
    annots: merge3(base?.annots ?? [], ours.annots, theirs.annots ?? [], (a) => a.id, (a) => a.modified),
  }
}

// 指纹 → 上次见到它的旁挂文件路径(存在插件自己的数据里):PDF 改名 / 挪走后按它把批注带过来。
let seen: Record<string, string> | null = null
async function seenMap(): Promise<Record<string, string>> {
  if (!seen) seen = ((await ctx.loadData?.<{ seen?: Record<string, string> }>().catch(() => null))?.seen) ?? {}
  return seen
}
async function remember(fingerprint: string, path: string): Promise<void> {
  const m = await seenMap()
  if (m[fingerprint] === path) return
  m[fingerprint] = path
  await ctx.saveData?.({ seen: m }).catch(() => {})
}

/** 一份打开着的 PDF 的批注。同一份 PDF 开在两个标签里时共用同一个对象(各写各的会互相盖掉);
 *  开在两个窗口里是两个对象,靠写之前「再读一遍、不一样就合并」不互相盖。 */
export class AnnotDoc {
  data: Sidecar
  refs = 0
  /** 只读,不落盘:这份批注是更新版本的插件写的,或者盘上那份读不出来又没能另存。 */
  readonly = false
  /** 内存里有还没写到盘上的改动。写成功才清;写失败留着,下次 flush(含关标签时)再试。 */
  dirty = false
  private subs = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()
  /** 盘上那份的原文(上次读到 / 写下的);null = 盘上没有。 */
  private disk: string | null = null
  private warned = false
  readonly path: string

  constructor(readonly pdfPath: string, fingerprint: string) {
    this.path = sidecarOf(pdfPath)
    this.data = blank(fingerprint)
  }

  private take(d: Partial<Sidecar>): void {
    if ((d.version ?? 1) > VERSION && !this.readonly) { this.readonly = true; ctx.notify?.(t('save.newer'), { level: 'warning' }) }
    this.data = { version: VERSION, fingerprint: this.data.fingerprint, note: d.note, annots: d.annots ?? [], ink: d.ink && typeof d.ink === 'object' ? d.ink : {} }
  }

  async load(): Promise<void> {
    const bytes = await ctx.app.readBytes!(this.path)
    if (!bytes) {
      // 没有旁挂文件:这份 PDF 可能是改了名 / 挪了位置,按指纹找上次的那份带过来(原处那份留着不动)。
      // 认领前核指纹:那个路径现在可能已经是别的 PDF 的批注。
      const old = (await seenMap())[this.data.fingerprint]
      const d = old && old !== this.path ? parse((await readText(old)) ?? '') : null
      if (d && d.fingerprint === this.data.fingerprint) { this.take(d); this.changed() } // 在新位置落一份;落成了才改记的路径(write 里)
      return
    }
    this.disk = dec.decode(bytes)
    const d = parse(this.disk)
    // ponytail: 同一路径上指纹对不上(PDF 被重新保存 / 换了一版)照样带上批注 —— 换版后批注不见了更糟;真换成了另一篇文档,位置会对不上,由用户自己删。
    if (d) { this.take(d); void remember(this.data.fingerprint, this.path); return }
    // 读不出来的文件绝不覆盖:原样另存一份,再从空白开始;另存不成就整份只读,原件留着不动。
    const keep = `${this.path}.broken-${Date.now()}`
    try {
      await ctx.app.writeBytes!(keep, bytes)
      ctx.notify?.(t('save.broken', { name: baseOf(keep) }), { level: 'warning' })
    } catch {
      this.readonly = true
      ctx.notify?.(t('save.brokenStuck'), { level: 'error' })
    }
  }

  subscribe(cb: () => void): () => void {
    this.subs.add(cb)
    return () => { this.subs.delete(cb) }
  }

  /** 改完 data 之后调:通知界面重画,并安排落盘。 */
  changed(): void {
    for (const cb of [...this.subs]) cb()
    if (this.readonly) return
    this.dirty = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), 400)
  }

  /** 立刻落盘(关标签时也调)。写入排队,不并发。 */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.dirty && !this.readonly) this.writing = this.writing.then(() => this.write())
    return this.writing
  }

  private async write(): Promise<void> {
    if (!this.dirty || this.readonly) return
    try {
      // 写之前再读一遍:和上次不一样 = 别的窗口写过(或者上次没读到)→ 把那边的并进来再写,不整份盖掉。
      const now = await readText(this.path)
      if (now != null && now !== this.disk) {
        const theirs = parse(now)
        if (!theirs) throw new Error('盘上的批注文件现在读不出来,不覆盖')
        if ((theirs.version ?? 1) > VERSION) { this.take(theirs); for (const cb of [...this.subs]) cb(); return }
        this.data = mergeSidecar(this.disk == null ? null : parse(this.disk), this.data, theirs)
        for (const cb of [...this.subs]) cb()
      }
      this.disk = now
      if (now == null && isEmpty(this.data)) { this.dirty = false; return } // 没批注过的 PDF 不留空文件
      const text = JSON.stringify(this.data, null, 1)
      this.dirty = false // 写的途中再改会重新标脏
      await ctx.app.writeBytes!(this.path, enc.encode(text))
      this.disk = text
      this.warned = false
      void remember(this.data.fingerprint, this.path)
    } catch (e) {
      this.dirty = true
      console.error('[pdf-reader] 批注没能保存', e)
      if (!this.warned) { this.warned = true; ctx.notify?.(t('save.failed'), { level: 'error' }) }
    }
  }

  /** 窗口要关 / 插件要停:等不了「读一遍再合并」,把内存里这份直接写下去(调用同步发出,不等结果)。 */
  flushNow(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (!this.dirty || this.readonly || (this.disk == null && isEmpty(this.data))) return
    const text = JSON.stringify(this.data, null, 1)
    this.dirty = false
    void ctx.app.writeBytes!(this.path, enc.encode(text)).then(() => { this.disk = text }, () => { this.dirty = true })
  }

  add(a: Omit<Annot, 'id' | 'created' | 'modified'>): Annot {
    const now = new Date().toISOString()
    const full: Annot = { ...a, id: newId(), created: now, modified: now }
    this.data.annots.push(full)
    this.changed()
    void this.flush() // 新加 / 删除是一下子的事,马上写;改评论、打标签这类连续的才攒 0.4 秒
    return full
  }

  patch(id: string, p: Partial<Annot>): void {
    const a = this.data.annots.find((x) => x.id === id)
    if (!a) return
    Object.assign(a, p, { modified: new Date().toISOString() })
    this.changed()
  }

  remove(id: string): void { this.removeMany([id]) }

  /** 一次删几条(橡皮扫过、框选后按删除),返回删掉的那些,留给撤销。 */
  removeMany(ids: string[]): Annot[] {
    const gone: Annot[] = []
    for (let i = this.data.annots.length - 1; i >= 0; i--) if (ids.includes(this.data.annots[i].id)) gone.unshift(...this.data.annots.splice(i, 1))
    if (!gone.length) return gone
    this.changed()
    void this.flush()
    return gone
  }

  /** 撤销删除:原样放回(id 不变;已经在的不重复放)。改动时间记成现在,别的窗口并进来时才认它是新的。 */
  restore(list: Annot[]): void {
    const have = new Set(this.data.annots.map((a) => a.id)), now = new Date().toISOString()
    const back = list.filter((a) => !have.has(a.id))
    if (!back.length) return
    this.data.annots.push(...back.map((a) => ({ ...a, modified: now })))
    this.changed()
    void this.flush()
  }

  /** 按阅读顺序:先页码,再从上到下(PDF 的 y 向上,所以 y 大的在前)。 */
  sorted(): Annot[] {
    const top = (a: Annot): number => (a.quads?.length ? Math.max(...a.quads.map((q) => q[1])) : a.rect ? Math.max(a.rect[1], a.rect[3]) : 0)
    return [...this.data.annots].sort((a, b) => a.page - b.page || top(b) - top(a))
  }
}

const open = new Map<string, Promise<AnnotDoc>>()
const live = new Set<AnnotDoc>()

export function acquire(pdfPath: string, fingerprint: string): Promise<AnnotDoc> {
  let p = open.get(pdfPath)
  if (!p) {
    p = (async () => { const d = new AnnotDoc(pdfPath, fingerprint); await d.load(); live.add(d); return d })()
    open.set(pdfPath, p)
    p.catch(() => open.delete(pdfPath))
  }
  return p.then((d) => { d.refs++; return d })
}

export function release(doc: AnnotDoc): void {
  doc.refs--
  // 等落盘写完再放手:马上重开同一份 PDF 时,不能读到还没写完的旧文件。
  // 放手前再核一遍:期间又被打开过、又有新改动、或者没存上的,都留着(没存上的留在内存里,重开还在)。
  const done = (): void => void open.get(doc.pdfPath)?.then((d) => {
    if (d !== doc || doc.refs > 0 || doc.dirty) return
    open.delete(doc.pdfPath)
    live.delete(doc)
  })
  void doc.flush().then(done, done)
}

/** 窗口退到后面:不等 0.4 秒,现在就写(照常先读一遍、有别的窗口写过就合并)。 */
export function flushAll(): void {
  for (const d of live) void d.flush()
}

/** 窗口要关 / 插件要停:把所有还没落盘的批注直接写掉。
 *  ponytail: 这一写不合并(来不及读);两个窗口开着同一份 PDF、一边刚改完 0.4 秒内就关窗,才会盖掉另一边没并进来的改动。 */
export function flushAllNow(): void {
  for (const d of live) d.flushNow()
}
