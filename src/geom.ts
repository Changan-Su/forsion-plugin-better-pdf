// 选区 / 点击 ↔ PDF 坐标。
// ⚠️ 参考系用页的内容盒(textLayer / canvasWrapper),不用 .page 外框:pdf.js 给 .page 留了 9px 透明边框。
// 两边都是 getBoundingClientRect 的客户区像素,所以应用整体缩放(界面缩放 110% 之类)不影响换算。

interface Box { left: number; top: number; right: number; bottom: number }
export interface PageQuads { page: number; quads: number[][] }

/** 同一行里的选区碎块并成一条:垂直中心落在对方高度带内算同一行;水平间隙小于行高才并(词间空隙连上,分栏不连)。 */
export function mergeLineRects(rects: Box[]): Box[] {
  const lines: { top: number; bottom: number; segs: { left: number; right: number }[] }[] = []
  for (const r of [...rects].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const cy = (r.top + r.bottom) / 2
    let line = lines.find((l) => cy > l.top && cy < l.bottom)
    if (!line) { line = { top: r.top, bottom: r.bottom, segs: [] }; lines.push(line) }
    else { line.top = Math.min(line.top, r.top); line.bottom = Math.max(line.bottom, r.bottom) }
    const h = r.bottom - r.top
    const seg = line.segs.find((s) => r.left < s.right + h && r.right > s.left - h)
    if (seg) { seg.left = Math.min(seg.left, r.left); seg.right = Math.max(seg.right, r.right) }
    else line.segs.push({ left: r.left, right: r.right })
  }
  return lines.flatMap((l) => l.segs.map((s) => ({ left: s.left, top: l.top, right: s.right, bottom: l.bottom })))
}

/** 页的内容盒;这一页还没渲染出来时是 null。 */
export const frameOf = (pv: any): DOMRect | null => {
  const el: HTMLElement | null = pv?.textLayer?.div ?? pv?.div?.querySelector('.canvasWrapper') ?? null
  return el ? el.getBoundingClientRect() : null
}

/** 客户区点 → 这一页的 PDF 用户空间坐标。客户区像素先按内容盒的实际宽度换成 pdf.js 视口像素。 */
const toPdf = (pv: any, frame: DOMRect, x: number, y: number): [number, number] => {
  const k = pv.viewport.width / frame.width
  return pv.viewport.convertToPdfPoint((x - frame.left) * k, (y - frame.top) * k)
}

/** 当前窗口选区 → 各页的 quads。没有选区,或选区不在页面上 → []。 */
export function selectionToQuads(viewer: any): PageQuads[] {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return []
  const rects: Box[] = []
  for (let i = 0; i < sel.rangeCount; i++) {
    for (const r of sel.getRangeAt(i).getClientRects()) {
      if (r.width >= 1 && r.height >= 1) rects.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
    }
  }
  const out: PageQuads[] = []
  for (let p = 0; p < (viewer.pagesCount ?? 0) && rects.length; p++) {
    const pv = viewer.getPageView(p)
    const frame = frameOf(pv)
    if (!frame) continue
    const inPage = rects.filter((r) => {
      const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2
      return cx >= frame.left && cx <= frame.right && cy >= frame.top && cy <= frame.bottom
    })
    if (!inPage.length) continue
    out.push({
      page: p,
      quads: mergeLineRects(inPage).map((r) => {
        const [ax, ay] = toPdf(pv, frame, r.left, r.top)
        const [bx, by] = toPdf(pv, frame, r.right, r.bottom)
        const xL = Math.min(ax, bx), xR = Math.max(ax, bx), yT = Math.max(ay, by), yB = Math.min(ay, by)
        return [xL, yT, xR, yT, xL, yB, xR, yB]
      }),
    })
  }
  return out
}

/** 客户区点落在哪一页 + 页内 PDF 坐标。 */
export function pageAt(viewer: any, x: number, y: number): { page: number; x: number; y: number } | null {
  for (let p = 0; p < (viewer.pagesCount ?? 0); p++) {
    const pv = viewer.getPageView(p)
    const frame = frameOf(pv)
    if (!frame || x < frame.left || x > frame.right || y < frame.top || y > frame.bottom) continue
    const [px, py] = toPdf(pv, frame, x, y)
    return { page: p, x: px, y: py }
  }
  return null
}

/** 客户区点 → **指定页**的 PDF 坐标(页外的点钳进页内)。拖框时起止点锁在同一页。 */
export function pointOnPage(viewer: any, page: number, x: number, y: number): [number, number] | null {
  const pv = viewer.getPageView(page)
  const frame = frameOf(pv)
  if (!frame) return null
  return toPdf(pv, frame, Math.min(frame.right, Math.max(frame.left, x)), Math.min(frame.bottom, Math.max(frame.top, y)))
}

/** PDF 用户空间的两个角 → 页面 pt 坐标(y 向下,已含页面旋转)的 [x, y, w, h]。vp1 = 这一页缩放为 1 的视口。 */
export function toPageBox(vp1: any, x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
  const [a, b] = vp1.convertToViewportPoint(x0, y0)
  const [c, d] = vp1.convertToViewportPoint(x1, y1)
  return [Math.min(a, c), Math.min(b, d), Math.abs(a - c), Math.abs(b - d)]
}

/** 一条 quad → 页面 pt 的 [x, y, w, h]。 */
export const quadBox = (vp1: any, q: number[]): [number, number, number, number] => toPageBox(vp1, q[0], q[1], q[6], q[7])
