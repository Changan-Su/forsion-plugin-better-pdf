// 打包 src/index.ts(含 pdf.js)→ 单文件 IIFE main.js。
//  - format:'iife' → 顶层无 import/export,过宿主的「main.js 必须是裸 setup 体」闸;`ctx` 是宿主注入的自由变量。
//  - pdf.js 的 worker 以**文本**进包(`?text` 后缀),运行时做成 Blob URL:宿主 CSP 是 `worker-src 'self' blob:`,
//    而插件拿不到宿主那份带哈希的 worker 地址。
//  - .css 当文本进包,运行时注入 <style>。
//  - globalName + footer:入口的默认导出是清理函数,footer 在函数体最外层把它 return 给宿主(停用 / 重载时先调,那时 ctx 还能用)。
//  - main.js 必须提交并与 src 同步(市场装 zip 不构建)—— 改 src 后重跑本脚本。
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const dev = process.argv.includes('--dev')

const asText = {
  name: 'as-text',
  setup(b) {
    b.onResolve({ filter: /\?text$/ }, (a) => ({ path: require.resolve(a.path.slice(0, -5)), namespace: 'as-text' }))
    b.onLoad({ filter: /.*/, namespace: 'as-text' }, async (a) => ({ contents: await readFile(a.path, 'utf8'), loader: 'text' }))
  },
}

export const options = {
  entryPoints: ['src/index.ts'],
  outfile: 'main.js',
  bundle: true,
  format: 'iife',
  globalName: '__pdfReader',
  footer: { js: 'return __pdfReader.default;' },
  platform: 'browser',
  target: 'es2022',
  minify: !dev,
  sourcemap: false,
  legalComments: 'none',
  loader: { '.css': 'text' },
  plugins: [asText],
  metafile: true,
  logLevel: 'info',
}

// 直接运行才落盘;check.mjs 只借这份配置在内存里重打一遍,核对 main.js 和 src 是不是同步。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = await build(options)
  console.log(`built main.js (${(out.metafile.outputs['main.js'].bytes / 1024).toFixed(0)} KB)`)
}
