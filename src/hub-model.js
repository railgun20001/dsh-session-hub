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
export const HUB_PENDING_KINDS = Object.freeze(['approval', 'plan-review', 'question'])

/**
 * 状态排序：数字越小越靠前。
 *
 * 顺序刻意与颜色一致——**红（报错）> 黄（等待回答）> 绿（待查看）> 蓝（运行中）**：
 * 一眼扫过去就是「先看红的、最后才看还在跑的」，也和任务栏点灯的优先级同源。
 * 注意这只是**显示顺序**，不是状态判定顺序（判定见 deriveHubRows：
 * 等待回答 > 报错 > 运行中 > 待查看，同时在等你时优先按「等待回答」显示）。
 */
export const STATE_ORDER = Object.freeze({
  error: 0,
  answer: 1,
  unread: 2,
  running: 3,
})

/** 状态的中文短标签（状态栏 chip 与通知调试用）。 */
export const STATE_LABELS = Object.freeze({
  answer: '等待回答',
  error: '报错',
  running: '运行中',
  unread: '待查看',
})

/** 归到「报错」的回合结局。interrupted 是宿主异常退出后的合成收尾。 */
export const HUB_FAILURE_OUTCOMES = Object.freeze(['error', 'interrupted'])

/** 状态栏最多渲染多少行（防止极端情况下渲染上千个 chip）。 */
export const MAX_HUB_ROWS = 40

/**
 * 取会话展示标题。
 * @param {object} row 会话列表行。
 * @returns {string} 标题；都没有时回落到 id。
 */
export function hubTitleOf(row) {
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
export function currentSessionIdOf(list) {
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
export function projectionOf(list, id) {
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
export function isUnackedFailure(projection, ackedSeq) {
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
export function hasLocalUnread(localUnread, id) {
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
export function normalizeSeqMap(value) {
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
export const normalizeLocalUnread = normalizeSeqMap

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
export function deriveHubRows({
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
export function aggregateTaskbarState(rows) {
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
export function failureKindOf(projection, ackedSeq) {
  if (!isUnackedFailure(projection, ackedSeq)) return null
  return projection.outcome === 'interrupted' ? 'interrupted' : 'error'
}

/**
 * 归一化持久化的报错确认表：只保留整数 seq，丢掉坏值。
 *
 * 实现见 {@link normalizeSeqMap}（与「后台完成」记账共用一份）。
 * @type {(value: unknown) => object}
 */
export const normalizeAckErrors = normalizeSeqMap
