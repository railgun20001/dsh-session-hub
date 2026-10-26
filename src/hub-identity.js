/**
 * dsh-session-hub —— 插件身份与存储键的**单一来源**
 *
 * 这些字符串以前散在三个地方（宿主半的 `PROJECTION_KEY`、客户端半的 `PLUGIN_ID`、
 * 以及各处 localStorage 键字面量），注释还写着「两半共用同一个字符串」却没有共用的事实。
 * 现在两半都从这里取：
 *
 *   - 宿主半 `index.js` 直接 import（Node ESM）；
 *   - 客户端半被 `build/bundle.mjs` 内联进同一个 factory 作用域（去掉 `export` 前缀）。
 *
 * 因此本文件**不能** import 任何东西：内联要求它是自足的（否则 bundle 里会出现顶层
 * `import`，浏览器 classic script 直接语法错误）。
 *
 * @module dsh-session-hub/hub-identity
 */

/**
 * 插件 id，同时是：
 *   - 客户端 bundle 注册进 `window.__ModuleLoader__` 的 id（必须与 package.json 的 name 一致）；
 *   - 客户端调宿主半路由的路径前缀（文档相对路径 `dsh-session-hub/<action>`）；
 *   - 所有日志行的标签。
 * @type {string}
 */
export const PLUGIN_ID = 'dsh-session-hub'

/**
 * 宿主半注册的会话投影键。宿主半与客户端半共用这一个字符串。
 * @type {string}
 */
export const PROJECTION_KEY = 'hubTurnOutcome'

/**
 * 宿主半挂载内部路由的前缀（`/ping` `/debug` `/warmup` `/raise` `/taskbar` 挂在它下面）。
 * @type {string}
 */
export const ROUTE_PATH = '/dsh-session-hub'

/**
 * 内部路由的签名头名称（值见 {@link ROUTE_HEADER_VALUE}）。
 *
 * 两半共用一份：客户端每条请求都带上它，宿主半见到它才处理。自定义头会把浏览器请求
 * 升级成需要预检的跨站请求，而宿主半不返回任何 CORS 响应头——于是别的网页即使能
 * POST 到本机端口，也到不了 handler（详见 index.js 里 createRouteHandler 的说明）。
 * @type {string}
 */
export const ROUTE_HEADER = 'x-dsh-session-hub'

/**
 * 签名头的唯一合法取值。没有语义，只是为了让头「非空且确定」，便于服务端做等值判断。
 * @type {string}
 */
export const ROUTE_HEADER_VALUE = '1'

/**
 * localStorage 键的后缀。
 *
 * 带版本后缀是刻意的：形状一变就改后缀，旧数据自然作废，不需要写迁移代码。
 * @type {Readonly<Record<string, string>>}
 */
export const STORAGE_SUFFIX = Object.freeze({
  /** 用户配置（见 notify-core 的 DEFAULT_CONFIG）。 */
  config: 'config-v1',
  /** 通知水位：每个会话已消化到哪个事件。 */
  watermarks: 'watermarks-v1',
  /** 已确认的报错 `{ sessionId: seq }`：红点与任务栏红灯据此熄灭。 */
  ack: 'error-acks-v1',
  /** 补记的「后台完成、尚未查看」`{ sessionId: seq }`：绿点与任务栏绿灯的依据。 */
  unread: 'local-unread-v1',
  /** 跨标签页去重窗口（同一事件只允许一个页面真的弹通知）。 */
  recent: 'recent-v1',
  /** 通知落地结果诊断日志（环形，保留最近若干条）。 */
  notifyLog: 'notify-log-v1',
})

/**
 * 拼出当前插件的全部 localStorage 键。
 * @param {string} [pluginId] 插件 id；默认 {@link PLUGIN_ID}。
 * @returns {Record<string, string>} 例如 `{ config: 'dsh-session-hub/config-v1', … }`。
 */
export function hubStorageKeys(pluginId = PLUGIN_ID) {
  const keys = {}
  for (const [name, suffix] of Object.entries(STORAGE_SUFFIX)) keys[name] = `${pluginId}/${suffix}`
  return keys
}
