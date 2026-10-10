// 宿主注入的 `ctx`(new Function('ctx', code) 的形参)。只声明本插件用到的面;带 ? 的是较新宿主才有的,用前探测。
// 完整契约见 Forsion-Genesis/desktop/frontend/src/amadeus/plugins/types.ts。

interface HostChatMount {
  ready: Promise<{ ok: boolean; sessionId?: string; error?: string }>
  quote(text: string): void
  prefill(text: string): void
  dispose(): void
}

interface HostBoardScene { elements: readonly any[]; files?: Record<string, unknown> }
interface HostBoardViewport { scrollX: number; scrollY: number; zoom: number }
interface HostBoardOptions {
  scene: HostBoardScene
  viewport: HostBoardViewport
  tool?: 'selection' | 'freedraw' | 'eraser'
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

declare const ctx: {
  app: {
    readFile(path: string): Promise<string | null>
    writeFile(path: string, text: string): Promise<void>
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
    id: string; extensions: string[]; icon?: string; title?: string; override?: boolean
    mount(el: HTMLElement, file: { filePath: string }): (() => void) | void
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
    mountBoard?(el: HTMLElement, opts: HostBoardOptions): HostBoardHandle
    boardToSvg?(scene: HostBoardScene, opts?: { theme?: 'light' | 'dark'; padding?: number }): Promise<{ svg: SVGSVGElement; x: number; y: number; width: number; height: number } | null>
  }
}

declare module '*.css' { const css: string; export default css }
declare module '*?text' { const text: string; export default text }
