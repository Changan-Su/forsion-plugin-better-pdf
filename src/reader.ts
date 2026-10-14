// 一份打开着的 PDF:pdf.js 渲染 + 一条工具栏 + 页面上的批注层 + 选中浮条 / 批注卡。
// 批注列表、大纲、对话在宿主的右栏里(panel.ts),经 getActive()/subscribe 跟着「最近操作过的那份 PDF」走。
import { EventBus, PDFFindController, PDFLinkService, PDFViewer, ensureWorker, pdfjsLib } from './pdf'
import { acquire, release, baseOf, dirOf, type Annot, type AnnotDoc, type AnnotType } from './store'
import { pageAt, quadBox, selectionToQuads, toPageBox, type PageQuads } from './geom'
import { icon } from './icons'
import { t } from './i18n'
import { InkLayer, inkAvailable } from './ink'
import { exportAnnotated } from './export'

export const COLORS = ['#ffd400', '#ff6666', '#5fb236', '#2ea8e5', '#a28ae5']
type Tool = 'select' | 'highlight' | 'underline' | 'note' | 'text' | 'shape' | 'ink' | 'eraser'
const TOOLS: [Tool, string][] = [
  ['select', 'mouse-pointer-2'], ['highlight', 'highlighter'], ['underline', 'underline'], ['note', 'sticky-note'],
  ['text', 'type'], ['shape', 'shapes'], ['ink', 'pen-line'], ['eraser', 'eraser'],
]
/** 归白板层的三个工具:宿主没有白板层接口时不出现。 */
const BOARD_TOOLS: Tool[] = ['shape', 'ink', 'eraser']
/** 工具的字母键,照宿主白板的来(V 选择、P / X 笔、E 橡皮、R O A L 四种形状、T 文字);高亮、下划线、便签是我们自己的,另取 H U N。
 *  白板层的工具由我们定死,引擎因此不认它自己的快捷键,得我们来接。数字键另算:按工具栏上的顺序,0 也是橡皮。 */
const KEY_TOOL: Record<string, [Tool, HostBoardShape?]> = {
  v: ['select'], h: ['highlight'], u: ['underline'], n: ['note'], t: ['text'], p: ['ink'], x: ['ink'], e: ['eraser'], 0: ['eraser'],
  r: ['shape', 'rectangle'], o: ['shape', 'ellipse'], a: ['shape', 'arrow'], l: ['shape', 'line'],
}
/** 写在按钮提示上的那个键。 */
export const TOOL_KEY: Record<string, string> = { select: 'V', highlight: 'H', underline: 'U', note: 'N', text: 'T', shape: 'R', ink: 'P', eraser: 'E', rectangle: 'R', ellipse: 'O', arrow: 'A', line: 'L' }

/** 调色盘之外、自己用取色器挑过的颜色:留最近三种,批注和手写共用。 */
const HEX = /^#[0-9a-f]{6}$/
const RECENT_KEY = 'forsion-pdf-reader.colors'
let recent: string[] = []
try { recent = (JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown[]).filter((c): c is string => typeof c === 'string' && HEX.test(c)).slice(0, 3) } catch { /* 读不出来就当没挑过 */ }
function remember(c: string): void {
  recent = [c, ...recent.filter((x) => x !== c)].slice(0, 3)
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)) } catch { /* 存不上:只记这一程 */ }
}
/** 一次手势(按下到抬起,或一次按键)留下的东西:删掉了哪些批注、白板那边变没变。撤销 / 重做按它走。 */
interface Step { annots: Annot[]; board: boolean; /** 笔尾橡皮擦掉的笔迹 / 形状(不走引擎的撤销栈,我们自己放回去)。 */ ink?: any[] }
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

/** 手写笔模式:笔一碰到页面就自动打开。开着的时候手指只滚动页面,不画、不放批注;笔和鼠标照常用当前的工具。 */
let penMode = false
/** 这一程见过手写笔(见过才在工具栏上放那颗开关)。 */
let penSeen = false
function setPenMode(on: boolean): void {
  if (penMode === on) return
  penMode = on
  for (const r of readers) {
    r.renderToolbar()
    if (!on) r.remountBoard() // 引擎自己也记着「见过笔」、从此不让手指画;关掉时重挂一次让它忘掉
  }
}

let panelOpened = false
/** 这个阅读器旁边有没有放面板的右栏。两种没有:
 *  ① 标签移到新窗口后的那个窗口 —— 三个面板没处放,开进主区会把 PDF 这个标签顶掉,面板自己也因为没有阅读器是空的;
 *  ② 阅读器开在对话旁边那一格里(聊天里点引用、Agent 把 PDF 摆上台)—— 右栏一开,那一格就被顶掉,PDF 反而看不见了。
 *  ponytail: ② 认的是宿主那一格的类名 .agent-desk(已发布的宿主上没有别的办法知道);宿主给出正式的「我在哪种容器里」之后换掉。 */
export const hasRight = (at?: Element | null): boolean => !!ctx.viewLocations?.includes('right') && !at?.closest('.agent-desk')
/** 把批注 / 大纲 / 对话开进右栏;没有右栏的地方什么都不做(对应的按钮也不出现)。 */
export function openPanel(id: 'annots' | 'outline' | 'chat' = 'annots', at?: Element | null): void {
  if (!hasRight(at)) return
  const open = (v: string): void => ctx.openView(v, { location: 'right' })
  // 第一次:三个标签按「批注 / 大纲 / 对话」的顺序开出来,再回到要看的那个。
  if (!panelOpened) { open('annots'); open('outline'); if (ctx.tangu?.mountChat) open('chat') }
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
  /** 选中的批注(点一条是一条,框选可以是好几条)。 */
  readonly sel = new Set<string>()
  private tool: Tool = 'select'
  private log: Step[] = []
  private redoLog: Step[] = []
  /** 正按着的这一下(选择工具下的点选 / 框选、橡皮)。只认按下的那一个指针。 */
  private press: { id: number; x: number; y: number; lx: number; ly: number; onBoard: boolean; hit: string | null; shift: boolean; erased: Set<string>; tail: boolean; inkGone: any[] } | null = null
  /** 落在白板层上、被我们拿来滚页面的那根手指(far = 离落点最远到过多远:没怎么动就是一次轻点)。 */
  private finger: { id: number; x: number; y: number; x0: number; y0: number; far: number } | null = null
  /** 笔尖正按在页面上(这时落下来的多半是手掌,不拿它滚页面)。 */
  private penDown = false
  /** 换到橡皮之前手上的工具(E 键、手指连点两下再回去用)。 */
  private beforeEraser: Tool = 'select'
  private lastTap = 0
  /** 笔尾橡皮刚记过一手:引擎不知道这一手,它那边旧的「重做」还留着。账上没得重做时别再去叫引擎重做(会把早先撤销掉的东西翻回来)。 */
  private redoCut = false
  private color = COLORS[0]
  private dead = false
  private readonly subs = new Set<() => void>()
  private readonly layers = new Map<number, HTMLElement>()
  private readonly mo: MutationObserver
  private readonly off: (() => void)[] = []
  private pop: HTMLElement | null = null
  /** 宿主的划线条(新宿主才有);没有就照旧自己画浮条 .pr-selpop。 */
  private readonly bar: HostSelectionBarHandle | null
  private barShown = false
  /** 在页面里按下的那个指针。按在划线条上的那一下(条挂在 body 下、随即收起),松手常常落回页面:那不是一次新的选择。 */
  private downInPage: number | null = null
  /** 划线条上的取色器打开时那段选区(取色面板不挡操作,挑好之前选区可能已经换了);在阅读器里再按一下就作废。 */
  private pendingPick: { pages: PageQuads[]; text: string } | null = null
  private justMade = 0
  private thumbsBuilt = false
  private pendingGoto: { page: number; quote?: string } | null = null
  /** 容器当前有尺寸、且页面已经按这个尺寸排过(由 ResizeObserver 维护)。 */
  private sized = false
  /** 查找条里现在这句是落点带来的引语(不是用户自己搜的):下一个不带引语的落点到了要把它撤掉。 */
  private quoteFind = false
  readonly ink: InkLayer | null

  constructor(host: HTMLElement, readonly pdfPath: string) {
    this.root = el(`<div class="pr-root">
      <div class="pr-toolbar"></div>
      <div class="pr-findbar" hidden></div>
      <div class="pr-body">
        <div class="pr-side" hidden><div class="pr-thumbs"></div></div>
        <div class="pr-viewport">
          <div class="pr-container" tabindex="-1"><div class="pdfViewer"></div></div>
          <div class="pr-board"></div>
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
    // 共用的划线条:翻译、问 Tangu、别的插件的动作都在上面,我们的颜色 / 划线 / 批注是本视图的工具。
    // 文字层是我们自己摆的、只在选择工具下算数,所以不让宿主自己看选区(watch: false),由 onSelection 报。
    this.bar = ctx.ui?.mountSelectionBar?.(this.root, {
      view: 'pdf',
      watch: false,
      ask: (s) => this.ask(s.text, this.page),
      source: () => ({ title: baseOf(this.pdfPath), path: this.pdfPath, page: this.page }),
    }) ?? null
    if (this.bar) this.off.push(() => this.bar!.dispose())

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

  /** 只选中一条时是它(批注卡、右栏列表跟着它走)。 */
  get selected(): string | null { return this.sel.size === 1 ? [...this.sel][0] : null }
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
    eventBus.on('pagesinit', () => { viewer.currentScaleValue = 'page-width'; this.flushGoto() })
    eventBus.on('pagerendered', (e: { pageNumber: number }) => { this.paintPage(e.pageNumber - 1); this.ink?.onPageRendered(e.pageNumber - 1) })
    eventBus.on('pagechanging', () => { this.syncBottombar(); this.syncThumbs(); this.emit() })
    eventBus.on('scalechanging', () => { this.syncBottombar(); this.closePop(); this.ink?.syncViewport() })
    eventBus.on('updatefindmatchescount', (e: any) => this.syncFind(e.matchesCount))
    eventBus.on('updatefindcontrolstate', (e: any) => this.syncFind(e.matchesCount, e.state))

    // ⌘/Ctrl + 滚轮、触控板捏合(= 带 ctrlKey 的滚轮)缩放,以光标为中心。pdf.js 的组件包不带这一手。
    on(container, 'wheel', (ev: WheelEvent) => this.onWheel(ev), { passive: false })
    // 划线条是按当时的位置摆在视口上的:页面一滚就不在选区旁边了。
    on(container, 'scroll', () => { this.ink?.onScroll(); this.hideBar() }, { passive: true })
    on(container, 'pointerdown', (ev: PointerEvent) => { this.downInPage = ev.pointerId; this.onDown(ev) })
    on(container, 'pointerup', (ev: PointerEvent) => {
      const fromPage = !this.bar || this.downInPage === ev.pointerId
      if (this.downInPage === ev.pointerId) this.downInPage = null
      if (fromPage && !inPop(ev)) setTimeout(() => this.onSelection(), 0)
    })
    // 在页面里按下、拖到页面外才松手:也是一次选择(冒泡阶段,排在上面那条后面 —— 松在页面里的那一下上面已经处理并清掉了)。
    on(window, 'pointerup', (ev: PointerEvent) => {
      if (this.downInPage !== ev.pointerId) return
      this.downInPage = null
      if (this.bar) setTimeout(() => this.onSelection(), 0)
    })
    on(window, 'pointercancel', (ev: PointerEvent) => { if (this.downInPage === ev.pointerId) this.downInPage = null })
    on(container, 'click', (ev: MouseEvent) => this.onClick(ev))
    on(this.root, 'pointerdown', (ev: PointerEvent) => {
      setActive(this)
      // 点在浮层之外:收起浮层(点另一条批注、点「更多」按钮各有各的处理,不在这里收)。
      const tg = ev.target as HTMLElement
      if (this.pop && !inPop(ev) && !tg.closest('[data-a], [data-act="more"]')) this.closePop()
      this.hideBar() // 条在 body 下:按在这个阅读器里的任何地方都是「点到条外面」
      this.pendingPick = null
    }, { capture: true })
    on(this.root, 'focusin', () => setActive(this))
    on(this.root, 'keydown', (ev: KeyboardEvent) => this.onKey(ev))
    // 捕获阶段:白板引擎的键盘处理挂在它自己的容器上,删除 / 撤销要赶在它前面看到。
    on(this.root, 'keydown', (ev: KeyboardEvent) => this.onKeyFirst(ev), { capture: true })
    // 白板层盖在页面上面,指针落在它身上时容器听不到:这几个在外层的捕获阶段听。
    const vp = this.q('.pr-viewport')
    on(vp, 'pointerdown', (ev: PointerEvent) => this.onPressDown(ev), { capture: true })
    on(vp, 'pointermove', (ev: PointerEvent) => this.onPressMove(ev), { capture: true })
    on(window, 'pointerup', (ev: PointerEvent) => this.onPressUp(ev), { capture: true })
    on(window, 'pointercancel', (ev: PointerEvent) => this.onPressUp(ev), { capture: true })
    on(document, 'selectionchange', () => this.onSelChange())
    on(this.root, 'click', (ev: MouseEvent) => this.onAct(ev))
    on(this.root, 'change', (ev: Event) => {
      const i = ev.target as HTMLInputElement
      if (!i.matches?.('input[type="color"][data-color]')) return
      const c = i.value.toLowerCase()
      remember(c)
      if (i.dataset.color === 'ink-color') { this.ink?.setColor(c); this.renderToolbar() } else this.pickColor(c, i)
    })

    const ro = new ResizeObserver(() => {
      this.hideBar() // 切走标签页、拖分栏:条不跟着这个视图藏起来 / 挪走
      this.sized = container.clientHeight > 0
      if (this.dead || !this.pdf) return
      const cur = viewer.currentScaleValue
      if (cur === 'page-width' || cur === 'page-fit') viewer.currentScaleValue = cur
      this.ink?.syncViewport()
      if (this.sized) this.flushGoto() // 在后台收到的落点,回到前台、页面按新尺寸排好之后再跳
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
    if (ev.key !== 'Escape') return
    if (this.pop) this.closePop()
    else if (!this.q('.pr-findbar').hidden) this.toggleFind(false)
    else if (this.tool !== 'select') this.setTool('select')
    else if (this.sel.size) this.select(null)
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
      case 'panel': openPanel('annots', this.root); break
      case 'more': this.openMore(b); break
      case 'zoom-in': this.viewer.increaseScale(); break
      case 'zoom-out': this.viewer.decreaseScale(); break
      case 'prev': this.viewer.currentPageNumber = Math.max(1, this.page - 1); break
      case 'next': this.viewer.currentPageNumber = Math.min(this.pageCount, this.page + 1); break
      case 'thumb': this.viewer.currentPageNumber = Number(v); break
      case 'penmode': setPenMode(!penMode); break
      case 'pen': this.ink?.setPen(v); this.renderToolbar(); break
      case 'shape': this.ink?.setShape(v); this.renderToolbar(); break
      case 'ink-color': this.ink?.setColor(v); this.renderToolbar(); break
      case 'ink-width': this.ink?.setWidth(Number(v)); this.renderToolbar(); break
      case 'undo': this.undo(); break
      case 'redo': this.redo(); break
    }
  }

  // ── 工具栏 ──────────────────────────────────────────────────────────────────────
  renderToolbar(): void {
    // 提示上带快捷键(工具、形状才有);读屏念名字,键另写在 aria-keyshortcuts 上。
    const btn = (act: string, ic: string, title: string, on = false, v = ''): string => {
      const key = act === 'tool' || act === 'shape' ? TOOL_KEY[v] : ''
      return `<button class="pr-btn pr-tool${on ? ' on' : ''}" data-act="${act}" data-v="${v}" title="${esc(title)}${key ? ` (${key})` : ''}" aria-label="${esc(title)}"${key ? ` aria-keyshortcuts="${key}"` : ''}${on ? ' aria-pressed="true"' : ''}>${icon(ic)}</button>`
    }
    const sep = '<span class="pr-sep"></span>'
    const tools = this.tools().map(([k, ic]) => btn('tool', ic, t(`tool.${k}`), this.tool === k, k)).join('')
    const inking = this.ink && BOARD_TOOLS.includes(this.tool)
    const mid = inking ? this.ink!.toolbarHtml(btn, sep) : this.dotsHtml(this.color, 'color')
    // 整条重画,被点的那颗按钮也一起换掉 —— 键盘焦点原来在工具栏上的话会掉到 body 上,接下来的按键(快捷键、Esc、撤销、删除)就没人听了。
    // 重画之后还给同一颗按钮;它不在了(换了工具,那一排没了)就还给页面。
    const bar = this.q('.pr-toolbar'), f = document.activeElement as HTMLElement | null, had = !!f && bar.contains(f)
    // 手写 / 形状的那一排(笔、颜色、粗细、撤销)太长,不放进工具栏:浮在页面上方(pr-palette)。工具栏因此总是一行,换工具时页面不跟着跳。
    bar.innerHTML =
      `<span class="pr-group">${btn('thumbs', 'panel-left', t('tool.thumbs'), !this.q('.pr-side').hidden)}${sep}${tools}</span>` +
      `<span class="pr-group${inking && this.tool !== 'eraser' ? ' pr-palette' : ''}">${sep}${mid}</span>` +
      `<span class="pr-group pr-right">${btn('find', 'search', t('tool.find'), !this.q('.pr-findbar').hidden)}` +
      `${penSeen ? btn('penmode', 'pen', t('tool.penMode'), penMode) : ''}${hasRight(this.root) ? btn('panel', 'panel-right', t('tool.panel')) : ''}${btn('more', 'ellipsis', t('tool.more'))}</span>`
    if (had) (bar.querySelector<HTMLElement>(`[data-act="${f!.dataset.act}"][data-v="${f!.dataset.v ?? ''}"]`) ?? this.container).focus({ preventScroll: true })
  }

  /** 一排色点:固定的几种,后面跟着自己挑过的(最近三种;这条批注正用着的不在里面也补上),最后一颗是取色器,什么颜色都行。 */
  dotsHtml(current: string | null, act: string, colors = COLORS): string {
    const own = [...new Set([...(current && HEX.test(current) ? [current] : []), ...recent])].filter((c) => !colors.includes(c)).slice(0, 3)
    const custom = esc(t('tool.customColor'))
    return `<span class="pr-dots" role="group" aria-label="${esc(t('tool.color'))}">${[...colors, ...own].map((c) =>
      `<button class="pr-dot${c === current ? ' on' : ''}" data-act="${act}" data-v="${c}" style="--c:${c}" title="${c}" aria-label="${c}"></button>`).join('')}` +
      `<label class="pr-dot pr-custom" title="${custom}"><input type="color" data-color="${act}" value="${own[0] ?? colors[0]}" aria-label="${custom}"></label></span>`
  }

  private tools(): [Tool, string][] { return TOOLS.filter(([k]) => this.ink || !BOARD_TOOLS.includes(k)) }

  /** 橡皮和上一个工具来回换(E 键、手写笔模式下手指连点两下):白板的规矩。 */
  private toggleEraser(): void { this.setTool(this.tool === 'eraser' ? this.beforeEraser : 'eraser') }

  private setTool(tool: Tool): void {
    if (this.tool === tool && tool !== 'select') tool = 'select' // 再点一次当前工具 = 回到选择
    if (tool === 'eraser' && this.tool !== 'eraser') this.beforeEraser = this.tool
    this.tool = tool
    this.root.dataset.tool = tool
    this.pendingPick = null
    this.closePop()
    this.ghost(null)
    if (this.press) { const p = this.press; this.press = null; this.repaint(); if (p.tail) this.endTail(p, []) } // 还按着就换了工具:这一下作废(擦到一半变淡的恢复原样;笔尾已经擦掉的笔迹照样记账,好撤销)
    if (tool !== 'select') this.select(null)
    this.ink?.setTool(tool)
    this.renderToolbar()
  }

  private pickColor(c: string, from: HTMLElement): void {
    // 浮条 / 批注卡里的色点有自己的含义(给选区上色、给这条批注换色),工具栏上的才是「当前颜色」。
    if (from.dataset.color === 'sel') { // 宿主划线条那一格替它点开的取色器:落在打开时的那段选区上,作废了就不落
      const p = this.pendingPick
      this.pendingPick = null
      if (p?.pages.length) { this.color = c; this.markSelection('highlight', p.pages, p.text); this.renderToolbar() }
      return
    }
    const kind = from.closest<HTMLElement>('.pr-pop')?.dataset.kind
    if (kind === 'sel') { this.color = c; this.markSelection('highlight'); this.renderToolbar(); return }
    if (kind === 'card') {
      if (!this.selected) return
      this.doc?.patch(this.selected, { color: c })
      // 重画这一排:刚用取色器挑的那种原来不在里面。被点的那颗跟着换掉了,键盘焦点还给新的那颗(不然掉到 body 上,Esc、撤销没人听)。
      const dots = this.pop!.querySelector('.pr-dots')!, had = dots.contains(document.activeElement)
      dots.outerHTML = this.dotsHtml(c, 'color')
      if (had) (this.pop!.querySelector<HTMLElement>('.pr-dot.on') ?? this.container).focus({ preventScroll: true })
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
      const sel = this.sel.has(a.id) ? ' sel' : ''
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

  // ── 指针:放便签 / 文字 ───────────────────────────────────────────────────────────
  private onDown(ev: PointerEvent): void {
    const target = ev.target as HTMLElement
    if (inPop(ev)) return
    if (document.activeElement !== this.container && !target.closest('[contenteditable], input, textarea')) this.container.focus({ preventScroll: true })
    if (ev.button !== 0 || !this.doc || target.closest('[data-a]')) return
    const tool = this.tool
    if ((tool !== 'note' && tool !== 'text') || (penMode && ev.pointerType === 'touch')) return
    const at = pageAt(this.viewer, ev.clientX, ev.clientY)
    if (!at) return
    ev.preventDefault()
    const a = this.doc.add({ type: tool, page: at.page, color: this.color, rect: [at.x, at.y, at.x, at.y], ...(tool === 'text' ? { text: '' } : {}) })
    this.justMade = performance.now()
    this.setTool('select')
    this.select(a.id)
    if (tool === 'text') this.layerOf(at.page)?.querySelector<HTMLElement>(`.pr-text[data-a="${a.id}"]`)?.focus()
    else this.openCard(a.id, true)
  }

  // ── 一次按下到抬起:手写笔模式、橡皮擦批注、点选 / 框选、记撤销 ─────────────────────────
  private onPressDown(ev: PointerEvent): void {
    if (ev.pointerType === 'pen') { this.penDown = true; penSeen = true; if (!penMode) setPenMode(true); else if (!this.q('[data-act="penmode"]')) this.renderToolbar() }
    const onBoard = !!this.ink?.owns(ev.target)
    // 手指落在白板层上,而这一下不该是「画」:手写笔模式开着(手指从不画),或者是选择工具
    // (手指没有悬停,白板层收不收指针还停在上一次鼠标的位置上,不能让一次本该点链接的轻点落到引擎手里)。
    // 不交给引擎,我们拿它滚页面;没怎么动就抬起的,当成点在页面上(见 onPressUp)。落在页面上的手指浏览器自己会滚。
    // ponytail: 没有惯性,也没有双指缩放;要有得自己算速度 / 两指间距。
    if (ev.pointerType === 'touch' && (penMode || this.tool === 'select')) {
      if (!onBoard) return
      ev.stopPropagation(); ev.preventDefault()
      this.finger ??= { id: ev.pointerId, x: ev.clientX, y: ev.clientY, x0: ev.clientX, y0: ev.clientY, far: 0 }
      return
    }
    // 笔尾的橡皮(指针事件里是 5 号键):按着的这一下当橡皮用,手上的工具不换 —— 白板的规矩。
    // 白板层的工具由我们定死,引擎因此不接这颗键(它会拿当前的笔照画)。所以这一下不给引擎看,批注和画上去的东西都由我们自己擦。
    // 已经是橡皮工具时照常交给引擎。
    const tailEnd = ev.pointerType === 'pen' && ev.button === 5
    if (this.press?.tail && onBoard) { ev.stopPropagation(); ev.preventDefault(); return } // 笔尾按着的时候,别的指针不许去动白板(那一手谁也不记账)
    if ((ev.button !== 0 && !tailEnd) || inPop(ev) || !this.doc || this.press) return
    const tail = tailEnd && this.tool !== 'eraser' && (onBoard || this.container.contains(ev.target as Node))
    if (tail) { ev.stopPropagation(); ev.preventDefault() } // preventDefault:落在字上时别开始选字
    this.ink?.take() // 上一手之后才冒出来的变化(引擎给一笔收尾)归上一手,不算进这一手
    const x = ev.clientX, y = ev.clientY
    this.press = { id: ev.pointerId, x, y, lx: x, ly: y, onBoard, hit: onBoard && !tail && this.tool === 'select' ? this.ink!.hitAt(x, y) : null, shift: ev.shiftKey, erased: new Set(), tail, inkGone: [] }
    if (tail) { this.root.dataset.tail = ''; this.closePop(); this.eraseAlong(x, y) }
    else if (this.tool === 'select') {
      if (!onBoard) this.ink?.unpick()
      else { this.closePop(); if (!ev.shiftKey) this.selectMany([]) }
    } else if (this.tool === 'eraser' && onBoard) this.eraseAlong(x, y) // 只有按在白板层上才是在擦:底栏的按钮也在这块区域里,点它不能擦到它身后的批注
  }

  private onPressMove(ev: PointerEvent): void {
    const f = this.finger
    if (f && ev.pointerType === 'touch') {
      ev.stopPropagation()
      if (ev.pointerId !== f.id) return
      const c = this.container, z = c.offsetWidth ? c.getBoundingClientRect().width / c.offsetWidth : 1
      if (!this.penDown) c.scrollBy((f.x - ev.clientX) / z, (f.y - ev.clientY) / z)
      f.x = ev.clientX; f.y = ev.clientY
      f.far = Math.max(f.far, Math.hypot(f.x - f.x0, f.y - f.y0))
      return
    }
    const p = this.press
    if (p?.tail && ev.pointerId === p.id) { ev.stopPropagation(); if (ev.buttons) this.eraseAlong(ev.clientX, ev.clientY) }
    else if (p) { if (p.onBoard && this.tool === 'eraser' && ev.pointerId === p.id && ev.buttons) this.eraseAlong(ev.clientX, ev.clientY) }
    else if (!ev.buttons && ev.pointerType !== 'touch') this.ink?.hover(ev.clientX, ev.clientY)
  }

  private onPressUp(ev: PointerEvent): void {
    if (ev.pointerType === 'pen') this.penDown = false
    const f = this.finger
    if (f && ev.pointerType === 'touch') {
      ev.stopPropagation()
      if (ev.pointerId !== f.id) return
      this.finger = null
      // 手写笔模式下手指连点两下:橡皮和刚才的工具来回换(白板的规矩;选字、划线这些时候不换)。
      if (penMode && ev.type === 'pointerup' && f.far < 8 && BOARD_TOOLS.includes(this.tool)) {
        if (ev.timeStamp - this.lastTap < 300) { this.lastTap = 0; this.toggleEraser(); return }
        this.lastTap = ev.timeStamp
      }
      // 没怎么动:是一次轻点。点的是页面上的东西(链接、批注)就替它点下去。
      const under = ev.type === 'pointerup' && f.far < 8 ? document.elementsFromPoint(f.x0, f.y0).find((e) => !this.ink!.owns(e)) : null
      if (under && this.container.contains(under)) under.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: f.x0, clientY: f.y0 }))
      return
    }
    const p = this.press
    if (!p || ev.pointerId !== p.id || this.dead) return
    this.press = null
    if (p.tail) ev.stopPropagation()
    const cancelled = ev.type === 'pointercancel'
    if (cancelled) this.repaint() // 系统收走了这一下:不算数,变淡的批注恢复原样(笔尾已经擦掉的笔迹照样记账,好撤销)
    if (cancelled && !p.tail) return
    const moved = Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > 4, tool = this.tool
    let gone: Annot[] = []
    if (!cancelled && (tool === 'eraser' || p.tail) && p.erased.size) gone = this.doc?.removeMany([...p.erased]) ?? []
    if (p.tail) { this.endTail(p, gone); return }
    if (tool === 'select' && p.onBoard && this.ink) {
      if (p.hit) this.ink.pick([p.hit], p.shift)
      else if (moved) {
        // 框选:画上去的东西引擎自己选;批注由我们按同一个框来选(同一条规矩:要整个框住)。
        const r = { left: Math.min(p.x, ev.clientX), top: Math.min(p.y, ev.clientY), right: Math.max(p.x, ev.clientX), bottom: Math.max(p.y, ev.clientY) }
        this.ink.pick(this.ink.within(r), p.shift)
        this.selectMany([...(p.shift ? this.sel : []), ...this.annotsWithin(r)])
      } else this.ink.pick([], p.shift)
    }
    // 引擎处理这次抬起的监听挂在 window 上、排在我们后面:等它处理完再看白板那边变了没有。
    setTimeout(() => {
      if (this.dead) return
      this.step(gone) // 形状工具画完不跳回选择:和别的工具一样,留在手上接着画(Esc / 再点一次才回去)
    }, 0)
  }

  /** 橡皮扫过的批注(从上一个采样点到这一点,隔几像素取一个点):先标淡,抬起时一起删。 */
  private eraseAlong(x: number, y: number): void {
    const p = this.press!
    const n = Math.max(1, Math.ceil(Math.hypot(x - p.lx, y - p.ly) / 4))
    for (let i = 1; i <= n; i++) {
      const px = p.lx + ((x - p.lx) * i) / n, py = p.ly + ((y - p.ly) * i) / n
      const layer = this.layers.get(pageAt(this.viewer, px, py)?.page ?? -1)
      for (const m of layer?.querySelectorAll<HTMLElement>('.pr-marks > [data-a]') ?? []) {
        const r = m.getBoundingClientRect()
        if (px < r.left - 2 || px > r.right + 2 || py < r.top - 2 || py > r.bottom + 2) continue
        p.erased.add(m.dataset.a!)
        layer!.querySelectorAll(`[data-a="${m.dataset.a}"]`).forEach((e) => e.classList.add('erasing'))
      }
      if (p.tail) p.inkGone.push(...(this.ink?.eraseAt(px, py) ?? []))
    }
    p.lx = x; p.ly = y
  }

  /** 整个落在这块客户区矩形里的批注(跨几行的高亮要每一行都在里面)。 */
  private annotsWithin(r: { left: number; top: number; right: number; bottom: number }): string[] {
    const inside = new Map<string, boolean>()
    for (const m of this.container.querySelectorAll<HTMLElement>('.pr-marks > [data-a]')) {
      const b = m.getBoundingClientRect(), id = m.dataset.a!
      inside.set(id, (inside.get(id) ?? true) && b.left >= r.left && b.top >= r.top && b.right <= r.right && b.bottom <= r.bottom)
    }
    return [...inside].filter(([, all]) => all).map(([id]) => id)
  }

  // ── 撤销 / 重做 ──────────────────────────────────────────────────────────────────
  /** 记下刚结束的这一手。白板那边变没变现问(返回它)。
   *  ponytail: 白板的撤销栈是引擎自己的,我们只记「这一手动没动过它」、撤销时叫它退一步;引擎不经指针和删除键的改动
   *  (方向键挪动之类)不在这本账上,混着撤销时先后可能差一步,不会丢东西。要逐条对上得等宿主把引擎的历史露出来。 */
  private step(annots: Annot[]): boolean {
    const board = this.ink?.take() ?? false
    if (annots.length || board) { this.log.push({ annots, board }); this.redoLog.length = 0 }
    if (board) this.redoCut = false // 引擎自己记了新的一手,它那边旧的重做已经作废
    return board
  }
  /** 笔尾橡皮这一手收尾:白板上的是我们自己擦的(不经引擎),单记一笔,撤销时自己放回去。 */
  private endTail(p: NonNullable<Reader['press']>, annots: Annot[]): void {
    delete this.root.dataset.tail
    const board = this.ink?.take() ?? false // 我们自己擦的不算在里面(见 InkLayer.replace);真是引擎动过才是 true
    if (!annots.length && !p.inkGone.length && !board) return
    this.log.push({ annots, board, ink: p.inkGone }); this.redoLog.length = 0
    if (p.inkGone.length) this.redoCut = true
  }
  undo(): void {
    const s = this.log.pop()
    if (s?.annots.length) this.doc?.restore(s.annots)
    if (s?.ink?.length) this.ink?.putBack(s.ink)
    if (!s || s.board) this.ink?.undo()
    if (s) this.redoLog.push(s)
  }
  redo(): void {
    const s = this.redoLog.pop()
    // 记下删掉时的样子:撤销之后用户可能又改过评论 / 标签,下次撤销放回的得是改过的这一份。
    if (s?.annots.length) { for (const a of s.annots) this.sel.delete(a.id); s.annots = this.doc?.removeMany(s.annots.map((a) => a.id)) ?? [] }
    if (s?.ink?.length) s.ink = this.ink?.drop(s.ink) ?? s.ink
    if (s ? s.board : !this.redoCut) this.ink?.redo()
    if (s) this.log.push(s)
  }

  /** 把白板层卸掉重挂。引擎的撤销栈跟着没了,账上「白板那一步」作废(删掉的批注照样能撤销回来)。 */
  remountBoard(): void {
    const keep = (l: Step[]): Step[] => l.filter((s) => s.annots.length || s.ink?.length).map((s) => ({ annots: s.annots, board: false, ink: s.ink }))
    this.log = keep(this.log); this.redoLog = keep(this.redoLog)
    this.ink?.remount()
  }

  private onKeyFirst(ev: KeyboardEvent): void {
    const k = ev.key.toLowerCase()
    // 查找也得赶在引擎前面:焦点在白板上时(刚画过、刚点过空白)它把 ⌘/Ctrl+F 当成自己的「搜索画布」吃掉,而它在这里没有界面。
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && k === 'f') { ev.preventDefault(); ev.stopPropagation(); this.toggleFind(true); return }
    // Esc 也一样:焦点在白板上时引擎自己收下、不往上冒。我们有事可做(收浮层、关查找、回到选择工具)就先做并拦下;没事可做再给它(放下它选中的东西)。
    if (ev.key === 'Escape' && this.ink?.owns(ev.target)) { this.onKey(ev); return }
    if ((ev.target as HTMLElement).closest?.('input, textarea, select, [contenteditable]')) return
    if ((ev.metaKey || ev.ctrlKey) && (k === 'z' || k === 'y')) {
      ev.preventDefault(); ev.stopPropagation() // 撤销只走我们这一本账(它会去叫引擎退一步),不让引擎自己再退一次
      if (k === 'y' || ev.shiftKey) this.redo(); else this.undo()
      return
    }
    if (!ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && !ev.repeat && !ev.isComposing) {
      const [tool, shape] = /^[1-9]$/.test(k) ? [this.tools()[Number(k) - 1]?.[0]] : KEY_TOOL[k] ?? []
      if (tool && (this.ink || !BOARD_TOOLS.includes(tool))) {
        ev.preventDefault(); ev.stopPropagation()
        if (shape) this.ink!.setShape(shape)
        if (tool === 'eraser') this.toggleEraser()
        else if (this.tool !== tool) this.setTool(tool)
        else this.renderToolbar() // 还是这个工具,只是换了形状
        return
      }
    }
    if ((ev.key !== 'Delete' && ev.key !== 'Backspace') || this.tool !== 'select') return
    // 画上去的东西引擎自己删(这个按键接着会到它那里);选中的批注我们删。两边记成同一手。
    this.ink?.take()
    const gone = this.doc?.removeMany([...this.sel]) ?? []
    if (gone.length) { this.sel.clear(); this.closePop() }
    setTimeout(() => { if (!this.dead) this.step(gone) }, 0)
  }

  // ── 选中文字 ────────────────────────────────────────────────────────────────────
  private selText(): string { return (window.getSelection()?.toString() ?? '').replace(/\s+/g, ' ').trim() }

  private onSelection(): void {
    if (this.dead || !this.doc) return
    const sel = window.getSelection()
    const inside = sel && !sel.isCollapsed && sel.anchorNode && this.container.contains(sel.anchorNode) && (sel.anchorNode.parentElement?.closest('.textLayer'))
    if (!inside) { if (this.pop?.dataset.kind === 'sel') this.closePop(); this.hideBar(); return }
    if (this.tool === 'highlight' || this.tool === 'underline') { this.markSelection(this.tool); return }
    if (this.tool !== 'select') return
    const rects = [...sel!.getRangeAt(0).getClientRects()].filter((r) => r.width > 1 && r.height > 1)
    if (!rects.length) return
    if (this.bar) { this.showBar(rects); return }
    // 没有共用划线条的宿主(2.13.3 及更早):自己画浮条。
    const dots = this.dotsHtml(null, 'color')
    const b = (act: string, ic: string, tip: string, txt = ''): string => `<button class="pr-pbtn${txt ? ' txt' : ''}" data-pop="${act}" title="${esc(tip)}" aria-label="${esc(tip)}">${icon(ic, 14)}${esc(txt)}</button>`
    const pop = el(`<div class="pr-pop pr-selpop" data-kind="sel">${dots}<span class="pr-sep"></span>${b('underline', 'underline', t('tool.underline'))}${b('strike', 'strikethrough', t('tool.strike'))}${b('comment', 'sticky-note', t('sel.comment'))}<span class="pr-sep"></span>${b('copy', 'copy', t('sel.copy'))}${b('cite', 'text-quote', t('sel.cite'), t('sel.cite'))}${b('ask', 'message-square-quote', t('sel.ask'))}</div>`)
    pop.addEventListener('pointerdown', (e) => e.preventDefault()) // 点浮条不许把选区点没
    pop.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-pop]')?.dataset.pop
      if (!act) return
      const text = this.selText()
      if (act === 'underline' || act === 'strike') this.markSelection(act)
      else if (act === 'comment') { const a = this.markSelection('highlight'); if (a) { this.select(a.id); this.openCard(a.id, true) } }
      else if (act === 'copy') { void navigator.clipboard?.writeText(text); ctx.notify?.(t('copy.done')); this.closePop() }
      else if (act === 'cite') { this.cite({ page: selectionToQuads(this.viewer)[0]?.page ?? this.page - 1, text }); this.closePop() }
      else if (act === 'ask') { this.ask(text, this.page); this.closePop() }
    })
    const top = rects.reduce((m, r) => Math.min(m, r.top), Infinity), left = rects.reduce((m, r) => Math.min(m, r.left), Infinity)
    this.showPop(pop, { left, top, bottom: rects.reduce((m, r) => Math.max(m, r.bottom), -Infinity) }, 'above')
  }

  /** 划线条上本视图的工具,和自己画的浮条是同一套:颜色点(含最近挑过的、取色器)、下划线、删除线、写批注、复制、复制引用。 */
  private barTools(): HostSelectionBarTool[] {
    const hl = (c: string) => (): void => { this.color = c; this.markSelection('highlight'); this.renderToolbar() }
    return [
      ...[...COLORS, ...recent.filter((c) => !COLORS.includes(c))].map((c) => ({ id: `color-${c.slice(1)}`, title: c, color: c, run: hl(c) })),
      // ponytail: 宿主把 color 画成色点的 background,渐变照样画得出来:拿它当取色器那颗彩虹点(和工具栏上那颗同一个样子)。
      { id: 'custom-color', title: t('tool.customColor'), color: 'conic-gradient(#ff6666, #ffd400, #5fb236, #2ea8e5, #a28ae5, #ff6666)', run: () => this.pickSelColor() },
      { id: 'underline', title: t('tool.underline'), icon: 'underline', run: () => { this.markSelection('underline') } },
      { id: 'strike', title: t('tool.strike'), icon: 'strikethrough', run: () => { this.markSelection('strike') } },
      { id: 'comment', title: t('sel.comment'), icon: 'annotate', run: () => { const a = this.markSelection('highlight'); if (a) { this.select(a.id); this.openCard(a.id, true) } } },
      { id: 'copy', title: t('sel.copy'), icon: 'copy', run: () => { void navigator.clipboard?.writeText(this.selText()); ctx.notify?.(t('copy.done')); this.closePop() } },
      { id: 'cite', title: t('sel.cite'), icon: 'cite', run: () => { this.cite({ page: selectionToQuads(this.viewer)[0]?.page ?? this.page - 1, text: this.selText() }); this.closePop() } },
    ]
  }

  /** 条上放不了 <input type="color">:页面里留一个看不见的,按条上那颗彩虹点时替它点开。挑好之后走 root 的 change → pickColor。 */
  private pickSelColor(): void {
    let i = this.root.querySelector<HTMLInputElement>('.pr-selcolor')
    if (!i) { i = el<HTMLInputElement>('<input type="color" class="pr-selcolor" data-color="sel" tabindex="-1" aria-hidden="true">'); this.root.append(i) }
    i.value = recent[0] ?? COLORS[0]
    this.pendingPick = { pages: selectionToQuads(this.viewer), text: this.selText() }
    i.click() // 按条上那一下是 mousedown,算用户手势,取色器开得出来
  }

  private showBar(rects: DOMRect[]): void {
    const rect = { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)), top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) }
    this.bar!.update({ tools: this.barTools() }) // 最近挑过的颜色、界面语言随时会变:每次出条现算
    this.bar!.show({ text: this.selText(), rect })
    this.barShown = true
  }

  /** 条出着的时候选区变了(Shift+方向键、点到别处收起了):条跟着换到新的那段,或者收起 —— 免得条上的动作拿到的是旧的那段字。 */
  private syncBar(): void {
    if (!this.barShown) return
    const sel = window.getSelection()
    const rects = sel && !sel.isCollapsed && sel.anchorNode && this.container.contains(sel.anchorNode)
      ? [...sel.getRangeAt(0).getClientRects()].filter((r) => r.width > 1 && r.height > 1) : []
    if (rects.length) this.showBar(rects)
    else this.hideBar()
  }

  /** 收起划线条(结果卡不跟着收:它点到外面自己会关)。 */
  private hideBar(): void {
    if (!this.barShown) return
    this.barShown = false
    this.bar?.hide()
  }

  /** 高亮 / 下划线工具下,选区每变一次就把「松手会得到的那几条」画出来(浏览器自己的选区蓝底这时是藏着的)。 */
  private onSelChange(): void {
    this.syncBar()
    if (this.tool !== 'highlight' && this.tool !== 'underline') return
    const sel = window.getSelection()
    this.ghost(sel && !sel.isCollapsed && sel.anchorNode && this.container.contains(sel.anchorNode) ? selectionToQuads(this.viewer) : null)
  }
  private ghost(pages: PageQuads[] | null): void {
    for (const g of this.container.querySelectorAll('.pr-ghosts')) g.remove()
    const cls = this.tool === 'highlight' ? 'pr-hl' : 'pr-ul'
    for (const p of pages ?? []) {
      const vp1 = this.viewer.getPageView(p.page)?.viewport.clone({ scale: 1 })
      if (!vp1) continue
      this.layerOf(p.page)?.append(el(`<div class="pr-marks pr-ghosts">${p.quads.map((q) => { const b = quadBox(vp1, q); return `<i class="${cls}" style="--x:${n2(b[0])};--y:${n2(b[1])};--w:${n2(b[2])};--h:${n2(b[3])};--c:${this.color}"></i>` }).join('')}</div>`))
    }
  }

  /** 把当前选区变成一条(跨页则每页一条)批注,返回第一条。 */
  private markSelection(type: 'highlight' | 'underline' | 'strike', pages = selectionToQuads(this.viewer), text = this.selText()): Annot | null {
    if (!this.doc) return null
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

  select(id: string | null): void { this.selectMany(id ? [id] : []) }
  selectMany(ids: string[]): void {
    if (ids.length === this.sel.size && ids.every((i) => this.sel.has(i))) return
    this.sel.clear()
    for (const i of ids) this.sel.add(i)
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
      <div class="pr-card-top">${this.dotsHtml(a.color, 'color')}<span class="pr-flex"></span>${a.text || a.comment ? ib('cite', 'text-quote', t('sel.cite')) + ib('ask', 'message-square-quote', t('sel.ask')) : ''}${ib('delete', 'trash-2', t('card.delete'))}</div>
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
      if (act === 'delete') { this.closePop(); this.sel.delete(id); this.log.push({ annots: this.doc?.removeMany([id]) ?? [], board: false }); this.redoLog.length = 0 }
      else if (act === 'cite') this.cite(a)
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
    this.hideBar()
    const had = this.pop?.contains(document.activeElement)
    this.pop?.remove()
    this.pop = null
    if (had && !this.dead) this.container.focus({ preventScroll: true }) // 焦点原来在浮层里:还给页面,不然删除 / 撤销这些按键没人听
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

  /** 宿主送来的落点:带页码的链接(包括「复制引用」贴出去的那种)、聊天引用。
   *  页面还没排好、或者这个标签刚从后台回来还没按新尺寸排过(sized)就先记着。后一种是实测出来的:标签在后台时
   *  容器没有尺寸、页面被缩到最小;宿主切回标签的同一拍落点就到了,这时容器已经有高度,但页面还是缩着的、
   *  根本滚不动,pdf.js 随即把页码改回第 1 页。要等上面那个 ResizeObserver 把缩放重算过再跳。
   *  引语走查找:只在文字层上标出来,不写进文件;查找条跟着打开,看得见标的是什么,也关得掉。 */
  goto(page: number, quote?: string): void {
    if (!this.viewer.pagesCount || !this.sized) { this.pendingGoto = { page, quote }; return }
    this.viewer.currentPageNumber = Math.min(this.pageCount, Math.max(1, Math.trunc(page) || 1))
    const input = this.q<HTMLInputElement>('.pr-findinput'), open = !this.q('.pr-findbar').hidden
    if (quote) {
      input.value = quote
      this.quoteFind = true
      if (!open) this.toggleFind(true)
      this.find(false, false)
    } else if (this.quoteFind) {
      // 上一个落点带的引语还在找(或还标着):撤掉。不撤的话它晚一步找到,会把页面从这一页拉回那句话那里。
      this.quoteFind = false
      input.value = ''
      this.find(false, false)
      if (open) this.toggleFind(false)
    }
  }

  private flushGoto(): void {
    const g = this.pendingGoto
    this.pendingGoto = null
    if (g) this.goto(g.page, g.quote)
  }

  // ── 查找 ────────────────────────────────────────────────────────────────────────
  private renderFindbar(): void {
    const b = (act: string, ic: string, tip: string): string => `<button class="pr-btn pr-tool" data-act="${act}" title="${esc(tip)}" aria-label="${esc(tip)}">${icon(ic, 14)}</button>`
    const bar = this.q('.pr-findbar')
    const old = bar.querySelector('input')?.value ?? ''
    bar.innerHTML = `<input class="pr-findinput" type="search" placeholder="${esc(t('find.placeholder'))}"><span class="pr-findcount"></span>${b('find-prev', 'chevron-up', t('find.prev'))}${b('find-next', 'chevron-down', t('find.next'))}${b('find-close', 'x', t('find.close'))}`
    const input = bar.querySelector('input')!
    input.value = old
    input.addEventListener('input', () => { this.quoteFind = false; this.find(false, false) })
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

  // ── 引用 / 问 Tangu ──────────────────────────────────────────────────────────────
  /** 引用:原文 + 回到这一页的链接 + 评论,复制到剪贴板,到笔记里粘贴。 */
  cite(a: Pick<Annot, 'page' | 'text' | 'comment'>): void {
    const link = `[[${baseOf(this.pdfPath)}#page=${a.page + 1}|${t('note.pageLink', { n: a.page + 1 })}]]`
    const quote = (a.text ?? '').replace(/\s+/g, ' ').trim()
    void navigator.clipboard?.writeText(`${quote ? `> ${quote}\n> — ${link}\n` : `${link}\n`}${a.comment ? `\n${a.comment.trim()}\n` : ''}`)
    ctx.notify?.(t('cite.copied'), { level: 'success' })
  }

  /** 把一段原文递给 Tangu:挂成右栏对话输入框上方的引用条,不替用户发送。 */
  private ask(text: string, page: number): void {
    if (!text) return
    const quoted = `${text}\n\n— ${baseOf(this.pdfPath)} · ${t('card.page', { n: page })}`
    if (ctx.tangu?.mountChat && hasRight(this.root)) {
      openPanel('chat', this.root)
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
    if (!text.trim()) { if (this.sel.delete(id)) this.closePop(); this.doc.remove(id) }
    else this.doc.patch(id, { text })
  }
}

/** 文字框的失焦要在捕获阶段听(focusout 冒泡,但我们要在重画之前拿到内容)。 */
export function mountReader(host: HTMLElement, pdfPath: string, onGoto?: OnGoto): () => void {
  const r = new Reader(host, pdfPath)
  const onOut = (e: FocusEvent): void => r.commitText(e.target as HTMLElement)
  r.root.addEventListener('focusout', onOut)
  const offGoto = onGoto?.((to) => r.goto(to.page, to.quote))
  return () => { offGoto?.(); r.root.removeEventListener('focusout', onOut); r.dispose() }
}
