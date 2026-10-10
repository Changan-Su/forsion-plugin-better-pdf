// 界面文案:每条成对给 [中文, English]。渲染时现取语言,切语言后重画即可(见 index.ts 的 subscribeLocale)。
const M: Record<string, [string, string]> = {
  'view.annots': ['批注', 'Annotations'],
  'view.outline': ['大纲', 'Outline'],
  'view.chat': ['Tangu', 'Tangu'],

  'tool.thumbs': ['缩略图', 'Thumbnails'],
  'tool.select': ['选择', 'Select'],
  'tool.highlight': ['高亮', 'Highlight'],
  'tool.underline': ['下划线', 'Underline'],
  'tool.strike': ['删除线', 'Strikethrough'],
  'tool.note': ['便签', 'Note'],
  'tool.text': ['文字', 'Text'],
  'tool.area': ['区域', 'Area'],
  'tool.ink': ['手写', 'Draw'],
  'tool.eraser': ['橡皮', 'Eraser'],
  'tool.find': ['在文档中查找', 'Find in document'],
  'tool.panel': ['批注栏', 'Annotation panel'],
  'tool.more': ['更多', 'More'],
  'tool.readingNote': ['读书笔记', 'Reading notes'],
  'tool.undo': ['撤销', 'Undo'],
  'tool.redo': ['重做', 'Redo'],
  'tool.color': ['颜色', 'Colour'],
  'tool.width': ['粗细', 'Width'],

  'pen.default': ['默认', 'Default'],
  'pen.finetip': ['细尖笔', 'Fine tip'],
  'pen.fountain': ['钢笔', 'Fountain pen'],
  'pen.marker': ['马克笔', 'Marker'],
  'pen.highlighter': ['荧光笔', 'Highlighter'],
  'pen.thick-thin': ['粗到细', 'Thick to thin'],
  'pen.thin-thick-thin': ['两头细', 'Thin–thick–thin'],

  'find.placeholder': ['查找…', 'Find…'],
  'find.prev': ['上一处', 'Previous match'],
  'find.next': ['下一处', 'Next match'],
  'find.close': ['关闭查找', 'Close find'],
  'find.none': ['没有找到', 'No matches'],

  'sel.comment': ['写批注', 'Add a comment'],
  'sel.copy': ['复制', 'Copy'],
  'sel.cite': ['引用到笔记', 'Quote in notes'],
  'sel.ask': ['问 Tangu', 'Ask Tangu'],

  'card.placeholder': ['写点什么…', 'Write a comment…'],
  'card.addTag': ['+ 标签', '+ Tag'],
  'card.tagPlaceholder': ['标签,回车确认', 'Tag, press Enter'],
  'card.delete': ['删除', 'Delete'],
  'card.removeTag': ['移除标签', 'Remove tag'],
  'card.page': ['第 {n} 页', 'Page {n}'],
  'card.today': ['今天 {t}', 'Today {t}'],

  'kind.highlight': ['高亮', 'Highlight'],
  'kind.underline': ['下划线', 'Underline'],
  'kind.strike': ['删除线', 'Strikethrough'],
  'kind.note': ['便签', 'Note'],
  'kind.text': ['文字', 'Text'],
  'kind.area': ['区域', 'Area'],
  'kind.ink': ['手写', 'Drawing'],

  'list.count': ['{n} 条批注', '{n} annotations'],
  'list.filter': ['筛选批注…', 'Filter annotations…'],
  'list.empty': ['还没有批注。在 PDF 里选中文字,或用上方的工具开始。', 'No annotations yet. Select text in the PDF, or pick a tool above.'],
  'list.noMatch': ['没有符合的批注', 'No matching annotations'],
  'list.noPdf': ['打开一份 PDF 后,它的批注会列在这里。', 'Open a PDF and its annotations are listed here.'],
  'outline.empty': ['这份 PDF 没有目录', 'This PDF has no outline'],
  'outline.noPdf': ['打开一份 PDF 后,它的目录会列在这里。', 'Open a PDF and its outline is listed here.'],
  'outline.untitled': ['(无标题)', '(untitled)'],
  'chat.unavailable': ['这个版本的应用还不能把对话放进面板。', 'This version of the app cannot dock a conversation here.'],
  'chat.noPdf': ['打开一份 PDF 后,可以在这里就它提问。', 'Open a PDF to ask about it here.'],
  'chat.title': ['读 {name}', 'Reading {name}'],

  'more.export': ['导出带批注的 PDF', 'Export PDF with annotations'],
  'more.copyLink': ['复制本页链接', 'Copy link to this page'],

  'zoom.fitWidth': ['适合宽度', 'Fit width'],
  'zoom.fitPage': ['适合页面', 'Fit page'],
  'zoom.out': ['缩小', 'Zoom out'],
  'zoom.in': ['放大', 'Zoom in'],
  'zoom.title': ['缩放', 'Zoom'],
  'page.prev': ['上一页', 'Previous page'],
  'page.next': ['下一页', 'Next page'],
  'page.input': ['页码,回车跳转', 'Page number, press Enter to jump'],

  'state.loading': ['加载中…', 'Loading…'],
  'state.error': ['无法打开这份 PDF', 'Could not open this PDF'],
  'state.retry': ['重试', 'Retry'],

  'note.title': ['读书笔记 - {name}', 'Reading notes - {name}'],
  'note.cited': ['已引用到《{name}》', 'Quoted in “{name}”'],
  'note.failed': ['没能写进读书笔记', 'Could not write to the reading notes'],
  'note.pageLink': ['第 {n} 页', 'p. {n}'],
  'ask.copied': ['已复制,粘贴到对话里即可', 'Copied — paste it into a conversation'],
  'copy.done': ['已复制', 'Copied'],
  'save.failed': ['批注没能保存', 'Annotations could not be saved'],
  'save.broken': ['旧的批注文件读不出来,已另存为 {name},这次从空白开始。', 'The old annotation file could not be read. It was kept as {name}; starting from blank.'],
  'save.newer': ['这份批注是更新版本的插件写的,为免损坏,这里只读。', 'These annotations were written by a newer version of the plugin and are read-only here.'],
  'export.done': ['已导出到 {name}', 'Exported to {name}'],
  'export.failed': ['导出失败', 'Export failed'],
  'export.name': ['{name}(带批注)', '{name} (annotated)'],
}

export const locale = (): 'zh' | 'en' => ctx.getLocale?.() ?? 'zh'

export function t(key: string, vars?: Record<string, string | number>): string {
  const m = M[key]
  let s = m ? m[locale() === 'en' ? 1 : 0] : key
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
  return s
}

/** check.mjs 用:每条都要有两种语言,英文里不许夹汉字,占位符两边一致。 */
export const MESSAGES = M
