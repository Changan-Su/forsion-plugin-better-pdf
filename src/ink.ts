// 手写与形状:笔迹、方框、圆、箭头、直线都是宿主白板的元素(同一个引擎、同样的七支笔),经宿主的白板层接口
// (ctx.ui.mountBoard / boardToSvg)。宿主没有这个接口时整块不出现(工具栏上没有「手写」「形状」「橡皮」)。
//
// 同一份笔迹有两种画法:
//  - 每页一张静态 SVG(boardToSvg 出的),放在这一页的批注层里,跟着页面滚动和缩放,一帧不差。
//  - 一块铺满视口的白板层盖在页面上,整份文档是它的一张连续画布 ——
//    第 p 页在画布上占 x ∈ [-宽/2, 宽/2]、y 从「前面各页的高 + 页间留白」累加起(单位 pt)。
//    页面怎么滚、怎么缩放,由我们算出白板的视口推给它(它自己不滚不缩),滚轮事件它原样交回来。
// 文档里有笔迹、或者正在用手写 / 形状 / 橡皮时白板层就挂着:画、擦、点选、拖动、缩放、框选都是引擎自己的。
// 页面静止时看到的是白板层(静态图藏着);页面在滚的那一阵换回静态图 —— 白板层是脚本跟着滚动事件推的,会慢一帧。
// 存盘时按页拆回去,存页内坐标(pt,y 向下),所以和缩放、窗口大小都无关。
import type { Reader } from './reader'
import { esc } from './reader'
import { t } from './i18n'
import { validNewShape } from './toolSession'
import { boundsOf, hits } from './geom'
import { isShape, shapeNote, withShapeNote, type ShapeStyle, type ShapeEdit, visualBoundsOf } from './shape'

export const inkAvailable = (): boolean => !!(ctx.ui?.mountBoard && ctx.ui?.boardToSvg)

export const PENS: [string, string][] = [
  ['default', 'pencil'], ['finetip', 'pen-line'], ['fountain', 'feather'], ['marker', 'brush'],
  ['highlighter', 'highlighter'], ['thick-thin', 'pen-tool'], ['thin-thick-thin', 'slash'],
]
export const SHAPES: [HostBoardShape, string][] = [['rectangle', 'square'], ['ellipse', 'circle'], ['arrow', 'move-up-right'], ['line', 'minus']]
export const INK_COLORS = ['#1e1e1e', '#2b4acb', '#e03131', '#2f9e44', '#ffd43b']
/** 白板引擎的线宽档。 */
export const INK_WIDTHS = [0.5, 1, 2, 4]
/** 页间留白(pt)。和 style.css 里 --page-margin 的 9px 是同一个数,改一处要改两处。 */
const GAP = 9
/** 选择工具下,离字这么近(客户区像素)的空白仍然算「在选字」:从行间、行首左边一点起拖是选字,不是框选。 */
const NEAR_TEXT_X = 24, NEAR_TEXT_Y = 10
/** 点中一条线的容差、选中之后外框多让出来的一圈(客户区像素)。 */
const HIT = 6, FRAME = 14
/** 给引擎留出画一帧的时间(毫秒),之后才把它露出来。 */
const SETTLE = 60

const centerY = (e: any): number => { const b = boundsOf(e); return (b[1] + b[3]) / 2 }
const sig = (els: any[] | undefined): string => (els ?? []).map((e) => `${e.id}:${e.version}:${e.versionNonce ?? 0}`).join(',')
const sigAll = (ink: Record<string, any[]> | undefined): string => Object.keys(ink ?? {}).sort().map((p) => `${p}=${sig(ink![p])}`).join(';')

export class InkLayer {
  private handle: HostBoardHandle | null = null
  /** 阅读器当前的工具落到白板层上:画(手写 / 形状 / 橡皮,指针全归它)、选(跟着悬停改道,见 hover)、不归它管(摆着看)。 */
  private role: 'draw' | 'select' | 'idle' = 'select'
  private tool: HostBoardTool = 'selection'
  private shaping = false
  private pen = 'default'
  private shape: HostBoardShape = 'rectangle'
  private roundness: 'sharp' | 'round' = 'sharp'
  private shapeGesture: { pointer: number; ids: Set<string>; ended: boolean; x: number; y: number } | null = null
  /** 每支笔记着用户给它挑的颜色 / 粗细;null = 用这支笔自己的。形状另记一份。 */
  private readonly prefs: Record<string, { color: string | null; width: number | null }> = {}
  private readonly shapePref: { color: string | null; width: number | null } = { color: INK_COLORS[2], width: 1 } // 形状的线宽引擎按两倍算:1 档画出来是 2pt
  /** html:右栏小图用的那份序列化(第一次要时才做,之后原样给);rev:换过一次图就加一,右栏凭它判断要不要重画。 */
  private readonly svgs = new Map<number, { el: HTMLElement; svg: SVGSVGElement; url: string; sig: string; html?: string; rev: number }>()
  private svgRev = 0
  /** 关掉之后还在出图的那一份回来时直接丢掉(不然建出的图片地址没人回收)。 */
  private disposed = false
  private tops: number[] = []
  private widths: number[] = []
  private commitTimer: ReturnType<typeof setTimeout> | null = null
  private scrollTimer: ReturnType<typeof setTimeout> | null = null
  private entering = 0
  /** 白板上有还没收进数据的改动。没动过的白板绝不提交(它手里可能是别的标签改之前的旧快照)。 */
  private dirty = false
  /** 白板手里那份笔迹的签名(挂上 / 提交 / 外面推进来时记)。 */
  private held = ''
  /** 从上次 take() 到现在,笔迹变过没有。 */
  private moved = false
  /** 我们以为引擎选中着的那几个(按自己看到的点选 / 框选记的,接口上问不到引擎)。只用来把它们外框那一圈也让给白板层,让缩放柄够得着。 */
  private readonly picked = new Set<string>()
  private clearPickTimer: ReturnType<typeof setTimeout> | null = null
  /** 选择工具下点过白板层:引擎那边可能选着东西。 */
  private touched = false
  /** 抬笔就收:不等下面那个 300ms 的攒批(引擎收尾这一笔时再变一次,由攒批补上)。
   *  不看 dirty:画得快时引擎的变化回调还没来得及报(实测一笔画完才报),而能在这块板上抬笔,它手里就不是旧快照。 */
  /** 按在白板层上、还没抬起的指针。按着的时候不收数据(引擎每一帧都报变化,收一次要扫全部笔迹 + 通知一圈),抬笔再收。
   *  抬起 / 取消 / 窗口失焦 / 换工具都会清掉,不会卡住。 */
  private readonly downs = new Set<number>()
  private readonly onDown = (ev: PointerEvent): void => {
    // 缩放刚停、白板层还透明着:引擎手里的视口是缩放前的,这一下交给它会画歪。先推视口露出来,这一下不给它(抬笔再落就是对的)。
    // 带悬停的笔在落下之前就把它叫醒了(reader 的 onPressMove),走不到这里。
    if (this.wake()) { ev.preventDefault(); ev.stopImmediatePropagation(); return }
    if (this.role === 'draw') this.downs.add(ev.pointerId)
    if (!this.shaping || this.role !== 'draw' || !this.handle || ev.button !== 0) return
    const ids = (this.shape === 'line' || this.shape === 'arrow') && this.shapeGesture ? this.shapeGesture.ids : new Set(this.handle.getScene().elements.map(e => e.id))
    this.shapeGesture = { pointer: ev.pointerId, ids, ended: false, x: ev.clientX, y: ev.clientY }
  }
  private readonly onCancel = (ev: PointerEvent): void => { this.shapeGesture = null; this.downs.delete(ev.pointerId); this.schedule() }
  private readonly onBlur = (): void => { this.downs.clear(); this.schedule() }
  private readonly onUp = (ev: PointerEvent): void => {
    const was = this.downs.delete(ev.pointerId)
    if (!this.owns(ev.target) && this.shapeGesture?.pointer !== ev.pointerId) { if (was) this.schedule(); return }
    if (this.shapeGesture?.pointer === ev.pointerId) {
      const linear = this.shape === 'line' || this.shape === 'arrow'
      this.shapeGesture.ended = !linear || Math.hypot(ev.clientX - this.shapeGesture.x, ev.clientY - this.shapeGesture.y) >= 2
    }
    this.dirty = true; this.commit()
    setTimeout(() => { this.finishShape(); }, 0)
  }
  private readonly onFinalize = (ev: Event): void => {
    if (!this.shapeGesture || !this.shaping || (this.shape !== 'line' && this.shape !== 'arrow')) return
    if (ev instanceof KeyboardEvent && ev.key !== 'Enter') return
    this.shapeGesture.ended = true
    setTimeout(() => this.finishShape(), 0)
  }
  private finishShape(): void {
    const gesture = this.shapeGesture
    if (!gesture?.ended || !this.handle || !this.shaping) return
    if (!this.handle.getScene().elements.some(e => validNewShape(e, gesture.ids))) return
    this.shapeGesture = null
    this.dirty = true; this.commit()
    this.r.completeTool('shape')
  }
  /** 指针最后在哪(客户区)。页面滚完之后指针底下换了东西,要按它重判一次归谁。 */
  private last: [number, number] | null = null

  constructor(private readonly r: Reader) {
    this.board.addEventListener('pointerdown', this.onDown, true)
    this.board.addEventListener('dblclick', this.onFinalize, true)
    this.board.addEventListener('keydown', this.onFinalize, true)
    window.addEventListener('pointerup', this.onUp, true)
    window.addEventListener('pointercancel', this.onCancel, true)
    window.addEventListener('blur', this.onBlur)
  }

  /** 攒一下再收(引擎给一笔收尾、键盘挪动这类不经抬笔的变化)。笔还按着就不排,抬笔时再排。 */
  private schedule(): void {
    if (this.dirty && !this.commitTimer && !this.downs.size) this.commitTimer = setTimeout(() => { this.commit(false); this.finishShape() }, 300)
  }

  private get pref(): { color: string | null; width: number | null } { return this.shaping ? this.shapePref : (this.prefs[this.pen] ??= { color: null, width: null }) }
  private get board(): HTMLElement { return this.r.root.querySelector('.pr-board') as HTMLElement }
  private hasInk(): boolean { return Object.values(this.r.doc?.data.ink ?? {}).some((l) => l.length) }
  private style(): Pick<HostBoardOptions, 'pen' | 'strokeColor' | 'strokeWidth' | 'roundness'> {
    return { roundness: this.roundness, pen: this.shaping ? 'default' : this.pen, strokeColor: this.pref.color ?? undefined, strokeWidth: this.pref.width ?? undefined }
  }

  // ── 工具栏中段(手写 / 形状 / 橡皮时) ──
  toolbarHtml(btn: (act: string, ic: string, title: string, on?: boolean, v?: string) => string, sep: string): string {
    const history = btn('undo', 'undo-2', t('tool.undo')) + btn('redo', 'redo-2', t('tool.redo'))
    if (this.tool === 'eraser') return history // 橡皮没有笔 / 颜色 / 粗细可选
    const row = this.shaping
      ? SHAPES.map(([id, ic]) => btn('shape', ic, t(`shape.${id}`), this.shape === id, id)).join('')
      : PENS.map(([id, ic]) => btn('pen', ic, t(`pen.${id}`), this.pen === id, id)).join('')
    const widths = `<span class="pr-widths" role="group" aria-label="${esc(t('tool.width'))}">${INK_WIDTHS.map((w, i) =>
      `<button class="pr-width${this.pref.width === w ? ' on' : ''}" data-act="ink-width" data-v="${w}" style="--d:${4 + i * 2.5}px" title="${w}" aria-label="${esc(t('tool.width'))} ${w}"></button>`).join('')}</span>`
    const corners = this.shaping ? this.cornersHtml() + sep : ''
    return `<span class="pr-penrow">${row}</span>` + sep + corners + this.r.dotsHtml(this.pref.color, 'ink-color', INK_COLORS) + sep + widths + sep + history
  }
  private get shownRoundness(): 'sharp' | 'round' { return this.roundness }
  setRoundness(value: 'sharp' | 'round'): void {
    this.roundness = value === 'round' ? 'round' : 'sharp'
    this.handle?.update(this.style())
  }

  selectedShapes(): any[] {
    return (this.handle?.getScene().elements ?? []).filter(e => this.picked.has(e.id) && isShape(e))
  }

  editShapes(style: ShapeStyle, elements = this.selectedShapes()): void {
    if (this.r.doc?.readonly) return
    const keys = Object.keys(style) as (keyof ShapeStyle)[]
    const edits: ShapeEdit[] = elements.map(element => ({
      id: element.id, after: style,
      before: Object.fromEntries(keys.map(key => [key, element[key]])) as ShapeStyle,
    })).filter(edit => keys.some(key => JSON.stringify(edit.before[key] ?? null) !== JSON.stringify(style[key] ?? null)))
    if (!edits.length) return
    this.r.recordShapeEdit(edits)
    this.applyShapeEdits(edits, 'after')
  }

  applyShapeEdits(edits: ShapeEdit[], direction: 'before' | 'after'): void {
    const byId = new Map(edits.map(edit => [edit.id, edit[direction]]))
    this.updateElements(e => byId.has(e.id) ? { ...e, ...byId.get(e.id) } : e)
  }

  writeShapeNote(id: string, text: string): void {
    if (this.r.doc?.readonly) return
    const note = text.trimEnd()
    this.updateElements(e => e.id === id && isShape(e) && shapeNote(e) !== note ? withShapeNote(e, note) : e, false)
  }

  private updateElements(edit: (element: any) => any, write = true): void {
    if (!this.handle) return
    let changed = false
    const elements = this.handle.getScene().elements.map(element => {
      const next = edit(element)
      if (next === element) return element
      changed = true
      return { ...next, version: (element.version ?? 0) + 1, versionNonce: crypto.getRandomValues(new Uint32Array(1))[0] >>> 1, updated: Date.now() }
    })
    if (changed) this.replace(elements, write)
  }

  /** Transform the selected scene bounds into viewport-space CSS pixels. */
  selectionBounds(elements: any[]): [number, number, number, number] {
    const v = this.viewport()
    const bounds = elements.map(e => visualBoundsOf(e))
    return [
      (Math.min(...bounds.map(b => b[0])) + v.scrollX) * v.zoom,
      (Math.min(...bounds.map(b => b[1])) + v.scrollY) * v.zoom,
      (Math.max(...bounds.map(b => b[2])) + v.scrollX) * v.zoom,
      (Math.max(...bounds.map(b => b[3])) + v.scrollY) * v.zoom,
    ]
  }

  /** Sync both the reader's selection and the displayed actions after a sidebar or touch pick. */
  selectShape(id: string): void {
    this.unpick()
    this.pick([id])
  }

  deleteSelectedShapes(): void {
    const gone = this.removeSelectedShapes()
    if (gone.length) this.r.recordInkDelete(gone)
  }

  removeSelectedShapes(): any[] {
    if (this.r.doc?.readonly) return []
    const gone = this.drop(this.selectedShapes())
    this.unpick()
    return gone
  }

  cornersHtml(): string {
    return `<span class="pr-penrow"><button class="pr-btn pr-tool${this.shownRoundness === 'sharp' ? ' on' : ''}" data-act="roundness" data-v="sharp">${esc(t('shape.sharp'))}</button><button class="pr-btn pr-tool${this.shownRoundness === 'round' ? ' on' : ''}" data-act="roundness" data-v="round">${esc(t('shape.round'))}</button></span>`
  }
  setPen(id: string): void { this.pen = id; this.handle?.update(this.style()) }
  setShape(id: string): void { this.shape = id as HostBoardShape; if (this.shaping) { this.tool = this.shape; this.handle?.update({ tool: this.tool }) } }
  setColor(c: string): void { this.pref.color = c; this.handle?.update(this.style()) }
  setWidth(w: number): void { this.pref.width = w; this.handle?.update(this.style()) }
  undo(): void { this.handle?.undo(); this.take() }
  redo(): void { this.handle?.redo(); this.take() }

  // ── 每页一张静态 SVG ──
  onDocReady(): void { if (this.hasInk()) void this.enter() } // 静态图在各页渲染出来时画(onPageRendered)

  onPageRendered(page: number): void { void this.renderPage(page) }

  private async renderPage(page: number): Promise<void> {
    if (this.disposed) return
    const els = this.r.doc?.data.ink[page]
    const s = sig(els)
    let cur = this.svgs.get(page)
    if (!els?.length) { if (cur) { cur.el.remove(); URL.revokeObjectURL(cur.url) } this.svgs.delete(page); return }
    if (!cur || cur.sig !== s) {
      const out = await ctx.ui!.boardToSvg!({ elements: els }, { theme: 'light', padding: 4 }).catch((e) => { console.error('[pdf-reader] 笔迹出图失败', e); return null })
      if (!out || this.disposed || sig(this.r.doc?.data.ink[page]) !== s) return // 出图期间又改了 / 已关掉:让后一次来画
      const box = document.createElement('div')
      box.className = 'pr-ink'
      box.style.cssText = `--x:${out.x.toFixed(2)};--y:${out.y.toFixed(2)};--w:${out.width.toFixed(2)}`
      out.svg.setAttribute('width', '100%')
      out.svg.removeAttribute('height')
      // 页面上放成一张图(<img>),不放内联 SVG:内联时每一笔都是一个元素,缩放时页面的倍数变量一变,几百个 path 都要重算样式、重排版
      // (降速 4× + 600 笔实测:藏掉静态图,缩放时 >33ms 的帧 57 → 33)。右栏小图仍用 SVG 源码(thumb)。
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(out.svg)], { type: 'image/svg+xml' }))
      const img = document.createElement('img')
      img.src = url; img.alt = ''; img.draggable = false
      box.append(img)
      const old = this.svgs.get(page)
      if (old) { old.el.remove(); URL.revokeObjectURL(old.url) }
      cur = { el: box, svg: out.svg, url, sig: s, rev: ++this.svgRev }
      this.svgs.set(page, cur)
      this.r.emit() // 右栏列表里这一页的小图有了
    }
    const layer = this.r.layerOf(page, false)
    if (layer && cur.el.parentNode !== layer) layer.append(cur.el)
  }
  private refreshStatic(): void {
    for (const p of new Set([...this.svgs.keys(), ...Object.keys(this.r.doc?.data.ink ?? {}).map(Number)])) void this.renderPage(p)
  }

  /** 列表里的小图:这一页笔迹的静态图(没画出来过就没有)。 */
  thumb(page: number): string { const cur = this.svgs.get(page); if (!cur) return ''; return (cur.html ??= cur.svg.outerHTML) }
  /** 这一页小图的版本号(没有图 = 0)。右栏拿它当「要不要重画」的依据,不去序列化整张图。 */
  thumbRev(page: number): number { return this.svgs.get(page)?.rev ?? 0 }

  // ── 白板层 ──
  /** 阅读器换了工具。 */
  setTool(tool: string): void {
    const was = this.role
    if (tool !== 'shape') this.shapeGesture = null
    this.shaping = tool === 'shape'
    this.role = tool === 'ink' || tool === 'shape' || tool === 'eraser' ? 'draw' : tool === 'select' ? 'select' : 'idle'
    this.tool = tool === 'ink' ? 'freedraw' : tool === 'eraser' ? 'eraser' : tool === 'shape' ? this.shape : 'selection'
    this.picked.clear()
    if (this.clearPickTimer) clearTimeout(this.clearPickTimer)
    this.clearPickTimer = null
    this.touched = false
    this.downs.clear()
    this.settleNow() // 滚动 / 缩放还没收尾就换了工具:当场推视口、露出白板层(不然新工具落下的第一下拿的是旧视口)
    this.board.style.pointerEvents = this.role === 'draw' ? 'auto' : 'none'
    if (this.handle) {
      this.handle.update({ tool: this.tool, ...this.style() })
      if (was === 'draw' && this.role !== 'draw') this.refreshStatic() // 画的那一阵没跟着出静态图,现在补上
    } else if (this.role === 'draw' || this.hasInk()) void this.enter()
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
    if (token !== this.entering || !r.doc || this.handle) return
    this.tops = []; this.widths = []
    let y = 0
    for (let p = 0; p < r.pageCount; p++) {
      // ponytail: 没算 UserUnit ≠ 1 的页(极少见的超大幅面 PDF),那种页上笔迹位置会按比例偏;真遇到再乘上它。
      const vp = r.viewer.getPageView(p).viewport
      this.tops.push(y); this.widths.push(vp.width / vp.scale)
      y += vp.height / vp.scale + GAP
    }
    this.dirty = false
    this.held = sigAll(r.doc.data.ink)
    this.lastVp = null
    const h = this.handle = ctx.ui!.mountBoard!(this.board, {
      scene: { elements: this.sceneElements() }, viewport: this.viewport(), tool: this.tool, theme: 'light', ...this.style(),
      onChange: () => { this.dirty = true; this.schedule() }, // 落笔时每一帧都来:按着的时候不收,抬笔再收
      onWheel: (ev) => {
        if (ev.ctrlKey || ev.metaKey) r.onWheel(ev)
        else { r.container.scrollBy(ev.deltaX, ev.deltaY); this.syncViewport() } // 同一拍就推,不等 scroll 事件(那要晚一帧)
      },
      // 引擎画出第一帧之后再把静态图换下去,中间不留一段两边都没有的空白。(用定时器不用 rAF:窗口不在前台时 rAF 不走。)
      onReady: () => setTimeout(() => { if (this.handle === h) r.root.classList.add('pr-inking') }, SETTLE),
    })
  }

  /** 各页存的笔迹(页内坐标)搬到连续画布上。 */
  private sceneElements(): any[] {
    const out: any[] = []
    for (const [p, list] of Object.entries(this.r.doc?.data.ink ?? {})) {
      const o = this.origin(Number(p))
      for (const e of list) out.push({ ...e, x: e.x + o.x, y: e.y + o.y })
    }
    return out
  }

  /** 批注数据变了(自己刚收的一笔、别的标签画的、别的窗口写的被并进来):静态图和白板层都跟上。 */
  onDocChanged(noteOnly = false): void {
    const ink = this.r.doc?.data.ink
    // 正画着的时候不每笔出图(重出整页太重):停笔一阵再补,缩放时才有一份跟得上的静态图可换(见 onZoom);换工具时也补
    if (!noteOnly) {
      if (this.role !== 'draw' || !this.handle) this.refreshStatic()
      else this.scheduleStatic()
    }
    if (!this.handle) { if (this.hasInk()) void this.enter(); return }
    if (this.dirty || sigAll(ink) === this.held) return // 自己刚提交的那次签名对得上,不动
    this.held = sigAll(ink)
    this.handle.update({ scene: { elements: this.sceneElements() } })
  }

  /** 窗口要关 / 插件要停:最后一笔可能还在 300ms 的攒批里,立刻收进数据。 */
  settle(): void { if (this.handle) this.commit() }

  /** 把白板上还没收的改动收进数据,并回答「从上次问到现在,笔迹变过没有」。阅读器按一次次手势记撤销用。 */
  take(): boolean {
    if (this.handle) { this.dirty = true; this.commit() }
    const m = this.moved
    this.moved = false
    return m
  }

  /** 界面整体缩放:客户区像素 / CSS 像素。 */
  private get k(): number { return this.board.offsetWidth ? this.board.getBoundingClientRect().width / this.board.offsetWidth : 1 }

  /** 白板的视口:让「当前页」在白板上的位置和它在屏幕上的位置逐像素对上(相邻页最多差不到 1px 的取整)。 */
  private viewport(): HostBoardViewport {
    const r = this.r, page = Math.max(0, r.page - 1)
    const pv = r.viewer.getPageView(page)
    const zoom = pv?.viewport.scale || 1
    const div: HTMLElement | undefined = pv?.div
    if (!div) return { scrollX: 0, scrollY: 0, zoom }
    const pr = div.getBoundingClientRect(), br = this.board.getBoundingClientRect(), k = this.k
    const o = this.origin(page)
    return { zoom, scrollX: (pr.left - br.left) / k / zoom + div.clientLeft / zoom - o.x, scrollY: (pr.top - br.top) / k / zoom + div.clientTop / zoom - o.y }
  }

  /** 上次推给白板的视口。没变就不推(推一次引擎就整份重画一遍)。 */
  private lastVp: HostBoardViewport | null = null
  syncViewport(): void {
    if (!this.handle) return
    const v = this.viewport(), l = this.lastVp
    // A background tab can lose its layout before its pending scroll callback runs.
    if (![v.scrollX, v.scrollY, v.zoom].every(Number.isFinite) || v.zoom <= 0) return
    if (l && Math.abs(l.scrollX - v.scrollX) < 1e-6 && Math.abs(l.scrollY - v.scrollY) < 1e-6 && Math.abs(l.zoom - v.zoom) < 1e-9) return
    this.lastVp = v
    this.handle.update({ viewport: v })
  }

  /** 页面缩放了。手写时白板层要一直跟着(笔随时会落下);别的时候和滚动一样:动的这一阵换静态图、不推视口,停下来推一次。 */
  onZoom(): void {
    if (!this.handle) return
    if (this.role !== 'draw') { this.motion(); return }
    // 手写时:缩放一步引擎就得按新倍数重生成每一笔的缓存,一路推下去整份重画(实测比不推还卡)。
    // 静态图跟得上就换静态图、停下再推;跟不上(刚写完还没补出图)就照旧一路推。
    if (this.zoomHide || this.staticFresh()) this.hideForZoom()
    else this.syncViewport()
  }
  /** 手写时缩放的这一阵:白板层透明(不是 visibility:hidden —— 笔还得落在它上面,见 onDown 的 wake)、不推视口。 */
  private zoomHide = false
  private hideForZoom(): void {
    const root = this.r.root
    this.zoomHide = true
    root.classList.add('pr-zooming')
    if (this.scrollTimer) clearTimeout(this.scrollTimer)
    this.scrollTimer = setTimeout(() => {
      this.syncViewport()
      this.scrollTimer = setTimeout(() => this.unhide(), SETTLE)
    }, 140)
  }
  /** 手写时缩放刚停、白板层还透明着,笔就来了:马上推视口、露出来。返回 true = 刚才确实藏着。 */
  wake(): boolean {
    if (!this.zoomHide) return false
    this.settleNow()
    return true
  }
  /** 滚动 / 缩放这一阵的收尾(两种藏法共用一个定时器,收尾也只有这一处,谁先谁后都不会把对方的收尾弄丢):两种都撤掉。 */
  private unhide(): void {
    this.scrollTimer = null
    this.zoomHide = false
    this.r.root.classList.remove('pr-scrolling', 'pr-zooming')
    if (this.last) this.hover(this.last[0], this.last[1])
    this.r.shapeActions.refresh()
  }
  /** 不等了,马上收尾:先把视口推到位(白板层露出来时引擎手里必须是现在的视口),再撤掉藏法。 */
  private settleNow(): void {
    if (!this.scrollTimer && !this.zoomHide && !this.r.root.matches('.pr-scrolling, .pr-zooming')) return
    if (this.scrollTimer) clearTimeout(this.scrollTimer)
    this.syncViewport()
    this.unhide()
  }
  /** 每页静态图是不是和数据一致(没有没收的改动、每页图的签名对得上、没有多余的图)。 */
  private staticFresh(): boolean {
    const ink = this.r.doc?.data.ink ?? {}
    if (this.dirty) return false
    for (const [p, l] of Object.entries(ink)) if (l.length && this.svgs.get(Number(p))?.sig !== sig(l)) return false
    for (const p of this.svgs.keys()) if (!ink[p]?.length) return false
    return true
  }
  private staticTimer: ReturnType<typeof setTimeout> | null = null
  private scheduleStatic(): void {
    if (this.staticTimer) clearTimeout(this.staticTimer)
    this.staticTimer = setTimeout(() => { this.staticTimer = null; this.refreshStatic() }, 1200)
  }

  /** 页面滚了。画的时候滚轮是白板层交回来、由脚本滚的,同一帧里推得上;别的时候页面是浏览器自己滚的,
   *  白板层跟不上那一帧 —— 滚的这一阵换成跟着页面走的静态图,停下来再换回白板层。 */
  onScroll(): void {
    if (!this.handle) return
    if (this.role === 'draw') { if (this.zoomHide) this.hideForZoom(); else this.syncViewport(); return } // 缩放带出来的滚动:接着藏、不推
    this.motion()
  }
  /** 动的这一阵:白板层藏起来、露出跟着页面走的静态图;停下 140ms 推一次视口,再过一拍换回白板层。藏着的时候不推视口(推了也看不见,白画)。 */
  private motion(): void {
    const root = this.r.root
    root.classList.add('pr-scrolling')
    if (this.scrollTimer) clearTimeout(this.scrollTimer)
    this.scrollTimer = setTimeout(() => {
      this.syncViewport()
      this.scrollTimer = setTimeout(() => this.unhide(), SETTLE)
    }, 140)
  }

  // ── 选择工具:这一下指针归谁 ──
  /** 客户区的一点 → 画布坐标,外带一个客户区像素合多少画布单位。 */
  private toScene(x: number, y: number): [number, number, number] {
    const v = this.viewport(), br = this.board.getBoundingClientRect(), k = this.k
    return [(x - br.left) / k / v.zoom - v.scrollX, (y - br.top) / k / v.zoom - v.scrollY, 1 / k / v.zoom]
  }
  /** 这一点上最上面的那个笔迹 / 形状。 */
  hitAt(x: number, y: number): string | null {
    if (!this.handle) return null
    const [sx, sy, u] = this.toScene(x, y), els = this.handle.getScene().elements
    for (let i = els.length - 1; i >= 0; i--) if (hits(els[i], sx, sy, HIT * u)) return els[i].id
    return null
  }
  shapeAt(x: number, y: number): string | undefined {
    const id = this.hitAt(x, y)
    const hit = id && this.handle?.getScene().elements.find(e => e.id === id)
    return isShape(hit) ? hit.id : undefined
  }

  /** 整个落在这块客户区矩形里的笔迹 / 形状(引擎框选的规矩:要整个框住)。 */
  within(r: { left: number; top: number; right: number; bottom: number }): string[] {
    if (!this.handle) return []
    const [x0, y0] = this.toScene(r.left, r.top), [x1, y1] = this.toScene(r.right, r.bottom)
    return this.handle.getScene().elements.filter((e) => { const b = boundsOf(e); return b[0] >= x0 && b[1] >= y0 && b[2] <= x1 && b[3] <= y1 }).map((e) => e.id)
  }
  /** 记下「引擎这会儿选中的是这几个」(more:按着 Shift,在原来的上面加减)。 */
  pick(ids: string[], more = false): void {
    if (!more) this.picked.clear()
    for (const id of ids) { if (more && ids.length === 1 && this.picked.has(id)) this.picked.delete(id); else this.picked.add(id) }
    this.touched = true
    this.r.shapeActions.refresh()
    this.r.emit()
  }
  owns(target: EventTarget | null): boolean { return target instanceof Node && this.board.contains(target) }

  /** 选择工具下,接下来这一下指针该归谁。指针事件只能在按下之前改道,所以跟着悬停走:
   *  底下是笔迹 / 形状、是刚选中那几个的外框一带、或者是离字远的空白 → 白板层(点选、拖动、缩放、框选都是引擎自己的);
   *  是字、批注、链接,或紧挨着字的空白 → 页面(选字、点批注、点链接)。
   *  ponytail: 没有悬停的输入(手指、不带悬停的手写笔)按上一次的结果走,选不中画上去的东西;要支持得等宿主给「选中」的接口。 */
  hover(x: number, y: number): void {
    this.last = [x, y]
    if (this.role !== 'select' || !this.handle) return
    const at = (px: number, py: number): Element | undefined => document.elementsFromPoint(px, py).find((e) => !this.board.contains(e))
    const c = this.r.container, cr = c.getBoundingClientRect(), k = this.k, under = at(x, y)
    // 滚动条那一条(传统滚动条才有宽度)留给容器自己。
    const onPage = !!under && c.contains(under) && !under.closest('.pr-pop, .pr-shape-pin') && x < cr.left + c.clientWidth * k && y < cr.top + c.clientHeight * k
    const busy = (): boolean => !!under!.closest('[data-a], .annotationLayer a, .annotationLayer section, input, textarea, select, button') ||
      [[0, 0], [0, -NEAR_TEXT_Y], [0, NEAR_TEXT_Y], [-NEAR_TEXT_X, 0], [NEAR_TEXT_X, 0]].some(([dx, dy]) => at(x + dx, y + dy)?.closest('.textLayer span'))
    this.board.style.pointerEvents = onPage && (this.hitAt(x, y) != null || this.nearPicked(x, y) || !busy()) ? 'auto' : 'none'
  }
  wasPicked(id: string): boolean { return this.picked.has(id) }
  get clearingSelection(): boolean { return this.clearPickTimer !== null }

  nearPicked(x: number, y: number): boolean {
    if (!this.picked.size || !this.handle) return false
    const [sx, sy, u] = this.toScene(x, y), pad = FRAME * u
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const e of this.handle.getScene().elements) {
      if (!this.picked.has(e.id)) continue
      const b = visualBoundsOf(e)
      x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3])
    }
    // 只让出外框那一圈(边线、缩放柄都在这上面)。框里面照旧按底下的东西判:圈住一段话的方框选中着,里面的字还得能选。
    return sx >= x0 - pad && sx <= x1 + pad && sy >= y0 - pad && sy <= y1 + pad && !(sx > x0 + pad && sx < x1 - pad && sy > y0 + pad && sy < y1 - pad)
  }
  // ── 笔尾橡皮:不经引擎(工具由我们定死时它不认笔尾那颗键),直接改白板上的元素 ──
  /** 把这一点上的笔迹 / 形状拿掉,返回拿掉的那些(连续画布上的坐标,撤销时原样放回)。 */
  eraseAt(x: number, y: number): any[] {
    if (!this.handle) return []
    const [sx, sy, u] = this.toScene(x, y), els = this.handle.getScene().elements
    const gone = els.filter((e) => hits(e, sx, sy, HIT * u))
    if (gone.length) this.replace(els.filter((e) => !gone.includes(e)))
    return gone
  }
  /** 撤销:放回去,按元素自带的层次号(引擎的 index,按字符串比)排回原来的上下顺序;没有层次号的老元素排在后面。 */
  putBack(els: any[]): void {
    if (!this.handle) return
    const have = new Set(this.handle.getScene().elements.map((e) => e.id))
    this.replace([...this.handle.getScene().elements, ...els.filter((e) => !have.has(e.id))].sort((x, y) => (!x.index || !y.index || x.index === y.index ? 0 : x.index < y.index ? -1 : 1)))
  }
  /** 重做:再拿掉,返回这次真正拿掉的(撤销之后它们可能被挪过、改过,下次放回的得是现在这一份)。 */
  drop(els: any[]): any[] {
    if (!this.handle) return els
    const ids = new Set(els.map((e) => e.id)), cur = this.handle.getScene().elements, gone = cur.filter((e) => ids.has(e.id))
    if (gone.length) this.replace(cur.filter((e) => !ids.has(e.id)))
    return gone
  }
  /** 我们自己改的不算「引擎那边动过」(那是给撤销账问引擎用的)。 */
  private replace(elements: any[], write = true): void { const was = this.moved; this.handle!.update({ scene: { elements } }); this.dirty = true; this.commit(write, write ? 'ink' : 'shape-note'); this.moved = was }

  /** 指针按在了页面那一边:让引擎放下它选中的东西。接口上没有「取消选中」,借引擎自己的规矩 —— 切到别的工具会清掉选中,再切回来。 */
  unpick(): void {
    this.clearPickedTracking()
    const h = this.handle
    if (!h || !this.touched || this.role !== 'select') return
    this.touched = false
    if (this.clearPickTimer) clearTimeout(this.clearPickTimer)
    h.update({ tool: 'freedraw' })
    this.clearPickTimer = setTimeout(() => {
      this.clearPickTimer = null
      if (this.handle === h && this.role === 'select') h.update({ tool: this.tool })
    }, 80) // 引擎是下一拍才清的
  }

  /** The native board owns selection immediately after duplication. */
  clearPickedTracking(): void {
    if (!this.picked.size) return
    this.picked.clear()
    this.r.shapeActions.setOutline(false)
    this.r.emit()
  }

  /** 白板上的元素按页拆回去,存页内坐标。write = false:不立刻写盘,交给批注文件自己的 0.4 秒攒批(给一笔收尾这类补变化用;
   *  抬笔、删除、撤销这些「一手」的收尾照旧马上写 —— 退出应用时宿主不等渲染层)。 */
  private commit(write = true, kind: 'ink' | 'shape-note' = 'ink'): void {
    if (this.commitTimer) clearTimeout(this.commitTimer)
    this.commitTimer = null
    const doc = this.r.doc
    if (!this.handle || !doc || !this.dirty) return
    this.dirty = false
    const ink: Record<string, any[]> = {}
    for (const e of this.handle.getScene().elements) {
      const p = this.pageOfY(centerY(e)), o = this.origin(p)
      ;(ink[p] ??= []).push({ ...e, x: e.x - o.x, y: e.y - o.y })
    }
    if (Object.keys(ink).length === Object.keys(doc.data.ink).length && Object.entries(ink).every(([p, l]) => sig(l) === sig(doc.data.ink[p]))) return
    doc.data.ink = ink
    this.held = sigAll(ink)
    this.moved = true
    doc.changed(kind)
    // 一笔一存:退出应用时宿主不等渲染层收尾,刚画的一笔不能留在定时器里。
    // ponytail: 每次都是整份重写(写前还读一遍);笔迹攒到几 MB 时每笔一次读写会变重,到时按页拆文件。
    if (write) void doc.flush()
  }

  /** 把白板层卸掉重挂(引擎自己记着的状态 —— 比如「见过手写笔」—— 就此清零)。 */
  remount(): void {
    if (!this.handle) return
    this.take()
    this.handle.dispose()
    this.handle = null
    this.r.root.classList.remove('pr-inking')
    void this.enter()
  }

  dispose(): void {
    this.disposed = true
    this.entering++
    if (this.commitTimer) clearTimeout(this.commitTimer)
    if (this.scrollTimer) clearTimeout(this.scrollTimer)
    if (this.clearPickTimer) clearTimeout(this.clearPickTimer)
    if (this.staticTimer) clearTimeout(this.staticTimer)
    this.commit()
    this.handle?.dispose()
    this.handle = null
    this.board.removeEventListener('pointerdown', this.onDown, true)
    this.board.removeEventListener('dblclick', this.onFinalize, true)
    this.board.removeEventListener('keydown', this.onFinalize, true)
    window.removeEventListener('pointerup', this.onUp, true)
    window.removeEventListener('pointercancel', this.onCancel, true)
    window.removeEventListener('blur', this.onBlur)
    this.shapeGesture = null
    for (const s of this.svgs.values()) { s.el.remove(); URL.revokeObjectURL(s.url) }
    this.svgs.clear()
  }
}
