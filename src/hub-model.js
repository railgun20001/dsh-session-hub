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
export const HUB_PENDING_KINDS = Object.freeze(['approval', 'plan-review', 'question'])

/** 状态排序：数字越小越靠前（也越"需要人"）。 */
export const STATE_ORDER = Object.freeze({
  answer: 0,
  error: 1,
  running: 2,
  unread: 3,
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
export function deriveHubRows({ list, statuses, ackErrors = {}, includeSubagents = false, now = 0 } = {}) {
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
export function aggregateTaskbarState(rows) {
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
export function normalizeAckErrors(value) {
  const out = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [id, seq] of Object.entries(value)) {
    if (typeof id === 'string' && id !== '' && Number.isInteger(seq) && seq >= 0) out[id] = seq
  }
  return out
}
