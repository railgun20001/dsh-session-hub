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
export const DEFAULT_CONFIG = Object.freeze({
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
  /** 点击通知时请求宿主半把桌面窗口提到前台（见 lib/raise-window.js）。 */
  raiseWindow: true,
  /** 水位表保留条数上限（按 updatedAt 新的优先）。 */
  maxRememberedSessions: 300,
})

/** 三类「需要你回应」的待交互（与 dsh-client-ui-workspace 的 visiblePendingKind 同口径）。 */
export const PENDING_KINDS = Object.freeze(['approval', 'plan-review', 'question'])

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
export const STATE_VERSION = 1

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
export function normalizeConfig(raw) {
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
export function classifyOutcome(outcome) {
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
export function categoryEnabled(category, config) {
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
export function shouldSilence({ focused, isCurrent, config }) {
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
export function describeNotification({ category, title, projection, pending }) {
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
 * @returns {{notifications: Array<object>, state: object, notes: Array<string>, completions: Array<object>}}
 *   通知列表、新水位、诊断说明（用于调试与单测断言）、以及本次观测到的**回合完成边沿**
 *   （`{ sessionId, seq, time, category }`，与通知开关/静默无关）。
 */
export function planNotifications(input) {
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
