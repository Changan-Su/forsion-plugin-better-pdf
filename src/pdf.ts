// pdf.js 的装载。⚠️ 三行 import 的先后不能动:先记下宿主的全局 → 库文件 → 阅读器文件(它在加载时读全局)。
import { restoreGlobals } from './pdfjs-pre'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import * as pdfjsViewer from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'
import workerSource from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?text'
import viewerCss from 'pdfjs-dist/legacy/web/pdf_viewer.css'

restoreGlobals()

export { pdfjsLib }
export const { EventBus, PDFFindController, PDFLinkService, PDFViewer } = pdfjsViewer as any

/** worker 以文本随包,做成 Blob 地址(宿主 CSP:worker-src 'self' blob:)。 */
let workerUrl = ''
export function ensureWorker(): void {
  if (workerUrl) return
  workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl
}
export function dropWorker(): void {
  if (workerUrl) URL.revokeObjectURL(workerUrl)
  workerUrl = ''
}

/** pdf.js 的样式表关进 .pr-root:它按全局写的(:root 变量、dialog、按钮),直接注入会改坏宿主自己的界面。
 *  ① :root → :scope(@scope 里 :root 永不匹配,变量会全丢);
 *  ② 去掉 --viewer-container-height:0 —— pdf.js 运行时把真值写在 <html> 上,作用域里的 0 会压过继承来的真值;
 *  ③ 图片地址(images/…)在插件里没有对应文件,换成 none,免得每次打开都请求一串不存在的文件。 */
export const scopedViewerCss = (): string =>
  `@scope (.pr-root) {\n${viewerCss
    .replace(/:root\b/g, ':scope')
    .replace(/--viewer-container-height:\s*0;/g, '')
    .replace(/url\(\s*["']?images\/[^)]*\)/g, 'none')}\n}`
