/**
 * dsh-session-hub 客户端 bundle 构建脚本。
 *
 * 产物 `lib/client.js` 是**手写协议**的浏览器 bundle：DSH 的客户端模块系统
 * （@deepseek-ai/dsh-client-modules）用 classic `<script>` 加载每个插件的客户端半，
 * 脚本执行时只做一件事——把自己注册进 `window.__ModuleLoader__`：
 *
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => exports })
 *
 * 客户端 bundle 里不能出现 `import`/`export`（它不是 ES 模块），也不能依赖包外的
 * 相对路径（浏览器只拿到这一个文件）。因此本脚本做一次极简的源码内联：把 `SOURCES`
 * 里的每个文件按顺序塞进同一个 factory 作用域，末尾挂 `exports.apply` / `exports.inject`。
 *
 * ## 顺序即作用域
 *
 * 内联后所有模块共享一个作用域，模块之间**不 import，直接按名字引用**。因此：
 *   - 顶层 `const` 只允许被「函数体内」引用（函数在调用时才求值），不允许在模块初始化
 *     阶段读取别的模块的 `const`；
 *   - 顺序按「纯逻辑 → 有状态 → 胶水」排，读起来就是数据流的方向。
 *
 * 用法：
 *   node build/bundle.mjs            # 生成 lib/client.js
 *   node build/bundle.mjs --check    # 只校验产物是当前源码的等价生成（CI 用）
 *
 * @module dsh-session-hub/build
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** 包名：注册到 __ModuleLoader__ 的 id，必须与 package.json 的 name 一致。 */
const PACKAGE_NAME = 'dsh-session-hub'

/**
 * 参与内联的源文件，**顺序即作用域顺序**。
 *
 * 每一项：`file` 是相对 src/ 的文件名，`label` 是产物里 region 注释用的说明。
 * @type {ReadonlyArray<{ file: string, label: string }>}
 */
const SOURCES = Object.freeze([
  { file: 'hub-identity.js', label: '插件 id 与存储键（单一来源）' },
  { file: 'hub-strings.js', label: '界面文案（单一来源）' },
  { file: 'hub-model.js', label: '状态栏 / 任务栏纯逻辑' },
  { file: 'notify-core.js', label: '通知边沿引擎（纯逻辑）' },
  { file: 'hub-scroll.js', label: '侧栏会话行定位、滚动与揭示控制器' },
  { file: 'hub-json-store.js', label: 'localStorage JSON 读写' },
  { file: 'hub-stores.js', label: '配置 / 水位 / 确认表 / 后台完成记账' },
  { file: 'hub-notify.js', label: '通知落地（短 tag / 跨标签页去重 / 落地日志）' },
  { file: 'hub-host.js', label: '宿主半路由（前置窗口 / 任务栏状态 / 在线探活）' },
  { file: 'hub-ui.js', label: 'React 状态栏与行悬停提示组件' },
  { file: 'hub-slots.js', label: '插槽注册' },
  { file: 'client-main.js', label: '接线：服务 → 模型 → 通知 / 状态栏 / 任务栏' },
])

const PACKAGE_JSON = join(ROOT, 'package.json')
const OUTPUT = join(ROOT, 'lib', 'client.js')

/**
 * 把 ESM 纯逻辑模块转成同一作用域内的普通声明。
 *
 * 只处理本插件自己写的模块：它们没有 import、没有 `export default`、没有重导出，
 * 全部导出都是 `export const` / `export function`。任何超出该假设的形状都直接报错，
 * 而不是悄悄生成一个坏 bundle。
 * @param {string} source 源码文本。
 * @param {string} label 报错用的文件名。
 * @returns {string} 去掉导出关键字后的源码。
 */
function inlineEsModule(source, label) {
  if (/^\s*import\s/m.test(source)) {
    throw new Error(`${label} 不允许出现 import（客户端 bundle 是单文件）`)
  }
  if (/^\s*export\s+default\b/m.test(source)) {
    throw new Error(`${label} 不允许 export default（内联后无法表达）`)
  }
  if (/^\s*export\s*\{/m.test(source)) {
    throw new Error(`${label} 不允许 export {...} 列表（内联后无法表达）`)
  }
  return source.replace(/^export\s+/gm, '')
}

/**
 * 缩进一段源码，方便产物阅读。
 * @param {string} source 源码。
 * @param {string} pad 前缀。
 * @returns {string} 缩进后的源码。
 */
function indent(source, pad) {
  return source
    .split('\n')
    .map((line) => (line.length === 0 ? line : `${pad}${line}`))
    .join('\n')
}

/**
 * 生成 bundle 文本。
 * @returns {string} lib/client.js 的完整内容。
 */
function build() {
  // 版本从 package.json 注入，保证「宿主半读 package.json」与「客户端半内联」永远一致：
  // 两半版本不一致是真实存在的运行状态（宿主半随 DSH 启动加载，客户端半随页面加载），
  // 必须能一眼看出来。
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
  const version = typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : 'unknown'

  const header = `/**
 * dsh-session-hub —— 客户端 bundle（由 build/bundle.mjs 生成，请不要手改）
 *
 * 内联自 src/ 下的 ${SOURCES.length} 个文件（顺序即作用域顺序）：
${SOURCES.map((entry) => ` *   - src/${entry.file.padEnd(20)}${entry.label}`).join('\n')}
 *
 * 协议：DSH 客户端模块系统用 classic <script> 加载本文件，脚本执行时通过
 * window.__ModuleLoader__.load({ id, factory }) 注册工厂；工厂在首次
 * import/require 时物化，并作为 Cordis 插件激活（apply + inject）。
 */
window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PACKAGE_NAME)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

\t\t/** 客户端半的构建版本；由 build/bundle.mjs 从 package.json 注入。 */
\t\tconst BUNDLE_VERSION = ${JSON.stringify(version)};
`

  const footer = `
\t\texports.apply = apply;
\t\texports.inject = inject;
\t\treturn module.exports;
\t}
});
`

  const chunks = [header]
  for (const entry of SOURCES) {
    const source = readFileSync(join(ROOT, 'src', entry.file), 'utf8')
    chunks.push(`\n\t\t//#region src/${entry.file} —— ${entry.label}\n`)
    chunks.push(indent(inlineEsModule(source, entry.file).trimEnd(), '\t\t'))
    chunks.push('\n\t\t//#endregion\n')
  }
  chunks.push(footer)

  const body = chunks.join('')

  // 语法自检：产物必须是可解析的脚本。
  try {
    // eslint-disable-next-line no-new-func
    new Function(body)
  } catch (error) {
    throw new Error(`生成的 bundle 语法非法：${error.message}`)
  }
  return body
}

const bundle = build()
const checkOnly = process.argv.includes('--check')

if (checkOnly) {
  let existing = ''
  try {
    existing = readFileSync(OUTPUT, 'utf8')
  } catch {
    console.error('lib/client.js 不存在，请先运行：node build/bundle.mjs')
    process.exit(1)
  }
  if (existing !== bundle) {
    console.error('lib/client.js 与源码不一致，请重新运行：node build/bundle.mjs')
    process.exit(1)
  }
  console.log('lib/client.js 与源码一致')
  process.exit(0)
}

mkdirSync(dirname(OUTPUT), { recursive: true })
writeFileSync(OUTPUT, bundle, 'utf8')
console.log(`已生成 ${OUTPUT}（${Buffer.byteLength(bundle, 'utf8')} 字节）`)
