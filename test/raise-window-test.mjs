/**
 * 宿主半「窗口前置 + 任务栏状态点」worker 协议单测。
 *
 * 运行：node --test test/raise-window-test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  DEFAULT_IDLE_SHUTDOWN_MS,
  OVERLAY_STATES,
  WORKER_SCRIPT,
  createWindowRaiser,
  isOverlayState,
  resolveTargetProcessId,
} from '../lib/raise-window.js'

/**
 * 造一个假的 child_process 进程。
 * @returns {object} 假进程与它的写入记录。
 */
function fakeChild() {
  const child = new EventEmitter()
  child.writes = []
  child.ended = false
  child.killed = false
  child.stdin = {
    write: (chunk) => { child.writes.push(chunk) },
    end: () => { child.ended = true },
  }
  child.stdout = new EventEmitter()
  child.kill = () => { child.killed = true }
  return child
}

/**
 * 造一个 spawn 桩，并记录每次调用。
 * @returns {{spawn: Function, calls: object[], children: object[]}} 桩。
 */
function spawnStub() {
  const calls = []
  const children = []
  const spawn = (command, args, options) => {
    const child = fakeChild()
    children.push(child)
    calls.push({ command, args, options })
    return child
  }
  return { spawn, calls, children }
}

test('worker 脚本用 UTF-16LE base64 投递给 -EncodedCommand（不落临时文件）', () => {
  const stub = spawnStub()
  const raiser = createWindowRaiser({ spawn: stub.spawn })
  assert.equal(raiser.warmup(), true)
  const { args, options } = stub.calls[0]
  assert.ok(args.includes('-EncodedCommand'))
  const index = args.indexOf('-EncodedCommand')
  const encoded = args[index + 1]
  assert.notEqual(index, -1)
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), WORKER_SCRIPT)
  assert.ok(args.includes('-NoProfile'))
  assert.ok(args.includes('-NonInteractive'))
  assert.ok(args.includes('-WindowStyle'))
  assert.equal(options.windowsHide, true)
  raiser.dispose()
})

test('worker 脚本包含任务栏覆盖图标接口与三种颜色指令', () => {
  assert.match(WORKER_SCRIPT, /ITaskbarList3|IDshTaskbarList3/)
  assert.match(WORKER_SCRIPT, /SetOverlayIcon/)
  assert.match(WORKER_SCRIPT, /overlay:\(red\|yellow\|green\|none\)/)
  assert.match(WORKER_SCRIPT, /#E5484D/)
  assert.match(WORKER_SCRIPT, /#F5A524/)
  assert.match(WORKER_SCRIPT, /#22C55E/)
})

test('调用顺序回归：AttachThreadInput 必须先于 SetForegroundWindow', () => {
  const attach = WORKER_SCRIPT.indexOf('AttachThreadInput(thisThread')
  const show = WORKER_SCRIPT.indexOf('ShowWindow(target, 9)')
  const top = WORKER_SCRIPT.indexOf('BringWindowToTop(target)')
  const setFore = WORKER_SCRIPT.indexOf('SetForegroundWindow(target)')
  const detach = WORKER_SCRIPT.indexOf('AttachThreadInput(thisThread', attach + 1)
  assert.ok(attach !== -1 && show !== -1 && top !== -1 && setFore !== -1 && detach !== -1)
  assert.ok(attach < show, 'AttachThreadInput 必须在 ShowWindow 之前')
  assert.ok(show < top && top < setFore, 'ShowWindow → BringWindowToTop → SetForegroundWindow')
  assert.ok(setFore < detach, '结束后必须解挂线程输入')
})

test('worker 是复用的：多次 warmup / raise / overlay 只起一个进程', () => {
  const stub = spawnStub()
  const raiser = createWindowRaiser({ spawn: stub.spawn })
  assert.equal(raiser.warmup(), true)
  assert.equal(raiser.warmup(), true)
  assert.equal(raiser.raise(1234), true)
  assert.equal(raiser.raise(5678), true)
  assert.equal(raiser.isRunning(), true)
  assert.equal(stub.children.length, 1)
  assert.deepEqual(stub.children[0].writes, ['raise:1234\n', 'raise:5678\n'])
  raiser.dispose()
})

test('overlay 按需起 worker，写入状态与进程号，并记录当前状态', () => {
  const stub = spawnStub()
  const raiser = createWindowRaiser({ spawn: stub.spawn })
  assert.equal(raiser.overlay('red', 4321), true)
  assert.equal(raiser.overlayState(), 'red')
  assert.deepEqual(stub.children[0].writes, ['overlay:red:4321\n'])
  assert.equal(raiser.overlay('none', 4321), true)
  assert.equal(raiser.overlayState(), 'none')
  assert.deepEqual(stub.children[0].writes, ['overlay:red:4321\n', 'overlay:none:4321\n'])
  raiser.dispose()
})

test('非法状态 / 进程号直接拒绝，不起进程', () => {
  const stub = spawnStub()
  const raiser = createWindowRaiser({ spawn: stub.spawn })
  assert.equal(isOverlayState('red'), true)
  assert.equal(isOverlayState('purple'), false)
  assert.deepEqual(OVERLAY_STATES, ['red', 'yellow', 'green', 'none'])
  assert.equal(raiser.overlay('purple', 1234), false)
  assert.equal(raiser.overlay('red', 0), false)
  assert.equal(raiser.overlay('red', -1), false)
  assert.equal(raiser.overlay('red', 1.5), false)
  assert.equal(stub.children.length, 0)
  raiser.dispose()
})

test('非法 raise 进程号直接拒绝，不起进程', () => {
  const stub = spawnStub()
  const raiser = createWindowRaiser({ spawn: stub.spawn })
  assert.equal(raiser.raise(0), false)
  assert.equal(raiser.raise(-1), false)
  assert.equal(raiser.raise(1.5), false)
  assert.equal(raiser.raise(Number.NaN), false)
  assert.equal(raiser.raise('1234'), false)
  assert.equal(stub.children.length, 0)
  raiser.dispose()
})

test('状态点亮着时不会因空闲自动退出；清除后才会', async () => {
  const stub = spawnStub()
  const raiser = createWindowRaiser({ spawn: stub.spawn, idleShutdownMs: 20 })
  raiser.overlay('green', 111)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(raiser.isRunning(), true, '状态点亮着时 worker 必须保持存活')
  assert.equal(stub.children[0].killed, false)
  raiser.overlay('none', 111)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(raiser.isRunning(), false)
  assert.equal(stub.children[0].killed, true)
})

test('stdout 有数据即视为编译完成（isReady）', () => {
  const stub = spawnStub()
  const raiser = createWindowRaiser({ spawn: stub.spawn })
  raiser.warmup()
  assert.equal(raiser.isReady(), false)
  stub.children[0].stdout.emit('data', Buffer.from('READY'))
  assert.equal(raiser.isReady(), true)
  raiser.dispose()
})

test('worker 退出后会按需重启（崩溃自愈）', () => {
  const stub = spawnStub()
  const raiser = createWindowRaiser({ spawn: stub.spawn })
  raiser.overlay('yellow', 222)
  stub.children[0].emit('exit')
  assert.equal(raiser.isRunning(), false)
  assert.equal(raiser.isReady(), false)
  assert.equal(raiser.overlay('yellow', 333), true)
  assert.equal(stub.children.length, 2)
  assert.deepEqual(stub.children[1].writes, ['overlay:yellow:333\n'])
  raiser.dispose()
})

test('spawn 抛异常时降级：只告警一次，返回 false', () => {
  let calls = 0
  const warnings = []
  const raiser = createWindowRaiser({
    spawn: () => {
      calls += 1
      throw new Error('没有 PowerShell')
    },
    onWarn: (message) => warnings.push(message),
  })
  assert.equal(raiser.overlay('red', 111), false)
  assert.equal(raiser.raise(111), false)
  assert.equal(raiser.warmup(), false)
  assert.equal(calls, 3)
  assert.equal(warnings.length, 1)
})

test('dispose 之后不再起进程、不再写入，并清掉状态点', () => {
  const stub = spawnStub()
  const raiser = createWindowRaiser({ spawn: stub.spawn })
  raiser.overlay('red', 777)
  raiser.dispose()
  assert.equal(stub.children[0].ended, true)
  assert.equal(stub.children[0].killed, true)
  assert.equal(raiser.isRunning(), false)
  assert.equal(raiser.overlay('red', 111), false)
  assert.equal(raiser.raise(111), false)
  assert.equal(raiser.warmup(), false)
  assert.equal(stub.children.length, 1)
})

test('默认空闲窗口是 10 分钟', () => {
  assert.equal(DEFAULT_IDLE_SHUTDOWN_MS, 10 * 60 * 1000)
})

test('resolveTargetProcessId 用宿主进程的父进程（桌面端就是窗口进程）', () => {
  assert.equal(resolveTargetProcessId({ ppid: 33032 }), 33032)
  assert.equal(resolveTargetProcessId({ ppid: 0 }), undefined)
  assert.equal(resolveTargetProcessId({}), undefined)
  assert.equal(resolveTargetProcessId({ ppid: '33032' }), undefined)
  assert.equal(resolveTargetProcessId(null), undefined)
})
