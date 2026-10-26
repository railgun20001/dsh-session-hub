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
export function registerHubSlots({ ctx, pluginId, deps }) {
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
