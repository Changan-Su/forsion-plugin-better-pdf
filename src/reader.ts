// 一份打开着的 PDF:pdf.js 渲染 + 一条工具栏 + 页面上的批注层 + 选中浮条 / 批注卡。
// 批注列表、大纲、对话在宿主的右栏里(panel.ts),经 getActive()/subscribe 跟着「最近操作过的那份 PDF」走。
import { EventBus, PDFFindController, PDFLinkService, PDFViewer, ensureWorker, pdfjsLib } from './pdf'
import { acquire, release, baseOf, dirOf, stemOf, type Annot, type AnnotDoc, type AnnotType } from './store'
import { pageAt, pointOnPage, quadBox, selectionToQuads, toPageBox } from './geom'
import { icon } from './icons'
import { t } from './i18n'
import { InkLayer, inkAvailable } from './ink'
import { exportAnnotated } from './export'

export const COLORS = ['#ffd400', '#ff6666', '#5fb236', '#2ea8e5', '#a28ae5']
type Tool = 'select' | 'highlight' | 'underline' | 'note' | 'text' | 'area' | 'ink' | 'eraser'
const TOOLS: [Tool, string][] = [
  ['select', 'mouse-pointer-2'], ['highlight', 'highlighter'], ['underline', 'underline'], ['note', 'sticky-note'],
  ['text', 'type'], ['area', 'square-dashed'], ['ink', 'pen-line'], ['eraser', 'eraser'],
]
export const KIND_ICON: Record<AnnotType | 'ink', string> = {
  highlight: 'highlighter', underline: 'underline', strike: 'strikethrough', note: 'sticky-note', text: 'type', area: 'square-dashed', ink: 'pen-line',
}
const ZOOMS = ['page-width', 'page-fit', '0.5', '0.75', '1', '1.25', '1.5', '2', '3']

/** 这次事件是不是发生在浮层里。按派发时的路径判断:浮层自己的处理函数可能已经把被点的那颗按钮换掉了,
 *  换掉之后它没有祖先,closest('.pr-pop') 会答「不在」,于是点「+ 标签」被当成点了页面空白。 */
const inPop = (ev: Event): boolean => ev.composedPath().some((n) => n instanceof HTMLElement && n.classList.contains('pr-pop'))
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const n2 = (x: number): string => x.toFixed(2)
const el = <T extends HTMLElement = HTMLElement>(html: string): T => {
  const d = document.createElement('template')
  d.innerHTML = html.trim()
  return d.content.firstElementChild as T
}

export function fmtTime(iso: string): string {
  const d = new Date(iso), now = new Date()
  const loc = ctx.getLocale?.() === 'en' ? 'en' : 'zh-CN'
  const hm = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', hour12: false })
  return d.toDateString() === now.toDateString() ? t('card.today', { t: hm }) : `${d.toLocaleDateString(loc, { month: 'numeric', day: 'numeric' })} ${hm}`
}

// ── 哪份 PDF 是「当前的」:右栏的三个视图跟着它 ──────────────────────────────────────
const readers = new Set<Reader>()
let active: Reader | null = null
const activeSubs = new Set<() => void>()
export const getActive = (): Reader | null => active
export const onActive = (cb: () => void): (() => void) => { activeSubs.add(cb); return () => { activeSubs.delete(cb) } }
const setActive = (r: Reader | null): void => {
  if (active === r) return
  active = r
  for (const cb of [...activeSubs]) cb()
}
export const allReaders = (): Reader[] => [...readers]

/** 右栏的对话视图挂上之后登记在这里,「问 Tangu」经 quote 把引文递给它(owner 只用来认「是不是还是我登记的那一份」)。 */
export const chat: { owner: HostChatMount | null; folder: string | null; quote: ((text: string) => void) | null } = { owner: null, folder: null, quote: null }

let panelOpened = false
/** 把批注 / 大纲 / 对话开进右栏(宿主没有右栏时开在主区)。 */
export function openPanel(id: 'annots' | 'outline' | 'chat' = 'annots'): void {
  const right = ctx.viewLocations?.includes('right')
  const open = (v: string): void => ctx.openView(v, right ? { location: 'right' } : undefined)
  // 第一次:三个标签按「批注 / 大纲 / 对话」的顺序开出来,再回到要看的那个。
  if (right && !panelOpened) { open('annots'); open('outline'); if (ctx.tangu?.mountChat) open('chat') }
  panelOpened = true
  open(id)
}

export class Reader {
  readonly root: HTMLElement
  readonly container: HTMLElement
  readonly viewer: any
  private readonly eventBus: any
  readonly linkService: any
  pdf: any = null
  doc: AnnotDoc | null = null
  selected: string | null = null
  private tool: Tool = 'select'
  private color = COLORS[0]
  private dead = false
  private readonly subs = new Set<() => void>()
  private readonly layers = new Map<number, HTMLElement>()
  private readonly mo: MutationObserver
  private readonly off: (() => void)[] = []
  private pop: HTMLElement | null = null
  private justMade = 0
  private thumbsBuilt = false
  readonly ink: InkLayer | null

  constructor(host: HTMLElement, readonly pdfPath: string) {
    this.root = el(`<div class="pr-root">
      <div class="pr-toolbar"></div>
      <div class="pr-findbar" hidden></div>
      <div class="pr-body">
        <div class="pr-side" hidden><div class="pr-thumbs"></div></div>
        <div class="pr-viewport">
          <div class="pr-container" tabindex="-1"><div class="pdfViewer"></div></div>
          <div class="pr-board" hidden></div>
          <div class="pr-bottombar" hidden></div>
          <div class="pr-state"></div>
        </div>
      </div>
    </div>`)
    host.append(this.root)
    this.container = this.q('.pr-container')

    ensureWorker()
    this.eventBus = new EventBus()
    this.linkService = new PDFLinkService({ eventBus: this.eventBus })
    const find = new PDFFindController({ linkService: this.linkService, eventBus: this.eventBus })
    this.viewer = new PDFViewer({
      container: this.container, eventBus: this.eventBus, linkService: this.linkService, findController: find,
      annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE, // 批注是我们自己的层,pdf.js 的编辑器整个不用
      annotationMode: pdfjsLib.AnnotationMode.ENABLE,
      // ponytail: PDF 里已有便签的图标用宿主那份(public/pdfjs-annot);没有这份图的宿主上只是图标缺失,换成随包图标再说。
      imageResourcesPath: 'pdfjs-annot/',
    })
    this.linkService.setViewer(this.viewer)

    // pdf.js 重画一页时会清掉页里它不认识的子节点(缩放时每页都来一次):批注层被摘掉就当场挂回去,不等重画完,免得闪。
    this.mo = new MutationObserver((records) => {
      for (const m of records) for (const n of m.removedNodes) {
        if (n instanceof HTMLElement && n.classList.contains('pr-layer') && n.parentNode !== m.target) (m.target as HTMLElement).append(n)
      }
    })
    this.ink = inkAvailable() ? new InkLayer(this) : null

    this.renderToolbar()
    this.renderFindbar()
    this.setState('loading')
    this.bind()
    readers.add(this)
    setActive(this)
    void this.load()
  }

  private q<T extends HTMLElement = HTMLElement>(sel: string): T { return this.root.querySelector(sel) as T }

  subscribe(cb: () => void): () => void { this.subs.add(cb); return () => { this.subs.delete(cb) } }
  /** 通知右栏的视图重画(批注、选中、页码,或一页的笔迹小图有了变化)。 */
  emit(): void { for (const cb of [...this.subs]) cb() }

  get page(): number { return this.viewer.currentPageNumber || 1 }
  get pageCount(): number { return this.pdf?.numPages ?? 0 }
  get folder(): string { return dirOf(this.pdfPath) }

  // ── 装载 ────────────────────────────────────────────────────────────────────────
  private setState(s: 'loading' | 'error' | 'ready'): void {
    const box = this.q('.pr-state')
    box.hidden = s === 'ready'
    box.innerHTML = s === 'error' ? `<span>${esc(t('state.error'))}</span><button class="pr-btn" data-act="retry">${esc(t('state.retry'))}</button>` : esc(t('state.loading'))
    box.dataset.state = s
  }

  private async load(): Promise<void> {
    this.setState('loading')
    try {
      const bytes = await ctx.app.readBytes!(this.pdfPath)
      if (!bytes) throw new Error('unreadable')
      // slice:pdf.js 会把缓冲区转移进 worker。
      // ponytail: 没配 cMap / 标准字体(和内置阅读器一样),极少数老式中日韩 PDF 的字会缺;真遇到再随包带。
      const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
      if (this.dead) { void pdf.destroy(); return }
      this.pdf = pdf
      const doc = await acquire(this.pdfPath, pdf.fingerprints?.[0] ?? '')
      if (this.dead) { release(doc); return }
      this.doc = doc
      this.off.push(doc.subscribe(() => { this.repaint(); this.ink?.onDocChanged(); this.emit() }))
      this.viewer.setDocument(pdf)
      this.linkService.setDocument(pdf, null)
      this.viewer.findController.setDocument(pdf)
      this.setState('ready')
      this.renderBottombar()
      this.ink?.onDocReady()
      this.emit()
    } catch (e) {
      if (this.dead) return
      console.error('[pdf-reader] 打开失败', e)
      this.setState('error')
    }
  }

  // ── 事件 ────────────────────────────────────────────────────────────────────────
  private bind(): void {
    const { eventBus, container, viewer } = this
    const on = (target: EventTarget, type: string, fn: (e: any) => void, opts?: AddEventListenerOptions): void => {
      target.addEventListener(type, fn, opts)
      this.off.push(() => target.removeEventListener(type, fn, opts))
    }
    eventBus.on('pagesinit', () => { viewer.currentScaleValue = 'page-width' })
    eventBus.on('pagerendered', (e: { pageNumber: number }) => { this.paintPage(e.pageNumber - 1); this.ink?.onPageRendered(e.pageNumber - 1) })
    eventBus.on('pagechanging', () => { this.syncBottombar(); this.syncThumbs(); this.emit() })
    eventBus.on('scalechanging', () => { this.syncBottombar(); this.closePop(); this.ink?.syncViewport() })
    eventBus.on('updatefindmatchescount', (e: any) => this.syncFind(e.matchesCount))
    eventBus.on('updatefindcontrolstate', (e: any) => this.syncFind(e.matchesCount, e.state))

    // ⌘/Ctrl + 滚轮、触控板捏合(= 带 ctrlKey 的滚轮)缩放,以光标为中心。pdf.js 的组件包不带这一手。
    on(container, 'wheel', (ev: WheelEvent) => this.onWheel(ev), { passive: false })
    on(container, 'scroll', () => this.ink?.syncViewport(), { passive: true })
    on(container, 'pointerdown', (ev: PointerEvent) => this.onDown(ev))
    on(container, 'pointerup', (ev: PointerEvent) => { if (!inPop(ev)) setTimeout(() => this.onSelection(), 0) })
    on(container, 'click', (ev: MouseEvent) => this.onClick(ev))
    on(this.root, 'pointerdown', (ev: PointerEvent) => {
      setActive(this)
      // 点在浮层之外:收起浮层(点另一条批注、点「更多」按钮各有各的处理,不在这里收)。
      const tg = ev.target as HTMLElement
      if (this.pop && !inPop(ev) && !tg.closest('[data-a], [data-act="more"]')) this.closePop()
    }, { capture: true })
    on(this.root, 'focusin', () => setActive(this))
    on(this.root, 'keydown', (ev: KeyboardEvent) => this.onKey(ev))
    on(this.root, 'click', (ev: MouseEvent) => this.onAct(ev))

    const ro = new ResizeObserver(() => {
      if (this.dead || !this.pdf) return
      const cur = viewer.currentScaleValue
      if (cur === 'page-width' || cur === 'page-fit') viewer.currentScaleValue = cur
      this.ink?.syncViewport()
    })
    ro.observe(container)
    this.off.push(() => ro.disconnect())
  }

  onWheel(ev: WheelEvent): void {
    if (!ev.ctrlKey && !ev.metaKey) return
    ev.preventDefault() // 不拦的话是整个界面被浏览器缩放
    if (!this.pdf || !ev.deltaY) return
    // pdf.js 拿「origin − 容器的 offsetLeft / offsetTop」当指针在容器里的位置(它以为自己占满整页、没有界面缩放)。
    // 换算成它那个口径,缩放才锚在指针下面,不往一边漂。
    const c = this.container, cr = c.getBoundingClientRect(), z = c.offsetWidth ? cr.width / c.offsetWidth : 1
    const origin = [(ev.clientX - cr.left) / z + c.offsetLeft, (ev.clientY - cr.top) / z + c.offsetTop]
    this.viewer.updateScale({ scaleFactor: Math.max(0.8, Math.min(1.25, Math.exp(-ev.deltaY / 200))), origin, drawingDelay: 200 })
  }

  private onKey(ev: KeyboardEvent): void {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'f') { ev.preventDefault(); ev.stopPropagation(); this.toggleFind(true); return }
    if (ev.key !== 'Escape') return
    if (this.pop) this.closePop()
    else if (!this.q('.pr-findbar').hidden) this.toggleFind(false)
    else if (this.tool !== 'select') this.setTool('select')
    else return
    ev.stopPropagation()
  }

  /** 工具栏、浮条、批注卡、底栏上带 data-act 的按钮都从这里走。 */
  private onAct(ev: MouseEvent): void {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]')
    if (!b || !this.root.contains(b)) return
    const v = b.dataset.v ?? ''
    switch (b.dataset.act) {
      case 'retry': void this.load(); break
      case 'tool': this.setTool(v as Tool); break
      case 'color': this.pickColor(v, b); break
      case 'thumbs': this.toggleThumbs(); break
      case 'find': this.toggleFind(this.q('.pr-findbar').hidden); break
      case 'find-prev': this.find(true, true); break
      case 'find-next': this.find(true, false); break
      case 'find-close': this.toggleFind(false); break
      case 'panel': openPanel('annots'); break
      case 'note': void this.openReadingNote(); break
      case 'more': this.openMore(b); break
      case 'zoom-in': this.viewer.increaseScale(); break
      case 'zoom-out': this.viewer.decreaseScale(); break
      case 'prev': this.viewer.currentPageNumber = Math.max(1, this.page - 1); break
      case 'next': this.viewer.currentPageNumber = Math.min(this.pageCount, this.page + 1); break
      case 'thumb': this.viewer.currentPageNumber = Number(v); break
      case 'pen': this.ink?.setPen(v); this.renderToolbar(); break
      case 'ink-color': this.ink?.setColor(v); this.renderToolbar(); break
      case 'ink-width': this.ink?.setWidth(Number(v)); this.renderToolbar(); break
      case 'undo': this.ink?.undo(); break
      case 'redo': this.ink?.redo(); break
    }
  }

  // ── 工具栏 ──────────────────────────────────────────────────────────────────────
  renderToolbar(): void {
    const btn = (act: string, ic: string, title: string, on = false, v = ''): string =>
      `<button class="pr-btn pr-tool${on ? ' on' : ''}" data-act="${act}" data-v="${v}" title="${esc(title)}" aria-label="${esc(title)}"${on ? ' aria-pressed="true"' : ''}>${icon(ic)}</button>`
    const sep = '<span class="pr-sep"></span>'
    const tools = TOOLS.filter(([k]) => this.ink || (k !== 'ink' && k !== 'eraser'))
      .map(([k, ic]) => btn('tool', ic, t(`tool.${k}`), this.tool === k, k)).join('')
    const inking = this.ink && (this.tool === 'ink' || this.tool === 'eraser')
    const mid = inking ? this.ink!.toolbarHtml(btn, sep) : this.dotsHtml(this.color, 'color')
    // 三组各自不拆行;窗口窄到一行放不下时(手写那一排最长),右边那组整组折到第二行、仍然靠右。
    this.q('.pr-toolbar').innerHTML =
      `<span class="pr-group">${btn('thumbs', 'panel-left', t('tool.thumbs'), !this.q('.pr-side').hidden)}${sep}${tools}</span>` +
      `<span class="pr-group">${sep}${mid}</span>` +
      `<span class="pr-group pr-right">${btn('find', 'search', t('tool.find'), !this.q('.pr-findbar').hidden)}` +
      `<button class="pr-textbtn" data-act="note">${icon('notebook-pen', 14)}${esc(t('tool.readingNote'))}</button>` +
      `${btn('panel', 'panel-right', t('tool.panel'))}${btn('more', 'ellipsis', t('tool.more'))}</span>`
  }

  dotsHtml(current: string | null, act: string, colors = COLORS): string {
    return `<span class="pr-dots" role="group" aria-label="${esc(t('tool.color'))}">${colors.map((c) =>
      `<button class="pr-dot${c === current ? ' on' : ''}" data-act="${act}" data-v="${c}" style="--c:${c}" title="${c}" aria-label="${c}"></button>`).join('')}</span>`
  }

  private setTool(tool: Tool): void {
    if (this.tool === tool && tool !== 'select') tool = 'select' // 再点一次当前工具 = 回到选择
    this.tool = tool
    this.root.dataset.tool = tool
    this.closePop()
    this.ink?.setMode(tool === 'ink' ? 'freedraw' : tool === 'eraser' ? 'eraser' : null)
    this.renderToolbar()
  }

  private pickColor(c: string, from: HTMLElement): void {
    // 浮条 / 批注卡里的色点有自己的含义(给选区上色、给这条批注换色),工具栏上的才是「当前颜色」。
    const kind = from.closest<HTMLElement>('.pr-pop')?.dataset.kind
    if (kind === 'sel') { this.color = c; this.markSelection('highlight'); this.renderToolbar(); return }
    if (kind === 'card') {
      if (!this.selected) return
      this.doc?.patch(this.selected, { color: c })
      this.pop!.querySelectorAll<HTMLElement>('.pr-dot').forEach((d) => d.classList.toggle('on', d.dataset.v === c))
      return
    }
    this.color = c
    this.renderToolbar()
  }

  // ── 页面上的批注层 ────────────────────────────────────────────────────────────────
  /** 一页的批注层:inset 0 铺在页内容盒上,子元素的位置用 pt 写进变量,再由 pdf.js 的缩放系数换成像素,所以缩放不用重排。 */
  layerOf(i: number, create = true): HTMLElement | null {
    const div: HTMLElement | undefined = this.viewer.getPageView(i)?.div
    if (!div) return null
    let layer = this.layers.get(i)
    if (!layer) {
      if (!create) return null
      layer = el('<div class="pr-layer"><div class="pr-marks"></div></div>')
      this.layers.set(i, layer)
      this.mo.observe(div, { childList: true })
    }
    if (layer.parentNode !== div) div.append(layer)
    return layer
  }

  private paintPage(i: number): void {
    const layer = this.layerOf(i)
    const pv = this.viewer.getPageView(i)
    if (!layer || !pv || !this.doc) return
    const vp1 = pv.viewport.clone({ scale: 1 })
    const pos = (b: number[]): string => `--x:${n2(b[0])};--y:${n2(b[1])};--w:${n2(b[2])};--h:${n2(b[3])}`
    const out: string[] = []
    for (const a of this.doc.data.annots) {
      if (a.page !== i) continue
      const sel = a.id === this.selected ? ' sel' : ''
      const at = `data-a="${a.id}"`
      if (a.quads) {
        const cls = a.type === 'highlight' ? 'pr-hl' : a.type === 'underline' ? 'pr-ul' : 'pr-st'
        for (const q of a.quads) out.push(`<i class="${cls}${sel}" ${at} style="${pos(quadBox(vp1, q))};--c:${a.color}"></i>`)
      } else if (a.rect) {
        const b = toPageBox(vp1, a.rect[0], a.rect[1], a.rect[2], a.rect[3])
        if (a.type === 'note') out.push(`<button class="pr-note${sel}" ${at} style="${pos(b)};--c:${a.color}" title="${esc(a.comment || t('kind.note'))}">${icon('sticky-note', 12)}</button>`)
        else if (a.type === 'text') out.push(`<div class="pr-text${sel}" ${at} style="${pos(b)};--c:${a.color}" contenteditable="plaintext-only" spellcheck="false">${esc(a.text ?? '')}</div>`)
        else out.push(`<div class="pr-area${sel}" ${at} style="${pos(b)};--c:${a.color}"></div>`)
      }
    }
    // 正在页面上打字的那个文字框不能被换掉(换掉就丢焦点):这时整页先不重画,失焦时再画。
    const marks = layer.firstElementChild as HTMLElement
    if (marks.contains(document.activeElement)) return
    marks.innerHTML = out.join('')
  }

  repaint(): void { for (const i of this.layers.keys()) this.paintPage(i) }

  // ── 指针:放便签 / 文字 / 拖区域 ─────────────────────────────────────────────────────
  private onDown(ev: PointerEvent): void {
    const target = ev.target as HTMLElement
    if (inPop(ev)) return
    if (document.activeElement !== this.container && !target.closest('[contenteditable], input, textarea')) this.container.focus({ preventScroll: true })
    if (ev.button !== 0 || !this.doc || target.closest('[data-a]')) return
    const tool = this.tool
    if (tool !== 'note' && tool !== 'text' && tool !== 'area') return
    const at = pageAt(this.viewer, ev.clientX, ev.clientY)
    if (!at) return
    ev.preventDefault()
    if (tool !== 'area') {
      const a = this.doc.add({ type: tool, page: at.page, color: this.color, rect: [at.x, at.y, at.x, at.y], ...(tool === 'text' ? { text: '' } : {}) })
      this.justMade = performance.now()
      this.setTool('select')
      this.select(a.id)
      if (tool === 'text') this.layerOf(at.page)?.querySelector<HTMLElement>(`.pr-text[data-a="${a.id}"]`)?.focus()
      else this.openCard(a.id, true)
      return
    }
    // 区域:起止点锁在按下的那一页。
    const layer = this.layerOf(at.page)!
    const vp1 = this.viewer.getPageView(at.page).viewport.clone({ scale: 1 })
    const ghost = el(`<div class="pr-area ghost" style="--c:${this.color}"></div>`)
    layer.append(ghost)
    let end: [number, number] = [at.x, at.y]
    const draw = (): void => {
      const b = toPageBox(vp1, at.x, at.y, end[0], end[1])
      ghost.style.cssText = `--x:${n2(b[0])};--y:${n2(b[1])};--w:${n2(b[2])};--h:${n2(b[3])};--c:${this.color}`
    }
    const move = (e: PointerEvent): void => { end = pointOnPage(this.viewer, at.page, e.clientX, e.clientY) ?? end; draw() }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      ghost.remove()
      if (Math.abs(end[0] - at.x) < 4 || Math.abs(end[1] - at.y) < 4 || !this.doc) return // 没拖开:当成误点
      const a = this.doc.add({ type: 'area', page: at.page, color: this.color, rect: [Math.min(at.x, end[0]), Math.min(at.y, end[1]), Math.max(at.x, end[0]), Math.max(at.y, end[1])] })
      this.justMade = performance.now()
      this.setTool('select')
      this.select(a.id)
      this.openCard(a.id, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ── 选中文字 ────────────────────────────────────────────────────────────────────
  private selText(): string { return (window.getSelection()?.toString() ?? '').replace(/\s+/g, ' ').trim() }

  private onSelection(): void {
    if (this.dead || !this.doc) return
    const sel = window.getSelection()
    const inside = sel && !sel.isCollapsed && sel.anchorNode && this.container.contains(sel.anchorNode) && (sel.anchorNode.parentElement?.closest('.textLayer'))
    if (!inside) { if (this.pop?.dataset.kind === 'sel') this.closePop(); return }
    if (this.tool === 'highlight' || this.tool === 'underline') { this.markSelection(this.tool); return }
    if (this.tool !== 'select') return
    const rects = [...sel!.getRangeAt(0).getClientRects()].filter((r) => r.width > 1 && r.height > 1)
    if (!rects.length) return
    const dots = this.dotsHtml(null, 'color')
    const b = (act: string, ic: string, tip: string, txt = ''): string => `<button class="pr-pbtn${txt ? ' txt' : ''}" data-pop="${act}" title="${esc(tip)}" aria-label="${esc(tip)}">${icon(ic, 14)}${esc(txt)}</button>`
    const pop = el(`<div class="pr-pop pr-selpop" data-kind="sel">${dots}<span class="pr-sep"></span>${b('underline', 'underline', t('tool.underline'))}${b('strike', 'strikethrough', t('tool.strike'))}${b('comment', 'sticky-note', t('sel.comment'))}<span class="pr-sep"></span>${b('copy', 'copy', t('sel.copy'))}${b('cite', 'notebook-pen', t('sel.cite'), t('sel.cite'))}${b('ask', 'message-square-quote', t('sel.ask'))}</div>`)
    pop.addEventListener('pointerdown', (e) => e.preventDefault()) // 点浮条不许把选区点没
    pop.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-pop]')?.dataset.pop
      if (!act) return
      const text = this.selText()
      if (act === 'underline' || act === 'strike') this.markSelection(act)
      else if (act === 'comment') { const a = this.markSelection('highlight'); if (a) { this.select(a.id); this.openCard(a.id, true) } }
      else if (act === 'copy') { void navigator.clipboard?.writeText(text); ctx.notify?.(t('copy.done')); this.closePop() }
      else if (act === 'cite') { const a = this.markSelection('highlight'); if (a) void this.cite(a) }
      else if (act === 'ask') { this.ask(text, this.page); this.closePop() }
    })
    const top = rects.reduce((m, r) => Math.min(m, r.top), Infinity), left = rects.reduce((m, r) => Math.min(m, r.left), Infinity)
    this.showPop(pop, { left, top, bottom: rects.reduce((m, r) => Math.max(m, r.bottom), -Infinity) }, 'above')
  }

  /** 把当前选区变成一条(跨页则每页一条)批注,返回第一条。 */
  private markSelection(type: 'highlight' | 'underline' | 'strike'): Annot | null {
    if (!this.doc) return null
    const pages = selectionToQuads(this.viewer)
    const text = this.selText()
    let first: Annot | null = null
    for (const p of pages) {
      const a = this.doc.add({ type, page: p.page, color: this.color, quads: p.quads, text: first ? '' : text })
      first ??= a
    }
    window.getSelection()?.removeAllRanges()
    this.justMade = performance.now()
    this.closePop()
    return first
  }

  // ── 点批注 → 批注卡 ───────────────────────────────────────────────────────────────
  private onClick(ev: MouseEvent): void {
    const target = ev.target as HTMLElement
    if (inPop(ev) || !this.doc || this.tool !== 'select') return
    if (performance.now() - this.justMade < 350 || !window.getSelection()?.isCollapsed) return
    let id = target.closest<HTMLElement>('[data-a]')?.dataset.a ?? null
    if (!id) {
      // 高亮 / 下划线不挡文字选取(pointer-events:none),所以点没点中它们按几何算。
      const at = pageAt(this.viewer, ev.clientX, ev.clientY)
      const hit = at && [...this.doc.data.annots].reverse().find((a) => a.page === at.page && a.quads?.some((q) => at.x >= q[0] - 1 && at.x <= q[2] + 1 && at.y <= q[1] + 1.5 && at.y >= q[5] - 1.5))
      id = hit ? hit.id : null
    }
    if (!id) { this.select(null); return }
    this.select(id)
    this.openCard(id, false)
  }

  select(id: string | null): void {
    if (this.selected === id) return
    this.selected = id
    this.repaint()
    this.emit()
  }

  /** 右栏点一条批注:滚到它、选中它。 */
  reveal(id: string): void {
    const a = this.doc?.data.annots.find((x) => x.id === id)
    if (!a) return
    const y = a.quads?.length ? Math.max(...a.quads.map((q) => q[1])) : a.rect ? Math.max(a.rect[1], a.rect[3]) : 0
    this.viewer.scrollPageIntoView({ pageNumber: a.page + 1, destArray: [null, { name: 'XYZ' }, null, y + 90, null] })
    this.select(id)
  }

  private anchorOf(id: string): { left: number; top: number; bottom: number } | null {
    const els = [...this.container.querySelectorAll<HTMLElement>(`[data-a="${id}"]`)]
    if (!els.length) return null
    const r = els[els.length - 1].getBoundingClientRect()
    return { left: r.left, top: r.top, bottom: r.bottom }
  }

  private openCard(id: string, focus: boolean): void {
    const a = this.doc?.data.annots.find((x) => x.id === id)
    const anchor = a && this.anchorOf(id)
    if (!a || !anchor) return
    const ib = (act: string, ic: string, tip: string): string => `<button class="pr-ibtn" data-pop="${act}" title="${esc(tip)}" aria-label="${esc(tip)}">${icon(ic, 14)}</button>`
    const pop = el(`<div class="pr-pop pr-card" data-kind="card">
      <div class="pr-card-top">${this.dotsHtml(a.color, 'color')}<span class="pr-flex"></span>${a.text || a.comment ? ib('cite', 'notebook-pen', t('sel.cite')) + ib('ask', 'message-square-quote', t('sel.ask')) : ''}${ib('delete', 'trash-2', t('card.delete'))}</div>
      <textarea class="pr-card-body" rows="2" placeholder="${esc(t('card.placeholder'))}"></textarea>
      <div class="pr-card-foot"><span class="pr-tags"></span><span class="pr-flex"></span><span>${esc(t('card.page', { n: a.page + 1 }))} · ${esc(fmtTime(a.created))}</span></div>
    </div>`)
    const body = pop.querySelector('textarea')!
    body.value = a.comment ?? ''
    const grow = (): void => { body.style.height = 'auto'; body.style.height = `${Math.min(220, body.scrollHeight)}px` }
    body.addEventListener('input', () => { this.doc?.patch(id, { comment: body.value || undefined }); grow() })
    const tagsBox = pop.querySelector<HTMLElement>('.pr-tags')!
    const drawTags = (): void => {
      tagsBox.innerHTML = (a.tags ?? []).map((g, i) => `<button class="pr-tag" data-pop="untag" data-i="${i}" title="${esc(t('card.removeTag'))}">#${esc(g)}</button>`).join('') +
        `<button class="pr-tag add" data-pop="tag">${esc(t('card.addTag'))}</button>`
    }
    drawTags()
    pop.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-pop]')
      if (!b) return
      const act = b.dataset.pop
      if (act === 'delete') { this.closePop(); this.selected = null; this.doc?.remove(id) }
      else if (act === 'cite') void this.cite(a)
      else if (act === 'ask') this.ask([a.text, a.comment].filter(Boolean).join('\n\n'), a.page + 1)
      else if (act === 'untag') { this.doc?.patch(id, { tags: (a.tags ?? []).filter((_, i) => i !== Number(b.dataset.i)) }); drawTags() }
      else if (act === 'tag') {
        const input = el<HTMLInputElement>(`<input class="pr-taginput" placeholder="${esc(t('card.tagPlaceholder'))}">`)
        b.replaceWith(input)
        input.focus()
        let closed = false
        const done = (keep: boolean): void => {
          if (closed) return // 重画标签会把输入框摘掉,摘掉又触发一次失焦:只认第一次
          closed = true
          const v = input.value.trim().replace(/^#/, '')
          if (keep && v && !(a.tags ?? []).includes(v)) this.doc?.patch(id, { tags: [...(a.tags ?? []), v] })
          drawTags()
        }
        input.addEventListener('keydown', (k) => { if (k.key === 'Enter') done(true); else if (k.key === 'Escape') { k.stopPropagation(); done(false) } })
        input.addEventListener('blur', () => done(true))
      }
    })
    this.showPop(pop, anchor, 'below')
    grow()
    if (focus) body.focus()
  }

  // ── 浮层 ────────────────────────────────────────────────────────────────────────
  /** 浮层放进滚动容器里(跟着页面滚),位置由客户区坐标换成容器内容坐标;客户区像素先除掉界面的整体缩放。 */
  private showPop(pop: HTMLElement, a: { left: number; top: number; bottom: number }, prefer: 'above' | 'below'): void {
    this.closePop()
    const c = this.container, cr = c.getBoundingClientRect()
    const z = c.offsetWidth ? cr.width / c.offsetWidth : 1
    c.append(pop)
    this.pop = pop
    const w = pop.offsetWidth, h = pop.offsetHeight
    const x = Math.max(c.scrollLeft + 8, Math.min((a.left - cr.left) / z + c.scrollLeft - 2, c.scrollLeft + c.clientWidth - w - 8))
    const above = (a.top - cr.top) / z + c.scrollTop - h - 8, below = (a.bottom - cr.top) / z + c.scrollTop + 8
    const fitsAbove = above >= c.scrollTop + 4, fitsBelow = below + h <= c.scrollTop + c.clientHeight - 4
    const y = prefer === 'above' ? (fitsAbove || !fitsBelow ? above : below) : (fitsBelow || !fitsAbove ? below : above)
    pop.style.left = `${x}px`
    pop.style.top = `${Math.max(4, y)}px`
  }

  closePop(): void {
    this.pop?.remove()
    this.pop = null
  }

  private openMore(anchorBtn: HTMLElement): void {
    if (this.pop?.dataset.kind === 'menu') { this.closePop(); return }
    const r = anchorBtn.getBoundingClientRect()
    const pop = el(`<div class="pr-pop pr-menu" data-kind="menu">
      <button data-pop="export">${icon('file-down', 14)}${esc(t('more.export'))}</button>
      <button data-pop="link">${icon('link', 14)}${esc(t('more.copyLink'))}</button>
    </div>`)
    pop.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-pop]')?.dataset.pop
      this.closePop()
      if (act === 'export') void exportAnnotated(this)
      else if (act === 'link') { void navigator.clipboard?.writeText(`[[${baseOf(this.pdfPath)}#page=${this.page}]]`); ctx.notify?.(t('copy.done')) }
    })
    this.showPop(pop, { left: r.right - 200, top: r.top, bottom: r.bottom }, 'below')
    pop.style.top = `${this.container.scrollTop + 6}px`
    pop.style.left = `${this.container.scrollLeft + this.container.clientWidth - pop.offsetWidth - 10}px`
  }

  // ── 查找 ────────────────────────────────────────────────────────────────────────
  private renderFindbar(): void {
    const b = (act: string, ic: string, tip: string): string => `<button class="pr-btn pr-tool" data-act="${act}" title="${esc(tip)}" aria-label="${esc(tip)}">${icon(ic, 14)}</button>`
    const bar = this.q('.pr-findbar')
    const old = bar.querySelector('input')?.value ?? ''
    bar.innerHTML = `<input class="pr-findinput" type="search" placeholder="${esc(t('find.placeholder'))}"><span class="pr-findcount"></span>${b('find-prev', 'chevron-up', t('find.prev'))}${b('find-next', 'chevron-down', t('find.next'))}${b('find-close', 'x', t('find.close'))}`
    const input = bar.querySelector('input')!
    input.value = old
    input.addEventListener('input', () => this.find(false, false))
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.find(true, e.shiftKey) } })
  }

  private toggleFind(open: boolean): void {
    const bar = this.q('.pr-findbar')
    bar.hidden = !open
    if (open) { const i = bar.querySelector('input')!; i.focus(); i.select() }
    else { this.eventBus.dispatch('findbarclose', { source: this }); this.container.focus({ preventScroll: true }) }
    this.renderToolbar()
  }

  private find(again: boolean, previous: boolean): void {
    const query = this.q<HTMLInputElement>('.pr-findinput').value
    this.eventBus.dispatch('find', { source: this, type: again ? 'again' : '', query, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false })
  }

  private syncFind(count?: { current: number; total: number }, state?: number): void {
    const box = this.q('.pr-findcount')
    const has = !!this.q<HTMLInputElement>('.pr-findinput').value
    box.textContent = !has ? '' : state === 1 || (count && !count.total) ? t('find.none') : count ? `${count.current} / ${count.total}` : box.textContent
  }

  // ── 底栏:缩放 + 翻页 ─────────────────────────────────────────────────────────────
  private renderBottombar(): void {
    const bar = this.q('.pr-bottombar')
    bar.hidden = !this.pdf
    const zl = (v: string): string => (v === 'page-width' ? t('zoom.fitWidth') : v === 'page-fit' ? t('zoom.fitPage') : `${Math.round(parseFloat(v) * 100)}%`)
    bar.innerHTML = `<button class="pr-btn" data-act="zoom-out" title="${esc(t('zoom.out'))}" aria-label="${esc(t('zoom.out'))}">${icon('minus', 13)}</button>
      <select class="pr-zoomsel" title="${esc(t('zoom.title'))}" aria-label="${esc(t('zoom.title'))}">${ZOOMS.map((v) => `<option value="${v}">${esc(zl(v))}</option>`).join('')}<option value="custom" hidden></option></select>
      <button class="pr-btn" data-act="zoom-in" title="${esc(t('zoom.in'))}" aria-label="${esc(t('zoom.in'))}">${icon('plus', 13)}</button><span class="pr-sep"></span>
      <button class="pr-btn" data-act="prev" title="${esc(t('page.prev'))}" aria-label="${esc(t('page.prev'))}">‹</button>
      <input class="pr-pageinput" title="${esc(t('page.input'))}" aria-label="${esc(t('page.input'))}" inputmode="numeric"><span class="pr-pagetotal"></span>
      <button class="pr-btn" data-act="next" title="${esc(t('page.next'))}" aria-label="${esc(t('page.next'))}">›</button>`
    bar.querySelector('select')!.addEventListener('change', (e) => { this.viewer.currentScaleValue = (e.target as HTMLSelectElement).value })
    bar.querySelector('input')!.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      const n = parseInt((e.target as HTMLInputElement).value, 10)
      if (n >= 1 && n <= this.pageCount) this.viewer.currentPageNumber = n
      else this.syncBottombar()
    })
    this.syncBottombar()
  }

  private syncBottombar(): void {
    const bar = this.q('.pr-bottombar')
    const sel = bar.querySelector('select'), input = bar.querySelector('input')
    if (!sel || !input) return
    const cur = String(this.viewer.currentScaleValue ?? '')
    if (ZOOMS.includes(cur)) sel.value = cur
    else { const o = sel.querySelector<HTMLOptionElement>('option[value="custom"]')!; o.textContent = `${Math.round((this.viewer.currentScale || 1) * 100)}%`; sel.value = 'custom' }
    if (document.activeElement !== input) input.value = String(this.page)
    bar.querySelector('.pr-pagetotal')!.textContent = `/ ${this.pageCount || '…'}`
  }

  // ── 缩略图 ──────────────────────────────────────────────────────────────────────
  private toggleThumbs(): void {
    const side = this.q('.pr-side')
    side.hidden = !side.hidden
    this.renderToolbar()
    if (side.hidden || this.thumbsBuilt || !this.pdf) { this.syncThumbs(); return }
    this.thumbsBuilt = true
    const wrap = this.q('.pr-thumbs'), pdf = this.pdf
    wrap.innerHTML = Array.from({ length: pdf.numPages }, (_, i) => `<button class="pr-thumb" data-act="thumb" data-v="${i + 1}"><canvas></canvas><span>${i + 1}</span></button>`).join('')
    // 进了视口才画;画在离屏画布上、画完一次贴回,免得先刷一张白的。
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue
        io.unobserve(en.target)
        const canvas = en.target.querySelector('canvas')!
        void pdf.getPage(Number((en.target as HTMLElement).dataset.v)).then(async (page: any) => {
          const base = page.getViewport({ scale: 1 })
          const vp = page.getViewport({ scale: (128 / base.width) * 2 })
          const off = document.createElement('canvas')
          off.width = vp.width; off.height = vp.height
          await page.render({ canvasContext: off.getContext('2d')!, viewport: vp, canvas: off }).promise
          if (this.dead) return
          canvas.width = off.width; canvas.height = off.height
          canvas.getContext('2d')!.drawImage(off, 0, 0)
        }).catch(() => { /* 文档已关 */ })
      }
    }, { root: this.q('.pr-side'), rootMargin: '400px' })
    wrap.querySelectorAll('.pr-thumb').forEach((b) => io.observe(b))
    this.off.push(() => io.disconnect())
    this.syncThumbs()
  }

  private syncThumbs(): void {
    if (this.q('.pr-side').hidden) return
    for (const b of this.root.querySelectorAll<HTMLElement>('.pr-thumb')) {
      const on = Number(b.dataset.v) === this.page
      if (on && !b.classList.contains('on')) b.scrollIntoView({ block: 'nearest' })
      b.classList.toggle('on', on)
    }
  }

  // ── 读书笔记 / 问 Tangu ──────────────────────────────────────────────────────────
  /** 这份 PDF 的读书笔记路径;还没有就定下来(文件名跟当时的界面语言,之后不再变)。返回 [路径, 现有内容或 null]。 */
  private async readingNote(): Promise<[string, string | null]> {
    const doc = this.doc!
    let cur = doc.data.note ? await ctx.app.readFile(doc.data.note) : null
    if (cur === null) {
      doc.data.note = `${ctx.app.workFolder?.() || 'PDF'}/${t('note.title', { name: stemOf(this.pdfPath) })}.md`
      doc.changed()
      cur = await ctx.app.readFile(doc.data.note)
    }
    return [doc.data.note!, cur]
  }

  private noteHead(): string { return `# ${t('note.title', { name: stemOf(this.pdfPath) })}\n\n[[${baseOf(this.pdfPath)}]]\n` }

  private async openReadingNote(): Promise<void> {
    if (!this.doc) return
    try {
      const [path, cur] = await this.readingNote()
      if (cur === null) await ctx.app.writeFile(path, this.noteHead())
      if (ctx.app.openNote) ctx.app.openNote(path, { newTab: true })
      else ctx.app.openFile(path)
    } catch (e) {
      console.error('[pdf-reader] 读书笔记打不开', e)
      ctx.notify?.(t('note.failed'), { level: 'error' })
    }
  }

  /** 把一条批注写进读书笔记:引文 + 回到这一页的链接 + 评论。 */
  async cite(a: Pick<Annot, 'page' | 'text' | 'comment'>): Promise<void> {
    if (!this.doc) return
    const link = `[[${baseOf(this.pdfPath)}#page=${a.page + 1}|${t('note.pageLink', { n: a.page + 1 })}]]`
    const quote = (a.text ?? '').replace(/\s+/g, ' ').trim()
    const block = `${quote ? `> ${quote}\n> — ${link}\n` : `${link}\n`}${a.comment ? `\n${a.comment.trim()}\n` : ''}`
    try {
      const [path, cur] = await this.readingNote()
      // 笔记正开着、且是当前笔记:走编辑器的插入(整文件覆盖会和它没存的改动打架)。
      const live = cur !== null && ctx.app.getActivePage() === path && ctx.app.getPage && ctx.app.insertMarkdown?.(ctx.app.getPage().token, block, 'end')
      // ponytail: 笔记开在别的标签里时是整文件写;编辑器下一次保存靠宿主的比对交换发现盘上变了。要更稳得等宿主给「往指定笔记追加」的接口。
      if (!live) await ctx.app.writeFile(path, `${(cur ?? this.noteHead()).trimEnd()}\n\n${block}`)
      ctx.notify?.(t('note.cited', { name: baseOf(path).replace(/\.md$/, '') }), { level: 'success' })
    } catch (e) {
      console.error('[pdf-reader] 引用到笔记失败', e)
      ctx.notify?.(t('note.failed'), { level: 'error' })
    }
  }

  /** 把一段原文递给 Tangu:挂成右栏对话输入框上方的引用条,不替用户发送。 */
  private ask(text: string, page: number): void {
    if (!text) return
    const quoted = `${text}\n\n— ${baseOf(this.pdfPath)} · ${t('card.page', { n: page })}`
    if (ctx.tangu?.mountChat) {
      openPanel('chat')
      // 对话视图是异步挂上的:等它登记好再递引文。
      const deadline = Date.now() + 4000
      const hand = (): void => {
        if (chat.quote && chat.folder === this.folder) chat.quote(quoted)
        else if (Date.now() < deadline) setTimeout(hand, 80)
      }
      hand()
    } else if (ctx.tangu?.startChat) void ctx.tangu.startChat({ prompt: quoted, send: false, folder: this.folder || undefined })
    else { void navigator.clipboard?.writeText(quoted); ctx.notify?.(t('ask.copied')) }
  }

  /** 切语言后重画带文案的部分。 */
  relocale(): void {
    this.renderToolbar()
    this.renderFindbar()
    if (this.pdf) this.renderBottombar()
    if (this.q('.pr-state').dataset.state !== 'ready') this.setState(this.q('.pr-state').dataset.state as 'loading' | 'error')
    this.closePop()
    this.repaint()
  }

  dispose(): void {
    if (this.dead) return
    this.dead = true
    // 页面上正打着字的文字框:先收进数据再走。
    this.commitText(document.activeElement as HTMLElement | null)
    this.ink?.dispose()
    for (const f of this.off) { try { f() } catch { /* 收尾不抛 */ } }
    this.mo.disconnect()
    if (this.doc) release(this.doc)
    try { this.viewer.setDocument(null); this.linkService.setDocument(null) } catch { /* 忽略 */ }
    try { void this.pdf?.destroy() } catch { /* 忽略 */ }
    this.root.remove()
    readers.delete(this)
    if (active === this) setActive([...readers].pop() ?? null)
  }

  /** 窗口要关 / 插件要停:把还在手上的东西(正打着的字、最后一笔)收进数据。 */
  settle(text = true): void {
    if (text) this.commitText(document.activeElement as HTMLElement | null)
    this.ink?.settle()
  }

  /** 页面上的文字框失焦:内容收进数据;空的就删掉。 */
  commitText(box: HTMLElement | null): void {
    const id = box?.classList?.contains('pr-text') ? box.dataset.a : undefined
    if (!id || !this.doc) return
    const text = (box!.innerText ?? '').replace(/\n+$/, '')
    if (!text.trim()) { if (this.selected === id) { this.selected = null; this.closePop() } this.doc.remove(id) }
    else this.doc.patch(id, { text })
  }
}

/** 文字框的失焦要在捕获阶段听(focusout 冒泡,但我们要在重画之前拿到内容)。 */
export function mountReader(host: HTMLElement, pdfPath: string): () => void {
  const r = new Reader(host, pdfPath)
  const onOut = (e: FocusEvent): void => r.commitText(e.target as HTMLElement)
  r.root.addEventListener('focusout', onOut)
  return () => { r.root.removeEventListener('focusout', onOut); r.dispose() }
}
