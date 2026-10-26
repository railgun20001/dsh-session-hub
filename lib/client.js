/**
 * dsh-session-hub —— 客户端 bundle（由 build/bundle.mjs 生成，请不要手改）
 *
 * 内联自 src/ 下的 12 个文件（顺序即作用域顺序）：
 *   - src/hub-identity.js     插件 id 与存储键（单一来源）
 *   - src/hub-strings.js      界面文案（单一来源）
 *   - src/hub-model.js        状态栏 / 任务栏纯逻辑
 *   - src/notify-core.js      通知边沿引擎（纯逻辑）
 *   - src/hub-scroll.js       侧栏会话行定位、滚动与揭示控制器
 *   - src/hub-json-store.js   localStorage JSON 读写
 *   - src/hub-stores.js       配置 / 水位 / 确认表 / 后台完成记账
 *   - src/hub-notify.js       通知落地（短 tag / 跨标签页去重 / 落地日志）
 *   - src/hub-host.js         宿主半路由（前置窗口 / 任务栏状态 / 在线探活）
 *   - src/hub-ui.js           React 状态栏与行悬停提示组件
 *   - src/hub-slots.js        插槽注册
 *   - src/client-main.js      接线：服务 → 模型 → 通知 / 状态栏 / 任务栏
 *
 * 协议：DSH 客户端模块系统用 classic <script> 加载本文件，脚本执行时通过
 * window.__ModuleLoader__.load({ id, factory }) 注册工厂；工厂在首次
 * import/require 时物化，并作为 Cordis 插件激活（apply + inject）。
 */
window.__ModuleLoader__.load({
	id: "dsh-session-hub",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** 客户端半的构建版本；由 build/bundle.mjs 从 package.json 注入。 */
		const BUNDLE_VERSION = "0.1.0";

		//#region src/hub-identity.js —— 插件 id 与存储键（单一来源）
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
		const PLUGIN_ID = 'dsh-session-hub'

		/**
		 * 宿主半注册的会话投影键。宿主半与客户端半共用这一个字符串。
		 * @type {string}
		 */
		const PROJECTION_KEY = 'hubTurnOutcome'

		/**
		 * 宿主半挂载内部路由的前缀（`/ping` `/debug` `/warmup` `/raise` `/taskbar` 挂在它下面）。
		 * @type {string}
		 */
		const ROUTE_PATH = '/dsh-session-hub'

		/**
		 * 内部路由的签名头名称（值见 {@link ROUTE_HEADER_VALUE}）。
		 *
		 * 两半共用一份：客户端每条请求都带上它，宿主半见到它才处理。自定义头会把浏览器请求
		 * 升级成需要预检的跨站请求，而宿主半不返回任何 CORS 响应头——于是别的网页即使能
		 * POST 到本机端口，也到不了 handler（详见 index.js 里 createRouteHandler 的说明）。
		 * @type {string}
		 */
		const ROUTE_HEADER = 'x-dsh-session-hub'

		/**
		 * 签名头的唯一合法取值。没有语义，只是为了让头「非空且确定」，便于服务端做等值判断。
		 * @type {string}
		 */
		const ROUTE_HEADER_VALUE = '1'

		/**
		 * localStorage 键的后缀。
		 *
		 * 带版本后缀是刻意的：形状一变就改后缀，旧数据自然作废，不需要写迁移代码。
		 * @type {Readonly<Record<string, string>>}
		 */
		const STORAGE_SUFFIX = Object.freeze({
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
		function hubStorageKeys(pluginId = PLUGIN_ID) {
		  const keys = {}
		  for (const [name, suffix] of Object.entries(STORAGE_SUFFIX)) keys[name] = `${pluginId}/${suffix}`
		  return keys
		}
		//#endregion

		//#region src/hub-strings.js —— 界面文案（单一来源）
		/**
		 * dsh-session-hub —— 界面文案的**单一来源**
		 *
		 * 状态栏、会话行悬停提示、以及注册到宿主 locale 服务的字典，都必须从这里取。
		 * 之前同一个字符串存在三处（locale 注册一份、两个组件的 FALLBACK 各一份），加一条文案
		 * 要改三个地方，漏一处就会在界面上直接显示出 key 名（例如 `state.unread`）。
		 *
		 * 只放「可见文案」：状态的内部取值（`error` / `answer` / `running` / `unread`）与颜色
		 * 优先级属于模型层（见 hub-model.js 的 STATE_ORDER），不要混进来。
		 *
		 * 键的命名约定：
		 *   - `label` / `idle` / `aria` / `more` / `collapse`：状态栏容器自身
		 *   - `state.<state>`：状态短标签，`<state>` 必须与 hub-model 的 STATE_ORDER 键一致
		 *   - `row.<kind>`：会话行悬停卡片里的失败提示，`<kind>` 与 failureKindOf 的返回值一致
		 *
		 * @module dsh-session-hub/hub-strings
		 */

		/**
		 * 两种语言的完整文案表。
		 *
		 * `zh` 同时充当「locale 服务不可用」时的回落（见 hub-ui.js 的 createFallbackT）：
		 * 回落不是另一套文案，就是中文这一份，避免两份内容各自漂移。
		 *
		 * @type {Readonly<Record<'zh'|'en', Readonly<Record<string, string>>>>}
		 */
		const HUB_STRINGS = Object.freeze({
		  zh: Object.freeze({
		    label: '会话',
		    idle: '全部空闲',
		    aria: '会话状态：{count} 个需要关注',
		    more: '还有 {count} 个会话',
		    collapse: '收起',
		    'state.answer': '等待回答',
		    'state.error': '报错',
		    'state.running': '运行中',
		    'state.unread': '待查看',
		    'row.failed': '本轮失败',
		    'row.interrupted': '本轮中断',
		    'row.hint': '该会话最后一轮没有正常结束',
		  }),
		  en: Object.freeze({
		    label: 'Sessions',
		    idle: 'All idle',
		    aria: 'Session status: {count} need attention',
		    more: '{count} more Sessions',
		    collapse: 'Collapse',
		    'state.answer': 'Waiting',
		    'state.error': 'Failed',
		    'state.running': 'Running',
		    'state.unread': 'Unread',
		    'row.failed': 'Last turn failed',
		    'row.interrupted': 'Last turn interrupted',
		    'row.hint': 'The last turn of this Session did not finish normally',
		  }),
		})
		//#endregion

		//#region src/hub-model.js —— 状态栏 / 任务栏纯逻辑
		/**
		 * dsh-session-hub —— 状态栏与任务栏的纯逻辑模型（零依赖，可在 Node 里单测）
		 *
		 * 这一层把「会话列表 + 统一会话状态 + 最后回合结局投影」折叠成状态栏要显示的行，
		 * 以及任务栏要显示的聚合状态。它不碰 DOM、不碰 React、不碰 Cordis。
		 *
		 * ## 输入形状（均来自 DSH 受支持的客户端服务）
		 *
		 * 1. `ctx.sessions.list` 快照：
		 *    - `byId[id]`：`{ displayTitle, title, running, blank, origin, updatedAt, retainedBy }`
		 *    - `projectionsBySession[id].values.hubTurnOutcome`：宿主半折叠的最后一个回合结局
		 *      三态语义：对象 = 有结局；`null` = 键已注册但还没有回合；**缺失** = 宿主半未加载。
		 * 2. `ctx.uiSession.sessionStatus`：`{ running, pendingInteraction, completionUnread }`
		 *    - `pendingInteraction.kind` ∈ `approval` | `plan-review` | `question`
		 *
		 * ## 状态与优先级
		 *
		 *   报错（error，红） > 等待回答（answer，黄） > 待查看（unread，绿） > 运行中（running，蓝）
		 *
		 * 口径与任务栏一致：**红 → 黄 → 绿 → 蓝**，越靠前的颜色越需要你介入，
		 * 也让「状态栏 chip 顺序」和「任务栏点灯颜色」永远说的是同一种优先级。
		 * 注意这只决定**显示顺序**；一个会话归到哪一类仍由 `deriveHubRows` 的判定顺序决定
		 * （同时在等你回答又还没确认上一轮失败时，按「等待回答」显示，因为它更要求你动手）。
		 *
		 * 任务栏只点「需要你处理」的灯：
		 *   - 有报错 → red
		 *   - 否则有等待回答 → yellow
		 *   - 否则有**待查看**（未读完成）→ green
		 *   - 都没有 → none（清除覆盖图标）
		 *
		 * ## 「待查看」为什么不能只信官方的 completionUnread
		 *
		 * 官方 `ui-session` 的 `observeRunning` 只在「running → 停止」且**该会话不是主视图**
		 * （`retainedBy.mainView === 0`）时记 `completionUnread`；`reconcileStatus` 还会对
		 * 主视图会话主动清掉它。于是「你正在看这个对话、但 DSH 窗口被别的窗口盖住」这种最常见
		 * 的等任务场景里，回合结束**不会有任何待查看状态**——绿点、绿灯、状态栏 chip 全都不出现。
		 *
		 * 插件因此自带一份「后台完成」记账（`localUnread`）：窗口不在前台时观测到的回合完成
		 * 由客户端半补记，等窗口回到前台且真的在看这个会话时再清掉。判定见 {@link hasLocalUnread}。
		 *
		 * **运行中不点灯**：正在跑是常态，不需要你介入；把它点亮只会让任务栏一直是绿的，
		 * 反而盖掉真正的提示。运行中仍然出现在状态栏 chip 里（蓝色脉冲点）。
		 *
		 * @module dsh-session-hub/hub-model
		 */

		/** 三类「需要你回应」的待交互（与 dsh-client-ui-workspace 的 visiblePendingKind 同口径）。 */
		const HUB_PENDING_KINDS = Object.freeze(['approval', 'plan-review', 'question'])

		/**
		 * 状态排序：数字越小越靠前。
		 *
		 * 顺序刻意与颜色一致——**红（报错）> 黄（等待回答）> 绿（待查看）> 蓝（运行中）**：
		 * 一眼扫过去就是「先看红的、最后才看还在跑的」，也和任务栏点灯的优先级同源。
		 * 注意这只是**显示顺序**，不是状态判定顺序（判定见 deriveHubRows：
		 * 等待回答 > 报错 > 运行中 > 待查看，同时在等你时优先按「等待回答」显示）。
		 */
		const STATE_ORDER = Object.freeze({
		  error: 0,
		  answer: 1,
		  unread: 2,
		  running: 3,
		})

		/** 状态的中文短标签（状态栏 chip 与通知调试用）。 */
		const STATE_LABELS = Object.freeze({
		  answer: '等待回答',
		  error: '报错',
		  running: '运行中',
		  unread: '待查看',
		})

		/** 归到「报错」的回合结局。interrupted 是宿主异常退出后的合成收尾。 */
		const HUB_FAILURE_OUTCOMES = Object.freeze(['error', 'interrupted'])

		/** 状态栏最多渲染多少行（防止极端情况下渲染上千个 chip）。 */
		const MAX_HUB_ROWS = 40

		/**
		 * 取会话展示标题。
		 * @param {object} row 会话列表行。
		 * @returns {string} 标题；都没有时回落到 id。
		 */
		function hubTitleOf(row) {
		  const display = typeof row?.displayTitle === 'string' ? row.displayTitle.trim() : ''
		  if (display !== '') return display
		  const title = typeof row?.title === 'string' ? row.title.trim() : ''
		  if (title !== '') return title
		  return typeof row?.id === 'string' && row.id !== '' ? row.id : '未命名会话'
		}

		/**
		 * 从会话列表快照里解析当前打开的会话。
		 *
		 * 判据与侧栏一致：`retainedBy.mainView > 0` 的那一行就是主视图中的会话
		 * （dsh-client-ui-workspace 的 mainSessionId 同款）。
		 * @param {object} list 会话列表快照。
		 * @returns {string|undefined} 当前会话 id。
		 */
		function currentSessionIdOf(list) {
		  const byId = list?.byId
		  if (byId === null || typeof byId !== 'object') return undefined
		  for (const id of Object.keys(byId)) {
		    const row = byId[id]
		    if (row !== null && typeof row === 'object' && (row.retainedBy?.mainView ?? 0) > 0) return id
		  }
		  return undefined
		}

		/**
		 * 把「Map 或普通对象」统一成可按 id 查询的函数。
		 * @param {unknown} container Map 或对象。
		 * @returns {(id: string) => object|undefined} 查询函数。
		 */
		function lookupOf(container) {
		  if (container instanceof Map) return (id) => container.get(id)
		  if (container !== null && typeof container === 'object') return (id) => container[id]
		  return () => undefined
		}

		/**
		 * 取某会话的最后回合结局投影。
		 *
		 * 兼容两个位置：会话列表 RPC 的 `projectionsBySession`，以及单行 `projectionValues`
		 * （搜索 / 本地 fallback 行的形状）。两者都没有时返回 `undefined`，保留「宿主半未加载」
		 * 与「还没有回合」的三态区别。
		 * @param {object} list 会话列表快照。
		 * @param {string} id 会话 id。
		 * @returns {object|null|undefined} 投影值。
		 */
		function projectionOf(list, id) {
		  const fromList = list?.projectionsBySession?.[id]?.values
		  if (fromList !== null && typeof fromList === 'object' && Object.hasOwn(fromList, 'hubTurnOutcome')) {
		    return fromList.hubTurnOutcome
		  }
		  const values = list?.byId?.[id]?.projectionValues
		  if (values !== null && typeof values === 'object' && Object.hasOwn(values, 'hubTurnOutcome')) {
		    return values.hubTurnOutcome
		  }
		  return undefined
		}

		/**
		 * 判断一个投影是否构成「尚未确认的报错」。
		 * @param {object|null|undefined} projection 投影值。
		 * @param {number} ackedSeq 已确认到的 seq（没有确认过是 -1）。
		 * @returns {boolean} 是否应显示报错。
		 */
		function isUnackedFailure(projection, ackedSeq) {
		  if (projection === null || typeof projection !== 'object') return false
		  if (!HUB_FAILURE_OUTCOMES.includes(projection.outcome)) return false
		  const seq = Number.isInteger(projection.seq) ? projection.seq : -1
		  return seq > ackedSeq
		}

		/**
		 * 判断某会话是否被本插件补记为「后台完成、尚未查看」。
		 *
		 * 接受的形状（都按 id 命中即可，值本身不参与判定）：
		 *   - `{ [sessionId]: seq }`（客户端半落盘的形状）；
		 *   - `Set<string>` / `Map<string, number>`（测试与调用方便利）。
		 *
		 * @param {object|Set<string>|Map<string, number>|null|undefined} localUnread 记账表。
		 * @param {string} id 会话 id。
		 * @returns {boolean} 是否属于「后台完成未查看」。
		 */
		function hasLocalUnread(localUnread, id) {
		  if (localUnread === null || localUnread === undefined) return false
		  if (localUnread instanceof Set || localUnread instanceof Map) return localUnread.has(id)
		  if (typeof localUnread !== 'object') return false
		  const value = localUnread[id]
		  return value !== undefined && value !== null && value !== false
		}

		/**
		 * 归一化一张「会话 id → seq」的持久表：只保留非空字符串 id 与非负整数 seq。
		 *
		 * 「已确认的报错」与「补记的后台完成」是**同一形状**的两张表，以前各写了一份逐行相同的
		 * 实现；现在共用这一个函数（下面两个名字是语义别名，保留是为了调用处的可读性）。
		 * @param {unknown} value 读到的 JSON。
		 * @returns {object} `{ [sessionId]: number }`。
		 */
		function normalizeSeqMap(value) {
		  const out = {}
		  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out
		  for (const [id, seq] of Object.entries(value)) {
		    if (typeof id === 'string' && id !== '' && Number.isInteger(seq) && seq >= 0) out[id] = seq
		  }
		  return out
		}

		/**
		 * 归一化持久化的「后台完成」记账：只保留整数 seq（>= 0）的会话。
		 *
		 * seq 是「补记时那一轮回合的投影序号」，只用于诊断与去重；判定只看键是否存在。
		 * @type {(value: unknown) => object}
		 */
		const normalizeLocalUnread = normalizeSeqMap

		/**
		 * 从快照推导状态栏行。
		 *
		 * @param {object} input 输入。
		 * @param {object} input.list 会话列表快照。
		 * @param {Map|object} input.statuses 统一会话状态（Map 或对象）。
		 * @param {object} [input.ackErrors] 已确认的报错 seq：`{ [sessionId]: number }`。
		 * @param {object|Set<string>|Map<string, number>} [input.localUnread] 本插件补记的
		 *   「后台完成、尚未查看」会话（见 {@link hasLocalUnread}）。
		 * @param {boolean} [input.includeSubagents] 是否包含子代理会话（默认 false）。
		 * @param {number} [input.now] 当前时间（保留给未来排序/过期策略）。
		 * @returns {Array<{id: string, title: string, state: string, pendingKind: string|null, errorSeq: number|null, updatedAt: number}>}
		 *   按颜色优先级（红 > 黄 > 绿 > 蓝）与更新时间排好序的行。
		 */
		function deriveHubRows({
		  list,
		  statuses,
		  ackErrors = {},
		  localUnread = {},
		  includeSubagents = false,
		  now = 0,
		} = {}) {
		  const byId = list?.byId
		  if (byId === null || typeof byId !== 'object') return []
		  const statusOf = lookupOf(statuses)
		  const rows = []

		  for (const [id, row] of Object.entries(byId)) {
		    if (row === null || typeof row !== 'object') continue
		    // 空白「新会话」占位行没有内容，不进入状态栏。
		    if (row.blank === true) continue
		    // 子代理会话默认不打扰用户；一次任务会被子代理的成败淹没。
		    if (row.origin === 'subagent' && !includeSubagents) continue

		    const status = statusOf(id)
		    const pendingKind = HUB_PENDING_KINDS.includes(status?.pendingInteraction?.kind)
		      ? status.pendingInteraction.kind
		      : null
		    const projection = projectionOf(list, id)
		    const acked = Number.isInteger(ackErrors[id]) ? ackErrors[id] : -1
		    const failed = isUnackedFailure(projection, acked)
		    const running = status?.running === true || row.running === true
		    // 「待查看」有两个来源：官方 completionUnread（非主视图会话），以及本插件为
		    // 「窗口不在前台时完成的当前会话」补记的记账（官方对主视图会话永远不会置位）。
		    const unread = status?.completionUnread === true || hasLocalUnread(localUnread, id)

		    // 判定顺序（一个会话只归一类，取第一个命中的）：等待回答 > 报错 > 运行中 > 待查看。
		    // 这与 STATE_ORDER（显示顺序 红 > 黄 > 绿 > 蓝）是两件事：同时「等你回答」又「上一轮
		    // 还没确认失败」时，归为「等待回答」——它才是当下马上要你动手的那件事。
		    let state = null
		    if (pendingKind !== null) state = 'answer'
		    else if (failed) state = 'error'
		    else if (running) state = 'running'
		    else if (unread) state = 'unread'
		    if (state === null) continue

		    rows.push({
		      id,
		      title: hubTitleOf(row),
		      state,
		      pendingKind,
		      errorSeq: failed && typeof projection?.seq === 'number' ? projection.seq : null,
		      updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
		    })
		  }

		  // 显示顺序：红（报错）> 黄（等待回答）> 绿（待查看）> 蓝（运行中）；
		  // 同一类里更新时间新的靠前，最后用 id 兜底保证顺序稳定（避免 React key 跳动）。
		  rows.sort((a, b) => {
		    const byState = (STATE_ORDER[a.state] ?? 99) - (STATE_ORDER[b.state] ?? 99)
		    if (byState !== 0) return byState
		    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
		    return a.id.localeCompare(b.id)
		  })
		  return rows.slice(0, MAX_HUB_ROWS)
		}

		/**
		 * 把状态栏行聚合为任务栏状态（红 > 黄 > 绿 > 无）。
		 *
		 * 绿只来自「待查看」（未读完成），**不含运行中**：运行中是常态，任务栏常亮绿灯
		 * 会盖掉真正需要你介入的红/黄提示。运行中仍然在状态栏 chip 里可见。
		 * @param {Array<{state: string}>} rows 状态栏行。
		 * @returns {'red'|'yellow'|'green'|'none'} 任务栏状态。
		 */
		function aggregateTaskbarState(rows) {
		  if (!Array.isArray(rows) || rows.length === 0) return 'none'
		  if (rows.some((row) => row?.state === 'error')) return 'red'
		  if (rows.some((row) => row?.state === 'answer')) return 'yellow'
		  if (rows.some((row) => row?.state === 'unread')) return 'green'
		  return 'none'
		}

		/**
		 * 判定某会话「尚未确认的失败」属于哪一类，供行内提示挑选文案。
		 *
		 * 与 {@link isUnackedFailure} 同判据，只是把布尔换成可读的类别：
		 * `error`（模型/工具报错）、`interrupted`（宿主异常退出后的合成收尾）。
		 * @param {object|null|undefined} projection 投影值。
		 * @param {number} ackedSeq 已确认到的 seq。
		 * @returns {'error'|'interrupted'|null} 失败类别；没有未确认失败时为 null。
		 */
		function failureKindOf(projection, ackedSeq) {
		  if (!isUnackedFailure(projection, ackedSeq)) return null
		  return projection.outcome === 'interrupted' ? 'interrupted' : 'error'
		}

		/**
		 * 归一化持久化的报错确认表：只保留整数 seq，丢掉坏值。
		 *
		 * 实现见 {@link normalizeSeqMap}（与「后台完成」记账共用一份）。
		 * @type {(value: unknown) => object}
		 */
		const normalizeAckErrors = normalizeSeqMap
		//#endregion

		//#region src/notify-core.js —— 通知边沿引擎（纯逻辑）
		/**
		 * dsh-session-hub —— 通知决策引擎（纯逻辑，零依赖）
		 *
		 * 这一层只做一件事：把「会话事实快照」折叠成「本次应当弹出的通知列表」。
		 * 它不碰 DOM、不碰 Notification、不碰 Cordis，因此可以在 Node 里直接单测。
		 * 用例走真实 bundle：`test/client-half-test.mjs` 用桩浏览器环境加载 `lib/client.js`，
		 * 逐条断言「哪种状态变化该弹哪条通知」与 `completions` 的边沿。
		 *
		 * ## 事实来源（客户端半从 DSH 受支持服务读取）
		 *
		 * 1. 会话列表 `ctx.sessions.list`（SnapshotStore<SessionListState>）
		 *    - `byId[id]`：`{ displayTitle, title, running, blank, origin, updatedAt, retainedBy }`
		 *    - `projectionsBySession[id].values.<key>`：宿主侧投影值（本插件注册的
		 *      `hubTurnOutcome` 就在其中）
		 * 2. 统一会话状态 `ctx.uiSession.sessionStatus`（HostObservable<ReadonlyMap<id, SessionStatus>>）
		 *    - `{ running, pendingInteraction, completionUnread }`
		 *    - `pendingInteraction.kind` ∈ `approval` | `plan-review` | `question`
		 *
		 * ## 为什么事件要自己算边沿
		 *
		 * DSH 的这两路数据都是「当前状态」而不是「事件流」：running 是布尔、
		 * pendingInteraction 是当前值、投影是「最后一个回合的结局」。所以通知必须由状态
		 * 边沿推导，不能每收到一次推送就弹一次——后者正是「无问答也提示」的病灶
		 * （把实时活动当成通知发：正在思考…、正在执行 pwsh…）。
		 *
		 * 本引擎的边沿规则：
		 *  - `answer`：pendingInteraction 出现，且 key 与上次观察到的不相同；
		 *  - `failed` / `completed` / `stopped` / `max-tokens`：`hubTurnOutcome` 投影的
		 *    `seq` 严格大于上次观察到值；
		 *  - `completed` 退化路径：**只有调用方确认宿主半缺失**（`allowRunningFallback`
		 *    为 true，客户端由 `/ping` 探活得出）时，才用 running 的 true→false 兜底。
		 *    「读不到投影值」绝不等于「宿主半缺失」——实时取值只来自连接基线、变更帧与列表
		 *    块，新会话在第一个回合结束前本来就没有值，把它当成宿主的缺失就会在首个回合结束
		 *    的瞬间弹出一条假的「完成」；
		 *  - 每个会话每次观察最多产出一条通知，优先级 answer > 回合结局 > 兜底。
		 *
		 * 启动基线：插件刚激活时，所有会话的当前状态只记为基线、不通知；之后只有真正的新边沿
		 * 才通知。再加一层「新鲜度窗口」：事件 `time` 早于 `now - freshnessWindowMs` 的边沿
		 * 只推进水位、不通知（宿主重启后补写的历史事件不会变成一串迟到的通知）。
		 *
		 * ## 为什么除了通知还要回报 `completions`
		 *
		 * 「这一轮结束了」是一个**状态事实**，不只是「该不该弹通知」：官方的
		 * `completionUnread`（待查看绿点 / 任务栏绿灯）对主视图会话永远不置位，所以
		 * 「正在看的对话在后台跑完」这个最常见场景需要客户端半自己补记。边沿判定只应该有一份
		 * 实现，因此引擎把本次观测到的**回合完成边沿**（completed / max-tokens）连同通知一起
		 * 回报给调用方；是否补记由调用方按「窗口是否在前台」决定（见 `planNotifications` 的
		 * `completions` 返回值）。注意它与分类开关、静默无关——关掉「完成通知」不影响绿点。
		 *
		 * @module notify-core
		 */

		/** 配置默认值；客户端半用 localStorage 覆盖其中任意字段。 */
		const DEFAULT_CONFIG = Object.freeze({
		  /** 总开关。关掉后引擎照样跑（保持水位一致），只是不产出通知。 */
		  enabled: true,
		  /** 任务完成（正常收尾）。 */
		  onComplete: true,
		  /** 运行失败（turn/end 的 error，含账号登出重分类）。 */
		  onFailure: true,
		  /** 需要你回应：提问 / 待审批 / 计划待审。 */
		  onAnswer: true,
		  /** 达到单步输出上限（不算失败，但值得知道）。 */
		  onMaxTokens: true,
		  /** 手动停止 / 被中断（默认关：这是你自己的动作，不必再提醒一次）。 */
		  onStopped: false,
		  /** 子代理会话是否也通知（默认关：否则一次任务会被子代理的成败淹没）。 */
		  includeSubagents: false,
		  /** 窗口聚焦、而且正在看的正是这个会话时不弹（内容就在眼前）。 */
		  silenceCurrentWhenFocused: true,
		  /** 窗口聚焦时一律不弹。 */
		  silenceAllWhenFocused: false,
		  /** 判定「聚焦」时是否要求页面可见（最小化/隐藏视作不聚焦）。 */
		  requireVisibleForFocus: true,
		  /** 事件时间早于该窗口的边沿只推进水位、不通知。0 表示关闭该保护。 */
		  freshnessWindowMs: 120000,
		  /** 系统提示音。 */
		  sound: true,
		  /**
		   * 通知标题前加彩色圆点（🟢 完成 / 🟡 等你回应 / 🔴 失败），与状态栏、任务栏同源。
		   *
		   * Windows 上 toast 图标固定是应用图标，`icon` / `badge` 都没有落点，所以颜色只能靠
		   * 文本里的 emoji（见 {@link NOTIFY_MARKERS}）。不想要可以关掉。
		   */
		  colorMarkers: true,
		  /** 点击通知时请求宿主半把桌面窗口提到前台（见 lib/raise-window.js）。 */
		  raiseWindow: true,
		  /** 水位表保留条数上限（按 updatedAt 新的优先）。 */
		  maxRememberedSessions: 300,
		})

		/** 三类「需要你回应」的待交互（与 dsh-client-ui-workspace 的 visiblePendingKind 同口径）。 */
		const PENDING_KINDS = Object.freeze(['approval', 'plan-review', 'question'])

		/** 归到「失败」的回合结局。interrupted 是宿主异常退出后的合成收尾。 */
		const FAILURE_OUTCOMES = Object.freeze(['error', 'interrupted'])

		/**
		 * 归到「完成」的回合结局。
		 *
		 * 刻意不含 `blocked`：它是收件箱为空的良性拒绝（智能体没活可干），用户通常并不在
		 * 等它，弹「任务完成」是虚假信息。宁可不提醒，也不要提醒错。
		 */
		const COMPLETION_OUTCOMES = Object.freeze(['completed'])

		/**
		 * 算作「这一轮跑完了」的候选类别。
		 *
		 * 除通知外，它们还要被回报成 `completions`，供客户端半补记「待查看」（绿点 / 绿灯）：
		 * `max-tokens` 也是「这一轮不会再继续」，用户回来时要能看出结果已经在那儿了。
		 */
		const COMPLETION_CATEGORIES = Object.freeze(['completed', 'max-tokens'])

		/** 水位表版本：形状变化时递增，旧版本数据直接丢弃。 */
		const STATE_VERSION = 1

		/**
		 * 单会话水位：记录「上次观察到哪」的全部状态。
		 * @returns {object} 空水位。
		 */
		function emptyWatcher() {
		  return {
		    /** 已消化的 hubTurnOutcome.seq；-1 表示还没见过任何回合结局。 */
		    seq: -1,
		    /** 已观察到的 pendingInteraction.key；null 表示当前无待交互。 */
		    pendingKey: null,
		    /** 上次观察到的 running，用于退化路径的边沿判定。 */
		    running: false,
		    /** 该会话是否已经建立过启动基线。 */
		    seeded: false,
		  }
		}

		/**
		 * 归一化配置：只接受已知键，布尔键强制布尔，数值键做有界数值；未知键丢弃。
		 * @param {object|undefined|null} raw 用户覆盖值。
		 * @returns {object} 完整配置。
		 */
		function normalizeConfig(raw) {
		  const out = { ...DEFAULT_CONFIG }
		  if (raw === null || typeof raw !== 'object') return out
		  for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) {
		    const value = raw[key]
		    if (value === undefined) continue
		    if (typeof fallback === 'boolean') {
		      if (typeof value === 'boolean') out[key] = value
		      continue
		    }
		    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
		      out[key] = Math.floor(value)
		    }
		  }
		  return out
		}

		/**
		 * 把宿主投影里的回合结局映射成通知类别。
		 * @param {unknown} outcome 投影 outcome。
		 * @returns {'failed'|'completed'|'stopped'|'max-tokens'|null} 类别；null 表示不通知。
		 */
		function classifyOutcome(outcome) {
		  if (typeof outcome !== 'string') return null
		  if (FAILURE_OUTCOMES.includes(outcome)) return 'failed'
		  if (COMPLETION_OUTCOMES.includes(outcome)) return 'completed'
		  if (outcome === 'aborted') return 'stopped'
		  if (outcome === 'max-tokens') return 'max-tokens'
		  // 'forked' 是分叉产生的合成收尾，不是任务结局。
		  return null
		}

		/**
		 * 类别是否被配置开启。
		 * @param {string} category 'answer'|'failed'|'completed'|'stopped'|'max-tokens'。
		 * @param {object} config 归一化配置。
		 * @returns {boolean} 是否允许通知。
		 */
		function categoryEnabled(category, config) {
		  switch (category) {
		    case 'answer': return config.onAnswer
		    case 'failed': return config.onFailure
		    case 'completed': return config.onComplete
		    case 'stopped': return config.onStopped
		    case 'max-tokens': return config.onMaxTokens
		    default: return false
		  }
		}

		/**
		 * 静默判定。
		 * @param {object} args 判定输入。
		 * @param {boolean} args.focused 窗口是否聚焦（已按 requireVisibleForFocus 折算）。
		 * @param {boolean} args.isCurrent 该会话是否是当前打开的会话。
		 * @param {object} args.config 归一化配置。
		 * @returns {boolean} true 表示静默。
		 */
		function shouldSilence({ focused, isCurrent, config }) {
		  if (!focused) return false
		  if (config.silenceAllWhenFocused) return true
		  return config.silenceCurrentWhenFocused && isCurrent
		}

		/**
		 * 每个通知类别对应的彩色圆点标识。
		 *
		 * ## 为什么用 emoji 而不是 `icon`
		 *
		 * Windows 的 toast 图标是**应用图标**（取自 AUMID 对应的快捷方式），HTML5
		 * `Notification` 的 `icon` 字段在 Windows 上不会落到 toast 里，`badge` 更是只在
		 * macOS / Android 实现。想在不放弃「点击跳回会话」的前提下（那样只能用宿主半的
		 * WinRT toast，但点击就回不到页面了）给通知加颜色，唯一可靠的落点就是文本本身，
		 * 所以用 emoji 圆点——Windows 用 Segoe UI Emoji 渲染成真正的彩色字形。
		 *
		 * 配色与状态栏 / 任务栏同源：红（失败）> 黄（等你回应）> 绿（完成）。
		 * @type {Readonly<Record<string, string>>}
		 */
		const NOTIFY_MARKERS = Object.freeze({
		  completed: '🟢',
		  failed: '🔴',
		  answer: '🟡',
		  stopped: '⚪',
		  'max-tokens': '🟠',
		  /** 手动测试通知：不是状态变化，用铃铛而不是状态色，避免被误读成真事件。 */
		  test: '🔔',
		})

		/**
		 * 生成一条通知的标题与正文。
		 * @param {object} args 输入。
		 * @param {string} args.category 通知类别。
		 * @param {string} args.title 会话展示标题。
		 * @param {object|null} args.projection 该会话的 hubTurnOutcome 投影值。
		 * @param {object|null} args.pending pendingInteraction 值。
		 * @returns {{category: string, marker: string, title: string, body: string}} 通知文案（`marker` 为彩色圆点，可能为空串）。
		 */
		function describeNotification({ category, title, projection, pending }) {
		  const name = typeof title === 'string' && title.trim() !== '' ? title : '未命名会话'
		  const marker = NOTIFY_MARKERS[category] ?? ''
		  if (category === 'answer') {
		    const kind = pending?.kind
		    const what = kind === 'approval' ? '需要你批准' : kind === 'plan-review' ? '有一个计划待审' : '需要你回答'
		    return { category, marker, title: 'DSH · 需要你回应', body: `${what}：${name}` }
		  }
		  if (category === 'failed') {
		    const message = typeof projection?.message === 'string' && projection.message !== '' ? projection.message : null
		    const code = typeof projection?.code === 'string' && projection.code !== '' ? projection.code : null
		    const suffix = message !== null ? `：${message}` : (code !== null ? `（${code}）` : '')
		    return { category, marker, title: 'DSH · 任务失败', body: `${name}${suffix}` }
		  }
		  if (category === 'stopped') return { category, marker, title: 'DSH · 任务已停止', body: name }
		  if (category === 'max-tokens') return { category, marker, title: 'DSH · 达到输出上限', body: name }
		  return { category, marker, title: 'DSH · 任务完成', body: name }
		}

		/**
		 * 折叠一次观察，产出本轮应弹的通知与新的水位。
		 *
		 * 纯函数：同样的输入必然给出同样的输出，入参不会被就地修改。
		 *
		 * @param {object} input 观察输入。
		 * @param {object|Map} input.sessions 会话行，按 id 索引。
		 *   每行：`{ id?, title?, displayTitle?, origin?, blank?, running?, updatedAt? }`。
		 * @param {object|Map} input.statuses 统一状态，按 id 索引。
		 *   每条：`{ running?, pendingInteraction?, completionUnread? }`。
		 * @param {object|Map} input.projections 投影值，按 id 索引。三态语义：
		 *   - 对象：`{ outcome, turn, seq, time, code, message }`，宿主半已记录该会话的回合结局；
		 *   - `null`：宿主半已注册该投影键，只是这个会话还没有任何 turn/end；
		 *   - **键缺失（undefined）**：宿主半根本没加载（投影键未注册），此时才允许走
		 *     running 下降沿的兜底路径。
		 * @param {object} input.state 上次水位（`{ [id]: watcher }`）。
		 * @param {object} input.config 归一化配置。
		 * @param {number} input.now 当前时间（epoch 毫秒）。
		 * @param {boolean} input.focused 窗口是否聚焦（已折算可见性）。
		 * @param {string|undefined|null} input.currentSessionId 当前打开的会话 id。
		 * @param {boolean} [input.allowRunningFallback] 是否允许 running 下降沿兜底；
		 *   **默认 false**，只有调用方确证宿主半缺失时才传 true。
		 * @returns {{notifications: Array<object>, state: object, notes: Array<string>, completions: Array<object>}}
		 *   通知列表、新水位、诊断说明（用于调试与单测断言）、以及本次观测到的**回合完成边沿**
		 *   （`{ sessionId, seq, time, category }`，与通知开关/静默无关）。
		 */
		function planNotifications(input) {
		  const {
		    sessions = {},
		    statuses = {},
		    projections = {},
		    state = {},
		    config = DEFAULT_CONFIG,
		    now = 0,
		    focused = false,
		    currentSessionId = undefined,
		    allowRunningFallback = false,
		  } = input ?? {}

		  const next = {}
		  const notifications = []
		  const completions = []
		  const notes = []
		  const recency = new Map()

		  const rows = toEntries(sessions)
		  // 固定产出顺序，便于测试与日志阅读。
		  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])))

		  for (const [rawId, row] of rows) {
		    const id = String(rawId)
		    if (row === null || typeof row !== 'object') continue
		    // 空白「新会话」占位行没有内容，不值得通知。
		    if (row.blank === true) continue

		    recency.set(id, typeof row.updatedAt === 'number' ? row.updatedAt : 0)

		    const watcher = normalizeWatcher(state[id])
		    const status = lookup(statuses, id)
		    const projection = coerceProjection(lookup(projections, id))
		    const running = pickRunning(status, row)
		    const isCurrent = currentSessionId !== undefined && currentSessionId !== null
		      && String(currentSessionId) === id

		    // 1) 启动基线：第一次见到这个会话时只记水位，不通知。
		    if (!watcher.seeded) {
		      next[id] = {
		        seq: projectionSeq(projection),
		        pendingKey: pendingKey(status),
		        running,
		        seeded: true,
		      }
		      continue
		    }

		    // 2) 子代理会话默认不打扰用户；水位照常推进，之后打开开关也不会补弹历史。
		    if (row.origin === 'subagent' && !config.includeSubagents) {
		      next[id] = advance(watcher, status, projection, running)
		      continue
		    }

		    // 3) 本次观察的候选通知（每个会话最多一条）。
		    const candidate = deriveCandidate({
		      id, watcher, status, projection, running, now, config, notes, allowRunningFallback,
		    })
		    next[id] = advance(watcher, status, projection, running)

		    if (candidate === null) continue

		    // 3.5) 回合完成边沿：这是「状态事实」，与通知开关、静默无关，单独回报给调用方。
		    // 只认真正的投影边沿（退化路径的兜底没有 seq，也就没有可补记的「哪一轮」）。
		    if (candidate.projection !== null && COMPLETION_CATEGORIES.includes(candidate.category)) {
		      completions.push({
		        sessionId: id,
		        seq: projectionSeq(candidate.projection),
		        time: typeof candidate.projection?.time === 'number' ? candidate.projection.time : 0,
		        category: candidate.category,
		      })
		    }

		    // 4) 总开关 / 分类开关 / 静默。
		    if (!config.enabled || !categoryEnabled(candidate.category, config)) {
		      notes.push(`${id}: ${candidate.category} 未开启，跳过`)
		      continue
		    }
		    if (shouldSilence({ focused, isCurrent, config })) {
		      notes.push(`${id}: ${candidate.category} 因${config.silenceAllWhenFocused ? '窗口聚焦' : '当前会话且聚焦'}静默`)
		      continue
		    }

		    notifications.push({
		      sessionId: id,
		      dedupeKey: candidate.dedupeKey,
		      ...describeNotification({
		        category: candidate.category,
		        title: titleOf(row),
		        projection: candidate.projection,
		        pending: candidate.pending,
		      }),
		    })
		  }

		  return { notifications, state: prune(next, recency, config), notes, completions }
		}

		/**
		 * 从一次观察里推导候选通知。
		 *
		 * `dedupeKey` 描述「这是哪一个事件」，供多标签页去重使用：同一个事件在多个页面
		 * 里会被算成同一个键（同一会话 + 同一事件），因此只有一个页面会真的弹。
		 * @param {object} args 推导输入。
		 * @returns {{category: string, projection: object|null, pending: object|null, dedupeKey: string}|null} 候选。
		 */
		function deriveCandidate({ id, watcher, status, projection, running, now, config, notes, allowRunningFallback = false }) {
		  const pending = lookup2(status, 'pendingInteraction')
		  const key = pendingKey(status)
		  if (pending !== null && PENDING_KINDS.includes(pending.kind) && key !== watcher.pendingKey) {
		    return { category: 'answer', projection, pending, dedupeKey: `answer:${key}` }
		  }

		  const seq = projectionSeq(projection)
		  if (seq > watcher.seq) {
		    const category = classifyOutcome(projection.outcome)
		    if (category === null) return null
		    const time = typeof projection.time === 'number' ? projection.time : 0
		    if (config.freshnessWindowMs > 0 && time > 0 && now - time > config.freshnessWindowMs) {
		      notes.push(`${id}: ${category} 事件过旧（${now - time}ms），只推进水位`)
		      return null
		    }
		    return { category, projection, pending: null, dedupeKey: `${category}:${seq}` }
		  }

		  // 退化路径：**只有调用方确证宿主半缺失**（allowRunningFallback）时才用 running
		  // 下降沿兜底成「完成」。projection === undefined 只说明「客户端这个连接上还没有
		  // 拿到该键的值」，那可能是新会话的第一个回合、也可能是连接刚建立——把它当成宿主
		  // 缺失就会弹出假「完成」。
		  if (allowRunningFallback && projection === undefined && watcher.running && running === false) {
		    return { category: 'completed', projection: null, pending: null, dedupeKey: 'completed:fallback' }
		  }
		  return null
		}

		/**
		 * 推进水位：消化本次观察到的投影 seq、待交互 key 与 running。
		 * @param {object} watcher 旧水位。
		 * @param {object|undefined} status 统一状态。
		 * @param {object|null} projection 投影值。
		 * @param {boolean} running 本次 running。
		 * @returns {object} 新水位。
		 */
		function advance(watcher, status, projection, running) {
		  return {
		    seq: Math.max(watcher.seq, projectionSeq(projection)),
		    pendingKey: pendingKey(status),
		    running,
		    seeded: true,
		  }
		}

		/** 归一化一份水位记录；非法形状回落到空水位。 */
		function normalizeWatcher(value) {
		  if (value === null || typeof value !== 'object') return emptyWatcher()
		  return {
		    seq: Number.isInteger(value.seq) ? value.seq : -1,
		    pendingKey: typeof value.pendingKey === 'string' ? value.pendingKey : null,
		    running: value.running === true,
		    seeded: value.seeded === true,
		  }
		}

		/** 把对象或 Map 统一成 [key, value] 数组。 */
		function toEntries(container) {
		  if (container instanceof Map) return [...container.entries()]
		  if (container !== null && typeof container === 'object') return Object.entries(container)
		  return []
		}

		/** 按 id 取值（对象或 Map 都支持）。 */
		function lookup(container, id) {
		  if (container instanceof Map) return container.get(id)
		  if (container !== null && typeof container === 'object') return container[id]
		  return undefined
		}

		/** 取统一状态里的一个字段；缺失统一成 null。 */
		function lookup2(status, field) {
		  if (status === null || typeof status !== 'object') return null
		  const value = status[field]
		  return value === undefined ? null : value
		}

		/**
		 * 投影值归一化：保留三态。
		 *
		 * - `undefined`：投影键缺失（宿主半未加载）；
		 * - `null`：键在但还没有回合结局；
		 * - 对象：真实结局（形状不对的对象也退化为 null，避免把脏值当事实）。
		 * @param {unknown} value 原始值。
		 * @returns {object|null|undefined} 归一化结果。
		 */
		function coerceProjection(value) {
		  if (value === undefined) return undefined
		  if (value === null || typeof value !== 'object') return null
		  return value
		}

		/** 投影里已消化的 seq；没有投影时返回 -1。 */
		function projectionSeq(projection) {
		  if (projection === null || projection === undefined) return -1
		  return Number.isInteger(projection.seq) ? projection.seq : -1
		}

		/** 待交互的 key（没有待交互时为 null）。 */
		function pendingKey(status) {
		  const pending = lookup2(status, 'pendingInteraction')
		  if (pending === null || typeof pending !== 'object') return null
		  const key = pending.key
		  return typeof key === 'string' && key !== '' ? key : null
		}

		/** running 取值：统一状态优先，其次会话行。 */
		function pickRunning(status, row) {
		  const running = lookup2(status, 'running')
		  if (typeof running === 'boolean') return running
		  return row?.running === true
		}

		/** 通知里展示的会话标题。 */
		function titleOf(row) {
		  const display = typeof row?.displayTitle === 'string' ? row.displayTitle.trim() : ''
		  if (display !== '') return display
		  const title = typeof row?.title === 'string' ? row.title.trim() : ''
		  return title
		}

		/**
		 * 裁剪水位表：按 updatedAt 保留最近的若干会话。
		 * @param {object} state 水位表。
		 * @param {Map<string, number>} recency 会话 id → updatedAt。
		 * @param {object} config 归一化配置。
		 * @returns {object} 裁剪后的水位表。
		 */
		function prune(state, recency, config) {
		  const ids = Object.keys(state)
		  const limit = config.maxRememberedSessions
		  if (limit <= 0 || ids.length <= limit) return state
		  const sorted = [...ids].sort((a, b) => (recency.get(b) ?? 0) - (recency.get(a) ?? 0))
		  const kept = sorted.slice(0, limit)
		  const out = {}
		  for (const id of kept) out[id] = state[id]
		  return out
		}
		//#endregion

		//#region src/hub-scroll.js —— 侧栏会话行定位、滚动与揭示控制器
		/**
		 * dsh-session-hub —— 侧栏会话行定位与滚动（纯浏览器 DOM 辅助，可在 Node 里单测）
		 *
		 * 目标：点击状态栏 chip / 通知跳转到某个会话后，让**左侧会话列表也滚动到该会话行**
		 * （尽量垂直居中），长列表里目标行不在视野内时尤其重要。
		 *
		 * ## 为什么插件要自己补这一步
		 *
		 * 官方 ui-workspace 的侧栏**有**一套完整的 reveal 机制：
		 *   1. 展开目标会话所在的折叠分组；
		 *   2. 抬高该组的水位线（watermark），保证目标行不被「只显示前 N 条」折叠；
		 *   3. 目标行渲染后调用 `scrollIntoView({ block: "nearest" })`。
		 *
		 * 但这套机制只挂在**侧栏搜索结果点击**上（组件内部的 `openSearchResult` 会设置
		 * `revealSessionId`）。插件调用的是公开的 `uiWorkspace.openSession()`，它只切换主视图，
		 * 不会设置组件的内部 reveal 状态，因此列表不会滚动。
		 *
		 * ## 定位约定
		 *
		 * 官方侧栏列表行的 `data-row-key`（由 ui-workspace 的 Rows 组件写入，也用于它自身的
		 * 布局动画）：
		 *   - 会话行：`session:<sessionId>`
		 *   - 工作区分组行：`workspace:<workspaceId>`
		 *
		 * 这里按「先按属性前缀粗筛，再用 dataset 精确比较」查找，**不把会话 id 拼进 CSS
		 * 选择器**——id 里可能带引号/反斜杠，拼进选择器会抛异常或误匹配。
		 *
		 * @module dsh-session-hub/hub-scroll
		 */

		/** 会话行 `data-row-key` 的前缀。 */
		const SESSION_ROW_PREFIX = 'session:'

		/** 工作区分组行 `data-row-key` 的前缀。 */
		const WORKSPACE_ROW_PREFIX = 'workspace:'

		/**
		 * 跳转后等待侧栏渲染出目标会话行的上限（毫秒）。
		 *
		 * 点一下 chip 后列表要等 React 提交、必要时还要先抬高 watermark 才渲染目标行，
		 * 所以不是同步可见的；1.5 秒足够覆盖正常渲染，超过就静默放弃（绝不长时间占用帧）。
		 */
		const REVEAL_RETRY_TIMEOUT_MS = 1500

		/**
		 * 揭示重试的最大帧数。
		 *
		 * 与 {@link REVEAL_RETRY_TIMEOUT_MS} 取先到者：文档很大时每次重试都要扫一遍
		 * `[data-row-key]`，40 帧（约 0.7 秒 @60fps）已足够覆盖正常渲染，再等只是浪费。
		 */
		const REVEAL_MAX_ATTEMPTS = 40

		/**
		 * 按 `data-row-key` 精确定位一行。
		 * @param {Document|object|null} doc 文档（真实 DOM 或测试桩）。
		 * @param {string} key 目标 `data-row-key` 的完整值。
		 * @returns {Element|null} 命中的行元素；文档或行不存在时为 null。
		 */
		function findRowByKey(doc, key) {
		  if (doc === null || typeof doc !== 'object' || typeof doc.querySelectorAll !== 'function') return null
		  if (typeof key !== 'string' || key === '') return null
		  let rows
		  try {
		    rows = doc.querySelectorAll('[data-row-key]')
		  } catch {
		    // DOM 不可用（例如极早期的客户端或测试桩）时静默放弃：滚动只是锦上添花。
		    return null
		  }
		  if (rows === null || typeof rows !== 'object' || typeof rows.length !== 'number') return null
		  for (let index = 0; index < rows.length; index += 1) {
		    const row = rows[index]
		    if (row !== null && typeof row === 'object' && row.dataset?.rowKey === key) return row
		  }
		  return null
		}

		/**
		 * 找到侧栏里属于某个会话的行。
		 * @param {Document|object|null} doc 文档。
		 * @param {string} sessionId 会话 id。
		 * @returns {Element|null} 会话行；尚未渲染（未展开 / 被过滤）时为 null。
		 */
		function findSessionRow(doc, sessionId) {
		  if (typeof sessionId !== 'string' || sessionId === '') return null
		  return findRowByKey(doc, `${SESSION_ROW_PREFIX}${sessionId}`)
		}

		/**
		 * 找到某个工作区的分组行。
		 * @param {Document|object|null} doc 文档。
		 * @param {string} workspaceId 工作区 id；空串表示官方的「未分组」桶。
		 * @returns {Element|null} 分组行；不存在时为 null。
		 */
		function findWorkspaceRow(doc, workspaceId) {
		  if (typeof workspaceId !== 'string') return null
		  return findRowByKey(doc, `${WORKSPACE_ROW_PREFIX}${workspaceId}`)
		}

		/**
		 * 从 `uiWorkspace.workspaces.list` 的快照里找出某会话所属的工作区 id。
		 *
		 * 与官方 `owningGroupKey()` 同口径：第一个 `sessionIds` 包含该会话的工作区即归属；
		 * 快照可用但没有归属时返回空串（官方用空串表示「未分组」桶）；快照不可用（服务尚未
		 * 注册 / 形状不符）时返回 null，把「不知道」与「确定未分组」区分开。
		 * @param {object|undefined|null} snapshot 工作区列表快照，形如 `{ items: [{ workspaceId, sessionIds }] }`。
		 * @param {string} sessionId 会话 id。
		 * @returns {string|null} 工作区 id（可能是空串）；无法判定时为 null。
		 */
		function owningWorkspaceIdOf(snapshot, sessionId) {
		  if (typeof sessionId !== 'string' || sessionId === '') return null
		  const items = Array.isArray(snapshot?.items) ? snapshot.items : null
		  if (items === null) return null
		  for (const item of items) {
		    if (item === null || typeof item !== 'object') continue
		    if (!Array.isArray(item.sessionIds) || !item.sessionIds.includes(sessionId)) continue
		    return typeof item.workspaceId === 'string' ? item.workspaceId : null
		  }
		  return ''
		}

		/**
		 * 把一行滚动到可滚动祖先的**垂直居中**位置。
		 *
		 * 用 `block: "center"` 而不是官方 reveal 的 `nearest`：点击 chip / 通知是一次
		 * 「带我去看看这个会话」的显式跳转，目标行落在列表中部最醒目，也方便继续上下浏览；
		 * `nearest` 只保证「不被裁剪」，长列表里目标行会贴在列表顶部或底部的边缘，不够明确。
		 *
		 * 列表首尾的行无法真正居中时，浏览器会自动收敛到可滚动范围的边界——这正是
		 * 「尽量居中」：能居中就居中，不能就贴边，不会滚过头。滚动失败（宿主不支持
		 * 该选项等）只当没发生，绝不抛出。
		 * @param {Element|null} row 行元素。
		 */
		function scrollRowIntoView(row) {
		  if (row === null || typeof row !== 'object' || typeof row.scrollIntoView !== 'function') return
		  try {
		    row.scrollIntoView({ block: 'center' })
		  } catch {
		    /* 滚动只是锦上添花：失败不影响跳转与列表本身 */
		  }
		}

		/**
		 * 把侧栏列表滚动到某个会话行。
		 *
		 * 优先滚到会话行本身；找不到时退化为它所属的工作区分组行——分组被折叠时会话行
		 * 根本不会渲染，把用户带到分组标题仍比什么都不做强。
		 * @param {Document|object|null} doc 文档。
		 * @param {string} sessionId 会话 id。
		 * @param {{ workspaces?: object }} [context] 可选：`uiWorkspace.workspaces.list` 的快照，
		 *   仅用于「会话行不在 DOM 时找分组行」。
		 * @returns {'session'|'workspace'|null} 实际滚动到的行类型；没有滚动时为 null。
		 */
		function scrollSessionRowIntoView(doc, sessionId, context = {}) {
		  const sessionRow = findSessionRow(doc, sessionId)
		  if (sessionRow !== null) {
		    scrollRowIntoView(sessionRow)
		    return 'session'
		  }
		  const workspaceId = owningWorkspaceIdOf(context?.workspaces, sessionId)
		  if (workspaceId === null) return null
		  const workspaceRow = findWorkspaceRow(doc, workspaceId)
		  if (workspaceRow === null) return null
		  scrollRowIntoView(workspaceRow)
		  return 'workspace'
		}

		/**
		 * 创建一个「跳转后把侧栏滚到目标行」的控制器。
		 *
		 * ## 为什么要重试
		 *
		 * 跳转先改当前会话，侧栏列表要等 React 提交后才会（必要时先抬高该组 watermark 再）渲染
		 * 目标行，所以刚跳完那一刻目标行**可能还不在 DOM 里**。这里用 rAF 反复试到
		 * {@link REVEAL_RETRY_TIMEOUT_MS} 与 {@link REVEAL_MAX_ATTEMPTS} 先到者为止，
		 * 每次只扫一遍 `[data-row-key]`。
		 *
		 * ## 为什么只认最新一次跳转
		 *
		 * 连续点几个 chip 时，前几次的重试循环不能把列表再拉回旧会话——所以每次跳转领一个自增
		 * 序号，循环里发现序号变了就立刻退出。
		 *
		 * @param {object} options 依赖注入。
		 * @param {string} options.pluginId 日志标签。
		 * @param {() => Document|object|null} options.getDocument 取当前文档（测试注入）。
		 * @param {() => object|undefined} [options.getWorkspaces] 取 `uiWorkspace.workspaces.list`
		 *   快照，仅用于「会话行不在 DOM 时找所属分组行」。
		 * @param {() => boolean} [options.isCancelled] 插件已卸载时返回 true，让等待循环退出。
		 * @param {() => number} [options.now] 当前时间（测试注入）。
		 * @param {(callback: () => void) => void} [options.schedule] 下一帧调度（默认 rAF，缺省退回定时器）。
		 * @returns {(sessionId: string) => void} 揭示动作。
		 */
		function createRowRevealer({
		  pluginId,
		  getDocument,
		  getWorkspaces,
		  isCancelled = () => false,
		  now = () => Date.now(),
		  schedule,
		}) {
		  /** 每次跳转的序号：新跳转让旧的等待循环立刻退出。 */
		  let sequence = 0

		  /**
		   * 在下一帧再试一次（优先 rAF，没有时退回定时器）。
		   * @param {() => void} callback 回调。
		   * @returns {void}
		   */
		  const nextFrame = schedule ?? ((callback) => {
		    try {
		      if (typeof requestAnimationFrame === 'function') {
		        requestAnimationFrame(callback)
		        return
		      }
		    } catch {
		      /* 某些宿主没有 rAF：退回定时器 */
		    }
		    setTimeout(callback, 16)
		  })

		  return (sessionId) => {
		    if (typeof sessionId !== 'string' || sessionId === '') return
		    const doc = getDocument()
		    if (doc === null || doc === undefined) return
		    const mine = (sequence += 1)
		    const deadline = now() + REVEAL_RETRY_TIMEOUT_MS
		    let attempts = 0
		    const attempt = () => {
		      if (isCancelled() || mine !== sequence) return
		      let hit = null
		      try {
		        hit = scrollSessionRowIntoView(doc, sessionId, { workspaces: getWorkspaces?.() })
		      } catch (error) {
		        console.debug(`[${pluginId}] 滚动会话列表失败`, error)
		        return
		      }
		      if (hit !== null) return
		      attempts += 1
		      if (attempts >= REVEAL_MAX_ATTEMPTS) return
		      if (now() >= deadline) return
		      nextFrame(attempt)
		    }
		    attempt()
		  }
		}
		//#endregion

		//#region src/hub-json-store.js —— localStorage JSON 读写
		/**
		 * dsh-session-hub —— localStorage 的 JSON 读写层（零依赖，可单测）
		 *
		 * 只做一件事：把「读一个 JSON 键」和「写一个 JSON 键」的**全部失败路径**关在这里。
		 *
		 * 为什么值得单独一层：这些读写散落在配置、水位、确认表、待查看记账、去重窗口、诊断日志
		 * 六处，每处都要处理「没有 localStorage（纯 Node 测试）」「键不存在」「JSON 坏了」
		 * 「配额满 / 隐私模式」四件事，抄六遍必然漏。这里统一成「读失败回落默认值、写失败只记日志」。
		 *
		 * 依赖通过参数注入（`storage` / `warn`），因此可以在 Node 里用假存储直接测，不碰真全局。
		 *
		 * @module dsh-session-hub/hub-json-store
		 */

		/**
		 * 创建一个 JSON 存储读写器。
		 *
		 * @param {object} [options] 注入点。
		 * @param {string} [options.pluginId] 日志标签前缀。
		 * @param {{ getItem: (key: string) => string|null, setItem: (key: string, value: string) => void }|null} [options.storage]
		 *   存储后端；缺省用当前环境的 `localStorage`（纯 Node 下没有则所有读写静默降级）。
		 * @param {(message: string, error?: unknown) => void} [options.warn] 告警回调（默认 console.warn）。
		 * @returns {{
		 *   read: (key: string, fallback: unknown) => unknown,
		 *   write: (key: string, value: unknown) => void,
		 * }} 读写器。
		 */
		function createJsonStore(options = {}) {
		  const {
		    pluginId = 'dsh-session-hub',
		    storage = typeof localStorage === 'undefined' ? null : localStorage,
		    warn = (message, error) => console.warn(message, error),
		  } = options

		  /**
		   * 读一个 JSON 键；任何异常都回落到默认值。
		   * @param {string} key 存储键。
		   * @param {unknown} fallback 默认值。
		   * @returns {unknown} 解析结果或默认值（`null` / `undefined` 也按默认值处理）。
		   */
		  const read = (key, fallback) => {
		    try {
		      if (storage === null) return fallback
		      const raw = storage.getItem(key)
		      if (raw === null || raw === '') return fallback
		      const value = JSON.parse(raw)
		      return value === null || value === undefined ? fallback : value
		    } catch (error) {
		      warn(`[${pluginId}] 读取 ${key} 失败，使用默认值`, error)
		      return fallback
		    }
		  }

		  /**
		   * 写一个 JSON 键；配额 / 隐私模式导致的失败只记日志，绝不抛出。
		   * @param {string} key 存储键。
		   * @param {unknown} value 待写入值。
		   * @returns {void}
		   */
		  const write = (key, value) => {
		    try {
		      if (storage === null) return
		      storage.setItem(key, JSON.stringify(value))
		    } catch (error) {
		      warn(`[${pluginId}] 写入 ${key} 失败`, error)
		    }
		  }

		  return { read, write }
		}
		//#endregion

		//#region src/hub-stores.js —— 配置 / 水位 / 确认表 / 后台完成记账
		/**
		 * dsh-session-hub —— 客户端半的四份持久状态（配置 / 水位 / 报错确认 / 后台完成记账）
		 *
		 * 这一层把「插件在浏览器里记着什么」收拢到一处，其余模块只通过它读写：
		 *
		 * | 状态 | 形状 | 谁写 | 谁读 |
		 * |---|---|---|---|
		 * | 配置 | 见 notify-core 的 DEFAULT_CONFIG | `patchConfig` | 通知落地、状态栏、宿主路由 |
		 * | 通知水位 | `{ [id]: { seq, pendingKey, running, seeded } }` | tick（合并落盘） | `planNotifications` |
		 * | 报错确认 | `{ [id]: seq }` | `ackError` | `deriveHubRows`、行悬停提示 |
		 * | 后台完成 | `{ [id]: seq }` | `markLocalUnread` | `deriveHubRows`（绿点 / 绿灯） |
		 *
		 * 设计要点：
		 *
		 *   - **写盘与调度分离**。水位是高频变化的（每次推送都可能推进），所以不在这里落盘；
		 *     由调用方合并成一次 `watermarks.flush()`。其余三份都是「用户动作级」的低频写入，
		 *     直接落盘更简单。
		 *   - **变化与否要说清楚**。`ackError` / `markLocalUnread` / `clearLocalUnread` 都返回
		 *     布尔，调用方据此决定要不要重新观察一次（`scheduleTick`）——否则会陷入
		 *     「写→观察→再写」的空转。
		 *   - **归一化靠注入**。非法持久值（老版本、手工改过）必须被丢掉，但归一化函数住在
		 *     模型层（`normalizeConfig` / `normalizeSeqMap`），这里用参数接进来，避免这一层
		 *     反过来依赖模型层的实现细节。
		 *
		 * @module dsh-session-hub/hub-stores
		 */

		/**
		 * 一个极简快照仓库，供 React 的 `useSyncExternalStore` 订阅。
		 *
		 * 只在引用真的变化时才通知订阅者：`set` 收到同一个引用直接返回。
		 * @param {object} initial 初始值。
		 * @returns {{ getSnapshot: () => object, subscribe: (listener: () => void) => () => void, set: (next: object) => void }}
		 *   仓库接口。
		 */
		function createSnapshotStore(initial) {
		  let value = initial
		  const listeners = new Set()
		  return {
		    getSnapshot: () => value,
		    subscribe: (listener) => {
		      listeners.add(listener)
		      return () => { listeners.delete(listener) }
		    },
		    set: (next) => {
		      if (next === value) return
		      value = next
		      for (const listener of [...listeners]) {
		        try {
		          listener()
		        } catch (error) {
		          console.warn('[dsh-session-hub] 状态栏订阅者抛错', error)
		        }
		      }
		    },
		  }
		}

		/**
		 * 创建四份持久状态。
		 *
		 * @param {object} options 依赖注入。
		 * @param {{ read: (key: string, fallback: unknown) => unknown, write: (key: string, value: unknown) => void }} options.store
		 *   JSON 读写器（见 hub-json-store）。
		 * @param {{ config: string, watermarks: string, ack: string, unread: string }} options.keys 四个存储键。
		 * @param {{ config?: (raw: unknown) => object, seqMap?: (raw: unknown) => object }} [options.normalize]
		 *   归一化函数；缺省时按「不认识的值一律丢掉」处理。
		 * @returns {{
		 *   config: object,
		 *   patchConfig: (patch: object) => object,
		 *   watermarks: { get: () => object, set: (next: object) => void, flush: () => void },
		 *   acks: { getSnapshot: () => object, subscribe: (listener: () => void) => () => void, set: (next: object) => void },
		 *   localUnread: { getSnapshot: () => object, subscribe: (listener: () => void) => () => void, set: (next: object) => void },
		 *   ackError: (sessionId: string, seq: number) => boolean,
		 *   markLocalUnread: (sessionId: string, seq: number) => boolean,
		 *   clearLocalUnread: (sessionId?: string) => boolean,
		 * }} 状态仓库。
		 */
		function createHubStores({ store, keys, normalize = {} }) {
		  const normalizeConfig = typeof normalize.config === 'function' ? normalize.config : () => ({})
		  const normalizeSeqMap = typeof normalize.seqMap === 'function' ? normalize.seqMap : () => ({})

		  /** 生效中的配置：对象本身被就地更新（组件通过 getConfig 读快照）。 */
		  const config = normalizeConfig(store.read(keys.config, {}))

		  let watermarks = store.read(keys.watermarks, {})
		  if (watermarks === null || typeof watermarks !== 'object') watermarks = {}

		  /** 已确认的报错回合：`{ [sessionId]: seq }`。 */
		  const acks = createSnapshotStore(normalizeSeqMap(store.read(keys.ack, {})))

		  /** 「后台完成、尚未查看」的会话：`{ [sessionId]: seq }`。 */
		  const localUnread = createSnapshotStore(normalizeSeqMap(store.read(keys.unread, {})))

		  return {
		    config,

		    /**
		     * 合并写入配置（立即生效并落盘）。
		     * @param {object} patch 部分配置。
		     * @returns {object} 生效后的完整配置（与 {@link config} 同一个对象）。
		     */
		    patchConfig(patch) {
		      Object.assign(config, normalizeConfig({ ...config, ...patch }))
		      store.write(keys.config, config)
		      return config
		    },

		    watermarks: {
		      /** @returns {object} 通知水位表。 */
		      get: () => watermarks,
		      /** 替换水位表（由 tick 每次观察后调用，不落盘）。 */
		      set: (next) => { watermarks = next },
		      /** 把当前水位落盘（由调用方按合并窗口调用）。 */
		      flush: () => { store.write(keys.watermarks, watermarks) },
		    },

		    acks,
		    localUnread,

		    /**
		     * 确认某个会话的报错（点击状态栏条目 / 正在看该会话时自动确认）。
		     *
		     * 只前进不后退：seq 不大于已确认值时不写入、不通知订阅者。
		     * @param {string} sessionId 会话 id。
		     * @param {number|null} seq 报错回合的投影序号；null 不是合法确认值。
		     * @returns {boolean} 记账是否发生了变化。
		     */
		    ackError(sessionId, seq) {
		      if (typeof sessionId !== 'string' || sessionId === '') return false
		      if (!Number.isInteger(seq) || seq < 0) return false
		      const current = acks.getSnapshot()
		      if ((current[sessionId] ?? -1) >= seq) return false
		      const next = { ...current, [sessionId]: seq }
		      store.write(keys.ack, next)
		      acks.set(next)
		      return true
		    },

		    /**
		     * 补记一条「后台完成、尚未查看」。
		     *
		     * 只在窗口不在前台时由调用方使用：这正是官方 `completionUnread` 漏掉的那一类
		     * （主视图会话）。同一个会话的旧 seq 不会被更旧的边沿覆盖；重复调用是幂等的。
		     * @param {string} sessionId 会话 id。
		     * @param {number} seq 该回合结局的投影序号。
		     * @returns {boolean} 记账是否发生了变化。
		     */
		    markLocalUnread(sessionId, seq) {
		      if (typeof sessionId !== 'string' || sessionId === '') return false
		      if (!Number.isInteger(seq) || seq < 0) return false
		      const current = localUnread.getSnapshot()
		      if ((current[sessionId] ?? -1) >= seq) return false
		      const next = { ...current, [sessionId]: seq }
		      store.write(keys.unread, next)
		      localUnread.set(next)
		      return true
		    },

		    /**
		     * 清掉某个会话（或缺省全部）的「后台完成」记账。
		     *
		     * 触发时机：窗口回到前台且正在看该会话、用户点了该会话的通知 / chip（openSession）。
		     * @param {string} [sessionId] 会话 id；不传表示全部清掉。
		     * @returns {boolean} 记账是否发生了变化。
		     */
		    clearLocalUnread(sessionId) {
		      const current = localUnread.getSnapshot()
		      if (sessionId === undefined) {
		        if (Object.keys(current).length === 0) return false
		        store.write(keys.unread, {})
		        localUnread.set({})
		        return true
		      }
		      if (!Object.hasOwn(current, sessionId)) return false
		      const next = { ...current }
		      delete next[sessionId]
		      store.write(keys.unread, next)
		      localUnread.set(next)
		      return true
		    },
		  }
		}
		//#endregion

		//#region src/hub-notify.js —— 通知落地（短 tag / 跨标签页去重 / 落地日志）
		/**
		 * dsh-session-hub —— 通知落地层（跨标签页去重 / 短 tag / 落地诊断日志）
		 *
		 * 这一层只负责「把引擎算出来的通知真的交给系统，并留下可查的证据」。它不判断该不该弹
		 * （那是 `planNotifications` 的事），也不决定文案（`describeNotification` 的事）。
		 *
		 * 三件容易踩坑、因此集中在这里的事：
		 *
		 * 1. **tag 必须短**：Windows 的 toast 对 `tag` 长度有硬限制，超了会让整条通知在 Chromium
		 *    内部被静默丢弃（`show` / `failed` 都不派发，Windows 连 2416 都没有）。见
		 *    {@link shortToastTag} 的实测表。
		 * 2. **多标签页去重**：同一事件在多个页面里会各算一次，靠 `claimEvent` 落 localStorage
		 *    抢一个 4 秒窗口，只有一个页面真的弹。
		 * 3. **落地日志**：桌面端渲染进程的控制台平时没人看，而「通知没弹」是现场过去之后才被
		 *    发现的故障。把权限、构造结果、`show` / `failed` / `no-event` 留在 localStorage 里，
		 *    事后能判断是插件没发、Electron 没交给系统，还是系统没显示。
		 *
		 * @module dsh-session-hub/hub-notify
		 */

		/** 多标签页去重窗口：同一事件在此窗口内只允许一个页面真的弹通知。 */
		const CROSS_TAB_WINDOW_MS = 4000

		/** 通知结果诊断日志保留条数（环形，只留最近若干条）。 */
		const NOTIFY_LOG_LIMIT = 20

		/**
		 * 等待通知回执事件的上限（毫秒）。
		 *
		 * 超过这个时间 `show` / `failed` 都没来，记成 `no-event`。**它只表示「没等到回执」，
		 * 不表示「没显示」**：也可能显示了但回执没派发。因此 `no-event` 只能当「未知」看，
		 * 绝不能用它去判定失败或触发重发——那会在已经显示过的通知上再补一条重复的。
		 * 真正要确认「到没到系统」，查 Windows 的
		 * `Microsoft-Windows-PushNotification-Platform/Operational` 有没有 2416。
		 */
		const NOTIFY_SHOW_TIMEOUT_MS = 2500

		/**
		 * 把一条通知的身份压成可以安全交给 Windows 的短 `tag`。
		 *
		 * ## 为什么必须压短（2026-10-26 实测）
		 *
		 * Windows 的 toast 对 `tag` 长度有硬限制，超了之后**整条通知在 Chromium 里被悄悄
		 * 丢掉**：`new Notification()` 构造成功、`show` 和 `failed` 都不派发、Windows 的
		 * `PushNotification-Platform` 连 `2416`（本地通知提交）都没有——表现跟「插件压根没发」
		 * 一模一样，所以这个坑一直查不出来。同机（Windows 11 + Electron 44.7.0）对照实验：
		 *
		 * | tag | 结果 |
		 * |---|---|
		 * | 不带 tag | `show`，Windows 有 2416 |
		 * | `ab-x`（4 字符） | `show`，Windows 有 2416 |
		 * | `abcdefghij123456`（16 字符） | `show`，Windows 有 2416 |
		 * | `dsh-session-hub:session-82ed72ce-…#completed:1345`（63 字符） | 无 `show`、无 `failed`、Windows 无 2416 |
		 *
		 * 结论：**16 字符以内安全，几十个字符必丢**。因此不再把可读的
		 * `<插件>:<会话>#<事件>` 直接当 tag，而是取它的哈希，压成「`dsh` + 12 位十六进制」
		 * ＝ 15 个字符，严格低于那 16 字符的实验安全上限。
		 *
		 * ## 为什么是 48 位而不是 32 位
		 *
		 * tag 的唯一性只用来避开平台侧「同 tag 替换」分支；但 32 位哈希在几百条通知的量级上
		 * 已经有可观的碰撞概率，而碰撞的后果是「新通知顶掉旧通知」。两趟不同偏移基的 FNV-1a
		 * 拼成 48 位，碰撞概率降到可以忽略，长度也只多 4 个字符。
		 *
		 * 去重本身**不**依赖 tag：同一事件只弹一次由 `claimEvent` + 水位负责，tag 只影响
		 * 平台侧的替换 / 合并语义。所以哈希不可读不影响正确性；可读的身份原样记进诊断日志。
		 *
		 * @param {string} identity 完整身份串（`<插件>:<会话>#<事件键>`）。
		 * @returns {string} 15 个字符的 tag，只含 `[a-z0-9]`。
		 */
		function shortToastTag(identity) {
		  /** FNV-1a 32 位；换一个偏移基就是另一趟独立散列。 */
		  const fnv1a = (seed) => {
		    let hash = seed >>> 0
		    for (let index = 0; index < identity.length; index += 1) {
		      hash ^= identity.charCodeAt(index)
		      hash = Math.imul(hash, 0x01000193) >>> 0
		    }
		    return hash
		  }
		  const high = fnv1a(0x811c9dc5)
		  const low = fnv1a(0x9e3779b9)
		  return `dsh${high.toString(16).padStart(8, '0')}${(low & 0xffff).toString(16).padStart(4, '0')}`
		}

		/**
		 * 创建一个通知落地器。
		 *
		 * @param {object} options 依赖注入。
		 * @param {string} options.pluginId 插件 id（日志标签、tag 身份前缀）。
		 * @param {{ recent: string, notifyLog: string }} options.keys 去重窗口与诊断日志的存储键。
		 * @param {{ read: (key: string, fallback: unknown) => unknown, write: (key: string, value: unknown) => void }} options.store
		 *   JSON 读写器（见 hub-json-store）。
		 * @param {() => object} options.getConfig 读取当前配置（每次都读，改配置立即生效）。
		 * @param {() => boolean} options.isFocused 窗口此刻是否「用户就在看」（决定点击是否请求前置窗口）。
		 * @param {(sessionId: string, options?: { raise?: boolean }) => void} options.openSession 点击通知的跳转动作。
		 * @param {() => void} [options.onFirstShow] 首次成功弹出通知时的钩子（用来预热宿主半的 worker）。
		 * @param {() => number} [options.now] 当前时间（测试注入）。
		 * @returns {{
		 *   show: (notification: object) => void,
		 *   getLog: () => Array<object>,
		 *   clearLog: () => Array<object>,
		 * }} 落地器。
		 */
		function createNotifySink({
		  pluginId,
		  keys,
		  store,
		  getConfig,
		  isFocused,
		  openSession,
		  onFirstShow = () => {},
		  now = () => Date.now(),
		}) {
		  /** 预热只发一次：通知一弹出就去让宿主半把 PowerShell 编译好。 */
		  let warmedUp = false

		  /**
		   * 跨标签页去重：同一事件在多个页面里只会有一个页面真的弹通知。
		   *
		   * 判定依据是引擎给出的 `dedupeKey`（同一会话 + 同一事件）。窗口外的键会被清理，
		   * 因此这张表不会无限增长；多页面同时写入的竞态最多导致一次重复通知。
		   * @param {string} dedupeKey 事件键。
		   * @returns {boolean} true 表示本次由自己弹。
		   */
		  const claimEvent = (dedupeKey) => {
		    const at = now()
		    const recent = store.read(keys.recent, {})
		    const kept = {}
		    if (recent !== null && typeof recent === 'object') {
		      for (const [key, time] of Object.entries(recent)) {
		        if (typeof time === 'number' && at - time < CROSS_TAB_WINDOW_MS) kept[key] = time
		      }
		    }
		    const claimed = kept[dedupeKey] === undefined
		    if (claimed) kept[dedupeKey] = at
		    store.write(keys.recent, kept)
		    return claimed
		  }

		  /**
		   * 记录一条通知结果诊断（环形日志，落 localStorage）。
		   *
		   * 为什么要落盘而不是只 `console.warn`：桌面端的渲染进程控制台平时没人看，
		   * 而「通知没弹」恰恰是**现场已经过去**才被发现的故障；把最近若干条的
		   * 权限状态 / 构造结果 / `show` / `failed` 留在 `notify-log-v1` 里，
		   * 事后读 localStorage 就能判断是插件没发、浏览器没交给系统，还是系统没显示。
		   * 记录本身失败绝不影响通知流程。
		   * @param {object} entry 一条诊断（stage 为阶段，其余字段随阶段变化）。
		   * @returns {void}
		   */
		  const record = (entry) => {
		    try {
		      const log = store.read(keys.notifyLog, [])
		      const list = Array.isArray(log) ? log : []
		      list.push({ at: new Date().toISOString(), ...entry })
		      while (list.length > NOTIFY_LOG_LIMIT) list.shift()
		      store.write(keys.notifyLog, list)
		    } catch (error) {
		      console.warn(`[${pluginId}] 写入通知诊断日志失败`, error)
		    }
		  }

		  /**
		   * 弹一条系统通知。
		   * @param {object} notification 引擎产出的通知描述。
		   * @returns {void}
		   */
		  const show = (notification) => {
		    const config = getConfig()
		    /** 可读的事件身份：`<插件>:<会话>#<事件键>`。只进诊断日志，不直接当 tag。 */
		    const tagKey = `${pluginId}:${notification.sessionId}#${notification.dedupeKey}`
		    /**
		     * 真正交给系统显示的标题：默认带彩色圆点（🟢 完成 / 🟡 等你回应 / 🔴 失败）。
		     *
		     * Windows 的 toast **没有可定制的图标**——图标固定是应用图标，HTML5
		     * `Notification` 的 `icon` / `badge` 在 Windows 上都不落地，所以颜色只能进文本。
		     * 圆点配色与状态栏 chip、任务栏状态点同源。
		     */
		    const marker = config.colorMarkers === false ? '' : String(notification.marker ?? '')
		    const shownTitle = marker === '' ? notification.title : `${marker} ${notification.title}`
		    /** 诊断日志的公共字段。 */
		    const base = {
		      sessionId: notification.sessionId,
		      category: notification.category,
		      title: shownTitle,
		      key: tagKey,
		      permission: typeof Notification === 'undefined' ? 'unsupported' : String(Notification.permission),
		    }
		    if (typeof Notification === 'undefined') {
		      record({ ...base, stage: 'unsupported' })
		      return
		    }
		    if (Notification.permission !== 'granted') {
		      record({ ...base, stage: 'permission' })
		      console.warn(`[${pluginId}] 通知权限为 ${String(Notification.permission)}，跳过：${shownTitle}`)
		      return
		    }
		    if (!claimEvent(notification.dedupeKey)) {
		      // 别的标签页已经抢先弹了同一条事件；不是故障，但记下来免得被误当成「没通知」。
		      record({ ...base, stage: 'deduped' })
		      return
		    }

		    // 通知已经弹出，用户很可能一两秒内点它：提前把宿主半的窗口前置器烧热。
		    if (!warmedUp) {
		      warmedUp = true
		      onFirstShow()
		    }

		    // 每条事件一个**唯一**、且足够短的 tag，避开平台侧「同 tag 替换」分支。
		    //
		    // 可读身份在 `tagKey` 里（诊断日志要用），但**不能直接当 tag 用**：2026-10-26 实测
		    // 63 个字符的 tag 会让整条通知在 Chromium 内部被静默丢弃，Windows 侧连提交记录
		    // 都没有（详见 {@link shortToastTag} 的对照表）。这里把它压成 15 个字符的哈希。
		    const tag = shortToastTag(tagKey)
		    let toast
		    try {
		      toast = new Notification(shownTitle, {
		        body: notification.body,
		        tag,
		        // 刻意不传 renotify：它只在「同 tag 替换」时才有意义，而现在根本没有替换。
		        // 同一个现场里 renotify=true 与通知丢失同时出现，少一个变量少一次踩坑。
		        // silent=true 表示不出声。
		        silent: config.sound !== true,
		        // 需要你回应的通知常驻，直到用户处理（Windows 上也会留在操作中心）。
		        requireInteraction: notification.category === 'answer',
		      })
		    } catch (error) {
		      record({ ...base, tag, stage: 'construct-failed', detail: String(error) })
		      console.warn(`[${pluginId}] 创建通知失败`, error)
		      return
		    }

		    // 结果诊断：`shown` 表示浏览器确认已显示；`failed` 表示浏览器/系统明确拒绝；
		    // `no-event` 表示 2.5 秒内什么事件都没来——**只是「未确认」**。要确认「到底到没到
		    // 系统」，最终还得看 Windows 的
		    // `Microsoft-Windows-PushNotification-Platform/Operational` 有没有 2416/3052。
		    //
		    // 事件名必须两套都挂：Electron 的通知对象派发 `show` / `failed`，HTML5
		    // `Notification` 派发的是 `show` / `error`。2026-10-26 之前这里只挂了 `onerror`
		    // （HTML5 的名字），在 Electron 里**永远不会触发**，于是任何真实失败都被记成
		    // `no-event`——诊断在这里断掉，正是「收不到通知」查不出来的直接原因。
		    let settled = false
		    const settle = (stage, detail) => {
		      if (settled) return
		      settled = true
		      record({ ...base, tag, stage, detail })
		    }
		    const onShown = () => settle('shown')
		    const onFailed = (event) => {
		      settle('failed', event?.error?.message ?? event?.message ?? 'unknown')
		      console.warn(`[${pluginId}] 通知显示失败：${shownTitle}`)
		    }
		    /**
		     * 订阅一个事件。
		     *
		     * 同时兼容 EventTarget 与只暴露属性回调的实现；不支持订阅时静默跳过，
		     * 仍然有下面的 2.5 秒兜底，所以绝不让订阅本身把通知拖垮。
		     * @param {string} type 事件名。
		     * @param {(event?: object) => void} handler 处理函数。
		     */
		    const subscribe = (type, handler) => {
		      try {
		        if (typeof toast.addEventListener === 'function') toast.addEventListener(type, handler)
		      } catch {
		        /* 订阅失败不影响兜底超时 */
		      }
		    }
		    try {
		      // 属性回调与事件订阅同时挂：`settle` 只认第一次，重复派发没有副作用。
		      toast.onshow = onShown
		      toast.onerror = onFailed
		      subscribe('show', onShown)
		      subscribe('failed', onFailed)
		      subscribe('error', onFailed)
		      if (typeof setTimeout === 'function') {
		        setTimeout(() => settle('no-event'), NOTIFY_SHOW_TIMEOUT_MS)
		      }
		    } catch (error) {
		      record({ ...base, tag, stage: 'hook-failed', detail: String(error) })
		    }

		    /** 点击处理只认第一次：属性回调与事件订阅可能同时命中。 */
		    let clicked = false
		    const onClick = () => {
		      if (clicked) return
		      clicked = true
		      try {
		        toast.close()
		      } catch {
		        /* 关闭失败无所谓，下面照常跳转 */
		      }
		      // 窗口已经在前台时不需要再前置（也就不会触碰窗口状态）；后台/最小化时才请求。
		      openSession(notification.sessionId, { raise: !isFocused() })
		    }
		    toast.onclick = onClick
		    subscribe('click', onClick)
		    toast.onclose = () => {}
		  }

		  return {
		    show,
		    /**
		     * 最近若干条通知的落地结果（排障用）。
		     *
		     * `stage` 取值：`shown`（浏览器确认已显示）/ `failed`（浏览器或系统明确拒绝，
		     * Electron 派发 `failed`、HTML5 叫 `error`，两个事件名都挂）/ `no-event`（2.5 秒内
		     * 什么回执都没来，**只是未确认，可能已显示**）/ `permission`（权限不是 granted，
		     * 根本没发）/ `deduped`（别的标签页已弹）/ `construct-failed`（构造函数抛错）/
		     * `hook-failed`（挂回调时抛错）/ `unsupported`（环境没有 Notification）。
		     *
		     * 每条带 `key`（可读身份 `<插件>:<会话>#<事件键>`）与 `tag`（真正交给系统的短哈希）——
		     * **tag 超长会导致通知被 Chromium 静默丢弃**，所以两者分开记。
		     * @returns {Array<object>} 诊断日志（时间正序，最多 {@link NOTIFY_LOG_LIMIT} 条）。
		     */
		    getLog: () => {
		      const log = store.read(keys.notifyLog, [])
		      return Array.isArray(log) ? log : []
		    },
		    /**
		     * 清空通知诊断日志（排障用）。
		     * @returns {Array<object>} 空数组。
		     */
		    clearLog: () => {
		      store.write(keys.notifyLog, [])
		      return []
		    },
		  }
		}
		//#endregion

		//#region src/hub-host.js —— 宿主半路由（前置窗口 / 任务栏状态 / 在线探活）
		/**
		 * dsh-session-hub —— 客户端半通往宿主半的三条路（窗口前置 / 任务栏状态 / 在线探活）
		 *
		 * 渲染进程做不到「把窗口提到前台」和「在任务栏图标上画点」，这两件事只能请求宿主半
		 * （见 lib/raise-window.js 的说明）。这一层把三条请求收敛到一处，并统一成两种姿态：
		 *
		 *   - **永远是「发了不管」**：路由不存在、宿主半没加载、请求失败都只记日志，绝不抛错，
		 *     也绝不影响界面本身——跳转是应用内的事，前置窗口只是锦上添花。
		 *   - **状态只在本层维护**：任务栏状态的去重（`lastTaskbarState`）与宿主半在线状态机
		 *     （`unknown` / `checking` / `present` / `absent`）都是本层的私有状态，调用方只读。
		 *
		 * ## 为什么探活结论不能靠「有没有投影值」
		 *
		 * 新装的插件在任何会话产生回合结局之前本来就没有投影值，把「没有值」当成「宿主半没加载」
		 * 会误报；反过来，宿主半与客户端半**版本错位**是真实存在的运行状态（宿主半随 DSH 启动
		 * 加载，客户端半每次刷新页面都重新取）。因此这里只认 `/ping` 的应答：`host` 字段对得上
		 * 就是在；返回路由家族的 404 JSON 说明「路由在、宿主半是旧构建」，同样算在线。
		 *
		 * @module dsh-session-hub/hub-host
		 */

		/** 探活失败后的重试间隔：不管上次结论如何，5 分钟内只问一次。 */
		const HOST_HALF_RECHECK_MS = 5 * 60 * 1000

		/**
		 * 创建宿主半桥接器。
		 *
		 * @param {object} options 依赖注入。
		 * @param {string} options.pluginId 插件 id（即路由前缀与日志标签）。
		 * @param {string} options.version 客户端半版本（用于版本错位提示）。
		 * @param {() => object} options.getConfig 读取当前配置（`raiseWindow` 控制是否请求窗口前置）。
		 * @param {() => boolean} options.isDesktopShell 当前页面是否是桌面端外壳（只有它有任务栏按钮）。
		 * @param {() => boolean} options.isDisposed 插件是否已卸载。
		 * @param {typeof fetch} [options.fetchImpl] 请求实现（测试注入）。
		 * @param {() => number} [options.now] 当前时间（测试注入）。
		 * @returns {{
		 *   callHostRoute: (action: 'raise'|'warmup') => void,
		 *   pushTaskbar: (state: 'red'|'yellow'|'green'|'none', force?: boolean) => void,
		 *   checkHostHalf: (force?: boolean) => void,
		 *   hostHalfState: () => 'unknown'|'checking'|'present'|'absent',
		 *   resetHostHalfCheck: () => void,
		 * }} 桥接器。
		 */
		function createHostBridge({
		  pluginId,
		  version,
		  getConfig,
		  isDesktopShell,
		  isDisposed,
		  fetchImpl = typeof fetch === 'function' ? fetch : undefined,
		  now = () => Date.now(),
		}) {
		  /** 最近一次发给宿主半的任务栏状态，避免重复请求。 */
		  let lastTaskbarState = null
		  /** 宿主半在线状态：unknown（还没问过）/ checking / present / absent。 */
		  let hostHalfState = 'unknown'
		  let hostHalfCheckedAt = 0

		  /**
		   * 拼出请求头：内部路由要求带签名头（见 hub-identity 的 {@link ROUTE_HEADER}）。
		   * @param {Record<string, string>} [extra] 额外头（会覆盖同名项）。
		   * @returns {Record<string, string>} 合并后的头。
		   */
		  const signedHeaders = (extra) => ({ [ROUTE_HEADER]: ROUTE_HEADER_VALUE, ...extra })

		  /**
		   * 发一个「不需要看响应」的 POST（文档相对路径：桌面端由 shell 同源转发，Web 端落在
		   * 部署前缀下）。
		   * @param {string} path 相对路径，例如 `dsh-session-hub/raise`。
		   * @param {RequestInit} [init] 额外请求参数。
		   * @returns {void}
		   */
		  const post = (path, init) => {
		    try {
		      if (typeof fetchImpl !== 'function') return
		      Promise.resolve(fetchImpl(path, {
		        method: 'POST',
		        keepalive: true,
		        ...init,
		        headers: signedHeaders(init?.headers),
		      })).catch(() => {})
		    } catch (error) {
		      console.debug(`[${pluginId}] 请求宿主半 ${path} 失败`, error)
		    }
		  }

		  return {
		    /**
		     * 请求宿主半执行一个动作。
		     *
		     * `warmup` 永远可发（它只是提前把 C# 编译时间付掉）；`raise` 受 `raiseWindow` 关掉。
		     * @param {'raise'|'warmup'} action 动作名。
		     * @returns {void}
		     */
		    callHostRoute(action) {
		      if (action === 'raise' && getConfig().raiseWindow !== true) return
		      post(`${pluginId}/${action}`)
		    },

		    /**
		     * 把聚合状态发给宿主半，由它标记任务栏图标。
		     *
		     * 只在桌面外壳里发：普通浏览器页面没有任务栏按钮，多个标签页也不会互相抢状态。
		     * @param {'red'|'yellow'|'green'|'none'} state 任务栏状态。
		     * @param {boolean} [force] 忽略去重（卸载 / 测试）。
		     * @returns {void}
		     */
		    pushTaskbar(state, force = false) {
		      if (!isDesktopShell()) return
		      if (isDisposed() && force !== true) return
		      if (!force && state === lastTaskbarState) return
		      lastTaskbarState = state
		      post(`${pluginId}/taskbar`, {
		        headers: { 'content-type': 'application/json' },
		        body: JSON.stringify({ state }),
		      })
		    },

		    /**
		     * 问一次宿主半「你在不在」。
		     *
		     * 只有拿到 `host === pluginId` 才算在线——**不能用「有没有投影值」来判断**：
		     * 新装的插件在任何会话产生回合结局之前本来就没有值，那会误报成「宿主半没加载」。
		     *
		     * 还要容忍版本错位：宿主半是插件包的一部分，但它只在 DSH 启动/重载插件时加载，
		     * 而客户端半每次刷新页面都会重新取。当前者比后者旧时，`/ping` 会返回路由家族的
		     * 404（`{"error":"unknown-action"}`）——这同样证明「路由在、宿主半在」，不能报错。
		     * 判定为不在时每 {@link HOST_HALF_RECHECK_MS} 重试一次。
		     * @param {boolean} [force] 忽略退避（诊断入口用）。
		     * @returns {void}
		     */
		    checkHostHalf(force = false) {
		      if (isDisposed() || typeof fetchImpl !== 'function') return
		      const at = now()
		      if (!force) {
		        if (hostHalfState === 'checking' || hostHalfState === 'present') return
		        // 已经问过就不再刷屏：不管上次结论如何，5 分钟内只问一次。
		        if (hostHalfCheckedAt !== 0 && at - hostHalfCheckedAt < HOST_HALF_RECHECK_MS) return
		      }
		      hostHalfState = 'checking'
		      hostHalfCheckedAt = at
		      // 请求本身可能同步抛错（例如注入的 fetch 在离线环境下直接炸），
		      // 那种情况既不是「在线」也不是「确认不在」——按「无法确认」处理，措辞与网络失败一致。
		      let pending
		      try {
		        pending = Promise.resolve(fetchImpl(`${pluginId}/ping`, {
		          method: 'POST',
		          keepalive: true,
		          headers: signedHeaders(),
		        }))
		      } catch (error) {
		        hostHalfState = 'unknown'
		        console.warn(`[${pluginId}] 宿主半探活请求失败，无法确认其状态：${String(error)}`)
		        return
		      }
		      pending
		        .then(async (response) => {
		          let body = null
		          try {
		            body = await response?.json?.()
		          } catch {
		            body = null
		          }
		          if (isDisposed()) return
		          if (body?.host === pluginId) {
		            hostHalfState = 'present'
		            const hostVersion = typeof body.version === 'string' ? body.version : '未知'
		            const skew = hostVersion !== version
		              ? `（版本不一致：宿主半 v${hostVersion} / 客户端半 v${version}，重启 DSH 可对齐）`
		              : ''
		            console.info(
		              `[${pluginId}] 客户端半 v${version} ↔ 宿主半 v${hostVersion} 在线`
		              + `（投影键 ${body.projectionKey}）${skew}。`,
		            )
		            return
		          }
		          if (body !== null && typeof body === 'object' && body.error === 'forbidden') {
		            // 宿主半在，只是拒了这次请求（缺签名头）。旧客户端半会遇到这种情况。
		            hostHalfState = 'present'
		            console.warn(
		              `[${pluginId}] 宿主半拒绝了本次请求（缺签名头）：客户端半像是旧构建；`
		              + '刷新页面即可对齐，功能不受影响',
		            )
		            return
		          }
		          if (body !== null && typeof body === 'object' && 'error' in body) {
		            // 路由家族在应答，只是不认识 ping：宿主半是旧构建。投影与点击跳转都不受影响。
		            hostHalfState = 'present'
		            console.info(
		              `[${pluginId}] 客户端半 v${version}：宿主半在线但为旧构建（无 ping 动作）；`
		              + '功能不受影响，重启 DSH 可对齐版本',
		            )
		            return
		          }
		          hostHalfState = 'absent'
		          console.warn(
		            `[${pluginId}] 宿主半的路由不存在，本插件可能只挂上了客户端半：`
		            + '失败/完成将退化为「一轮结束即完成」',
		          )
		        })
		        .catch((error) => {
		          if (isDisposed()) return
		          // 网络层失败：说明无法确认，而不是确认不在。措辞必须如实。
		          hostHalfState = 'unknown'
		          console.warn(`[${pluginId}] 宿主半探活请求失败，无法确认其状态：${String(error)}`)
		        })
		    },

		    /** @returns {'unknown'|'checking'|'present'|'absent'} 宿主半在线状态。 */
		    hostHalfState: () => hostHalfState,

		    /** 清掉探活退避（诊断入口的「主动问一次」用）。 */
		    resetHostHalfCheck() {
		      hostHalfCheckedAt = 0
		    },
		  }
		}
		//#endregion

		//#region src/hub-ui.js —— React 状态栏与行悬停提示组件
		/**
		 * dsh-session-hub —— 工作区顶部会话状态栏（React 组件工厂，纯浏览器代码）
		 *
		 * 这个文件是 bundle 里的裸脚本片段：`createSessionHubRail(React, deps)` 返回一个
		 * 函数组件，由 client-main 注册进 `conversation.header.leading` 官方插槽。
		 *
		 * ## 为什么放在 header.leading
		 *
		 * `conversation.header.leading` 是官方声明的单占位插槽（`replaceRisk: none`），
		 * 位于会话标题之前、工作区内容之上，并且在「没有选中会话」时也会渲染。它天然就是
		 * 「工作区上方」的位置，又不需要替换任何 shipped UI。
		 *
		 * ## 数据来源
		 *
		 * 组件只读插槽的标准 props：`useSessions`、`useSessionStatus` 与绑定后的 `t`。
		 * 前两者都是订阅式快照钩子，会话状态一变就重渲染；组件自己不订阅事件、不扫描 DOM。
		 *
		 * 视觉全部使用 `--dsw-alias-*` 主题令牌；颜色只用于状态点，语义与原生侧栏一致。
		 * 可见文案一律来自 {@link HUB_STRINGS}（hub-strings.js）——组件里不再存第二份副本，
		 * locale 服务不可用时直接用其中的 `zh` 回落。
		 *
		 * @module dsh-session-hub/hub-ui
		 */

		/**
		 * 极简文案函数工厂：只在 locale 服务缺失时使用。
		 *
		 * @param {object} dict 键 → 文案。
		 * @returns {(key: string, params?: object) => string} 文案函数。
		 */
		function createFallbackT(dict) {
		  return (key, params) => {
		    const text = dict[key] ?? key
		    return params === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match))
		  }
		}

		/**
		 * 创建状态栏组件。
		 * @param {object} React React 运行时（由客户端模块表提供）。
		 * @param {{
		 *   openSession: (sessionId: string, options?: { raise?: boolean }) => void,
		 *   ackError: (sessionId: string, seq: number|null) => void,
		 *   acks: { subscribe: (listener: () => void) => () => void, getSnapshot: () => object },
		 *   unread?: { subscribe: (listener: () => void) => () => void, getSnapshot: () => object },
		 * }} deps 由 client-main 注入的动作、确认表与「后台完成」记账（`unread` 可选）。
		 * @param {'header'|'chrome'} [variant] 渲染位置：会话标题前，或 Windows 顶栏菜单之后。
		 * @returns {Function} React 函数组件。
		 */
		function createSessionHubRail(React, deps, variant = 'header') {
		  const h = React.createElement
		  const EMPTY_LIST = { byId: {}, projectionsBySession: {} }
		  const EMPTY_STATUSES = new Map()
		  const EMPTY_UNREAD = {}
		  /** 「后台完成」记账的缺省仓库：没有注入时组件照常渲染，只是没有补记的绿点。 */
		  const EMPTY_STORE = { subscribe: () => () => {}, getSnapshot: () => EMPTY_UNREAD }

		  /** 文案回落：插槽没有绑定 locale 时也能显示中文。 */
		  const fallbackT = createFallbackT(HUB_STRINGS.zh)

		  /** 没有插槽钩子时的安全回落（只会在测试或异常组合里用到）。 */
		  const useEmptySessions = () => EMPTY_LIST
		  const useEmptyStatuses = () => EMPTY_STATUSES

		  /**
		   * 订阅一个快照仓库；React 18+ 用 useSyncExternalStore，旧版本退化为强制刷新。
		   * @param {object} store 快照仓库。
		   * @returns {object} 当前快照。
		   */
		  function useSnapshot(store) {
		    if (typeof React.useSyncExternalStore === 'function') {
		      return React.useSyncExternalStore(store.subscribe, store.getSnapshot)
		    }
		    const [, force] = React.useState(0)
		    React.useEffect(() => store.subscribe(() => force((n) => n + 1)), [store])
		    return store.getSnapshot()
		  }

		  const CSS = [
		    '.dsh-hub{display:flex;align-items:center;gap:6px;min-width:0;max-width:min(46vw,700px);overflow-x:auto;overflow-y:hidden;padding:2px 4px 2px 0;scrollbar-width:none;font:inherit}',
		    '.dsh-hub::-webkit-scrollbar{display:none}',
		    '.dsh-hub__label{flex:none;font-size:11px;line-height:1;color:var(--dsw-alias-label-secondary);letter-spacing:.04em;margin-right:2px;user-select:none;white-space:nowrap}',
		    '.dsh-hub__idle{flex:none;display:inline-flex;align-items:center;height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;white-space:nowrap}',
		    '.dsh-hub__chip{flex:none;display:inline-flex;align-items:center;gap:6px;max-width:190px;height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:background .12s ease,border-color .12s ease}',
		    '.dsh-hub__chip:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}',
		    '.dsh-hub__chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
		    '.dsh-hub__dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
		    '.dsh-hub__chip--answer .dsh-hub__dot{background:var(--dsw-alias-state-warn-primary)}',
		    '.dsh-hub__chip--error .dsh-hub__dot{background:var(--dsw-alias-state-error-primary)}',
		    '.dsh-hub__chip--running .dsh-hub__dot{background:var(--dsw-static-blue-400,#60a5fa);animation:dsh-hub-pulse 1.4s ease-in-out infinite}',
		    '.dsh-hub__chip--unread .dsh-hub__dot{background:var(--dsw-alias-state-success-primary)}',
		    '.dsh-hub__title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		    '.dsh-hub__state{flex:none;font-size:10px;line-height:1;color:var(--dsw-alias-label-secondary)}',
		    '.dsh-hub__more{flex:none;display:inline-flex;align-items:center;height:26px;padding:0 9px;border:1px dashed var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1;cursor:pointer;white-space:nowrap}',
		    '.dsh-hub__more:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
		    '.dsh-hub__more:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
		    // Windows 顶栏变体：fixed 在「应用 / 编辑」菜单之后，高度跟随原生顶栏（40px）。
		    // --dsh-windows-menu-start 由侧栏发布（展开 48px / 收起 84px）；菜单本体约 100px。
		    '.dsh-hub--chrome{position:fixed;top:0;left:calc(var(--dsh-windows-menu-start,48px) + 108px);height:var(--dsh-windows-titlebar-height,40px);max-width:calc(100vw - 460px);padding:0 8px 0 0;gap:4px;z-index:1090;pointer-events:auto;-webkit-app-region:no-drag}',
		    '.dsh-hub--chrome .dsh-hub__chip,.dsh-hub--chrome .dsh-hub__idle,.dsh-hub--chrome .dsh-hub__more{height:24px;padding:0 8px;font-size:11px;background:var(--dsw-specific-sidebar-fill)}',
		    '.dsh-hub--chrome .dsh-hub__chip{max-width:180px}',
		    '.dsh-hub--chrome .dsh-hub__label{font-size:11px}',
		    '.dsh-hub--chrome .dsh-hub__state{font-size:9px}',
		    'html:not([data-windows-titlebar]) .dsh-hub--chrome{display:none}',
		    'html[data-windows-titlebar] .dsh-hub--header{display:none}',
		    '@keyframes dsh-hub-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
		    '@media (prefers-reduced-motion:reduce){.dsh-hub__chip--running .dsh-hub__dot{animation:none}}',
		  ].join('')

		  return function SessionHubRail(props) {
		    const t = typeof props?.t === 'function' ? props.t : fallbackT
		    const useSessions = typeof props?.useSessions === 'function' ? props.useSessions : useEmptySessions
		    const useSessionStatus = typeof props?.useSessionStatus === 'function' ? props.useSessionStatus : useEmptyStatuses
		    const list = useSessions((value) => value)
		    const statuses = useSessionStatus((value) => value)
		    const ackErrors = useSnapshot(deps.acks)
		    // 官方的 completionUnread 对主视图会话永不置位；「窗口在后台时跑完」的绿点来自
		    // 本插件的补记（client-main 的 localUnread），这里必须一起喂给模型。
		    const localUnread = useSnapshot(deps.unread ?? EMPTY_STORE)
		    const rows = deriveHubRows({ list, statuses, ackErrors, localUnread, now: Date.now() })
		    const [expanded, setExpanded] = React.useState(false)
		    const visibleRows = expanded ? rows : rows.slice(0, 3)
		    const hiddenCount = rows.length - visibleRows.length

		    const children = [h('style', { key: 'style' }, CSS)]
		    children.push(h('span', { key: 'label', className: 'dsh-hub__label' }, t('label')))
		    if (rows.length === 0) {
		      children.push(h('span', { key: 'idle', className: 'dsh-hub__idle' }, t('idle')))
		    } else {
		      for (const row of visibleRows) {
		        const stateLabel = t(`state.${row.state}`)
		        children.push(h('button', {
		          key: row.id,
		          type: 'button',
		          className: `dsh-hub__chip dsh-hub__chip--${row.state}`,
		          title: `${stateLabel}：${row.title}`,
		          'aria-label': `${stateLabel}：${row.title}`,
		          onClick: () => {
		            try {
		              deps.ackError(row.id, row.errorSeq)
		            } catch (error) {
		              console.warn('[dsh-session-hub] 确认报错失败', error)
		            }
		            // 点击 chip 时窗口本来就在前台：只做应用内跳转，不请求窗口前置，
		            // 避免触发 Win32 的窗口状态处理（最大化被 SW_RESTORE 打回普通尺寸）。
		            deps.openSession(row.id, { raise: false })
		          },
		        },
		        h('span', { className: 'dsh-hub__dot', 'aria-hidden': 'true' }),
		        h('span', { className: 'dsh-hub__title' }, row.title),
		        h('span', { className: 'dsh-hub__state' }, stateLabel)))
		      }
		      if (hiddenCount > 0) {
		        children.push(h('button', {
		          key: 'more',
		          type: 'button',
		          className: 'dsh-hub__more',
		          title: t('more', { count: hiddenCount }),
		          'aria-label': t('more', { count: hiddenCount }),
		          onClick: () => setExpanded(true),
		        }, `+${hiddenCount}`))
		      } else if (expanded && rows.length > 3) {
		        children.push(h('button', {
		          key: 'collapse',
		          type: 'button',
		          className: 'dsh-hub__more',
		          onClick: () => setExpanded(false),
		        }, t('collapse')))
		      }
		    }

		    return h('div', {
		      className: `dsh-hub dsh-hub--${variant}`,
		      'data-dsh-session-hub': variant,
		      role: 'group',
		      'aria-label': rows.length === 0 ? t('idle') : t('aria', { count: rows.length }),
		    }, children)
		  }
		}

		/**
		 * 创建「会话行悬停卡片里的失败提示」组件。
		 *
		 * ## 为什么需要它
		 *
		 * 侧栏会话行首那个圆点由官方 ui-workspace / ui-session 决定，只有四种：
		 * 等待交互（黄）、运行中（蓝）、未读完成（绿）、空闲（不画）。它**没有「失败」态**，
		 * 而 ui-session 在「running → 停止」时一律把会话记成 `completionUnread`，于是
		 * **一轮因报错/中断结束的会话，行首也会显示成绿色的「已完成」**。
		 *
		 * 插件不能改写官方行状态机（`sidebar.session.row.leading` 只在空闲时才轮到插件渲染），
		 * 所以这里用我们能控制的最近一个位置把真相补上：`sidebar.session.row.hover` 是行悬停
		 * 卡片的内容位（list 插槽），在这里加一行红色提示，鼠标停在行上就能看到
		 * 「本轮失败 / 本轮中断」，不会与官方绿点打架，也不去碰别人的 DOM。
		 *
		 * ## 数据来源
		 *
		 * 只读插槽标准 props：`useSessions`（会话列表快照）与 `t`；再加本插件自己的
		 * 「已确认报错」表（`deps.acks`）。判据与状态栏完全一致（`failureKindOf`）。
		 *
		 * @param {object} React React 运行时。
		 * @param {{ acks: { subscribe: (listener: () => void) => () => void, getSnapshot: () => object } }} deps
		 *   本插件的确认表。
		 * @returns {Function} React 函数组件。
		 */
		function createSessionHubRowHint(React, deps) {
		  const h = React.createElement
		  const EMPTY_LIST = { byId: {}, projectionsBySession: {} }
		  const useEmptySessions = () => EMPTY_LIST
		  const fallbackT = createFallbackT(HUB_STRINGS.zh)

		  /**
		   * 订阅「已确认报错」表。
		   * @param {object} store 快照仓库。
		   * @returns {object} 当前确认表。
		   */
		  function useAcks(store) {
		    if (typeof React.useSyncExternalStore === 'function') {
		      return React.useSyncExternalStore(store.subscribe, store.getSnapshot)
		    }
		    const [, force] = React.useState(0)
		    React.useEffect(() => store.subscribe(() => force((n) => n + 1)), [store])
		    return store.getSnapshot()
		  }

		  const CSS = [
		    '.dsh-hub-hint{display:flex;align-items:center;gap:6px;min-width:0;font:inherit;font-size:12px;line-height:1.3;color:var(--dsw-alias-label-primary)}',
		    '.dsh-hub-hint__dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-error-primary)}',
		    '.dsh-hub-hint__text{flex:none}',
		    '.dsh-hub-hint__detail{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary)}',
		  ].join('')

		  return function SessionHubRowHint(props) {
		    const t = typeof props?.t === 'function' ? props.t : fallbackT
		    const useSessions = typeof props?.useSessions === 'function' ? props.useSessions : useEmptySessions
		    const list = useSessions((value) => value)
		    const ackErrors = useAcks(deps.acks)
		    const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined
		    if (sessionId === undefined) return null

		    const projection = projectionOf(list, sessionId)
		    const acked = Number.isInteger(ackErrors[sessionId]) ? ackErrors[sessionId] : -1
		    const kind = failureKindOf(projection, acked)
		    if (kind === null) return null

		    const label = t(kind === 'interrupted' ? 'row.interrupted' : 'row.failed')
		    const detail = typeof projection?.code === 'string' && projection.code !== '' ? projection.code : ''

		    return h('div', {
		      className: 'dsh-hub-hint',
		      'data-dsh-session-hub-hint': kind,
		      title: t('row.hint'),
		      role: 'status',
		    }, [
		      h('style', { key: 'style' }, CSS),
		      h('span', { key: 'dot', className: 'dsh-hub-hint__dot', 'aria-hidden': 'true' }),
		      h('span', { key: 'text', className: 'dsh-hub-hint__text' }, label),
		      detail === '' ? null : h('span', { key: 'detail', className: 'dsh-hub-hint__detail' }, detail),
		    ])
		  }
		}
		//#endregion

		//#region src/hub-slots.js —— 插槽注册
		/**
		 * dsh-session-hub —— 客户端半的插槽注册（状态栏 / 顶栏变体 / 行悬停提示）
		 *
		 * 三处注册，位置与取舍见 README 第 2 节：
		 *
		 * | 插槽 | 变体 | 位置 | 何时可见 |
		 * |---|---|---|---|
		 * | `conversation.header.leading` | `header` | 会话标题之前、工作区内容之上 | 非 Windows 顶栏环境 |
		 * | `shell.overlay` | `chrome` | 软件顶端标题栏、「应用 / 编辑」菜单之后 | 桌面端（`data-windows-titlebar`） |
		 * | `sidebar.session.row.hover` | — | 会话行悬停卡片内容位 | 该行最后一轮失败/中断且未确认 |
		 *
		 * 两个状态栏变体都注册，由 CSS 按 `html[data-windows-titlebar]` 二选一显示：这样不用去
		 * 猜宿主此刻是什么外壳，也不需要监听外壳类型变化。
		 *
		 * 注册全部是「尽力而为」：拿不到 React、拿不到 slots 或 locale 服务、注册抛错，都只记日志。
		 * 通知与任务栏走的是另一条通路，不依赖渲染。
		 *
		 * @module dsh-session-hub/hub-slots
		 */

		/**
		 * 注册全部插槽。
		 *
		 * @param {object} options 依赖注入。
		 * @param {object} options.ctx 客户端 Cordis 上下文（需要 `ctx.inject` / `ctx.logger`）。
		 * @param {string} options.pluginId 插件 id（locale 命名空间与日志标签）。
		 * @param {{
		 *   openSession: (sessionId: string, options?: { raise?: boolean }) => void,
		 *   ackError: (sessionId: string, seq: number|null) => void,
		 *   acks: object,
		 *   localUnread: object,
		 * }} options.deps 组件要用的动作与状态仓库。
		 * @returns {void}
		 */
		function registerHubSlots({ ctx, pluginId, deps }) {
		  try {
		    if (typeof ctx?.inject !== 'function') return
		    ctx.inject(['slots', 'locale'], (scoped) => {
		      try {
		        // 可见文案走 Client locale 服务（字典本身来自 hub-strings 的单一来源）；
		        // 没有该服务时组件内部用同一份中文回落。
		        try {
		          scoped.effect(
		            () => scoped.locale.register(pluginId, HUB_STRINGS),
		            `${pluginId}: locale`,
		          )
		        } catch (error) {
		          console.warn(`[${pluginId}] 注册状态栏文案失败`, error)
		        }

		        const React = typeof require === 'function' ? require('react') : null
		        if (React === null || typeof React.createElement !== 'function') {
		          console.warn(`[${pluginId}] 拿不到 React，状态栏不渲染（通知与任务栏不受影响）`)
		          return
		        }

		        const railDeps = {
		          openSession: deps.openSession,
		          ackError: deps.ackError,
		          acks: deps.acks,
		          unread: deps.localUnread,
		        }
		        const RailHeader = createSessionHubRail(React, railDeps, 'header')
		        const RailChrome = createSessionHubRail(React, railDeps, 'chrome')
		        scoped.slots.inject('conversation.header.leading', () => scoped.slots.register({
		          name: 'conversation.header.leading',
		          locale: pluginId,
		        }, RailHeader))
		        // Windows 顶栏：菜单后、窗口控件前的 frame-wide 浮动层；Web 端由 CSS 隐藏。
		        scoped.slots.inject('shell.overlay', () => scoped.slots.register({
		          name: 'shell.overlay',
		          id: 'session-hub-chrome',
		          order: 5,
		          locale: pluginId,
		        }, RailChrome))
		        // 会话行悬停卡片：补一行「本轮失败/中断」，解释官方行首那个绿色「已完成」点
		        // 为什么会出现在失败会话上（官方行状态机没有失败态，插件改不了行首点）。
		        const RowHint = createSessionHubRowHint(React, { acks: deps.acks })
		        scoped.slots.inject('sidebar.session.row.hover', () => scoped.slots.register({
		          name: 'sidebar.session.row.hover',
		          id: 'session-hub-failure',
		          order: 10,
		          locale: pluginId,
		        }, RowHint))
		        ctx.logger?.info?.(
		          `[${pluginId}] 状态栏已注册到 conversation.header.leading + shell.overlay + sidebar.session.row.hover`,
		        )
		      } catch (error) {
		        console.warn(`[${pluginId}] 注册状态栏失败`, error)
		      }
		    })
		  } catch (error) {
		    console.warn(`[${pluginId}] 注入 slots 服务失败`, error)
		  }
		}
		//#endregion

		//#region src/client-main.js —— 接线：服务 → 模型 → 通知 / 状态栏 / 任务栏
		/**
		 * dsh-session-hub —— 客户端半的接线层（浏览器 bundle 的 factory 体）
		 *
		 * 这一层只做「编排」，不实现细节：
		 *
		 *   DSH 服务（sessions / uiSession）
		 *        │  订阅 + 30ms 合并窗口
		 *        ▼
		 *   tick()  ──▶ planNotifications（notify-core）──▶ 通知 + 回合完成边沿
		 *        │                                        └─▶ hub-stores 记「后台完成」
		 *        ├──▶ deriveHubRows（hub-model）──────▶ 状态栏行 ──▶ hub-host 上报任务栏
		 *        └──▶ 诊断快照（__DSH_SESSION_HUB__）
		 *
		 * 具体实现分别住在：
		 *
		 * | 关注点 | 文件 |
		 * |---|---|
		 * | 插件 id / 存储键 | hub-identity.js |
		 * | 界面文案 | hub-strings.js |
		 * | localStorage 读写 | hub-json-store.js |
		 * | 配置 / 水位 / 确认表 / 待查看记账 | hub-stores.js |
		 * | 通知落地（tag、去重、落地日志） | hub-notify.js |
		 * | 宿主半路由（前置窗口 / 任务栏 / 探活） | hub-host.js |
		 * | 状态栏与行悬停组件 | hub-ui.js |
		 * | 插槽注册 | hub-slots.js |
		 * | 状态与优先级模型 | hub-model.js |
		 * | 通知边沿引擎 | notify-core.js |
		 * | 侧栏滚动 | hub-scroll.js |
		 *
		 * 它不 retain 任何会话——因此不会激活别人的历史，也不会在侧栏里留下痕迹。
		 * 任何异常都只记日志：状态栏与通知绝不能影响 DSH 本身。
		 *
		 * @module dsh-session-hub/client
		 */

		/** 硬依赖：会话列表与统一会话状态。两者都是 web 组合的常驻服务。 */
		const inject = ['sessions', 'uiSession']

		/** 状态变化的合并窗口（毫秒）：把一串推送折叠成一次观察。 */
		const TICK_COALESCE_MS = 30

		/** 水位 / 确认表落盘的合并窗口（毫秒）。 */
		const PERSIST_COALESCE_MS = 400

		/**
		 * 窗口是否处于「用户就在看」的状态。
		 * @param {object} config 归一化配置。
		 * @returns {boolean} 是否聚焦。
		 */
		function isFocused(config) {
		  try {
		    if (typeof document === 'undefined') return false
		    if (config.requireVisibleForFocus && document.visibilityState !== 'visible') return false
		    return typeof document.hasFocus === 'function' ? document.hasFocus() : true
		  } catch {
		    return false
		  }
		}

		/**
		 * 把会话列表快照投影成引擎需要的最小事实。
		 *
		 * 投影值刻意保留三态：键在但值为 null（宿主半已注册、该会话还没有回合结局）
		 * 与键缺失（宿主半没加载）在引擎里含义不同，不能都压成 null。
		 * @param {object} listState 会话列表快照。
		 * @returns {{sessions: object, projections: object, hostHalfPresent: boolean}} 会话行、投影值、宿主半是否在。
		 */
		function projectListState(listState) {
		  const sessions = {}
		  const projections = {}
		  let hostHalfPresent = false
		  const byId = listState?.byId
		  if (byId === null || typeof byId !== 'object') return { sessions, projections, hostHalfPresent }

		  for (const [id, row] of Object.entries(byId)) {
		    if (row === null || typeof row !== 'object') continue
		    sessions[id] = {
		      id,
		      displayTitle: row.displayTitle,
		      title: row.title,
		      origin: row.origin,
		      blank: row.blank,
		      running: row.running,
		      updatedAt: row.updatedAt,
		    }
		    const values = listState.projectionsBySession?.[id]?.values
		    if (values !== undefined && values !== null && Object.hasOwn(values, PROJECTION_KEY)) {
		      projections[id] = values[PROJECTION_KEY]
		      hostHalfPresent = true
		    }
		  }
		  return { sessions, projections, hostHalfPresent }
		}

		/**
		 * 把统一会话状态快照（ReadonlyMap 或普通对象）投影成引擎需要的形状。
		 * @param {unknown} statusSnapshot 状态快照。
		 * @returns {object} 按 id 索引的状态。
		 */
		function projectStatuses(statusSnapshot) {
		  const statuses = {}
		  if (statusSnapshot instanceof Map) {
		    for (const [id, status] of statusSnapshot) statuses[id] = status
		    return statuses
		  }
		  if (statusSnapshot !== null && typeof statusSnapshot === 'object') {
		    for (const [id, status] of Object.entries(statusSnapshot)) statuses[id] = status
		  }
		  return statuses
		}

		/**
		 * 判断当前页面是否是 DSH 桌面端外壳（只有那里才有任务栏图标可标记）。
		 * @returns {boolean} 是否桌面端。
		 */
		function isDesktopShell() {
		  try {
		    return typeof location !== 'undefined' && location.protocol === 'dsh-app:'
		  } catch {
		    return false
		  }
		}

		/**
		 * 应用 Cordis 客户端插件。
		 * @param {object} ctx 客户端 Cordis 上下文。
		 */
		function apply(ctx) {
		  const keys = hubStorageKeys(PLUGIN_ID)
		  const store = createJsonStore({ pluginId: PLUGIN_ID })
		  const stores = createHubStores({
		    store,
		    keys,
		    normalize: { config: normalizeConfig, seqMap: normalizeSeqMap },
		  })
		  /** 生效中的配置（对象被就地更新，读取请走这里）。 */
		  const config = stores.config
		  const { acks, localUnread } = stores

		  let tickTimer = null
		  let persistTimer = null
		  let disposed = false
		  /** 最近一次推导出的状态栏行（诊断与任务栏聚合用）。 */
		  let lastRows = []

		  /** 安全读取一个（可能尚未注册的）服务。 */
		  const safeGet = (serviceName) => {
		    try {
		      return typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined
		    } catch {
		      return undefined
		    }
		  }

		  /** 让窗口到前台：渲染进程自己只能尽力而为（真正的保证在宿主半）。 */
		  const focusWindowBestEffort = () => {
		    try {
		      if (typeof window !== 'undefined' && typeof window.focus === 'function') window.focus()
		    } catch (error) {
		      console.warn(`[${PLUGIN_ID}] 聚焦窗口失败`, error)
		    }
		  }

		  // ---- 宿主半：前置窗口 / 任务栏状态 / 在线探活 ----
		  const host = createHostBridge({
		    pluginId: PLUGIN_ID,
		    version: BUNDLE_VERSION,
		    getConfig: () => config,
		    isDesktopShell,
		    isDisposed: () => disposed,
		  })

		  // ---- 跳转后把左侧会话列表也滚到目标行 ----
		  const revealSessionInList = createRowRevealer({
		    pluginId: PLUGIN_ID,
		    getDocument: () => (typeof document === 'undefined' ? null : document),
		    getWorkspaces: () => safeGet('uiWorkspace')?.workspaces?.list?.getSnapshot?.(),
		    isCancelled: () => disposed,
		  })

		  /**
		   * 打开一个会话（状态栏条目 / 通知点击的落点）。
		   *
		   * 四件事，按重要性排序：
		   *   1. 在应用内跳转到该会话（受支持通道，必然生效）；
		   *   2. 把左侧会话列表也滚动到该会话行（官方 openSession 不会滚）；
		   *   3. 请求宿主半把桌面窗口提到前台（渲染进程自己做不到）；
		   *   4. `window.focus()` 兜底（受 Blink 手势门控，可能无效，但零成本）。
		   *
		   * `options.raise === false` 时跳过第 3 步：**点击状态栏 chip 时窗口本来就在前台**，
		   * 再走一次窗口前置毫无收益，反而会经过 Win32 的窗口状态处理（历史实现里的
		   * SW_RESTORE 会把最大化窗口打回普通尺寸）。chip 点击只做应用内跳转。
		   * @param {string} sessionId 目标会话。
		   * @param {{ raise?: boolean }} [options] `raise:false` 表示不请求宿主半前置窗口。
		   */
		  const openSession = (sessionId, options = {}) => {
		    if (typeof sessionId !== 'string' || sessionId === '') return
		    const workspace = safeGet('uiWorkspace')
		    if (workspace !== undefined && typeof workspace.openSession === 'function') {
		      try {
		        workspace.openSession(sessionId)
		      } catch (error) {
		        console.warn(`[${PLUGIN_ID}] 打开会话失败：${sessionId}`, error)
		      }
		    } else {
		      // 退路：uiWorkspace 不可用时广播一个 DOM 事件，方便别的插件/用户脚本接管。
		      try {
		        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
		          window.dispatchEvent(new CustomEvent(`${PLUGIN_ID}:open-session`, { detail: { sessionId } }))
		        }
		      } catch {
		        /* 事件广播失败不影响通知本身 */
		      }
		    }
		    // 让左侧会话列表也滚到该会话行：官方 openSession 只切换主视图，不滚动列表。
		    // 这一步只读 DOM、异步等待渲染，失败静默，绝不影响上面真正的跳转。
		    revealSessionInList(sessionId)
		    // 用户主动跳转（点通知 / 点 chip）= 已经去看这个会话了：清掉「后台完成」记账，
		    // 绿点与任务栏绿灯随之熄灭。这条路径不依赖窗口此刻是否已经获得焦点。
		    if (stores.clearLocalUnread(sessionId)) scheduleTick()
		    if (options.raise !== false) host.callHostRoute('raise')
		    focusWindowBestEffort()
		  }

		  /**
		   * 确认某个会话的报错（点击状态栏条目 / 正在看该会话时自动确认）。
		   * @param {string} sessionId 会话 id。
		   * @param {number|null} seq 报错回合的 seq；null 不是合法确认值。
		   */
		  const ackError = (sessionId, seq) => {
		    if (!stores.ackError(sessionId, seq)) return
		    // 让任务栏聚合状态立即跟上（红灯在当前条目被确认后应当熄灭）。
		    scheduleTick()
		  }

		  // ---- 通知落地：tag 哈希 / 跨标签页去重 / 落地诊断日志 ----
		  const notifySink = createNotifySink({
		    pluginId: PLUGIN_ID,
		    keys,
		    store,
		    getConfig: () => config,
		    isFocused: () => isFocused(config),
		    openSession,
		    // 通知一弹出，用户很可能一两秒内就点它：提前把宿主半的 worker 烧热。
		    onFirstShow: () => host.callHostRoute('warmup'),
		  })

		  /** 立即观察一次（合并窗口到期时执行）。 */
		  const tick = () => {
		    tickTimer = null
		    if (disposed) return
		    try {
		      const sessionsService = safeGet('sessions')
		      const uiSession = safeGet('uiSession')
		      if (sessionsService === undefined || uiSession === undefined) return

		      const listState = sessionsService.list?.getSnapshot?.()
		      if (listState === undefined || listState === null) return
		      const statusSnapshot = uiSession.sessionStatus?.getSnapshot?.()
		      const statuses = projectStatuses(statusSnapshot)

		      // 一次观察里只判定一次「窗口在不在前台」：状态栏、通知、待查看记账必须同源，
		      // 否则会在同一帧里得出互相矛盾的结论。
		      const focused = isFocused(config)
		      const currentSessionId = currentSessionIdOf(listState)

		      // 1) 通知边沿。它同时给出「这一轮结束了」的事实（result.completions），
		      //    所以必须排在状态栏推导之前——补记的「待查看」要在同一帧里点亮绿点 / 绿灯。
		      const { sessions, projections, hostHalfPresent } = projectListState(listState)
		      if (!hostHalfPresent) host.checkHostHalf()
		      const result = planNotifications({
		        sessions,
		        projections,
		        statuses,
		        state: stores.watermarks.get(),
		        config,
		        now: Date.now(),
		        focused,
		        currentSessionId,
		        // 兜底路径只认探活结论：确证宿主半缺失才允许用 running 下降沿当「完成」。
		        allowRunningFallback: host.hostHalfState() === 'absent',
		      })

		      stores.watermarks.set(result.state)
		      schedulePersist()

		      // 2) 「后台完成」记账：官方 completionUnread 对主视图会话永不置位，这里补上。
		      //    - 窗口不在前台时完成的回合 → 记为待查看（绿点 / 任务栏绿灯 / 完成通知）；
		      //    - 窗口在前台且正在看这个会话 → 视为已查看，清掉记账。
		      if (focused) {
		        if (currentSessionId !== undefined) stores.clearLocalUnread(currentSessionId)
		      } else {
		        for (const completion of result.completions) {
		          stores.markLocalUnread(completion.sessionId, completion.seq)
		        }
		      }

		      // 3) 状态栏行。正在看当前会话且窗口聚焦时，当前会话的报错视为已读（不再亮红）。
		      const derive = () => deriveHubRows({
		        list: listState,
		        statuses,
		        ackErrors: acks.getSnapshot(),
		        localUnread: localUnread.getSnapshot(),
		      })
		      let rows = derive()
		      if (currentSessionId !== undefined && focused) {
		        const currentError = rows.find((row) => row.id === currentSessionId && row.state === 'error')
		        if (currentError !== undefined) {
		          if (stores.ackError(currentSessionId, currentError.errorSeq)) rows = derive()
		        }
		      }
		      lastRows = rows

		      // 4) 任务栏：红 > 黄 > 绿 > 无。
		      host.pushTaskbar(aggregateTaskbarState(rows))

		      // 5) 弹通知。
		      if (result.notes.length > 0) {
		        console.debug(`[${PLUGIN_ID}]`, result.notes)
		      }
		      for (const notification of result.notifications) notifySink.show(notification)
		    } catch (error) {
		      // 状态栏/通知功能绝不应当影响 DSH 本身：任何异常都只记日志。
		      console.error(`[${PLUGIN_ID}] 观察会话状态失败`, error)
		    }
		  }

		  /** 合并一串推送，只做一次观察。 */
		  const scheduleTick = () => {
		    if (disposed || tickTimer !== null) return
		    tickTimer = setTimeout(tick, TICK_COALESCE_MS)
		  }

		  /** 合并水位落盘。 */
		  const schedulePersist = () => {
		    if (disposed || persistTimer !== null) return
		    persistTimer = setTimeout(() => {
		      persistTimer = null
		      stores.watermarks.flush()
		    }, PERSIST_COALESCE_MS)
		  }

		  /**
		   * 权限为 default 时，等一次用户手势再请求（浏览器要求手势）。
		   * 桌面版已经把通知权限放行，这里只是兜底。
		   * @returns {() => void} 取消订阅。
		   */
		  const requestPermissionOnGesture = () => {
		    if (typeof Notification === 'undefined' || typeof window === 'undefined') return () => {}
		    if (Notification.permission !== 'default') return () => {}
		    const ask = () => {
		      quiesce()
		      try {
		        Promise.resolve(Notification.requestPermission()).catch(() => {})
		      } catch (error) {
		        console.warn(`[${PLUGIN_ID}] 请求通知权限失败`, error)
		      }
		    }
		    /** 撤掉等待手势的监听（拿到手势或插件卸载时都要撤）。 */
		    const quiesce = () => {
		      try {
		        window.removeEventListener('pointerdown', ask, true)
		        window.removeEventListener('keydown', ask, true)
		      } catch {
		        /* 忽略 */
		      }
		    }
		    try {
		      window.addEventListener('pointerdown', ask, true)
		      window.addEventListener('keydown', ask, true)
		    } catch {
		      return () => {}
		    }
		    return quiesce
		  }

		  // ---- 接线：两个受支持的状态源，任何变化都合并成一次观察 ----
		  const disposers = []
		  try {
		    const sessionsService = safeGet('sessions')
		    if (sessionsService?.list?.subscribe !== undefined) {
		      disposers.push(sessionsService.list.subscribe(scheduleTick))
		    }
		    const uiSession = safeGet('uiSession')
		    if (uiSession?.sessionStatus?.subscribe !== undefined) {
		      disposers.push(uiSession.sessionStatus.subscribe(scheduleTick))
		    }
		  } catch (error) {
		    console.error(`[${PLUGIN_ID}] 订阅会话状态失败`, error)
		  }

		  // ---- 窗口焦点：焦点/可见性变化也要触发一次观察 ----
		  //
		  // 「后台完成」的记账靠焦点状态判定，而焦点变化**不会**带来会话状态推送：用户切回窗口
		  // 那一刻必须自己重新观察一次，否则绿点 / 绿灯会一直亮到下一次会话状态变化为止。
		  const focusListeners = []
		  const onWindowFocusChange = () => scheduleTick()
		  try {
		    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
		      window.addEventListener('focus', onWindowFocusChange)
		      window.addEventListener('blur', onWindowFocusChange)
		      focusListeners.push({ target: window, type: 'focus' }, { target: window, type: 'blur' })
		    }
		    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
		      document.addEventListener('visibilitychange', onWindowFocusChange)
		      focusListeners.push({ target: document, type: 'visibilitychange' })
		    }
		  } catch (error) {
		    console.warn(`[${PLUGIN_ID}] 订阅窗口焦点失败`, error)
		  }

		  // ---- 工作区顶部状态栏 / 顶栏变体 / 行悬停提示 ----
		  registerHubSlots({
		    ctx,
		    pluginId: PLUGIN_ID,
		    deps: { openSession, ackError, acks, localUnread },
		  })

		  /** 页面卸载时清掉任务栏状态点，避免红灯留在任务栏上。 */
		  const onPageHide = () => {
		    host.pushTaskbar('none', true)
		  }
		  try {
		    if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide)
		  } catch {
		    /* 页面环境异常时忽略 */
		  }

		  const cancelPermissionWait = requestPermissionOnGesture()

		  ctx.effect(() => () => {
		    disposed = true
		    for (const dispose of disposers.splice(0)) {
		      try {
		        dispose()
		      } catch {
		        /* 清理失败不应阻塞其他清理 */
		      }
		    }
		    if (tickTimer !== null) clearTimeout(tickTimer)
		    if (persistTimer !== null) clearTimeout(persistTimer)
		    tickTimer = null
		    persistTimer = null
		    stores.watermarks.flush()
		    try {
		      cancelPermissionWait()
		    } catch {
		      /* 忽略 */
		    }
		    for (const { target, type } of focusListeners.splice(0)) {
		      try {
		        target.removeEventListener?.(type, onWindowFocusChange)
		      } catch {
		        /* 忽略 */
		      }
		    }
		    try {
		      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide)
		    } catch {
		      /* 忽略 */
		    }
		    // 卸载时清掉任务栏状态点（此时 disposed 已置位，必须 force）。
		    host.pushTaskbar('none', true)
		    if (typeof globalThis !== 'undefined' && globalThis.__DSH_SESSION_HUB__ === diagnostics) {
		      delete globalThis.__DSH_SESSION_HUB__
		    }
		  }, `${PLUGIN_ID}: observers`)

		  // 首帧先做一次基线观察：已有的历史结局不会变成一串迟到的通知。
		  scheduleTick()

		  // ---- 诊断/测试入口 ----
		  const diagnostics = {
		    /** @returns {object} 当前生效配置。 */
		    getConfig: () => ({ ...config }),
		    /**
		     * 合并写入配置（立即生效并落盘）。
		     * @param {object} patch 部分配置。
		     * @returns {object} 生效后的完整配置。
		     */
		    setConfig: (patch) => {
		      stores.patchConfig(patch ?? {})
		      scheduleTick()
		      return { ...config }
		    },
		    /** @returns {object} 当前水位表（只读快照）。 */
		    getWatermarks: () => JSON.parse(JSON.stringify(stores.watermarks.get())),
		    /** @returns {Array<object>} 当前状态栏行。 */
		    getRows: () => JSON.parse(JSON.stringify(lastRows)),
		    /** @returns {string} 当前聚合任务栏状态。 */
		    getTaskbarState: () => aggregateTaskbarState(lastRows),
		    /**
		     * 「后台完成、尚未查看」的记账（排障用）。
		     *
		     * 形如 `{ [sessionId]: seq }`。窗口不在前台时完成的回合会记在这里，用来补官方
		     * `completionUnread` 对主视图会话的空白；窗口回到前台并正在看该会话时自动清掉。
		     * @returns {object} 记账快照。
		     */
		    getLocalUnread: () => ({ ...localUnread.getSnapshot() }),
		    /**
		     * 手动清掉「后台完成」记账（排障用）。
		     * @param {string} [sessionId] 会话 id；不传表示全部清掉。
		     * @returns {boolean} 是否真的发生了变化。
		     */
		    clearLocalUnread: (sessionId) => {
		      const changed = stores.clearLocalUnread(sessionId)
		      if (changed) scheduleTick()
		      return changed
		    },
		    /** 立刻观察一次（不等合并窗口）。 */
		    tick,
		    /**
		     * 手动设置任务栏状态（排障用；绕过去重）。
		     * @param {string} state red | yellow | green | none。
		     * @returns {string} 传入的状态。
		     */
		    setTaskbarState: (state) => {
		      host.pushTaskbar(state, true)
		      return state
		    },
		    /**
		     * 弹一条测试通知，用来确认系统通知通路与点击跳转。
		     * @param {string|undefined} sessionId 目标会话；缺省用当前打开的会话。
		     * @returns {boolean} 是否真的弹了。
		     */
		    testNotification: (sessionId) => {
		      const target = sessionId ?? currentSessionIdOf(safeGet('sessions')?.list?.getSnapshot?.() ?? {})
		      if (target === undefined) {
		        console.warn(`[${PLUGIN_ID}] 没有可用于测试的会话`)
		        return false
		      }
		      notifySink.show({
		        sessionId: target,
		        dedupeKey: `test:${Date.now()}`,
		        // 借用 `answer` 只是为了常驻（`requireInteraction`）；标识用铃铛而不是黄点，
		        // 免得一条测试通知被看成「真的在等你回应」。
		        category: 'answer',
		        marker: NOTIFY_MARKERS.test,
		        title: 'DSH · 通知测试',
		        body: '点击这条通知应当跳回对应会话',
		      })
		      return true
		    },
		    /** 受支持服务的存在性（排障用）。 */
		    inspect: () => ({
		      version: BUNDLE_VERSION,
		      sessions: safeGet('sessions') !== undefined,
		      uiSession: safeGet('uiSession') !== undefined,
		      uiWorkspace: safeGet('uiWorkspace') !== undefined,
		      permission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
		      sessionsTracked: Object.keys(stores.watermarks.get()).length,
		      statusRows: lastRows.length,
		      taskbarState: aggregateTaskbarState(lastRows),
		      /** 「后台完成、尚未查看」的会话数（补官方 completionUnread 的那部分）。 */
		      localUnread: Object.keys(localUnread.getSnapshot()).length,
		      /** 窗口此刻是否在前台（与通知静默、待查看记账同源）。 */
		      focused: isFocused(config),
		      desktopShell: isDesktopShell(),
		      /** 宿主半在线状态（由 /ping 判定，与「有没有投影值」无关）。 */
		      hostHalf: host.hostHalfState(),
		    }),
		    /** @returns {Array<object>} 最近的通知落地结果（见 hub-notify 的 getLog）。 */
		    getNotifyLog: () => notifySink.getLog(),
		    /** 清空通知诊断日志（排障用）。 */
		    clearNotifyLog: () => notifySink.clearLog(),
		    /** 主动问一次宿主半在不在（返回 Promise，解析为最终状态）。 */
		    pingHost: async () => {
		      host.resetHostHalfCheck()
		      host.checkHostHalf(true)
		      const deadline = Date.now() + 3000
		      while (host.hostHalfState() === 'checking') {
		        if (Date.now() > deadline) break
		        await new Promise((resolve) => setTimeout(resolve, 50))
		      }
		      return host.hostHalfState()
		    },
		    /**
		     * 手动请求宿主半前置窗口（排障用；与点击通知走完全相同的通路）。
		     * @returns {boolean} 是否发起了请求。
		     */
		    raiseWindow: () => {
		      host.callHostRoute('raise')
		      return config.raiseWindow === true
		    },
		    /**
		     * 手动跳转到某个会话（排障用）。
		     * @param {string} sessionId 目标会话。
		     * @returns {boolean} 会话是否在目录里。
		     */
		    openSession: (sessionId) => {
		      const byId = safeGet('sessions')?.list?.getSnapshot?.()?.byId
		      if (byId === undefined || !Object.hasOwn(byId, sessionId)) return false
		      openSession(sessionId)
		      return true
		    },
		    /**
		     * 手动把左侧会话列表滚动到某个会话行（排障用，不跳转）。
		     *
		     * 返回值同时是一次「DOM 约定体检」：`session` 表示会话行命中；
		     * `workspace` 表示会话行没渲染（分组折叠 / 被过滤），退化到了它所属的分组行；
		     * `null` 表示两者都没找到。
		     * @param {string} sessionId 目标会话。
		     * @returns {'session'|'workspace'|null} 实际滚动到的行类型；没找到时为 null。
		     */
		    revealSessionRow: (sessionId) => {
		      const workspaceService = safeGet('uiWorkspace')
		      const workspaces = workspaceService?.workspaces?.list?.getSnapshot?.()
		      const doc = typeof document === 'undefined' ? null : document
		      return scrollSessionRowIntoView(doc, sessionId, { workspaces })
		    },
		    /**
		     * 手动确认某个会话的全部报错（排障用）。
		     * @param {string} sessionId 目标会话。
		     * @returns {boolean} 是否确认了。
		     */
		    ackError: (sessionId) => {
		      const row = lastRows.find((item) => item.id === sessionId && item.state === 'error')
		      if (row === undefined) return false
		      ackError(sessionId, row.errorSeq)
		      return true
		    },
		  }
		  try {
		    globalThis.__DSH_SESSION_HUB__ = diagnostics
		  } catch {
		    /* 只读全局对象等极端环境下放弃暴露诊断入口 */
		  }

		  ctx.logger?.info?.(
		    `[${PLUGIN_ID}] 客户端半 v${BUNDLE_VERSION} 已启动：`
		    + `完成=${config.onComplete} 失败=${config.onFailure} 需回应=${config.onAnswer}`,
		  )
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
