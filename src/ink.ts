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
import { boundsOf, hits } from './geom'

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
const sig = (els: any[] | undefined): string => (els ?? []).map((e) => `${e.id}:${e.version}`).join(',')
const sigAll = (ink: Record<string, any[]> | undefined): string => Object.keys(ink ?? {}).sort().map((p) => `${p}=${sig(ink![p])}`).join(';')

export class InkLayer {
  private handle: HostBoardHandle | null = null
  /** 阅读器当前的工具落到白板层上:画(手写 / 形状 / 橡皮,指针全归它)、选(跟着悬停改道,见 hover)、不归它管(摆着看)。 */
  private role: 'draw' | 'select' | 'idle' = 'select'
  private tool: HostBoardTool = 'selection'
  private shaping = false
  private pen = 'default'
  private shape: HostBoardShape = 'rectangle'
  /** 每支笔记着用户给它挑的颜色 / 粗细;null = 用这支笔自己的。形状另记一份。 */
  private readonly prefs: Record<string, { color: string | null; width: number | null }> = {}
  private readonly shapePref: { color: string | null; width: number | null } = { color: INK_COLORS[2], width: 1 } // 形状的线宽引擎按两倍算:1 档画出来是 2pt
  private readonly svgs = new Map<number, { el: HTMLElement; sig: string }>()
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
  /** 选择工具下点过白板层:引擎那边可能选着东西。 */
  private touched = false
  /** 抬笔就收:不等下面那个 300ms 的攒批(引擎收尾这一笔时再变一次,由攒批补上)。
   *  不看 dirty:画得快时引擎的变化回调还没来得及报(实测一笔画完才报),而能在这块板上抬笔,它手里就不是旧快照。 */
  private readonly onUp = (): void => { this.dirty = true; this.commit() }
  /** 指针最后在哪(客户区)。页面滚完之后指针底下换了东西,要按它重判一次归谁。 */
  private last: [number, number] | null = null

  constructor(private readonly r: Reader) {
    this.board.addEventListener('pointerup', this.onUp, true)
  }

  private get pref(): { color: string | null; width: number | null } { return this.shaping ? this.shapePref : (this.prefs[this.pen] ??= { color: null, width: null }) }
  private get board(): HTMLElement { return this.r.root.querySelector('.pr-board') as HTMLElement }
  private hasInk(): boolean { return Object.values(this.r.doc?.data.ink ?? {}).some((l) => l.length) }
  private style(): Pick<HostBoardOptions, 'pen' | 'strokeColor' | 'strokeWidth'> {
    return { pen: this.shaping ? 'default' : this.pen, strokeColor: this.pref.color ?? undefined, strokeWidth: this.pref.width ?? undefined }
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
    return `<span class="pr-penrow">${row}</span>` + sep + this.r.dotsHtml(this.pref.color, 'ink-color', INK_COLORS) + sep + widths + sep + history
  }
  setPen(id: string): void { this.pen = id; this.handle?.update(this.style()) }
  setShape(id: string): void { this.shape = id as HostBoardShape; if (this.shaping) { this.tool = this.shape; this.handle?.update({ tool: this.tool }) } }
  setColor(c: string): void { this.pref.color = c; this.handle?.update(this.style()) }
  setWidth(w: number): void { this.pref.width = w; this.handle?.update(this.style()) }
  undo(): void { this.handle?.undo() }
  redo(): void { this.handle?.redo() }

  // ── 每页一张静态 SVG ──
  onDocReady(): void { if (this.hasInk()) void this.enter() } // 静态图在各页渲染出来时画(onPageRendered)

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
  private refreshStatic(): void {
    for (const p of new Set([...this.svgs.keys(), ...Object.keys(this.r.doc?.data.ink ?? {}).map(Number)])) void this.renderPage(p)
  }

  /** 列表里的小图:这一页笔迹的静态图(没画出来过就没有)。 */
  thumb(page: number): string { return this.svgs.get(page)?.el.innerHTML ?? '' }

  // ── 白板层 ──
  /** 阅读器换了工具。 */
  setTool(tool: string): void {
    const was = this.role
    this.shaping = tool === 'shape'
    this.role = tool === 'ink' || tool === 'shape' || tool === 'eraser' ? 'draw' : tool === 'select' ? 'select' : 'idle'
    this.tool = tool === 'ink' ? 'freedraw' : tool === 'eraser' ? 'eraser' : tool === 'shape' ? this.shape : 'selection'
    this.picked.clear()
    this.touched = false
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
    const h = this.handle = ctx.ui!.mountBoard!(this.board, {
      scene: { elements: this.sceneElements() }, viewport: this.viewport(), tool: this.tool, theme: 'light', ...this.style(),
      onChange: () => { this.dirty = true; if (!this.commitTimer) this.commitTimer = setTimeout(() => this.commit(), 300) }, // 落笔时每一帧都来,攒一下
      onWheel: (ev) => {
        if (ev.ctrlKey || ev.metaKey) r.onWheel(ev)
        else r.container.scrollBy(ev.deltaX, ev.deltaY)
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
  onDocChanged(): void {
    const ink = this.r.doc?.data.ink
    if (this.role !== 'draw' || !this.handle) this.refreshStatic() // 正画着的时候不出图(每一笔都重出整页太重),换工具时补
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

  syncViewport(): void { if (this.handle) this.handle.update({ viewport: this.viewport() }) }

  /** 页面滚了。画的时候滚轮是白板层交回来、由脚本滚的,同一帧里推得上;别的时候页面是浏览器自己滚的,
   *  白板层跟不上那一帧 —— 滚的这一阵换成跟着页面走的静态图,停下来再换回白板层。 */
  onScroll(): void {
    if (!this.handle) return
    if (this.role === 'draw') { this.syncViewport(); return }
    const root = this.r.root
    root.classList.add('pr-scrolling')
    if (this.scrollTimer) clearTimeout(this.scrollTimer)
    this.scrollTimer = setTimeout(() => {
      this.syncViewport()
      this.scrollTimer = setTimeout(() => { root.classList.remove('pr-scrolling'); if (this.last) this.hover(this.last[0], this.last[1]) }, SETTLE)
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
    const onPage = !!under && c.contains(under) && !under.closest('.pr-pop') && x < cr.left + c.clientWidth * k && y < cr.top + c.clientHeight * k
    const busy = (): boolean => !!under!.closest('[data-a], .annotationLayer a, .annotationLayer section, input, textarea, select, button') ||
      [[0, 0], [0, -NEAR_TEXT_Y], [0, NEAR_TEXT_Y], [-NEAR_TEXT_X, 0], [NEAR_TEXT_X, 0]].some(([dx, dy]) => at(x + dx, y + dy)?.closest('.textLayer span'))
    this.board.style.pointerEvents = onPage && (this.hitAt(x, y) != null || this.nearPicked(x, y) || !busy()) ? 'auto' : 'none'
  }
  private nearPicked(x: number, y: number): boolean {
    if (!this.picked.size || !this.handle) return false
    const [sx, sy, u] = this.toScene(x, y), pad = FRAME * u
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const e of this.handle.getScene().elements) {
      if (!this.picked.has(e.id)) continue
      const b = boundsOf(e)
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
  private replace(elements: any[]): void { const was = this.moved; this.handle!.update({ scene: { elements } }); this.dirty = true; this.commit(); this.moved = was }

  /** 指针按在了页面那一边:让引擎放下它选中的东西。接口上没有「取消选中」,借引擎自己的规矩 —— 切到别的工具会清掉选中,再切回来。 */
  unpick(): void {
    this.picked.clear()
    const h = this.handle
    if (!h || !this.touched || this.role !== 'select') return
    this.touched = false
    h.update({ tool: 'freedraw' })
    setTimeout(() => { if (this.handle === h && this.role !== 'draw') h.update({ tool: this.tool }) }, 80) // 引擎是下一拍才清的
  }

  /** 白板上的元素按页拆回去,存页内坐标。 */
  private commit(): void {
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
    doc.changed()
    // 一笔一存:退出应用时宿主不等渲染层收尾,刚画的一笔不能留在定时器里。
    // ponytail: 每次都是整份重写(写前还读一遍);笔迹攒到几 MB 时每笔一次读写会变重,到时按页拆文件。
    void doc.flush()
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
    this.entering++
    if (this.commitTimer) clearTimeout(this.commitTimer)
    if (this.scrollTimer) clearTimeout(this.scrollTimer)
    this.commit()
    this.handle?.dispose()
    this.handle = null
    this.board.removeEventListener('pointerup', this.onUp, true)
    for (const s of this.svgs.values()) s.el.remove()
    this.svgs.clear()
  }
}
