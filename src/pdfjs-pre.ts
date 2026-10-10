// pdf.js 的库文件一加载就往 globalThis 上挂 pdfjsLib,阅读器文件再从那里取。宿主自带一份 pdf.js,
// 所以这里先记下宿主那份,等我们这份加载完再放回去(见 pdf.ts 的 import 顺序),不动宿主的全局。
const g = globalThis as any
const before = { lib: g.pdfjsLib, viewer: g.pdfjsViewer }
export function restoreGlobals(): void {
  for (const [k, v] of [['pdfjsLib', before.lib], ['pdfjsViewer', before.viewer]] as const) {
    if (v === undefined) delete g[k]
    else g[k] = v
  }
}
