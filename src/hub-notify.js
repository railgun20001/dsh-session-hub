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
export const CROSS_TAB_WINDOW_MS = 4000

/** 通知结果诊断日志保留条数（环形，只留最近若干条）。 */
export const NOTIFY_LOG_LIMIT = 20

/**
 * 等待通知回执事件的上限（毫秒）。
 *
 * 超过这个时间 `show` / `failed` 都没来，记成 `no-event`。**它只表示「没等到回执」，
 * 不表示「没显示」**：也可能显示了但回执没派发。因此 `no-event` 只能当「未知」看，
 * 绝不能用它去判定失败或触发重发——那会在已经显示过的通知上再补一条重复的。
 * 真正要确认「到没到系统」，查 Windows 的
 * `Microsoft-Windows-PushNotification-Platform/Operational` 有没有 2416。
 */
export const NOTIFY_SHOW_TIMEOUT_MS = 2500

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
export function shortToastTag(identity) {
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
export function createNotifySink({
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
