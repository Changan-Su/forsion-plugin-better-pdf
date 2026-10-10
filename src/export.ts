// 导出带批注的 PDF:原件不动,另存一份「X(带批注).pdf」。
// 划线 / 便签 / 区域 / 文字写成 PDF 原生注释(别的阅读器里看得到、点得开评论);手写画进页面内容。
import {
  BlendMode, PDFArray, PDFDocument, PDFHexString, PDFName, PDFString,
  concatTransformationMatrix, popGraphicsState, pushGraphicsState, rgb, type PDFPage,
} from 'pdf-lib'
import type { Reader } from './reader'
import { baseOf, dirOf, stemOf, type Annot } from './store'
import { t } from './i18n'

const SUBTYPE: Record<string, string> = { highlight: 'Highlight', underline: 'Underline', strike: 'StrikeOut' }

/** '#rgb' / '#rrggbb' / '#rrggbbaa' → [r, g, b, a](0–1)。认不出的当黑色。 */
function parseColor(s: string | null): [number, number, number, number] | null {
  if (!s || s === 'none' || s === 'transparent') return null
  let h = s.trim().replace('#', '')
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return [0, 0, 0, 1]
  const n = (i: number): number => parseInt(h.slice(i, i + 2), 16) / 255
  return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1]
}

const pdfDate = (iso: string): string => {
  const d = new Date(iso), p = (x: number): string => String(x).padStart(2, '0')
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function addAnnot(doc: PDFDocument, page: PDFPage, a: Annot, entries: Record<string, unknown>): void {
  const c = parseColor(a.color) ?? [1, 0.83, 0, 1]
  const dict = doc.context.obj({
    Type: 'Annot', P: page.ref, F: 4, C: c.slice(0, 3),
    M: PDFString.of(pdfDate(a.modified)), NM: PDFString.of(`forsion-${a.id}`),
    ...(a.comment ? { Contents: PDFHexString.fromText(a.comment) } : {}),
    ...entries,
  })
  const ref = doc.context.register(dict)
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
  if (annots) annots.push(ref)
  else page.node.set(PDFName.of('Annots'), doc.context.obj([ref]))
}

function writeAnnot(doc: PDFDocument, a: Annot): void {
  const page = doc.getPage(a.page)
  if (a.quads?.length) {
    const flat = a.quads.flat()
    const xs = flat.filter((_, i) => i % 2 === 0), ys = flat.filter((_, i) => i % 2 === 1)
    addAnnot(doc, page, a, { Subtype: SUBTYPE[a.type], Rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], QuadPoints: flat })
  } else if (a.rect) {
    const [x0, y0, x1, y1] = a.rect
    if (a.type === 'note') addAnnot(doc, page, a, { Subtype: 'Text', Rect: [x0, y0 - 20, x0 + 20, y0], Name: 'Comment', Open: false })
    else if (a.type === 'area') addAnnot(doc, page, a, { Subtype: 'Square', Rect: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)], BS: { W: 1.5 } })
    else if (a.type === 'text' && a.text) {
      const lines = a.text.split('\n'), w = Math.min(320, Math.max(...lines.map((l) => l.length)) * 11 + 8), h = lines.length * 15 + 4
      const c = parseColor(a.color) ?? [0, 0, 0, 1]
      // ponytail: 不写外观流,由阅读器自己排字(Acrobat / pdf.js 都会);个别阅读器里中文可能显示成方块,要稳得嵌字体。
      addAnnot(doc, page, { ...a, comment: a.text }, { Subtype: 'FreeText', Rect: [x0, y0 - h, x0 + w, y0], DA: PDFString.of(`/Helv 11 Tf ${c.slice(0, 3).map((v) => (v * 0.72).toFixed(3)).join(' ')} rg`) })
    }
  }
}

const attrUp = (node: Element, name: string, stop: Element): string | null => {
  for (let n: Element | null = node; n && n !== stop.parentElement; n = n.parentElement) {
    const v = n.getAttribute(name)
    if (v != null) return v
  }
  return null
}

/** 一页的笔迹画进页面内容:向宿主要这一组元素的 SVG(和屏幕上是同一份轮廓),逐条 path 画过去。
 *  矩阵 = 页面视口变换的逆 × 平移到 SVG 在页内的位置 × path 自己的变换 × 上下翻(pdf-lib 画 SVG 路径时 y 朝下)。 */
async function drawInk(page: PDFPage, vp1: any, elements: any[], multiply: boolean): Promise<void> {
  if (!elements.length) return
  const out = await ctx.ui!.boardToSvg!({ elements }, { theme: 'light', padding: 2 })
  if (!out) return
  const base = new DOMMatrix(vp1.transform).inverse().translate(out.x, out.y)
  for (const path of out.svg.querySelectorAll('path')) {
    const d = path.getAttribute('d')
    if (!d) continue
    let local = new DOMMatrix()
    let opacity = 1
    for (let n: Element | null = path; n && n !== out.svg; n = n.parentElement) {
      const c = (n as SVGGraphicsElement).transform?.baseVal?.consolidate()
      if (c) local = DOMMatrix.fromMatrix(c.matrix).multiply(local)
      opacity *= Number(n.getAttribute('opacity') ?? 1) || 1
    }
    const m = base.multiply(local).scale(1, -1)
    const fill = parseColor(attrUp(path, 'fill', out.svg))
    const stroke = parseColor(attrUp(path, 'stroke', out.svg))
    if (!fill && !stroke) continue
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(m.a, m.b, m.c, m.d, m.e, m.f))
    page.drawSvgPath(d, {
      x: 0, y: 0,
      ...(fill ? { color: rgb(fill[0], fill[1], fill[2]), opacity: fill[3] * opacity * Number(attrUp(path, 'fill-opacity', out.svg) ?? 1) } : {}),
      ...(stroke ? { borderColor: rgb(stroke[0], stroke[1], stroke[2]), borderWidth: Number(attrUp(path, 'stroke-width', out.svg) ?? 1), borderOpacity: stroke[3] * opacity } : {}),
      ...(multiply ? { blendMode: BlendMode.Multiply } : {}),
    })
    page.pushOperators(popGraphicsState())
  }
}

const isHighlighter = (e: any): boolean => !!e?.customData?.strokeOptions?.highlighter

export async function exportAnnotated(r: Reader): Promise<void> {
  if (!r.doc || !r.pdf) return
  try {
    const bytes = await ctx.app.readBytes!(r.pdfPath)
    if (!bytes) throw new Error('unreadable')
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    const pages = doc.getPageCount()
    for (const a of r.doc.data.annots) if (a.page < pages) writeAnnot(doc, a)
    if (ctx.ui?.boardToSvg) {
      for (const [p, els] of Object.entries(r.doc.data.ink)) {
        if (!els.length || Number(p) >= pages) continue
        const vp1 = (await r.pdf.getPage(Number(p) + 1)).getViewport({ scale: 1 })
        // 荧光笔单独一组:它要和页面「正片叠底」,否则盖住字。
        await drawInk(doc.getPage(Number(p)), vp1, els.filter(isHighlighter), true)
        await drawInk(doc.getPage(Number(p)), vp1, els.filter((e) => !isHighlighter(e)), false)
      }
    }
    const dir = dirOf(r.pdfPath)
    const name = `${t('export.name', { name: stemOf(r.pdfPath) })}.pdf`
    await ctx.app.writeBytes!(`${dir ? `${dir}/` : ''}${name}`, await doc.save({ useObjectStreams: false }))
    ctx.notify?.(t('export.done', { name }), { level: 'success' })
  } catch (e) {
    console.error('[pdf-reader] 导出失败', e)
    ctx.notify?.(`${t('export.failed')}:${baseOf(r.pdfPath)}`, { level: 'error' })
  }
}
