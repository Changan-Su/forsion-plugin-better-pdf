// PDF 阅读器插件入口。宿主以 new Function('ctx', <本文件的 esbuild IIFE 产物>) 装载:`ctx` 是宿主注入的自由变量,
// 产物顶层不能有 import/export。
//
// 做三件事:接管 .pdf 的打开(内置只读阅读器留作退路);在右栏注册批注 / 大纲 / 对话三个视图;
// 批注存在 PDF 旁边的隐藏文件里(store.ts),PDF 本身不改。
// 装好就是空的:不带示例 PDF、不带演示批注。
import css from './style.css'
import { scopedViewerCss } from './pdf'
import { allReaders, mountReader, openPanel } from './reader'
import { mountAnnots, mountChat, mountOutline } from './panel'
import { flushAll, flushAllNow } from './store'
import { t } from './i18n'

function injectCss(): void {
  const ID = 'forsion-pdf-reader-css'
  // 恒覆写:热更新(停用 → 装新版 → 启用,渲染进程不重启)时旧 <style> 还挂着,只查存在会让新版顶着旧样式跑。
  let el = document.getElementById(ID) as HTMLStyleElement | null
  if (!el) { el = document.createElement('style'); el.id = ID; document.head.append(el) }
  el.textContent = `${scopedViewerCss()}\n${css}`
}

/** 窗口要关 / 插件要停:手上的东西先收进数据,再把没落盘的直接写下去(平时是改完 0.4 秒后写)。
 *  两处都必须同步做完 —— 停用时宿主跑完这个函数就收走写盘接口。 */
function saveNow(): void {
  for (const r of allReaders()) r.settle()
  flushAllNow()
}
/** 窗口退到后面(切走、最小化):接着可能就是退出应用,而宿主退出时不给渲染层收尾的机会 —— 现在就写。 */
function saveSoon(): void {
  if (document.visibilityState === 'visible' && document.hasFocus()) return
  for (const r of allReaders()) r.settle(false) // 正打着的字由文字框自己的失焦去收
  flushAll()
}
let dispose: (() => void) | undefined

// 读写 PDF 和旁挂文件都走二进制接口;没有它的宿主也没有「接管 .pdf」,整个插件不出场。
if (ctx.app.readBytes && ctx.app.writeBytes) {
  let opened = false
  const taken = ctx.registerFileType({
    id: 'pdf',
    extensions: ['.pdf'],
    override: true,
    title: 'PDF',
    mount(el, file) {
      injectCss()
      const off = mountReader(el, file.filePath)
      // 这一程第一次打开 PDF 时把右栏的三个视图开出来;之后用户关了就不再自作主张(工具栏上有按钮)。
      if (!opened) { opened = true; openPanel('annots') }
      return off
    },
  })
  // false = 宿主不让接管(旧版本):什么都不注册,PDF 照旧由内置阅读器打开。
  if (taken !== false) {
    // ponytail: 视图标题在装载时按当时的语言定下(宿主的视图标题只收字符串),切语言后要重载插件才变;侧栏标签只显示图标,影响很小。
    ctx.registerView({ id: 'annots', title: t('view.annots'), icon: 'pen', mount: (el) => { injectCss(); return mountAnnots(el) } })
    ctx.registerView({ id: 'outline', title: t('view.outline'), icon: 'bulleted-list', mount: (el) => { injectCss(); return mountOutline(el) } })
    ctx.registerView({ id: 'chat', title: t('view.chat'), icon: 'callout-note', mount: (el) => { injectCss(); return mountChat(el) } })
    ctx.subscribeLocale?.(() => { for (const r of allReaders()) r.relocale() })
    window.addEventListener('pagehide', saveNow)
    window.addEventListener('blur', saveSoon)
    document.addEventListener('visibilitychange', saveSoon)
    dispose = () => {
      saveNow()
      window.removeEventListener('pagehide', saveNow)
      window.removeEventListener('blur', saveSoon)
      document.removeEventListener('visibilitychange', saveSoon)
    }
  }
}

/** 宿主停用 / 重载插件时先调它(这时 ctx 还能用),build.mjs 的 footer 把它 return 给宿主。 */
export default (): void => dispose?.()
