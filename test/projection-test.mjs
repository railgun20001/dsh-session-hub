/**
 * 宿主半（hubTurnOutcome 投影 + 路由）单测。
 *
 * 运行：node --test test/projection-test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  apply,
  createRouteHandler,
  foldHubTurnOutcome,
  hubTurnOutcomeSchema,
  inject,
  name,
  PROJECTION_KEY,
  ROUTE_PATH,
} from '../index.js'
import { resolveTargetProcessId } from '../lib/raise-window.js'

/** 读 package.json 的 version，作为两半版本标识的单一事实来源。 */
function packageVersion() {
  const here = dirname(fileURLToPath(import.meta.url))
  return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version
}

/** 构造一个 turn/end 事件。 */
function turnEndEvent(kind, seq = 4, extra = {}) {
  return {
    type: 'turn/end',
    seq,
    time: 1_700_000_000_000,
    data: { turn: 2, reason: { kind, ...extra } },
  }
}

test('插件声明了会话投影依赖', () => {
  assert.equal(name, 'session-hub')
  assert.deepEqual(inject, ['sessionProjections'])
  assert.equal(PROJECTION_KEY, 'hubTurnOutcome')
})

test('只关心 turn/end：其他事件保持旧引用', () => {
  const state = { outcome: 'completed', turn: 1, seq: 3, time: 1, code: null, message: null }
  const same = foldHubTurnOutcome(state, { type: 'turn/start', seq: 4, time: 2, data: { turn: 2 } })
  assert.equal(same, state)
})

test('completed 折叠出完整状态', () => {
  const state = foldHubTurnOutcome(null, turnEndEvent('completed'))
  assert.deepEqual(state, {
    outcome: 'completed',
    turn: 2,
    seq: 4,
    time: 1_700_000_000_000,
    code: null,
    message: null,
  })
})

test('error 带出错误码与信息', () => {
  const state = foldHubTurnOutcome(null, turnEndEvent('error', 9, {
    error: { code: 'LLM_REQUEST_FAILED', message: '连接被重置' },
  }))
  assert.equal(state.outcome, 'error')
  assert.equal(state.code, 'LLM_REQUEST_FAILED')
  assert.equal(state.message, '连接被重置')
})

test('error 缺字段时退化为 null', () => {
  const state = foldHubTurnOutcome(null, turnEndEvent('error', 9, { error: null }))
  assert.equal(state.code, null)
  assert.equal(state.message, null)
})

test('账号登出钩子触发的 aborted 重分类为 error', () => {
  const state = foldHubTurnOutcome(null, turnEndEvent('aborted', 5, {
    reason: { kind: 'hook', reason: 'deepseek-account/signed-out' },
  }))
  assert.equal(state.outcome, 'error')
  assert.equal(state.code, 'ACCOUNT_SIGNED_OUT')
})

test('普通手动中断保持 aborted', () => {
  const state = foldHubTurnOutcome(null, turnEndEvent('aborted', 5, {
    reason: { kind: 'user', reason: 'stop-button' },
  }))
  assert.equal(state.outcome, 'aborted')
  assert.equal(state.code, null)
})

test('崩溃恢复的 interrupted 与分叉的 forked 原样记录', () => {
  assert.equal(foldHubTurnOutcome(null, turnEndEvent('interrupted', 6)).outcome, 'interrupted')
  assert.equal(foldHubTurnOutcome(null, turnEndEvent('forked', 7)).outcome, 'forked')
})

test('reason 缺失或形状不对时保持旧状态', () => {
  const state = { outcome: 'completed', turn: 1, seq: 3, time: 1, code: null, message: null }
  assert.equal(foldHubTurnOutcome(state, { type: 'turn/end', seq: 8, time: 2, data: {} }), state)
  assert.equal(foldHubTurnOutcome(state, { type: 'turn/end', seq: 8, time: 2, data: { reason: 'nope' } }), state)
  assert.equal(foldHubTurnOutcome(state, turnEndEvent('未知结局', 8)), state)
})

test('同一 seq 重放幂等', () => {
  const first = foldHubTurnOutcome(null, turnEndEvent('completed', 4))
  const replay = foldHubTurnOutcome(first, turnEndEvent('error', 4, { error: { code: 'X', message: 'y' } }))
  assert.equal(replay, first)
})

test('超长错误信息被截断', () => {
  const long = 'x'.repeat(500)
  const state = foldHubTurnOutcome(null, turnEndEvent('error', 9, { error: { code: 'X', message: long } }))
  assert.equal(state.message.length, 201)
  assert.equal(state.message.endsWith('…'), true)
})

test('schema 接受合法状态并拒绝非法形状', () => {
  const good = { outcome: 'completed', turn: 0, seq: 0, time: 0, code: null, message: null }
  assert.equal(hubTurnOutcomeSchema.parse(good), good)
  assert.equal(hubTurnOutcomeSchema.parse(null), null)
  assert.throws(() => hubTurnOutcomeSchema.parse({ ...good, outcome: '瞎写' }), /非法的 outcome/)
  assert.throws(() => hubTurnOutcomeSchema.parse({ ...good, seq: -1 }), /seq/)
  assert.throws(() => hubTurnOutcomeSchema.parse({ ...good, code: 5 }), /code/)
  assert.throws(() => hubTurnOutcomeSchema.parse([good]), /对象或 null/)
})

test('状态可 JSON 往返', () => {
  const state = foldHubTurnOutcome(null, turnEndEvent('error', 11, { error: { code: 'A', message: 'B' } }))
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state)
})

test('apply 向注册表注册一个 stateVersion 为 1 的单元，并挂上路由', () => {
  let registered = null
  let routeRegistered = null
  let injectedDeps = null
  const disposers = []
  const ctx = {
    sessionProjections: { register: (definition) => { registered = definition } },
    logger: { info: () => {}, warn: () => {} },
    effect: (callback) => { disposers.push(callback()) },
    inject: (deps, callback) => {
      injectedDeps = deps
      callback({
        effect: (inner) => { disposers.push(inner()) },
        webServer: {
          register: (route) => {
            routeRegistered = route
            return () => {}
          },
        },
      })
    },
  }
  apply(ctx)
  assert.equal(registered.key, 'hubTurnOutcome')
  assert.equal(registered.stateVersion, 1)
  assert.equal(registered.init(), null)
  assert.equal(registered.apply, foldHubTurnOutcome)
  assert.equal(registered.wire.viewSchema, hubTurnOutcomeSchema)

  // webServer 是软依赖：不能进硬 inject（否则没有 web 服务器的组合整插件不激活）。
  assert.deepEqual(inject, ['sessionProjections'])
  assert.deepEqual(injectedDeps, ['webServer'])
  assert.equal(routeRegistered.kind, 'prefix')
  assert.equal(routeRegistered.path, ROUTE_PATH)
  assert.equal(typeof routeRegistered.handler, 'function')

  // 卸载时应当把前置器一起收拾掉。
  assert.equal(disposers.length, 2)
  for (const dispose of disposers) dispose()
})

/**
 * 构造一次路由调用。
 * @param {object} handler 路由处理器。
 * @param {string} method HTTP 方法。
 * @param {string} url 路径。
 * @param {object|undefined} body 请求体（提供时触发 data/end）。
 * @returns {object} 捕获到的 status/headers/body。
 */
function callRoute(handler, method, url, body) {
  const captured = {}
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.resume = () => {}
  req.destroy = () => {}
  const res = {
    writeHead: (status, headers) => { captured.status = status; captured.headers = headers },
    end: (payload) => { captured.body = payload === undefined ? undefined : JSON.parse(payload) },
  }
  handler(req, res)
  if (body !== undefined) {
    req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    req.emit('end')
  }
  return captured
}

test('路由只认 POST，ping / debug / raise / warmup / taskbar / 未知动作各有明确回应', () => {
  const calls = []
  const raiser = {
    warmup: () => { calls.push('warmup'); return true },
    raise: (pid) => { calls.push(`raise:${pid}`); return true },
    overlay: (state, pid) => { calls.push(`overlay:${state}:${pid}`); return true },
    isRunning: () => false,
    overlayState: () => 'none',
  }
  const handler = createRouteHandler(raiser, () => ({ hostHalf: true, marked: 'diagnostics' }))

  const ping = callRoute(handler, 'POST', '/dsh-session-hub/ping')
  assert.equal(ping.status, 200)
  assert.equal(ping.body.host, 'session-hub')
  assert.equal(ping.body.projectionKey, 'hubTurnOutcome')
  assert.equal(ping.body.raiserRunning, false)
  assert.equal(ping.body.overlayState, 'none')
  // 版本必须与 package.json 一致（宿主半运行时读的就是它），否则两半版本标识会失真。
  assert.equal(ping.body.version, packageVersion())

  const debug = callRoute(handler, 'POST', '/dsh-session-hub/debug')
  assert.equal(debug.status, 200)
  assert.deepEqual(debug.body, { hostHalf: true, marked: 'diagnostics' })

  const raise = callRoute(handler, 'POST', '/dsh-session-hub/raise')
  assert.equal(raise.status, 200)
  assert.equal(raise.body.raised, true)
  assert.equal(calls[0], `raise:${resolveTargetProcessId()}`)

  const warm = callRoute(handler, 'POST', '/dsh-session-hub/warmup')
  assert.equal(warm.status, 200)
  assert.deepEqual(warm.body, { warm: true })

  const taskbar = callRoute(handler, 'POST', '/dsh-session-hub/taskbar', { state: 'red' })
  assert.equal(taskbar.status, 200)
  assert.deepEqual(taskbar.body, { ok: true, state: 'red' })
  assert.equal(calls[calls.length - 1], `overlay:red:${resolveTargetProcessId()}`)

  const invalid = callRoute(handler, 'POST', '/dsh-session-hub/taskbar', { state: 'purple' })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.reason, 'invalid-state')

  const bad = callRoute(handler, 'POST', '/dsh-session-hub/nope')
  assert.equal(bad.status, 404)
  assert.equal(bad.body.error, 'unknown-action')

  const method = callRoute(handler, 'GET', '/dsh-session-hub/raise')
  assert.equal(method.status, 405)
  assert.equal(method.body.error, 'method-not-allowed')

  // 查询串不影响动作解析。
  const query = callRoute(handler, 'POST', '/dsh-session-hub/raise?x=1')
  assert.equal(query.status, 200)

  // 诊断回调抛异常也不能把路由打挂。
  const captured = callRoute(createRouteHandler(raiser, () => { throw new Error('诊断炸了') }),
    'POST', '/dsh-session-hub/debug')
  assert.match(captured.body.error, /diagnostics failed/)
})
