// 手写:笔迹就是宿主白板的元素(同一个引擎、同样的七支笔),经宿主的白板层接口(ctx.ui.mountBoard / boardToSvg)。
// 宿主没有这个接口时整块不出现(工具栏上没有「手写」「橡皮」)。
//
// 两种状态:
//  - 平时:每页一张静态 SVG(boardToSvg 出的),放在这一页的批注层里,跟着页面缩放。
//  - 手写 / 橡皮时:一块铺满视口的白板层盖在页面上,整份文档是它的一张连续画布 ——
//    第 p 页在画布上占 x ∈ [-宽/2, 宽/2]、y 从「前面各页的高 + 页间留白」累加起(单位 pt)。
//    页面怎么滚、怎么缩放,由我们算出白板的视口推给它(它自己不滚不缩),滚轮事件它原样交回来。
// 存盘时按页拆回去,存页内坐标(pt,y 向下),所以和缩放、窗口大小都无关。
import type { Reader } from './reader'
import { esc } from './reader'
import { t } from './i18n'

export const inkAvailable = (): boolean => !!(ctx.ui?.mountBoard && ctx.ui?.boardToSvg)

export const PENS: [string, string][] = [
  ['default', 'pencil'], ['finetip', 'pen-line'], ['fountain', 'feather'], ['marker', 'brush'],
  ['highlighter', 'highlighter'], ['thick-thin', 'pen-tool'], ['thin-thick-thin', 'slash'],
]
export const INK_COLORS = ['#1e1e1e', '#2b4acb', '#e03131', '#2f9e44', '#ffd43b']
/** 白板引擎的线宽档。 */
export const INK_WIDTHS = [0.5, 1, 2, 4]
/** 页间留白(pt)。和 style.css 里 --page-margin 的 9px 是同一个数,改一处要改两处。 */
const GAP = 9

/** 一个白板元素在画布上的竖直中心(自由画笔的 y 是起笔点,点列可以往上走,所以按点列算)。 */
function centerY(e: any): number {
  if (Array.isArray(e.points) && e.points.length) {
    let lo = Infinity, hi = -Infinity
    for (const p of e.points) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1] }
    return e.y + (lo + hi) / 2
  }
  return e.y + (e.height ?? 0) / 2
}
const sig = (els: any[] | undefined): string => (els ?? []).map((e) => `${e.id}:${e.version}`).join(',')

export class InkLayer {
  private handle: HostBoardHandle | null = null
  private mode: 'freedraw' | 'eraser' | null = null
  private pen = 'default'
  /** 每支笔记着用户给它挑的颜色 / 粗细;null = 用这支笔自己的。 */
  private readonly prefs: Record<string, { color: string | null; width: number | null }> = {}
  private readonly svgs = new Map<number, { el: HTMLElement; sig: string }>()
  private tops: number[] = []
  private widths: number[] = []
  private commitTimer: ReturnType<typeof setTimeout> | null = null
  private entering = 0

  constructor(private readonly r: Reader) {}

  private get pref(): { color: string | null; width: number | null } { return (this.prefs[this.pen] ??= { color: null, width: null }) }
  private get board(): HTMLElement { return this.r.root.querySelector('.pr-board') as HTMLElement }

  // ── 工具栏中段 ──
  toolbarHtml(btn: (act: string, ic: string, title: string, on?: boolean, v?: string) => string, sep: string): string {
    const pens = `<span class="pr-penrow">${PENS.map(([id, ic]) => btn('pen', ic, t(`pen.${id}`), this.pen === id, id)).join('')}</span>`
    const widths = `<span class="pr-widths" role="group" aria-label="${esc(t('tool.width'))}">${INK_WIDTHS.map((w, i) =>
      `<button class="pr-width${this.pref.width === w ? ' on' : ''}" data-act="ink-width" data-v="${w}" style="--d:${4 + i * 2.5}px" title="${w}" aria-label="${esc(t('tool.width'))} ${w}"></button>`).join('')}</span>`
    return pens + sep + this.r.dotsHtml(this.pref.color, 'ink-color', INK_COLORS) + sep + widths + sep +
      btn('undo', 'undo-2', t('tool.undo')) + btn('redo', 'redo-2', t('tool.redo'))
  }
  setPen(id: string): void { this.pen = id; this.pushStyle() }
  setColor(c: string): void { this.pref.color = c; this.pushStyle() }
  setWidth(w: number): void { this.pref.width = w; this.pushStyle() }
  private pushStyle(): void {
    this.handle?.update({ pen: this.pen, strokeColor: this.pref.color ?? undefined, strokeWidth: this.pref.width ?? undefined })
  }
  undo(): void { this.handle?.undo() }
  redo(): void { this.handle?.redo() }

  // ── 平时:每页一张静态 SVG ──
  onDocReady(): void { /* 静态图在各页渲染出来时再画(onPageRendered) */ }

  onPageRendered(page: number): void { void this.renderPage(page) }

  private async renderPage(page: number): Promise<void> {
    const els = this.r.doc?.data.ink[page]
    const s = sig(els)
    let cur = this.svgs.get(page)
    if (!els?.length) { cur?.el.remove(); this.svgs.delete(page); return }
    if (!cur || cur.sig !== s) {
      const out = await ctx.ui!.boardToSvg!({ elements: els }, { theme: 'light', padding: 4 }).catch((e) => { console.error('[pdf-reader] 笔迹出图失败', e); return null })
      if (!out || sig(this.r.doc?.data.ink[page]) !== s) return // 出图期间又改了:让后一次来画
      const box = document.createElement('div')
      box.className = 'pr-ink'
      box.style.cssText = `--x:${out.x.toFixed(2)};--y:${out.y.toFixed(2)};--w:${out.width.toFixed(2)}`
      out.svg.setAttribute('width', '100%')
      out.svg.removeAttribute('height')
      out.svg.style.display = 'block'
      box.append(out.svg)
      this.svgs.get(page)?.el.remove()
      cur = { el: box, sig: s }
      this.svgs.set(page, cur)
      this.r.emit() // 右栏列表里这一页的小图有了
    }
    const layer = this.r.layerOf(page, false)
    if (layer && cur.el.parentNode !== layer) layer.append(cur.el)
  }

  /** 列表里的小图:这一页笔迹的静态图(没画出来过就没有)。 */
  thumb(page: number): string { return this.svgs.get(page)?.el.innerHTML ?? '' }

  // ── 手写 / 橡皮:白板层 ──
  setMode(mode: 'freedraw' | 'eraser' | null): void {
    if (mode === this.mode) return
    this.mode = mode
    if (!mode) { this.leave(); return }
    if (this.handle) { this.handle.update({ tool: mode }); return }
    void this.enter()
  }

  /** 页在连续画布上的位置。全部页的尺寸到齐之后才算(页大小不一的文档,晚到的尺寸会挪动后面各页)。 */
  private origin(page: number): { x: number; y: number } { return { x: -(this.widths[page] ?? 0) / 2, y: this.tops[page] ?? 0 } }
  private pageOfY(y: number): number {
    let p = 0
    while (p + 1 < this.tops.length && y >= this.tops[p + 1]) p++
    return p
  }

  private async enter(): Promise<void> {
    const r = this.r, token = ++this.entering
    await r.viewer.pagesPromise?.catch(() => {})
    if (token !== this.entering || !this.mode || !r.doc || this.handle) return
    this.tops = []; this.widths = []
    let y = 0
    for (let p = 0; p < r.pageCount; p++) {
      // ponytail: 没算 UserUnit ≠ 1 的页(极少见的超大幅面 PDF),那种页上笔迹位置会按比例偏;真遇到再乘上它。
      const vp = r.viewer.getPageView(p).viewport
      this.tops.push(y); this.widths.push(vp.width / vp.scale)
      y += vp.height / vp.scale + GAP
    }
    const elements: any[] = []
    for (const [p, list] of Object.entries(r.doc.data.ink)) {
      const o = this.origin(Number(p))
      for (const e of list) elements.push({ ...e, x: e.x + o.x, y: e.y + o.y })
    }
    this.board.hidden = false
    r.root.classList.add('pr-inking')
    this.handle = ctx.ui!.mountBoard!(this.board, {
      scene: { elements }, viewport: this.viewport(), tool: this.mode, theme: 'light',
      pen: this.pen, strokeColor: this.pref.color ?? undefined, strokeWidth: this.pref.width ?? undefined,
      onChange: () => { if (!this.commitTimer) this.commitTimer = setTimeout(() => this.commit(), 300) }, // 落笔时每一帧都来,攒一下
      onWheel: (ev) => {
        if (ev.ctrlKey || ev.metaKey) r.onWheel(ev)
        else r.container.scrollBy(ev.deltaX, ev.deltaY)
      },
    })
  }

  /** 白板的视口:让「当前页」在白板上的位置和它在屏幕上的位置逐像素对上(相邻页最多差不到 1px 的取整)。 */
  private viewport(): HostBoardViewport {
    const r = this.r, page = Math.max(0, r.page - 1)
    const pv = r.viewer.getPageView(page)
    const zoom = pv?.viewport.scale || 1
    const div: HTMLElement | undefined = pv?.div
    if (!div) return { scrollX: 0, scrollY: 0, zoom }
    const pr = div.getBoundingClientRect(), br = this.board.getBoundingClientRect()
    const k = this.board.offsetWidth ? br.width / this.board.offsetWidth : 1 // 界面整体缩放:客户区像素 / CSS 像素
    const o = this.origin(page)
    return { zoom, scrollX: (pr.left - br.left) / k / zoom + div.clientLeft / zoom - o.x, scrollY: (pr.top - br.top) / k / zoom + div.clientTop / zoom - o.y }
  }

  syncViewport(): void { if (this.handle) this.handle.update({ viewport: this.viewport() }) }

  /** 白板上的元素按页拆回去,存页内坐标。 */
  private commit(): void {
    if (this.commitTimer) clearTimeout(this.commitTimer)
    this.commitTimer = null
    const doc = this.r.doc
    if (!this.handle || !doc) return
    const ink: Record<string, any[]> = {}
    for (const e of this.handle.getScene().elements) {
      const p = this.pageOfY(centerY(e)), o = this.origin(p)
      ;(ink[p] ??= []).push({ ...e, x: e.x - o.x, y: e.y - o.y })
    }
    if (Object.keys(ink).length === Object.keys(doc.data.ink).length && Object.entries(ink).every(([p, l]) => sig(l) === sig(doc.data.ink[p]))) return
    doc.data.ink = ink
    doc.changed()
  }

  private leave(): void {
    this.entering++
    if (!this.handle) return
    this.commit()
    this.handle.dispose()
    this.handle = null
    this.board.hidden = true
    this.board.replaceChildren()
    this.r.root.classList.remove('pr-inking')
    for (const p of new Set([...this.svgs.keys(), ...Object.keys(this.r.doc?.data.ink ?? {}).map(Number)])) void this.renderPage(p)
  }

  dispose(): void {
    this.mode = null
    this.leave()
    for (const s of this.svgs.values()) s.el.remove()
    this.svgs.clear()
  }
}
