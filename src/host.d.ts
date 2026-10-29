interface HostFileIO { saveCopy?(name: string, bytes: Uint8Array): Promise<string | null>; readBytes(path: string): Promise<Uint8Array | null>; writeBytes(path: string, bytes: Uint8Array): Promise<void> }
// 宿主注入的 `ctx`(new Function('ctx', code) 的形参)。只声明本插件用到的面;带 ? 的是较新宿主才有的,用前探测。
// 完整契约见 Forsion-Genesis/desktop/frontend/src/amadeus/plugins/types.ts。

interface HostChatMount {
  ready: Promise<{ ok: boolean; sessionId?: string; error?: string }>
  quote(text: string): void
  prefill(text: string): void
  dispose(): void
}

/** 订阅落点(页码 1 起;quote = 要在那一页标出来的原文)。返回退订。 */
type OnGoto = (cb: (to: { page: number; quote?: string }) => void) => () => void

interface HostBoardScene { elements: readonly any[]; files?: Record<string, unknown> }
interface HostBoardViewport { scrollX: number; scrollY: number; zoom: number }
type HostBoardShape = 'rectangle' | 'ellipse' | 'arrow' | 'line'
type HostBoardTool = 'selection' | 'freedraw' | 'eraser' | HostBoardShape
interface HostBoardOptions {
  scene: HostBoardScene
  viewport: HostBoardViewport
  tool?: HostBoardTool
  pen?: string
  strokeColor?: string
  strokeWidth?: number
  theme?: 'light' | 'dark'
  onChange?(scene: HostBoardScene): void
  onWheel?(event: WheelEvent): void
  onReady?(): void
}
interface HostBoardHandle {
  update(patch: Partial<Pick<HostBoardOptions, 'scene' | 'viewport' | 'tool' | 'pen' | 'strokeColor' | 'strokeWidth' | 'theme'>>): void
  getScene(): HostBoardScene
  undo(): void
  redo(): void
  dispose(): void
}

/** 宿主的划线条(ctx.ui.mountSelectionBar,2.13.3 之后的桌面版本才有)。 */
interface HostSelectionBarSelection { text: string; markdown?: string }
interface HostSelectionBarTool { id: string; title: string; icon?: string; color?: string; on?: boolean; run(sel: HostSelectionBarSelection): void }
interface HostSelectionBarHandle {
  show(sel: { text: string; markdown?: string; rect: { left: number; right: number; top: number; bottom: number } }): void
  hide(): void
  update(opts: { tools?: HostSelectionBarTool[] }): void
  dispose(): void
}

declare const ctx: {
  app: {
    readFile(path: string): Promise<string | null>
    writeFile(path: string, text: string): Promise<void>
    listFiles?(): Promise<string[]>
    readBytes?(path: string): Promise<Uint8Array | null>
    writeBytes?(path: string, bytes: Uint8Array): Promise<void>
    watchFile?(path: string, cb: () => void): () => void
    workFolder?(): string
    openFile(path: string): void
    openNote?(path: string, options?: { reuseKey?: string; activate?: boolean; newTab?: boolean }): void
    getActivePage(): string | null
    getPage?(): { token: string }
    insertMarkdown?(token: string, markdown: string, where?: 'cursor' | 'start' | 'end'): boolean
    vaultRoot?(): string | null
    hostPath?(path: string): string | null
  }
  registerFileType(def: {
    id: string; extensions: string[]; icon?: string; title?: string; override?: boolean; external?: boolean
    /** onGoto:带页码的链接、聊天引用点过来的落点(2.13.2 之后的桌面版本才有;没有它的宿主上这类链接归内置阅读器)。 */
    mount(el: HTMLElement, file: { filePath: string; io?: HostFileIO; onGoto?: OnGoto }): (() => void | Promise<void>) | void
  }): boolean | void
  registerView(view: { id: string; title: string; icon?: string; mount(el: HTMLElement): (() => void) | void }): void
  openView(viewId: string, opts?: { location?: 'main' | 'left' | 'right' | 'bottom' }): void
  viewLocations?: readonly string[]
  notify?(message: string, opts?: { level?: 'info' | 'success' | 'warning' | 'error'; title?: string }): void
  getLocale?(): 'zh' | 'en'
  subscribeLocale?(cb: (locale: 'zh' | 'en') => void): () => void
  loadData?<T = unknown>(): Promise<T | null>
  saveData?(value: unknown): Promise<void>
  tangu?: {
    mountChat?(el: HTMLElement, o?: { agent?: string; folder?: string; title?: string }): HostChatMount
    startChat?(o: { prompt: string; send?: boolean; folder?: string }): Promise<{ ok: boolean; error?: string }>
  }
  ui?: {
    attachTooltip?(el: HTMLElement, content: string, opts?: { side?: 'top' | 'bottom' | 'left' | 'right' }): { dispose(): void }
    contextMenu?(at: { anchor: HTMLElement; align?: 'start' | 'end' }, items: { label: string; icon?: string; run(): void }[], opts?: { onClose?(): void }): () => void
    popover?(anchor: HTMLElement, opts: { side?: 'top' | 'bottom'; label?: string; mount(el: HTMLElement): void | (() => void); onClose?(): void }): { dispose(): void; update(): void }

    mountBoard?(el: HTMLElement, opts: HostBoardOptions): HostBoardHandle
    boardToSvg?(scene: HostBoardScene, opts?: { theme?: 'light' | 'dark'; padding?: number }): Promise<{ svg: SVGSVGElement; x: number; y: number; width: number; height: number } | null>
    mountSelectionBar?(root: HTMLElement, opts?: {
      view?: string
      tools?: HostSelectionBarTool[]
      ask?: ((sel: HostSelectionBarSelection) => void) | false
      source?(sel: HostSelectionBarSelection): { title?: string; path?: string; page?: number } | undefined
      watch?: boolean
    }): HostSelectionBarHandle
  }
}

declare module '*.css' { const css: string; export default css }
declare module '*?text' { const text: string; export default text }
