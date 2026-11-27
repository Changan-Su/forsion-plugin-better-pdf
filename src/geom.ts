import type { PageViewport } from 'pdfjs-dist'

// 选区 / 点击 ↔ PDF 坐标。
// ⚠️ 参考系用页的内容盒(textLayer / canvasWrapper),不用 .page 外框:pdf.js 给 .page 留了 9px 透明边框。
// 两边都是 getBoundingClientRect 的客户区像素,所以应用整体缩放(界面缩放 110% 之类)不影响换算。

interface Box { left: number; top: number; right: number; bottom: number }
export interface PageQuads { page: number; quads: number[][] }

/** Group fragments by row before joining nearby words within each row. */
export function mergeLineRects(rects: Box[]): Box[] {
  const rows: Array<{ anchor: Box; fragments: Box[] }> = []
  // Keep each row anchored to its tallest fragment. An expanding union can
  // otherwise pull in adjacent lines through overlapping glyph boxes or scripts.
  for (const rect of [...rects].sort((a, b) => (b.bottom - b.top) - (a.bottom - a.top))) {
    let nearest: (typeof rows)[number] | undefined
    let distance = Infinity
    for (const row of rows) {
      const { anchor } = row
      const overlap = Math.min(anchor.bottom, rect.bottom) - Math.max(anchor.top, rect.top)
      if (overlap <= Math.min(anchor.bottom - anchor.top, rect.bottom - rect.top) / 2) continue
      const delta = Math.abs((anchor.top + anchor.bottom) - (rect.top + rect.bottom))
      if (delta >= distance) continue
      nearest = row
      distance = delta
      if (distance === 0) break
    }
    if (nearest) nearest.fragments.push(rect)
    else rows.push({ anchor: rect, fragments: [rect] })
  }

  const lines: Box[] = []
  for (const { fragments } of rows) {
    let band: Box | undefined
    let height = 0
    for (const { left, top, right, bottom } of fragments.sort((a, b) => a.left - b.left)) {
      const fragmentHeight = bottom - top
      if (band && left - band.right < Math.max(height, fragmentHeight) * 0.6) {
        band.right = Math.max(band.right, right)
        band.top = Math.min(band.top, top)
        band.bottom = Math.max(band.bottom, bottom)
        height = Math.max(height, fragmentHeight)
      } else {
        band = { left, top, right, bottom }
        lines.push(band)
        height = fragmentHeight
      }
    }
  }
  return lines.sort((a, b) => a.top - b.top || a.left - b.left)
}

/** 页的内容盒;这一页还没渲染出来时是 null。 */
export const frameOf = (pv: any): DOMRect | null => {
  const el: HTMLElement | null = pv?.textLayer?.div ?? pv?.div?.querySelector('.canvasWrapper') ?? null
  const frame = el?.getBoundingClientRect()
  return frame?.width && frame.height ? frame : null
}

/** Convert the rounded client frame to viewport pixels independently on each axis. */
const toPdf = (pv: any, frame: DOMRect, x: number, y: number): [number, number] => {
  const { viewport } = pv
  return viewport.convertToPdfPoint(
    (x - frame.left) * viewport.width / frame.width,
    (y - frame.top) * viewport.height / frame.height,
  )
}

/** 当前窗口选区 → 各页的 quads。没有选区,或选区不在页面上 → []。 */
export function selectionToQuads(viewer: any): PageQuads[] {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return []
  const rects = selectedTextRects(viewer.viewer ?? viewer.container)
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

/** The mark layer's CSS scale already includes /UserUnit. */
export const markViewport = (viewport: PageViewport): PageViewport => viewport.clone({ scale: 1 / viewport.userUnit })

/** PDF 用户空间的两个角 → 页面坐标(y 向下,已含页面旋转)的 [x, y, w, h]。 */
export function toPageBox(vp1: PageViewport, x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
  const [a, b] = vp1.convertToViewportPoint(x0, y0)
  const [c, d] = vp1.convertToViewportPoint(x1, y1)
  return [Math.min(a, c), Math.min(b, d), Math.abs(a - c), Math.abs(b - d)]
}

/** 一条 quad → 页面坐标的 [x, y, w, h]。 */
export const quadBox = (vp1: PageViewport, q: number[]): [number, number, number, number] => toPageBox(vp1, q[0], q[1], q[6], q[7])

// ── 白板元素(笔迹 / 形状)的几何:选择工具判断「指针底下是不是画上去的东西」用 ──
type Bounds = [number, number, number, number]
/** 一个白板元素不带旋转的外框。线和笔迹的 x / y 是起笔点,点列可以往回走,所以按点列算。 */
export function boundsOf(e: any): Bounds {
  if (!Array.isArray(e.points) || !e.points.length) return [e.x, e.y, e.x + (e.width ?? 0), e.y + (e.height ?? 0)]
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of e.points) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]) }
  return [e.x + x0, e.y + y0, e.x + x1, e.y + y1]
}
/** 画布上的一点是不是点中了这个元素。和引擎的规矩一个意思:线看离线多远,没填充的方框 / 圆只有边线算,填了色的整块算。
 *  ponytail: 弯的箭头按折线算、粗笔(荧光笔)按中线算,偏一点只影响「这一下归谁」,引擎自己还会再判一次。 */
export function hits(e: any, x: number, y: number, tol: number): boolean {
  const [x0, y0, x1, y1] = boundsOf(e)
  if (e.angle) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, c = Math.cos(-e.angle), s = Math.sin(-e.angle), dx = x - cx, dy = y - cy
    x = cx + dx * c - dy * s; y = cy + dx * s + dy * c
  }
  if (x < x0 - tol || x > x1 + tol || y < y0 - tol || y > y1 + tol) return false
  if (Array.isArray(e.points) && e.points.length) {
    const reach = tol + (e.strokeWidth ?? 1), px = x - e.x, py = y - e.y
    for (let i = 1; i < e.points.length; i++) {
      const [ax, ay] = e.points[i - 1], [bx, by] = e.points[i], vx = bx - ax, vy = by - ay
      const u = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1)))
      if (Math.hypot(px - ax - u * vx, py - ay - u * vy) <= reach) return true
    }
    return e.points.length === 1
  }
  if ((e.backgroundColor && e.backgroundColor !== 'transparent') || (e.type !== 'rectangle' && e.type !== 'ellipse' && e.type !== 'diamond')) return true
  if (e.type === 'ellipse') {
    const a = (x1 - x0) / 2, b = (y1 - y0) / 2
    return a < tol || b < tol || Math.abs(Math.hypot((x - (x0 + x1) / 2) / a, (y - (y0 + y1) / 2) / b) - 1) * Math.min(a, b) <= tol
  }
  return !(x > x0 + tol && x < x1 - tol && y > y0 + tol && y < y1 - tol)
}

/** Only selected text-node fragments: Range.getClientRects() also returns whole
 * textLayer/page wrappers when a selection crosses pages (including page y=0). */
export function selectedTextRects(root: HTMLElement | null | undefined, supplied?: Range): DOMRect[] {
  const sel = window.getSelection()
  const range = supplied ?? (sel?.rangeCount ? sel.getRangeAt(0) : null)
  if (!root || !range || range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return []
  const out: DOMRect[] = []
  const visit = (node: Node): void => {
    if (!node.textContent || !node.parentElement?.closest('.textLayer') || !range.intersectsNode(node)) return
    const part = document.createRange()
    part.selectNodeContents(node)
    if (node === range.startContainer) part.setStart(node, range.startOffset)
    if (node === range.endContainer) part.setEnd(node, range.endOffset)
    if (!part.collapsed) for (const r of part.getClientRects()) if (r.width > 0.2 && r.height > 1) out.push(r)
  }
  const scope = range.commonAncestorContainer
  if (scope.nodeType === Node.TEXT_NODE) visit(scope)
  else {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) visit(node)
  }
  return out
}
