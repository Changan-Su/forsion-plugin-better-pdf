# Better PDF

Forsion 的 PDF 阅读 / 批注插件,读文献用:划线、批注、标签、便签、形状、手写。装上之后,点开库里的 PDF 就由它打开。

当前版本 **0.1.1**(更新记录见 [CHANGELOG.md](./CHANGELOG.md)),需要 Forsion 桌面端 2.13.0 或更新的版本;**手写、形状、橡皮需要 2.13.1 之后的桌面版本**,在 2.13.1 及更早的版本上这三个按钮不出现,其余功能照常。

- **批注不改 PDF**。每份 PDF 的批注存在它旁边的隐藏文件 `.<文件名>.pdf.annot.json` 里(坐标是 PDF 自己的坐标,换设备、换缩放都对得上)。
  需要给别人看时用「更多 → 导出带批注的 PDF」另存一份。
- **手写和形状是白板的元素**。笔迹、方框、圆、箭头、直线都是宿主白板的元素,用的是宿主的白板层接口 `ctx.ui.mountBoard`;
  「选择」工具下点选、拖动、缩放、框选它们,走的是白板引擎自己的那一套。这个接口在 2.13.1 之后的桌面版本里才有。
- **引用是复制**。「复制引用」把原文、回到这一页的链接(`[[x.pdf#page=3|第 3 页]]`)和评论放进剪贴板,到笔记里自己粘贴;插件不替你建笔记。
- **右栏**:批注列表、PDF 目录、Tangu 对话三个标签,跟着你最近操作的那份 PDF 走。
- **装好是空的**:不带示例 PDF,不带演示批注。

**凡是「打开这份 PDF」都归本插件**(2.13.2 之后的桌面版本):文件树、最近使用、笔记里的 `[[x.pdf]]`,带页码的 `[[x.pdf#page=3]]`(「复制引用」贴出来的就是这种,点回去落在那一页),以及聊天里的引用(落在那一页;带引语的会用查找把那句话标出来,查找条开着,关掉即清)。
仍由内置阅读器处理的只有两样:笔记里的 `![[x.pdf]]` 嵌入,和文件树右键的「用内置阅读器打开」。库外的 PDF(聊天里按绝对路径引用的)插件读不到,也走内置阅读器。

**桌面 2.13.2 及更早**:只有从左侧文件树(和最近使用)点开才归本插件;笔记里的 PDF 链接、带页码的链接、聊天引用进的是内置阅读器 —— 那几个版本没有把这些入口交给「默认打开方式」。在这些版本上请从文件树点那份 PDF。

## 开发

```bash
npm install
node build.mjs     # src → main.js(单文件;pdf.js 和它的 worker 都打在里面)
node check.mjs     # 自检:装载闸、main.js 与 src 同步、文案成对、批注存取的保命路径
```

改了 `src/` 必须重跑 `node build.mjs` 并提交 `main.js`(市场按 zip 安装,不构建)。

真应用里的冒烟(隔离的 home,不碰开发实例和真实的库;在 Forsion 仓根跑,桌面端先 `npm run build`):

```bash
node .claude/hooks/devlock.cjs run --vehicle=e2e --what="PDF 阅读器插件冒烟" --eta=4 -- node Forsion-Instrumentality-Project/forsion-plugin-pdf-reader/verify/smoke.cjs
```

它用真鼠标走一遍:点开 → 选字高亮 → 评论 / 标签 / 换色 → 复制引用 → 问 Tangu → 目录 / 查找 / 缩略图 → 下划线(拖着就看得到)→ 便签 →
形状 → 点选拖动 / 框选 / 删除 / 撤销 → 缩放后对位 → 手写(翻页、放大后再画、撤销重做、橡皮)→ 橡皮擦划线再撤销 →
手写笔模式(笔和手指是用调试协议合成的事件)→ 导出 → 关掉重开。截图在 `.shots/`。`UI_ZOOM=1.1` 在界面缩放 110% 下跑同一遍。

## 源码

| 文件 | 管什么 |
|---|---|
| `src/index.ts` | 入口:接管 `.pdf`、注册右栏三个视图 |
| `src/reader.ts` | 一份打开着的 PDF:工具栏、页面上的批注层、选中浮条、批注卡、查找、缩略图 |
| `src/panel.ts` | 右栏:批注列表 / 目录 / 对话 |
| `src/store.ts` | 批注的存取(旁挂文件) |
| `src/ink.ts` | 手写与形状:白板层 + 每页的静态笔迹;选择工具下指针归白板层还是归页面 |
| `src/export.ts` | 导出带批注的 PDF |
| `src/geom.ts` | 选区、点击 ↔ PDF 坐标;点没点中一个白板元素 |
| `src/pdf.ts` | pdf.js 的装载(样式关进作用域、worker 走 Blob 地址) |

## 已知的边界

- PDF 被别的程序改写后不会自动重载,关掉重开。
- 把标签「移到新窗口」后,那个窗口没有右栏:PDF 和所有批注工具照常用,批注列表 / 目录 / 对话三个面板不出现,工具栏上也不放「面板」按钮;
  在那里点「问 Tangu」按宿主的代码会把这个标签换成对话(点后退回到 PDF),这一条没实测过。要在新窗口里也有面板,得宿主让那种窗口带右栏。
- 开在对话旁边那一格里时(聊天里点引用、Agent 把 PDF 摆上台)同样没有那三个面板:右栏一开,那一格就被顶掉。批注工具照常用;
  「问 Tangu」在那里走的也是上一条说的那条没实测过的路。
- 聊天引用带的引语用查找去标:模型抄的引语和 PDF 里的字对不上(断行、连字符)时找不到,查找条会写「没有找到」,页面仍停在引用的那一页。
- 便签 / 文字放下后不能拖动,删掉重放;高亮、下划线跟着文字走,只能选中和删除。能拖、能缩放的是画上去的东西(笔迹、形状)。
- 选择工具下「这一下归谁」是按指针底下的东西定的:画上去的东西和离字远的空白归白板(点选、拖动、框选),字和紧挨着字的空白归页面(选字)。
  所以框选要从页边、段落之间这类空白处起拖;压在字上的笔迹,点它的线条本身才选得中。
- 没有悬停的输入(手指、不带悬停的手写笔)在选择工具下选不中画上去的东西。
- 撤销按「一次手势」记:擦掉 / 删掉的批注和白板那边的一步各是各的账,混着撤销时先后可能差一步,不会丢东西。
- 手写笔模式下手指滚动页面没有惯性,也不能双指缩放;关掉这个模式后,笔再碰一下页面它会自己再打开。真的手写笔没试过(冒烟里的笔和手指是合成事件)。
- 关掉手写笔模式要把白板层重挂一次,笔迹这边的撤销历史随之清空(删掉的批注照样能撤销回来)。
- 选择工具下,手指落在白板层上时不交给引擎:拖是滚动页面,轻点会穿到页面上(点链接、点批注)。
- 旧版本存下的「区域」框照样显示(不再填色),但新画的框是白板元素;旧的不会自动转过去。
- 批注文件不监听外部改动:另一个窗口、另一台设备写的批注,要等这边下一次保存(保存前会读一遍,把那边的并进来)或重开才看得到。
- 退出应用时宿主不等界面收尾。新加 / 删除批注、每一笔手写都是马上写盘;正在打的评论、标签最多有 0.4 秒没存(切到别的窗口时会立刻存)。
- 两个窗口开着同一份 PDF、一边刚改完 0.4 秒内就关窗:关窗那一写来不及合并,会盖掉另一边还没并进来的改动。
- 导出的文字批注没有写外观流,个别阅读器里中文会显示成方块;划线、便签、形状、手写不受影响。
- 页面单位不是 1 的 PDF(`/UserUnit`,极少见的超大幅面)上,手写的位置会按比例偏。
- 没随包带 cMap / 标准字体(和内置阅读器一样),极少数老式中日韩 PDF 的字会缺。

## 第三方

`main.js` 里打包了下面这些库(构建时去掉了注释里的许可声明,全文见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)):

- [pdf.js](https://github.com/mozilla/pdf.js)(`pdfjs-dist` 5.7.284)— Apache-2.0,© Mozilla Foundation
- [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1 — MIT,© 2019 Andrew Dillon;以及它依赖的 `@pdf-lib/standard-fonts`、`@pdf-lib/upng`(MIT)、`pako`(MIT 与 Zlib)、`tslib`(0BSD)

本插件自己的代码按 [Apache-2.0](./LICENSE) 发布。

---

## English

**Better PDF** is a PDF reader and annotator for Forsion, built for working through papers. Select text to highlight (five colors), underline, strike through, comment and tag; place sticky notes and text on the page; draw boxes, ellipses, arrows and lines; write by hand with the seven pens of the whiteboard. The annotation list, the PDF outline and a Tangu chat sit in the right sidebar.

- **The PDF is never modified.** Annotations live in a hidden file next to it (`.<name>.pdf.annot.json`, in the PDF's own coordinates). "More → Export annotated PDF" saves a separate copy with native PDF annotations.
- **Handwriting and shapes are whiteboard elements**, so in the select tool they can be picked, moved, resized and box-selected, and the eraser removes anything (with undo). These need a desktop version newer than 2.13.1; on 2.13.1 and earlier the three buttons do not appear and everything else works.
- **Quoting is copying.** "Copy quote" puts the text, a link back to the page and your comment on the clipboard.
- **It ships empty**: no sample PDF, no demo annotations.

On desktop versions newer than 2.13.2, every way of opening a PDF goes to this plugin: the file tree, recent items, `[[x.pdf]]` note links, page links such as `[[x.pdf#page=3]]` (what "Copy citation" produces; clicking one lands on that page) and chat citations (a quoted passage is marked through the find bar). Only `![[x.pdf]]` embeds, the explicit "Open with the built-in reader" entry and PDFs outside the vault stay with the built-in reader. On desktop 2.13.2 and earlier, note links and chat citations still open the built-in reader; open the PDF from the file tree instead.

Requires desktop Forsion 2.13.0 or newer. Desktop only.
