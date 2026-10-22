/**
 * dsh-session-hub —— 客户端 bundle（由 build/bundle.mjs 生成，请不要手改）
 *
 * 内联自：
 *   - src/hub-model.js     状态栏 / 任务栏纯逻辑
 *   - src/notify-core.js   通知决策引擎（纯逻辑）
 *   - src/hub-ui.js        顶部状态栏 React 组件
 *   - src/client-main.js   接线：DSH 服务 → 模型 → 通知 / 状态栏 / 任务栏
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

		//#region src/hub-model.js

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
		 *   等待回答（answer，黄） > 报错（error，红） > 运行中（running，蓝） > 待查看（unread，绿）
		 *
		 * 任务栏只取最高优先级的三色：
		 *   - 有报错 → red
		 *   - 否则有等待回答 → yellow
		 *   - 否则有运行中或待查看 → green
		 *   - 都没有 → none（清除覆盖图标）
		 *
		 * @module dsh-session-hub/hub-model
		 */

		/** 三类「需要你回应」的待交互（与 dsh-client-ui-workspace 的 visiblePendingKind 同口径）。 */
		const HUB_PENDING_KINDS = Object.freeze(['approval', 'plan-review', 'question'])

		/** 状态排序：数字越小越靠前（也越"需要人"）。 */
		const STATE_ORDER = Object.freeze({
		  answer: 0,
		  error: 1,
		  running: 2,
		  unread: 3,
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
		 * 从快照推导状态栏行。
		 *
		 * @param {object} input 输入。
		 * @param {object} input.list 会话列表快照。
		 * @param {Map|object} input.statuses 统一会话状态（Map 或对象）。
		 * @param {object} [input.ackErrors] 已确认的报错 seq：`{ [sessionId]: number }`。
		 * @param {boolean} [input.includeSubagents] 是否包含子代理会话（默认 false）。
		 * @param {number} [input.now] 当前时间（保留给未来排序/过期策略）。
		 * @returns {Array<{id: string, title: string, state: string, pendingKind: string|null, errorSeq: number|null, updatedAt: number}>}
		 *   按优先级与更新时间排好序的行。
		 */
		function deriveHubRows({ list, statuses, ackErrors = {}, includeSubagents = false, now = 0 } = {}) {
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
		    const unread = status?.completionUnread === true

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
		 * @param {Array<{state: string}>} rows 状态栏行。
		 * @returns {'red'|'yellow'|'green'|'none'} 任务栏状态。
		 */
		function aggregateTaskbarState(rows) {
		  if (!Array.isArray(rows) || rows.length === 0) return 'none'
		  if (rows.some((row) => row?.state === 'error')) return 'red'
		  if (rows.some((row) => row?.state === 'answer')) return 'yellow'
		  if (rows.some((row) => row?.state === 'running' || row?.state === 'unread')) return 'green'
		  return 'none'
		}

		/**
		 * 归一化持久化的报错确认表：只保留整数 seq，丢掉坏值。
		 * @param {unknown} value 读到的 JSON。
		 * @returns {object} `{ [sessionId]: number }`。
		 */
		function normalizeAckErrors(value) {
		  const out = {}
		  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out
		  for (const [id, seq] of Object.entries(value)) {
		    if (typeof id === 'string' && id !== '' && Number.isInteger(seq) && seq >= 0) out[id] = seq
		  }
		  return out
		}

		//#endregion
		//#region src/notify-core.js

		/**
		 * dsh-session-hub —— 通知决策引擎（纯逻辑，零依赖）
		 *
		 * 这一层只做一件事：把「会话事实快照」折叠成「本次应当弹出的通知列表」。
		 * 它不碰 DOM、不碰 Notification、不碰 Cordis，因此可以在 Node 里直接单测
		 * （见 test/notify-core-test.mjs）。
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
		  /** 同一会话的新通知替换旧通知（tag），避免一个会话堆一列。 */
		  replacePerSession: true,
		  /** 系统提示音。 */
		  sound: true,
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
		 * 生成一条通知的标题与正文。
		 * @param {object} args 输入。
		 * @param {string} args.category 通知类别。
		 * @param {string} args.title 会话展示标题。
		 * @param {object|null} args.projection 该会话的 hubTurnOutcome 投影值。
		 * @param {object|null} args.pending pendingInteraction 值。
		 * @returns {{category: string, title: string, body: string}} 通知文案。
		 */
		function describeNotification({ category, title, projection, pending }) {
		  const name = typeof title === 'string' && title.trim() !== '' ? title : '未命名会话'
		  if (category === 'answer') {
		    const kind = pending?.kind
		    const what = kind === 'approval' ? '需要你批准' : kind === 'plan-review' ? '有一个计划待审' : '需要你回答'
		    return { category, title: 'DSH · 需要你回应', body: `${what}：${name}` }
		  }
		  if (category === 'failed') {
		    const message = typeof projection?.message === 'string' && projection.message !== '' ? projection.message : null
		    const code = typeof projection?.code === 'string' && projection.code !== '' ? projection.code : null
		    const suffix = message !== null ? `：${message}` : (code !== null ? `（${code}）` : '')
		    return { category, title: 'DSH · 任务失败', body: `${name}${suffix}` }
		  }
		  if (category === 'stopped') return { category, title: 'DSH · 任务已停止', body: name }
		  if (category === 'max-tokens') return { category, title: 'DSH · 达到输出上限', body: name }
		  return { category, title: 'DSH · 任务完成', body: name }
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
		 * @returns {{notifications: Array<object>, state: object, notes: Array<string>}}
		 *   通知列表、新水位、诊断说明（用于调试与单测断言）。
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

		  return { notifications, state: prune(next, recency, config), notes }
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
		//#region src/hub-ui.js

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
		 *
		 * @module dsh-session-hub/hub-ui
		 */

		/**
		 * 创建状态栏组件。
		 * @param {object} React React 运行时（由客户端模块表提供）。
		 * @param {{
		 *   openSession: (sessionId: string) => void,
		 *   ackError: (sessionId: string, seq: number|null) => void,
		 *   acks: { subscribe: (listener: () => void) => () => void, getSnapshot: () => object },
		 * }} deps 由 client-main 注入的动作与确认表。
		 * @param {'header'|'chrome'} [variant] 渲染位置：会话标题前，或 Windows 顶栏菜单之后。
		 * @returns {Function} React 函数组件。
		 */
		function createSessionHubRail(React, deps, variant = 'header') {
		  const h = React.createElement
		  const EMPTY_LIST = { byId: {}, projectionsBySession: {} }
		  const EMPTY_STATUSES = new Map()

		  /** 文案回落：插槽没有绑定 locale 时也能显示中文。 */
		  const FALLBACK = {
		    label: '会话',
		    idle: '全部空闲',
		    aria: '会话状态：{count} 个需要关注',
		    more: '还有 {count} 个会话',
		    collapse: '收起',
		    'state.answer': '等待回答',
		    'state.error': '报错',
		    'state.running': '运行中',
		    'state.unread': '待查看',
		  }

		  /**
		   * 极简文案函数（只在 locale 服务缺失时使用）。
		   * @param {string} key 文案键。
		   * @param {object} [params] 插值参数。
		   * @returns {string} 文案。
		   */
		  const fallbackT = (key, params) => {
		    const text = FALLBACK[key] ?? key
		    return params === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match))
		  }

		  /** 没有插槽钩子时的安全回落（只会在测试或异常组合里用到）。 */
		  const useEmptySessions = () => EMPTY_LIST
		  const useEmptyStatuses = () => EMPTY_STATUSES

		  /**
		   * 订阅「已确认报错」表；React 18+ 用 useSyncExternalStore，旧版本退化为强制刷新。
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
		    const ackErrors = useAcks(deps.acks)
		    const rows = deriveHubRows({ list, statuses, ackErrors, now: Date.now() })
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

		//#endregion
		//#region src/client-main.js

		/**
		 * dsh-session-hub —— 客户端半（浏览器 bundle 的 factory 体）
		 *
		 * 职责：
		 *   1. 从 DSH 受支持的服务读「会话事实」（会话列表 + 统一会话状态 + 宿主投影）；
		 *   2. 交给纯逻辑模型 `deriveHubRows` 推导状态栏行，交给 `planNotifications` 算通知边沿；
		 *   3. 注册 `conversation.header.leading` 插槽，在工作区上方显示会话状态栏；
		 *   4. 把聚合状态发给宿主半，由宿主半用 ITaskbarList3 标记任务栏图标（红/黄/绿）；
		 *   5. 状态变化时弹 Windows 系统通知；点击通知 / 状态栏条目跳转到对应会话。
		 *
		 * 它不 retain 任何会话——因此不会激活别人的历史，也不会在侧栏里留下痕迹。
		 *
		 * ## 为什么用浏览器通知而不是 PowerShell/WinRT toast
		 *
		 * 「点击通知跳回对应会话」要求点击事件能回到页面里：HTML5 Notification 的
		 * `onclick` 就在页面里触发，可以直接调用 DSH 自己的导航服务。宿主侧起 PowerShell
		 * 弹 WinRT toast 虽然窗口关掉也能弹，但点击只能落到「协议激活」上，而 DSH 没有
		 * 注册会话深链协议，跳转无从谈起。桌面版窗口常驻，页面通路足够。
		 *
		 * @module dsh-session-hub/client
		 */

		/** 插件 id（与 package.json 的 name 一致，供日志与 tag 使用）。 */
		const PLUGIN_ID = 'dsh-session-hub'

		/** 宿主半注册的投影键。 */
		const PROJECTION_KEY = 'hubTurnOutcome'

		/** localStorage 键（带版本后缀，形状变化时换键即自动丢弃旧数据）。 */
		const CONFIG_KEY = `${PLUGIN_ID}/config-v1`
		const WATERMARK_KEY = `${PLUGIN_ID}/watermarks-v1`
		const RECENT_KEY = `${PLUGIN_ID}/recent-v1`
		const ACK_KEY = `${PLUGIN_ID}/error-acks-v1`

		/** 多标签页去重窗口：同一事件在此窗口内只允许一个页面真的弹通知。 */
		const CROSS_TAB_WINDOW_MS = 4000

		/** 状态变化的合并窗口（毫秒）：把一串推送折叠成一次观察。 */
		const TICK_COALESCE_MS = 30

		/** 水位 / 确认表落盘的合并窗口（毫秒）。 */
		const PERSIST_COALESCE_MS = 400

		/** 硬依赖：会话列表与统一会话状态。两者都是 web 组合的常驻服务。 */
		const inject = ['sessions', 'uiSession']

		/**
		 * 读取 localStorage 里的 JSON；任何异常都回落到默认值。
		 * @param {string} key 存储键。
		 * @param {unknown} fallback 默认值。
		 * @returns {unknown} 解析结果或默认值。
		 */
		function readJson(key, fallback) {
		  try {
		    if (typeof localStorage === 'undefined') return fallback
		    const raw = localStorage.getItem(key)
		    if (raw === null || raw === '') return fallback
		    const value = JSON.parse(raw)
		    return value === null || value === undefined ? fallback : value
		  } catch (error) {
		    console.warn(`[${PLUGIN_ID}] 读取 ${key} 失败，使用默认值`, error)
		    return fallback
		  }
		}

		/**
		 * 写入 localStorage 里的 JSON；配额/隐私模式导致的失败只记日志。
		 * @param {string} key 存储键。
		 * @param {unknown} value 待写入值。
		 */
		function writeJson(key, value) {
		  try {
		    if (typeof localStorage === 'undefined') return
		    localStorage.setItem(key, JSON.stringify(value))
		  } catch (error) {
		    console.warn(`[${PLUGIN_ID}] 写入 ${key} 失败`, error)
		  }
		}

		/**
		 * 创建一个小型快照仓库，供 React 的 useSyncExternalStore 订阅。
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
		          console.warn(`[${PLUGIN_ID}] 状态栏订阅者抛错`, error)
		        }
		      }
		    },
		  }
		}

		/**
		 * 跨标签页去重：同一事件在多个页面里只会有一个页面真的弹通知。
		 *
		 * 判定依据是引擎给出的 `dedupeKey`（同一会话 + 同一事件）。窗口内的键会被清理，
		 * 因此这张表不会无限增长；多页面同时写入的竞态最多导致一次重复通知。
		 * @param {string} dedupeKey 事件键。
		 * @returns {boolean} true 表示本次由自己弹。
		 */
		function claimEvent(dedupeKey) {
		  const now = Date.now()
		  const recent = readJson(RECENT_KEY, {})
		  const kept = {}
		  if (recent !== null && typeof recent === 'object') {
		    for (const [key, time] of Object.entries(recent)) {
		      if (typeof time === 'number' && now - time < CROSS_TAB_WINDOW_MS) kept[key] = time
		    }
		  }
		  const claimed = kept[dedupeKey] === undefined
		  if (claimed) kept[dedupeKey] = now
		  writeJson(RECENT_KEY, kept)
		  return claimed
		}

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
		  const config = normalizeConfig(readJson(CONFIG_KEY, {}))
		  let watermarks = readJson(WATERMARK_KEY, {})
		  if (watermarks === null || typeof watermarks !== 'object') watermarks = {}

		  /** 已确认的报错回合：`{ [sessionId]: seq }`。 */
		  const acks = createSnapshotStore(normalizeAckErrors(readJson(ACK_KEY, {})))

		  let tickTimer = null
		  let persistTimer = null
		  let disposed = false
		  /** 最近一次推导出的状态栏行（诊断与任务栏聚合用）。 */
		  let lastRows = []
		  /** 最近一次发给宿主的任务栏状态，避免重复请求。 */
		  let lastTaskbarState = null

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

		  /**
		   * 调宿主半的内部路由（同源、文档相对，见宿主半 ROUTE_PATH 的说明）。
		   *
		   * 永远是「发了不管」：路由不存在、宿主半没加载、请求失败都不影响界面本身。
		   * @param {'raise'|'warmup'} action 动作名。
		   */
		  const callHostRoute = (action) => {
		    try {
		      if (config.raiseWindow !== true) return
		      if (typeof fetch !== 'function') return
		      const url = `${PLUGIN_ID}/${action}`
		      Promise.resolve(fetch(url, { method: 'POST', keepalive: true })).catch(() => {})
		    } catch (error) {
		      console.debug(`[${PLUGIN_ID}] 调用宿主路由 ${action} 失败`, error)
		    }
		  }

		  /**
		   * 打开一个会话（状态栏条目 / 通知点击的落点）。
		   *
		   * 三件事，按重要性排序：
		   *   1. 在应用内跳转到该会话（受支持通道，必然生效）；
		   *   2. 请求宿主半把桌面窗口提到前台（渲染进程自己做不到）；
		   *   3. `window.focus()` 兜底（受 Blink 手势门控，可能无效，但零成本）。
		   *
		   * `options.raise === false` 时跳过第 2 步：**点击状态栏 chip 时窗口本来就在前台**，
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
		    if (options.raise !== false) callHostRoute('raise')
		    focusWindowBestEffort()
		  }

		  /**
		   * 确认某个会话的报错（点击状态栏条目 / 正在看该会话时自动确认）。
		   * @param {string} sessionId 会话 id。
		   * @param {number|null} seq 报错回合的 seq；null 不是合法确认值。
		   */
		  const ackError = (sessionId, seq) => {
		    if (typeof sessionId !== 'string' || sessionId === '') return
		    if (!Number.isInteger(seq) || seq < 0) return
		    const current = acks.getSnapshot()
		    if ((current[sessionId] ?? -1) >= seq) return
		    const next = { ...current, [sessionId]: seq }
		    writeJson(ACK_KEY, next)
		    acks.set(next)
		    // 让任务栏聚合状态立即跟上（红灯在当前条目被确认后应当熄灭）。
		    scheduleTick()
		  }

		  /**
		   * 把聚合状态发给宿主半，由它标记任务栏图标。
		   *
		   * 只在桌面外壳里发：普通浏览器页面没有任务栏按钮，多个标签页也不会互相抢状态。
		   * @param {'red'|'yellow'|'green'|'none'} state 任务栏状态。
		   * @param {boolean} [force] 忽略去重（卸载 / 测试）。
		   */
		  const pushTaskbar = (state, force = false) => {
		    if (!isDesktopShell()) return
		    if (disposed && force !== true) return
		    if (!force && state === lastTaskbarState) return
		    lastTaskbarState = state
		    try {
		      if (typeof fetch !== 'function') return
		      Promise.resolve(fetch(`${PLUGIN_ID}/taskbar`, {
		        method: 'POST',
		        headers: { 'content-type': 'application/json' },
		        body: JSON.stringify({ state }),
		        keepalive: true,
		      })).catch(() => {})
		    } catch (error) {
		      console.debug(`[${PLUGIN_ID}] 更新任务栏状态失败`, error)
		    }
		  }

		  /** 预热只发一次：通知一弹出就去让宿主半把 PowerShell 编译好。 */
		  let warmedUp = false

		  /**
		   * 弹一条系统通知。
		   * @param {object} notification 引擎产出的通知描述。
		   */
		  const showNotification = (notification) => {
		    if (typeof Notification === 'undefined') return
		    if (Notification.permission !== 'granted') {
		      console.warn(`[${PLUGIN_ID}] 通知权限为 ${String(Notification.permission)}，跳过：${notification.title}`)
		      return
		    }
		    if (!claimEvent(notification.dedupeKey)) return

		    // 通知已经弹出，用户很可能一两秒内点它：提前把宿主半的窗口前置器烧热。
		    if (!warmedUp) {
		      warmedUp = true
		      callHostRoute('warmup')
		    }
		    let toast
		    try {
		      toast = new Notification(notification.title, {
		        body: notification.body,
		        // 同一会话的新通知替换旧的，避免一个会话堆成一列。
		        tag: config.replacePerSession ? `${PLUGIN_ID}:${notification.sessionId}` : undefined,
		        // silent=true 表示不出声。
		        silent: config.sound !== true,
		        // 需要你回应的通知常驻，直到用户处理（Windows 上也会留在操作中心）。
		        requireInteraction: notification.category === 'answer',
		      })
		    } catch (error) {
		      console.warn(`[${PLUGIN_ID}] 创建通知失败`, error)
		      return
		    }

		    toast.onclick = () => {
		      try {
		        toast.close()
		      } catch {
		        /* 关闭失败无所谓，下面照常跳转 */
		      }
		      // 窗口已经在前台时不需要再前置（也就不会触碰窗口状态）；后台/最小化时才请求。
		      openSession(notification.sessionId, { raise: !isFocused(config) })
		    }
		    toast.onclose = () => {}
		    toast.onerror = () => {
		      console.warn(`[${PLUGIN_ID}] 通知显示失败：${notification.title}`)
		    }
		  }

		  /** 宿主半在线状态：unknown（还没问过）/ checking / present / absent。 */
		  let hostHalfState = 'unknown'
		  let hostHalfCheckedAt = 0

		  /**
		   * 问一次宿主半「你在不在」。
		   *
		   * 只有拿到 `host === PLUGIN_ID` 才算在线——**不能用「有没有投影值」来判断**：
		   * 新装的插件在任何会话产生回合结局之前本来就没有值，那会误报成「宿主半没加载」。
		   *
		   * 还要容忍版本错位：宿主半是插件包的一部分，但它只在 DSH 启动/重载插件时加载，
		   * 而客户端半每次刷新页面都会重新取。当前者比后者旧时，`/ping` 会返回路由家族的
		   * 404（`{"error":"unknown-action"}`）——这同样证明「路由在、宿主半在」，不能报错。
		   * 判定为不在时每 5 分钟重试一次。
		   */
		  const checkHostHalf = (force = false) => {
		    if (disposed || typeof fetch !== 'function') return
		    const now = Date.now()
		    if (!force) {
		      if (hostHalfState === 'checking' || hostHalfState === 'present') return
		      // 已经问过就不再刷屏：不管上次结论如何，5 分钟内只问一次。
		      if (hostHalfCheckedAt !== 0 && now - hostHalfCheckedAt < 5 * 60 * 1000) return
		    }
		    hostHalfState = 'checking'
		    hostHalfCheckedAt = now
		    Promise.resolve(fetch(`${PLUGIN_ID}/ping`, { method: 'POST', keepalive: true }))
		      .then(async (response) => {
		        let body = null
		        try {
		          body = await response?.json?.()
		        } catch {
		          body = null
		        }
		        if (disposed) return
		        if (body?.host === PLUGIN_ID) {
		          hostHalfState = 'present'
		          const hostVersion = typeof body.version === 'string' ? body.version : '未知'
		          const skew = hostVersion !== BUNDLE_VERSION
		            ? `（版本不一致：宿主半 v${hostVersion} / 客户端半 v${BUNDLE_VERSION}，重启 DSH 可对齐）`
		            : ''
		          console.info(
		            `[${PLUGIN_ID}] 客户端半 v${BUNDLE_VERSION} ↔ 宿主半 v${hostVersion} 在线`
		            + `（投影键 ${body.projectionKey}）${skew}。`,
		          )
		          return
		        }
		        if (body !== null && typeof body === 'object' && 'error' in body) {
		          // 路由家族在应答，只是不认识 ping：宿主半是旧构建。投影与点击跳转都不受影响。
		          hostHalfState = 'present'
		          console.info(
		            `[${PLUGIN_ID}] 客户端半 v${BUNDLE_VERSION}：宿主半在线但为旧构建（无 ping 动作）；`
		            + '功能不受影响，重启 DSH 可对齐版本',
		          )
		          return
		        }
		        hostHalfState = 'absent'
		        console.warn(
		          `[${PLUGIN_ID}] 宿主半的路由不存在，本插件可能只挂上了客户端半：`
		          + '失败/完成将退化为「一轮结束即完成」',
		        )
		      })
		      .catch((error) => {
		        if (disposed) return
		        // 网络层失败：说明无法确认，而不是确认不在。措辞必须如实。
		        hostHalfState = 'unknown'
		        console.warn(`[${PLUGIN_ID}] 宿主半探活请求失败，无法确认其状态：${String(error)}`)
		      })
		  }

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

		      // 1) 状态栏行。正在看当前会话且窗口聚焦时，当前会话的报错视为已读（不再亮红）。
		      let rows = deriveHubRows({ list: listState, statuses, ackErrors: acks.getSnapshot() })
		      const currentSessionId = currentSessionIdOf(listState)
		      if (currentSessionId !== undefined && isFocused(config)) {
		        const currentError = rows.find((row) => row.id === currentSessionId && row.state === 'error')
		        if (currentError !== undefined) {
		          ackError(currentSessionId, currentError.errorSeq)
		          rows = deriveHubRows({ list: listState, statuses, ackErrors: acks.getSnapshot() })
		        }
		      }
		      lastRows = rows

		      // 2) 任务栏：红 > 黄 > 绿 > 无。
		      pushTaskbar(aggregateTaskbarState(rows))

		      // 3) 通知边沿。
		      const { sessions, projections, hostHalfPresent } = projectListState(listState)
		      if (!hostHalfPresent) checkHostHalf()
		      const result = planNotifications({
		        sessions,
		        projections,
		        statuses,
		        state: watermarks,
		        config,
		        now: Date.now(),
		        focused: isFocused(config),
		        currentSessionId,
		        // 兜底路径只认探活结论：确证宿主半缺失才允许用 running 下降沿当「完成」。
		        allowRunningFallback: hostHalfState === 'absent',
		      })

		      watermarks = result.state
		      schedulePersist()

		      if (result.notes.length > 0) {
		        console.debug(`[${PLUGIN_ID}]`, result.notes)
		      }
		      for (const notification of result.notifications) showNotification(notification)
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
		      writeJson(WATERMARK_KEY, watermarks)
		    }, PERSIST_COALESCE_MS)
		  }

		  /**
		   * 权限为 default 时，等一次用户手势再请求（浏览器要求手势）。
		   * 桌面版已经把通知权限放行，这里只是兜底。
		   */
		  const requestPermissionOnGesture = () => {
		    if (typeof Notification === 'undefined' || typeof window === 'undefined') return
		    if (Notification.permission !== 'default') return
		    const ask = () => {
		      window.removeEventListener('pointerdown', ask, true)
		      window.removeEventListener('keydown', ask, true)
		      try {
		        Promise.resolve(Notification.requestPermission()).catch(() => {})
		      } catch (error) {
		        console.warn(`[${PLUGIN_ID}] 请求通知权限失败`, error)
		      }
		    }
		    window.addEventListener('pointerdown', ask, true)
		    window.addEventListener('keydown', ask, true)
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

		  // ---- 工作区顶部状态栏：官方单占位插槽 ----
		  try {
		    if (typeof ctx.inject === 'function') {
		      ctx.inject(['slots', 'locale'], (scoped) => {
		        try {
		          // 可见文案走 Client locale 服务；没有该服务时组件内部有中文回落。
		          try {
		            scoped.effect(() => scoped.locale.register(PLUGIN_ID, {
		              zh: {
		                label: '会话',
		                idle: '全部空闲',
		                aria: '会话状态：{count} 个需要关注',
		                more: '还有 {count} 个会话',
		                collapse: '收起',
		                'state.answer': '等待回答',
		                'state.error': '报错',
		                'state.running': '运行中',
		                'state.unread': '待查看',
		              },
		              en: {
		                label: 'Sessions',
		                idle: 'All idle',
		                aria: 'Session status: {count} need attention',
		                more: '{count} more Sessions',
		                collapse: 'Collapse',
		                'state.answer': 'Waiting',
		                'state.error': 'Failed',
		                'state.running': 'Running',
		                'state.unread': 'Unread',
		              },
		            }), `${PLUGIN_ID}: locale`)
		          } catch (error) {
		            console.warn(`[${PLUGIN_ID}] 注册状态栏文案失败`, error)
		          }

		          const React = typeof require === 'function' ? require('react') : null
		          if (React === null || typeof React.createElement !== 'function') {
		            console.warn(`[${PLUGIN_ID}] 拿不到 React，状态栏不渲染（通知与任务栏不受影响）`)
		            return
		          }
		          const RailHeader = createSessionHubRail(React, { openSession, ackError, acks }, 'header')
		          const RailChrome = createSessionHubRail(React, { openSession, ackError, acks }, 'chrome')
		          scoped.slots.inject('conversation.header.leading', () => scoped.slots.register({
		            name: 'conversation.header.leading',
		            locale: PLUGIN_ID,
		          }, RailHeader))
		          // Windows 顶栏：菜单后、窗口控件前的 frame-wide 浮动层；Web 端由 CSS 隐藏。
		          scoped.slots.inject('shell.overlay', () => scoped.slots.register({
		            name: 'shell.overlay',
		            id: 'session-hub-chrome',
		            order: 5,
		            locale: PLUGIN_ID,
		          }, RailChrome))
		          ctx.logger?.info?.(`[${PLUGIN_ID}] 状态栏已注册到 conversation.header.leading + shell.overlay`)
		        } catch (error) {
		          console.warn(`[${PLUGIN_ID}] 注册状态栏失败`, error)
		        }
		      })
		    }
		  } catch (error) {
		    console.warn(`[${PLUGIN_ID}] 注入 slots 服务失败`, error)
		  }

		  /** 页面卸载时清掉任务栏状态点，避免红灯留在任务栏上。 */
		  const onPageHide = () => {
		    lastTaskbarState = 'none'
		    pushTaskbar('none', true)
		  }
		  try {
		    if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide)
		  } catch {
		    /* 页面环境异常时忽略 */
		  }

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
		    writeJson(WATERMARK_KEY, watermarks)
		    try {
		      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide)
		    } catch {
		      /* 忽略 */
		    }
		    // 卸载时清掉任务栏状态点（此时 disposed 已置位，必须 force）。
		    pushTaskbar('none', true)
		    if (typeof globalThis !== 'undefined' && globalThis.__DSH_SESSION_HUB__ === diagnostics) {
		      delete globalThis.__DSH_SESSION_HUB__
		    }
		  }, `${PLUGIN_ID}: observers`)

		  requestPermissionOnGesture()

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
		      Object.assign(config, normalizeConfig({ ...config, ...patch }))
		      writeJson(CONFIG_KEY, config)
		      scheduleTick()
		      return { ...config }
		    },
		    /** @returns {object} 当前水位表（只读快照）。 */
		    getWatermarks: () => JSON.parse(JSON.stringify(watermarks)),
		    /** @returns {Array<object>} 当前状态栏行。 */
		    getRows: () => JSON.parse(JSON.stringify(lastRows)),
		    /** @returns {string} 当前聚合任务栏状态。 */
		    getTaskbarState: () => aggregateTaskbarState(lastRows),
		    /** 立刻观察一次（不等合并窗口）。 */
		    tick,
		    /**
		     * 手动设置任务栏状态（排障用；绕过去重）。
		     * @param {string} state red | yellow | green | none。
		     * @returns {string} 传入的状态。
		     */
		    setTaskbarState: (state) => {
		      pushTaskbar(state, true)
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
		      showNotification({
		        sessionId: target,
		        dedupeKey: `test:${Date.now()}`,
		        category: 'answer',
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
		      sessionsTracked: Object.keys(watermarks).length,
		      statusRows: lastRows.length,
		      taskbarState: aggregateTaskbarState(lastRows),
		      desktopShell: isDesktopShell(),
		      /** 宿主半在线状态（由 /ping 判定，与「有没有投影值」无关）。 */
		      hostHalf: hostHalfState,
		    }),
		    /** 主动问一次宿主半在不在（返回 Promise，解析为最终状态）。 */
		    pingHost: async () => {
		      hostHalfCheckedAt = 0
		      checkHostHalf(true)
		      const deadline = Date.now() + 3000
		      while (hostHalfState === 'checking') {
		        if (Date.now() > deadline) break
		        await new Promise((resolve) => setTimeout(resolve, 50))
		      }
		      return hostHalfState
		    },
		    /**
		     * 手动请求宿主半前置窗口（排障用；与点击通知走完全相同的通路）。
		     * @returns {boolean} 是否发起了请求。
		     */
		    raiseWindow: () => {
		      callHostRoute('raise')
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
