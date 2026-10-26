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
export const SESSION_ROW_PREFIX = 'session:'

/** 工作区分组行 `data-row-key` 的前缀。 */
export const WORKSPACE_ROW_PREFIX = 'workspace:'

/**
 * 跳转后等待侧栏渲染出目标会话行的上限（毫秒）。
 *
 * 点一下 chip 后列表要等 React 提交、必要时还要先抬高 watermark 才渲染目标行，
 * 所以不是同步可见的；1.5 秒足够覆盖正常渲染，超过就静默放弃（绝不长时间占用帧）。
 */
export const REVEAL_RETRY_TIMEOUT_MS = 1500

/**
 * 揭示重试的最大帧数。
 *
 * 与 {@link REVEAL_RETRY_TIMEOUT_MS} 取先到者：文档很大时每次重试都要扫一遍
 * `[data-row-key]`，40 帧（约 0.7 秒 @60fps）已足够覆盖正常渲染，再等只是浪费。
 */
export const REVEAL_MAX_ATTEMPTS = 40

/**
 * 按 `data-row-key` 精确定位一行。
 * @param {Document|object|null} doc 文档（真实 DOM 或测试桩）。
 * @param {string} key 目标 `data-row-key` 的完整值。
 * @returns {Element|null} 命中的行元素；文档或行不存在时为 null。
 */
export function findRowByKey(doc, key) {
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
export function findSessionRow(doc, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  return findRowByKey(doc, `${SESSION_ROW_PREFIX}${sessionId}`)
}

/**
 * 找到某个工作区的分组行。
 * @param {Document|object|null} doc 文档。
 * @param {string} workspaceId 工作区 id；空串表示官方的「未分组」桶。
 * @returns {Element|null} 分组行；不存在时为 null。
 */
export function findWorkspaceRow(doc, workspaceId) {
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
export function owningWorkspaceIdOf(snapshot, sessionId) {
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
export function scrollSessionRowIntoView(doc, sessionId, context = {}) {
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
export function createRowRevealer({
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
