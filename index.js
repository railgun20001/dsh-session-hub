/**
 * dsh-session-hub —— 宿主半
 *
 * 宿主半做三件事：
 *
 * 1. **注册 `hubTurnOutcome` 会话投影**，把每个会话「最后一个回合的结束原因」折叠成
 *    一份可持久化、可序列化的小状态：
 *
 *      { outcome, turn, seq, time, code, message }   或   null（还没有任何 turn/end）
 *
 *    客户端用它在状态栏里显示「报错」红点，并据此决定任务栏红灯。
 *
 * 2. **挂载窗口前置路由**（`/raise`、`/warmup`）：通知或状态栏被点击时，渲染进程
 *    没有能力把桌面窗口提到前台（详见 lib/raise-window.js 的说明），由宿主半用
 *    PowerShell + user32 代劳。
 *
 * 3. **挂载任务栏状态路由**（`/taskbar`）：客户端把聚合状态（red / yellow / green /
 *    none）发过来，宿主半用 ITaskbarList3.SetOverlayIcon 在 DSH 的任务栏按钮上画
 *    一个状态点。这是 Electron 主进程没有暴露给渲染进程的能力，只能从宿主半这一侧
 *    通过 Win32 补上（宿主进程是 Electron 主进程的直接子进程，能找到窗口句柄）。
 *
 * ## 为什么需要宿主半
 *
 * 「任务失败」这个事实在客户端是拿不到的：客户端的统一会话状态
 * （`ctx.uiSession.sessionStatus`）只有 `running` / `pendingInteraction` /
 * `completionUnread` 三个事实，没有「上一轮为什么结束」。会话日志里的
 * `turn/end` 事件带 `reason.kind`，但它只在会话被打开（retain）时才有事件流。
 * 会话投影（`ctx.sessionProjections`）是受支持的正解：**所有**会话（含未打开的
 * 冷会话）都由框架驱动折叠，值经三条受支持通道自动到达客户端——
 *   1. 会话列表 RPC（每行的 projections 块 → 客户端 `projectionsBySession`）；
 *   2. `session.projections` RPC（按需读任意会话）；
 *   3. 打开会话时尾页的 projections 基线。
 * 因此客户端不需要 retain 任何会话，也不会因为状态栏而激活别人的历史。
 *
 * 持久性：投影注册表按 (sessionId, key, ver, seq) 落检查点（每次 turn/end 后写），
 * 宿主重启后仍能读到最后一轮结局。
 *
 * ## outcome 取值（取自 dsh-agent-loop 落日志的 turn/end reason.kind）
 *
 *   - `completed`   正常完成
 *   - `blocked`     收件箱为空的良性拒绝（客户端不通知）
 *   - `max-tokens`  达到单步输出上限
 *   - `aborted`     手动中断（reason.reason 携带中断来源）
 *   - `error`       运行失败（reason.error 携带 { code, message }）
 *   - `interrupted` 宿主异常退出后的合成收尾（崩溃恢复）
 *   - `forked`      分叉继承前缀的合成收尾（正常产物）
 *
 * 账号登出特判：聊天视图把「aborted 且中断来源是 deepseek-account/signed-out 钩子」
 * 渲染成 turn-error。为了让状态栏与聊天区同口径，这里做同样的重分类：
 * 记 outcome:"error"、code:"ACCOUNT_SIGNED_OUT"。
 *
 * ## 零依赖
 *
 * 本文件不 import 任何 npm 包。投影框架对 schema 的全部调用面就是 `.parse()`
 * （viewCheckpoint / restore / hydrate / viewCell 路径），因此这里提供一个等价的
 * 极简校验对象，校验语义与内置单元的 zod schema 一致：非法持久行抛错。
 *
 * @module dsh-session-hub
 */

import { createWindowRaiser, resolveTargetProcessId, isOverlayState, WORKER_PROTOCOL } from './lib/raise-window.js'
import { PROJECTION_KEY, ROUTE_PATH } from './src/hub-identity.js'
import { readFileSync } from 'node:fs'

/** 投影键与路由前缀与客户端半共用一份定义（src/hub-identity.js），此处原样再导出。 */
export { PROJECTION_KEY, ROUTE_PATH }

/**
 * 宿主半的构建版本，直接读同目录的 package.json（单一事实来源）。
 *
 * 宿主半只在 DSH 启动或插件重载时加载，客户端半每次刷新页面都会重新取，两半版本
 * 错位是**真实存在的运行状态**。把版本打出来，这类问题就能一眼定位（客户端半还会
 * 把两半版本一起打在控制台）。
 * @type {string}
 */
const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
})()

/** Cordis 插件名（诊断与 patch 行定位用）。 */
export const name = 'session-hub'

/** 硬依赖：没有会话投影注册表就没有可注册的单元。 */
export const inject = ['sessionProjections']

/** turn/end reason.kind 的全集。 */
const OUTCOME_KINDS = new Set([
  'completed',
  'blocked',
  'max-tokens',
  'aborted',
  'error',
  'interrupted',
  'forked',
])

/** 错误 message 的截断上限（状态栏 / 通知正文里也没必要超过这个长度）。 */
const MESSAGE_LIMIT = 200

/** 账号登出钩子的稳定标识：与聊天区 turn-error 的判据一一对应。 */
const ACCOUNT_SIGNED_OUT = 'ACCOUNT_SIGNED_OUT'

/**
 * 会话投影键与路由前缀。
 *
 * 这两个字符串与客户端半共用同一份定义（`src/hub-identity.js`），本文件只做 re-export，
 * 不再各自写一份字面量——以前注释写着「两半共用这一个字符串」，实际却是两处字面量。
 *
 * 路由的调用约定：客户端用**文档相对**路径请求（`dsh-session-hub/...`，不带前导斜杠）：
 * 桌面端页面是 `dsh-app://app/`，其非静态路径会被 shell 同源转发到宿主；Web 端页面带
 * `<base href="./">`，相对路径能正确落在部署前缀下（与 dsh-client-ui-skill-explorer
 * 的 `api/...` 同款约定）。
 */

/** 单次 taskbar 请求体上限：只接受 `{"state":"red"}` 这种几十字节的 JSON。 */
const MAX_BODY_BYTES = 1024

/**
 * 造一个路由处理器：只认 POST，永远快速返回，绝不因为前置/任务栏失败而报错。
 *
 * - `POST <前缀>/ping`    ：宿主半在线探针（无副作用）；
 * - `POST <前缀>/debug`   ：只读诊断：投影键是否注册、每个在挂会话的投影键与当前值；
 * - `POST <前缀>/raise`   ：把桌面窗口提到前台（通知 / 状态栏被点击时由客户端调用）；
 * - `POST <前缀>/warmup`  ：只预热 PowerShell worker（把 Add-Type 的编译时间提前付掉）；
 * - `POST <前缀>/taskbar` ：设置 / 清除任务栏状态点，body `{ "state": "red|yellow|green|none" }`。
 * 其他方法与路径一律 404/405。
 *
 * @param {{
 *   raise: (pid: number) => boolean,
 *   warmup: () => boolean,
 *   overlay: (state: string, pid: number) => boolean,
 *   isRunning?: () => boolean,
 *   overlayState?: () => string,
 * }} raiser 窗口前置 / 任务栏状态器。
 * @param {(() => object) | undefined} [diagnostics] 只读诊断回调。
 * @returns {(req: object, res: object) => void} node:http 处理器。
 */
export function createRouteHandler(raiser, diagnostics) {
  return (req, res) => {
    const url = typeof req.url === 'string' ? req.url : ''
    const action = url.startsWith(`${ROUTE_PATH}/`)
      ? url.slice(ROUTE_PATH.length + 1).split('?')[0]
      : ''

    if (req.method !== 'POST') {
      respond(res, 405, { error: 'method-not-allowed' })
      return
    }

    if (action === 'ping') {
      req.resume?.()
      respond(res, 200, {
        host: name,
        version: VERSION,
        projectionKey: PROJECTION_KEY,
        raiserRunning: raiser.isRunning?.() === true,
        overlayState: raiser.overlayState?.() ?? 'none',
        workerProtocol: WORKER_PROTOCOL,
      })
      return
    }
    if (action === 'debug') {
      req.resume?.()
      let body
      try {
        body = diagnostics?.()
      } catch (error) {
        body = { error: `diagnostics failed: ${String(error)}` }
      }
      respond(res, 200, body ?? { error: 'diagnostics-unavailable' })
      return
    }
    if (action === 'warmup') {
      req.resume?.()
      respond(res, 200, { warm: raiser.warmup() === true })
      return
    }
    if (action === 'raise') {
      req.resume?.()
      const target = resolveTargetProcessId()
      if (target === undefined) {
        respond(res, 503, { raised: false, reason: 'no-parent-process' })
        return
      }
      respond(res, 200, { raised: raiser.raise(target) === true })
      return
    }
    if (action === 'taskbar') {
      const target = resolveTargetProcessId()
      readJsonBody(req, (error, body) => {
        if (error !== null) {
          respond(res, error === 'too-large' ? 413 : 400, { ok: false, reason: error })
          return
        }
        const state = body?.state
        if (!isOverlayState(state)) {
          respond(res, 400, { ok: false, reason: 'invalid-state' })
          return
        }
        if (target === undefined) {
          respond(res, 503, { ok: false, reason: 'no-parent-process' })
          return
        }
        respond(res, 200, { ok: raiser.overlay(state, target) === true, state })
      })
      return
    }
    req.resume?.()
    respond(res, 404, { error: 'unknown-action' })
  }
}

/**
 * 读取一个小 JSON 请求体。
 * @param {object} req node:http 请求。
 * @param {(error: string|null, body: object|undefined) => void} done 回调。
 */
function readJsonBody(req, done) {
  const chunks = []
  let size = 0
  let settled = false
  const finish = (error, body) => {
    if (settled) return
    settled = true
    done(error, body)
  }
  req.on?.('data', (chunk) => {
    if (settled) return
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      finish('too-large', undefined)
      try {
        req.destroy?.()
      } catch {
        /* 已经断开 */
      }
      return
    }
    chunks.push(chunk)
  })
  req.on?.('error', () => finish('read-error', undefined))
  req.on?.('end', () => {
    if (settled) return
    try {
      const text = Buffer.concat(chunks).toString('utf8')
      const body = text === '' ? {} : JSON.parse(text)
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        finish('invalid-json', undefined)
        return
      }
      finish(null, body)
    } catch {
      finish('invalid-json', undefined)
    }
  })
}

/**
 * 写一个 JSON 响应。
 * @param {object} res node:http 响应对象。
 * @param {number} status HTTP 状态码。
 * @param {object} body JSON 体。
 */
function respond(res, status, body) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  } catch {
    /* 连接已经断了：忽略 */
  }
}

/**
 * 把任意输入截成有界字符串；非字符串或空串返回 null。
 * @param {unknown} value 原始值。
 * @returns {string|null} 截断后的字符串或 null。
 */
function boundedString(value) {
  if (typeof value !== 'string' || value === '') return null
  return value.length > MESSAGE_LIMIT ? `${value.slice(0, MESSAGE_LIMIT)}…` : value
}

/**
 * 校验并原样返回一份 hubTurnOutcome 状态（给投影框架的极简 schema 面）。
 * @param {unknown} value 待校验的持久值或内存值。
 * @returns {object|null} 原值（校验通过）或 null。
 * @throws {Error} 形状非法时抛错，与内置单元的 zod schema 行为一致。
 */
function parseHubTurnOutcome(value) {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('hubTurnOutcome: 状态必须是对象或 null')
  }
  const state = value
  if (!OUTCOME_KINDS.has(state.outcome)) {
    throw new Error(`hubTurnOutcome: 非法的 outcome "${String(state.outcome)}"`)
  }
  if (!Number.isInteger(state.turn) || state.turn < 0) {
    throw new Error('hubTurnOutcome: turn 必须是非负整数')
  }
  if (!Number.isInteger(state.seq) || state.seq < 0) {
    throw new Error('hubTurnOutcome: seq 必须是非负整数')
  }
  if (!Number.isInteger(state.time) || state.time < 0) {
    throw new Error('hubTurnOutcome: time 必须是非负整数（epoch 毫秒）')
  }
  if (state.code !== null && typeof state.code !== 'string') {
    throw new Error('hubTurnOutcome: code 必须是字符串或 null')
  }
  if (state.message !== null && typeof state.message !== 'string') {
    throw new Error('hubTurnOutcome: message 必须是字符串或 null')
  }
  return state
}

/** 极简 schema 对象；框架只调用 .parse()。parse 单独导出便于单测复用。 */
export const hubTurnOutcomeSchema = { parse: parseHubTurnOutcome }

/**
 * 投影折叠函数（纯函数，单独导出便于单测）。
 *
 * 规则：
 *   - 只关心 `turn/end`，其余事件原样返回旧引用（变更按引用相等判定）；
 *   - `reason` 缺失或形状不对时保持旧状态；
 *   - 同一 seq 的重放幂等（直接返回旧引用）；
 *   - 账号登出的 aborted 按聊天区口径重分类为 error。
 * @param {object|null} state 折叠前状态。
 * @param {object} event 已提交的会话事件（含 type/seq/time/data）。
 * @returns {object|null} 新状态，或旧引用。
 */
export function foldHubTurnOutcome(state, event) {
  if (event.type !== 'turn/end') return state
  const reason = event.data?.reason
  if (reason === null || typeof reason !== 'object') return state
  const kind = reason.kind
  if (!OUTCOME_KINDS.has(kind)) return state
  if (state !== null && state.seq === event.seq) return state

  let outcome = kind
  let code = null
  let message = null
  if (kind === 'error') {
    const failure = reason.error
    if (failure !== null && typeof failure === 'object') {
      code = typeof failure.code === 'string' ? failure.code : null
      message = boundedString(failure.message)
    }
  } else if (kind === 'aborted') {
    const cause = reason.reason
    if (cause !== null && typeof cause === 'object'
      && cause.kind === 'hook' && cause.reason === 'deepseek-account/signed-out') {
      outcome = 'error'
      code = ACCOUNT_SIGNED_OUT
    }
  }

  return {
    outcome,
    turn: event.data.turn,
    seq: event.seq,
    time: event.time,
    code,
    message,
  }
}

/**
 * Cordis 插件入口：注册 `hubTurnOutcome` 投影单元，并在宿主 HTTP 上挂内部路由，
 * 供客户端半探活（ping）、排障（debug）、前置窗口（raise）与更新任务栏（taskbar）。
 *
 * stateVersion 从 1 起：将来改动状态形状必须递增（注册表拒绝在同一键上共享不同
 * stateVersion 的单元）。
 * @param {object} ctx Cordis 上下文（注入了 ctx.sessionProjections）。
 */
export function apply(ctx) {
  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: hubTurnOutcomeSchema,
    init: () => null,
    apply: foldHubTurnOutcome,
    // wire 视图与状态同形：状态本身已经是最小事实，不需要再裁剪。
    wire: {
      viewSchema: hubTurnOutcomeSchema,
      view: (state) => state,
    },
  })
  ctx.logger?.info(`[session-hub] 宿主半 v${VERSION} 已加载：会话投影 ${PROJECTION_KEY} 已注册`)

  // ---- 窗口前置 + 任务栏：渲染进程够不到 user32/shell32，只能由宿主半代劳 ----
  const raiser = createWindowRaiser({
    onWarn: (message, error) => ctx.logger?.warn?.(`${message}${error === undefined ? '' : `：${String(error)}`}`),
  })
  ctx.effect(() => () => {
    // 卸载时先清掉任务栏状态点，再关 worker：否则插件被禁用后红灯会留在任务栏上。
    const target = resolveTargetProcessId()
    if (target !== undefined) raiser.overlay('none', target)
    raiser.dispose()
  }, 'session-hub: window raiser')

  /** 只读诊断：投影键是否真的注册进了客户端可见集合，以及每个在挂会话当前的值。 */
  const diagnostics = () => {
    const sessions = ctx.get?.('sessions')
    const attached = typeof sessions?.list === 'function' ? sessions.list() : []
    const rows = []
    for (const session of attached.slice(0, 25)) {
      const row = { id: session?.id }
      try {
        const cut = ctx.sessionProjections.snapshot(session)
        row.registered = Object.hasOwn(cut.values, PROJECTION_KEY)
        row.value = cut.values[PROJECTION_KEY] ?? null
      } catch (error) {
        row.error = String(error)
      }
      try {
        row.cached = Object.hasOwn(ctx.sessionProjections.cachedSnapshot(session).values, PROJECTION_KEY)
      } catch {
        row.cached = null
      }
      rows.push(row)
    }
    return {
      hostHalf: true,
      plugin: name,
      version: VERSION,
      projectionKey: PROJECTION_KEY,
      attachedSessions: attached.length,
      rows,
      raiserRunning: raiser.isRunning?.() === true,
      overlayState: raiser.overlayState?.() ?? 'none',
      workerProtocol: WORKER_PROTOCOL,
    }
  }

  // webServer 是软依赖：没有它（例如纯 headless 组合）时通知照常工作，只是点击不前置窗口。
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: createRouteHandler(raiser, diagnostics),
    }), 'session-hub: routes')
    ctx.logger?.info(`[session-hub] 宿主半 v${VERSION}：内部路由 ${ROUTE_PATH}（ping/debug/warmup/raise/taskbar）已挂载`)
  })
}

export default { name, inject, apply }
