# PDF 阅读器(Forsion 插件)

读文献用的 PDF 阅读器:划线、批注、标签、便签、区域框、手写。装上之后,点开库里的 PDF 就由它打开。

- **批注不改 PDF**。每份 PDF 的批注存在它旁边的隐藏文件 `.<文件名>.pdf.annot.json` 里(坐标是 PDF 自己的坐标,换设备、换缩放都对得上)。
  需要给别人看时用「更多 → 导出带批注的 PDF」另存一份。
- **手写是白板的笔**。笔迹就是宿主白板的元素,用的是宿主的白板层接口 `ctx.ui.mountBoard`;应用版本不带这个接口时,「手写」「橡皮」两个按钮不出现,其余功能照常。
- **右栏**:批注列表、PDF 目录、Tangu 对话三个标签,跟着你最近操作的那份 PDF 走。
- **装好是空的**:不带示例 PDF,不带演示批注。

没接管的两种打开方式仍然走内置阅读器:带页码或引文的跳转(聊天里的引用、`[[x.pdf#page=3]]`),以及笔记里的 `![[x.pdf]]` 嵌入。

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

它用真鼠标走一遍:点开 → 选字高亮 → 评论 / 标签 / 换色 → 引用到笔记 → 问 Tangu → 目录 / 查找 / 缩略图 → 下划线 → 便签 / 区域 →
缩放后对位 → 手写(翻页、放大后再画、撤销重做、橡皮)→ 导出 → 关掉重开。截图在 `.shots/`。

## 源码

| 文件 | 管什么 |
|---|---|
| `src/index.ts` | 入口:接管 `.pdf`、注册右栏三个视图 |
| `src/reader.ts` | 一份打开着的 PDF:工具栏、页面上的批注层、选中浮条、批注卡、查找、缩略图 |
| `src/panel.ts` | 右栏:批注列表 / 目录 / 对话 |
| `src/store.ts` | 批注的存取(旁挂文件) |
| `src/ink.ts` | 手写:白板层 + 每页的静态笔迹 |
| `src/export.ts` | 导出带批注的 PDF |
| `src/geom.ts` | 选区、点击 ↔ PDF 坐标 |
| `src/pdf.ts` | pdf.js 的装载(样式关进作用域、worker 走 Blob 地址) |

## 已知的边界

- PDF 被别的程序改写后不会自动重载,关掉重开。
- 便签 / 文字 / 区域放下后不能拖动,删掉重放。
- 批注文件不监听外部改动:另一台设备同步过来的批注,要重开这份 PDF 才看得到。
- 没随包带 cMap / 标准字体(和内置阅读器一样),极少数老式中日韩 PDF 的字会缺。
