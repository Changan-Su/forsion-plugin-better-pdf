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

/** 一份打开着的 PDF 的批注。同一份 PDF 开在两个标签里时共用同一个对象(各写各的会互相盖掉)。 */
export class AnnotDoc {
  data: Sidecar
  refs = 0
  /** 这份批注是更新版本的插件写的:只读,不落盘。 */
  readonly = false
  private subs = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()
  private onDisk = false
  private warned = false
  readonly path: string

  constructor(readonly pdfPath: string, fingerprint: string) {
    this.path = sidecarOf(pdfPath)
    this.data = blank(fingerprint)
  }

  async load(): Promise<void> {
    const read = ctx.app.readBytes!
    let bytes = await read(this.path)
    if (!bytes) {
      // 没有旁挂文件:这份 PDF 可能是改了名 / 挪了位置,按指纹找上次的那份带过来(原处那份留着不动)。
      const old = (await seenMap())[this.data.fingerprint]
      if (old && old !== this.path) bytes = await read(old)
    } else this.onDisk = true
    if (bytes) {
      try {
        const d = JSON.parse(dec.decode(bytes)) as Partial<Sidecar>
        if (!d || typeof d !== 'object' || !Array.isArray(d.annots)) throw new Error('shape')
        if ((d.version ?? 1) > VERSION) { this.readonly = true; ctx.notify?.(t('save.newer'), { level: 'warning' }) }
        this.data = { version: VERSION, fingerprint: this.data.fingerprint, note: d.note, annots: d.annots, ink: d.ink && typeof d.ink === 'object' ? d.ink : {} }
        if (!this.onDisk) this.changed() // 认回来的:在新位置落一份
      } catch {
        // 读不出来的文件绝不覆盖:原样另存一份,再从空白开始。
        const keep = `${this.path}.broken-${Date.now()}`
        await ctx.app.writeBytes!(keep, bytes).catch(() => {})
        ctx.notify?.(t('save.broken', { name: baseOf(keep) }), { level: 'warning' })
        this.onDisk = false
      }
    }
    void remember(this.data.fingerprint, this.path)
  }

  subscribe(cb: () => void): () => void {
    this.subs.add(cb)
    return () => { this.subs.delete(cb) }
  }

  /** 改完 data 之后调:通知界面重画,并安排落盘。 */
  changed(): void {
    for (const cb of [...this.subs]) cb()
    if (this.readonly) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), 400)
  }

  /** 立刻落盘(关标签、停用插件时调)。写入排队,不并发。 */
  flush(): Promise<void> {
    if (!this.timer) return this.writing
    clearTimeout(this.timer)
    this.timer = null
    if (!this.onDisk && isEmpty(this.data)) return this.writing // 没批注过的 PDF 不留空文件
    const bytes = enc.encode(JSON.stringify(this.data, null, 1))
    this.writing = this.writing.then(() => ctx.app.writeBytes!(this.path, bytes)).then(
      () => { this.onDisk = true; this.warned = false },
      (e) => {
        console.error('[pdf-reader] 批注没能保存', e)
        if (!this.warned) { this.warned = true; ctx.notify?.(t('save.failed'), { level: 'error' }) }
      },
    )
    return this.writing
  }

  add(a: Omit<Annot, 'id' | 'created' | 'modified'>): Annot {
    const now = new Date().toISOString()
    const full: Annot = { ...a, id: newId(), created: now, modified: now }
    this.data.annots.push(full)
    this.changed()
    return full
  }

  patch(id: string, p: Partial<Annot>): void {
    const a = this.data.annots.find((x) => x.id === id)
    if (!a) return
    Object.assign(a, p, { modified: new Date().toISOString() })
    this.changed()
  }

  remove(id: string): void {
    const i = this.data.annots.findIndex((x) => x.id === id)
    if (i < 0) return
    this.data.annots.splice(i, 1)
    this.changed()
  }

  /** 按阅读顺序:先页码,再从上到下(PDF 的 y 向上,所以 y 大的在前)。 */
  sorted(): Annot[] {
    const top = (a: Annot): number => (a.quads?.length ? Math.max(...a.quads.map((q) => q[1])) : a.rect ? Math.max(a.rect[1], a.rect[3]) : 0)
    return [...this.data.annots].sort((a, b) => a.page - b.page || top(b) - top(a))
  }
}

const open = new Map<string, Promise<AnnotDoc>>()

export function acquire(pdfPath: string, fingerprint: string): Promise<AnnotDoc> {
  let p = open.get(pdfPath)
  if (!p) {
    p = (async () => { const d = new AnnotDoc(pdfPath, fingerprint); await d.load(); return d })()
    open.set(pdfPath, p)
    p.catch(() => open.delete(pdfPath))
  }
  return p.then((d) => { d.refs++; return d })
}

export function release(doc: AnnotDoc): void {
  doc.refs--
  // 等这次落盘写完再放手:马上重开同一份 PDF 时,不能读到还没写完的旧文件。
  void doc.flush().finally(() => { if (doc.refs <= 0) open.delete(doc.pdfPath) })
}

/** 停用 / 重载插件时:把所有还没落盘的批注写掉。 */
export function flushAll(): void {
  for (const p of open.values()) void p.then((d) => d.flush(), () => {})
}
