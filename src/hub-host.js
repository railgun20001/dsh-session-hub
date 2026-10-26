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
export const HOST_HALF_RECHECK_MS = 5 * 60 * 1000

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
export function createHostBridge({
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
   * 发一个「不需要看响应」的 POST（文档相对路径：桌面端由 shell 同源转发，Web 端落在
   * 部署前缀下）。
   * @param {string} path 相对路径，例如 `dsh-session-hub/raise`。
   * @param {RequestInit} [init] 额外请求参数。
   * @returns {void}
   */
  const post = (path, init) => {
    try {
      if (typeof fetchImpl !== 'function') return
      Promise.resolve(fetchImpl(path, { method: 'POST', keepalive: true, ...init })).catch(() => {})
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
        pending = Promise.resolve(fetchImpl(`${pluginId}/ping`, { method: 'POST', keepalive: true }))
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
