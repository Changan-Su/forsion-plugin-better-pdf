import { mergeLineRects, selectedTextRects } from './geom'

/** Anchor to the first visible selected line, never a cross-page wrapper. */
export function selectionAnchor(root: HTMLElement, range: Range) {
  const clip = root.getBoundingClientRect()
  const lines = mergeLineRects(selectedTextRects(root, range))
  const line = lines.find((r) => r.bottom > Math.max(0, clip.top) && r.top < Math.min(window.innerHeight, clip.bottom) && r.right > clip.left && r.left < clip.right)
  return line ? { left: Math.max(clip.left, line.left), right: Math.min(clip.right, line.right), top: Math.max(clip.top, 0, line.top), bottom: Math.min(clip.bottom, window.innerHeight, line.bottom) } : null
}

/** One SVG path per page: overlapping glyph boxes receive colour exactly once.
 * Keep native Selection for dragging, keyboard extension, copying and annotation. */
export function paintSelection(root: HTMLElement, enabled: boolean): void {
  for (const layer of root.querySelectorAll('.pr-selection')) layer.remove()
  root.removeAttribute('data-pdf-selection')
  if (!enabled || matchMedia('(pointer: coarse)').matches || matchMedia('(forced-colors: active)').matches) return
  const rects = selectedTextRects(root)
  if (!rects.length) return
  let painted = false
  for (const page of root.querySelectorAll<HTMLElement>('.page')) {
    const text = page.querySelector<HTMLElement>('.textLayer')
    if (!text) continue
    const frame = text.getBoundingClientRect()
    if (!frame.width || !frame.height) continue
    const lines = mergeLineRects(rects.filter((r) => {
      const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2
      return x >= frame.left && x <= frame.right && y >= frame.top && y <= frame.bottom
    }))
    if (!lines.length) continue
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.classList.add('pr-selection')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('viewBox', `0 0 ${frame.width} ${frame.height}`)
    svg.setAttribute('preserveAspectRatio', 'none')
    const path = document.createElementNS(svg.namespaceURI, 'path')
    path.setAttribute('d', lines.map((r) => `M${r.left - frame.left},${r.top - frame.top}h${r.right - r.left}v${r.bottom - r.top}h${r.left - r.right}Z`).join(' '))
    svg.append(path)
    page.append(svg)
    painted = true
  }
  if (painted) root.setAttribute('data-pdf-selection', '')
}
