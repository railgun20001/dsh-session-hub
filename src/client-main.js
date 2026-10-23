/**
 * dsh-session-hub —— 客户端半（浏览器 bundle 的 factory 体）
 *
 * 职责：
 *   1. 从 DSH 受支持的服务读「会话事实」（会话列表 + 统一会话状态 + 宿主投影）；
 *   2. 交给纯逻辑模型 `deriveHubRows` 推导状态栏行，交给 `planNotifications` 算通知边沿；
 *   3. 注册 `conversation.header.leading` 插槽，在工作区上方显示会话状态栏；
 *   4. 把聚合状态发给宿主半，由宿主半用 ITaskbarList3 标记任务栏图标（红/黄/绿）；
 *   5. 状态变化时弹 Windows 系统通知；点击通知 / 状态栏条目跳转到对应会话，
 *      并把左侧会话列表也滚动到该会话行（官方 openSession 只切换主视图，不滚动列表）。
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
   * 每次跳转的「列表揭示」序号：新跳转让旧的等待循环立刻退出。
   *
   * 连续点几个 chip 时，前几次的重试循环不能把列表再拉回旧会话——只认最新一次。
   */
  let revealSequence = 0

  /**
   * 在下一帧再试一次（优先 rAF，没有时退回定时器）。
   * @param {() => void} callback 回调。
   */
  const scheduleRevealAttempt = (callback) => {
    try {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(callback)
        return
      }
    } catch {
      /* 某些宿主没有 rAF：退回定时器 */
    }
    setTimeout(callback, 16)
  }

  /**
   * 跳转会话后把左侧会话列表也滚动到对应行。
   *
   * ## 为什么需要
   *
   * 官方 ui-workspace 的列表 reveal（展开分组 + `scrollIntoView`）只挂在侧栏**搜索结果
   * 点击**上；公开的 `uiWorkspace.openSession()` 只切换主视图，长列表里目标行可能在
   * 视野外，用户点状态栏 chip / 通知跳过去后左侧看不出变化。这里补一次「滚到行」，
   * 并把目标行尽量滚到列表垂直居中（见 `scrollSessionRowIntoView`）。
   *
   * ## 时序与退让
   *
   * 跳转先改当前会话，列表要等 React 提交后才会（必要时先抬高 watermark 再）渲染
   * 目标行，所以用 rAF 重试到 {@link REVEAL_RETRY_TIMEOUT_MS}；会话行始终找不到时，
   * 退化到它所属的工作区分组行（分组折叠时只有组标题在 DOM 里）。整个过程只读 DOM，
   * 任何异常都吞掉——滚动绝不应当影响跳转本身。
   *
   * @param {string} sessionId 目标会话。
   */
  const revealSessionInList = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (typeof document === 'undefined') return
    const sequence = (revealSequence += 1)
    const deadline = Date.now() + REVEAL_RETRY_TIMEOUT_MS
    let attempts = 0
    const attempt = () => {
      if (disposed || sequence !== revealSequence) return
      let hit = null
      try {
        // 工作区归属只用于「会话行不在 DOM」时的退化查找；服务缺失时传 undefined。
        const workspaceService = safeGet('uiWorkspace')
        const workspaces = workspaceService?.workspaces?.list?.getSnapshot?.()
        hit = scrollSessionRowIntoView(document, sessionId, { workspaces })
      } catch (error) {
        console.debug(`[${PLUGIN_ID}] 滚动会话列表失败`, error)
        return
      }
      if (hit !== null) return
      attempts += 1
      if (attempts >= REVEAL_MAX_ATTEMPTS) return
      if (Date.now() >= deadline) return
      scheduleRevealAttempt(attempt)
    }
    attempt()
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
                'row.failed': '本轮失败',
                'row.interrupted': '本轮中断',
                'row.hint': '该会话最后一轮没有正常结束',
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
                'row.failed': 'Last turn failed',
                'row.interrupted': 'Last turn interrupted',
                'row.hint': 'The last turn of this Session did not finish normally',
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
          // 会话行悬停卡片：补一行「本轮失败/中断」，解释官方行首那个绿色「已完成」点
          // 为什么会出现在失败会话上（官方行状态机没有失败态，插件改不了行首点）。
          const RowHint = createSessionHubRowHint(React, { acks })
          scoped.slots.inject('sidebar.session.row.hover', () => scoped.slots.register({
            name: 'sidebar.session.row.hover',
            id: 'session-hub-failure',
            order: 10,
            locale: PLUGIN_ID,
          }, RowHint))
          ctx.logger?.info?.(`[${PLUGIN_ID}] 状态栏已注册到 conversation.header.leading + shell.overlay + sidebar.session.row.hover`)
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
