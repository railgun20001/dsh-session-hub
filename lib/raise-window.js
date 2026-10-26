/**
 * dsh-session-hub —— 宿主半：窗口前置 + 任务栏状态点
 *
 * ## 为什么需要这个文件
 *
 * 通知或状态栏被点击时必须让「被通知的那个窗口」真的出现，否则用户点了 toast 什么
 * 也看不见；同时任务栏图标要能显示红 / 黄 / 绿状态点。这两件事渲染进程都做不到：
 *
 *  - 桌面端 preload 暴露的 `dshDesktop` / `dshPlatform` 里**没有任何 focus/restore
 *    或任务栏 overlay API**；
 *  - Electron 收到 Windows toast 的点击时只派发页面里的 JS `click`，**自己从不
 *    调用 show/focus/SetForegroundWindow**（Electron 44 的 windows_toast_* 实现）；
 *  - 页面侧的 `window.focus()` 受 Blink 的 transient user activation 门控，不可靠；
 *  - 任务栏覆盖图标需要 `ITaskbarList3.SetOverlayIcon`，只有宿主这一侧的 Win32
 *    通道能做（宿主进程是 Electron 主进程的直接子进程，能找到主窗口句柄）。
 *
 * ## 为什么是「常驻 PowerShell worker」而不是一次性调用
 *
 * 单纯 `AppActivate`（WScript.Shell / VisualBasic）会被 Windows 的前台锁挡住：
 * 实测返回 True 但前台窗口不变。有效的是经典组合：
 * `AttachThreadInput` + `ShowWindow` + `BringWindowToTop` + `SetForegroundWindow`
 * （实测在「没有用户点击、别的窗口在最前」这种最苛刻场景下也能把 DSH 窗口提上来）。
 *
 * 但这需要 P/Invoke，而 Windows PowerShell 5.1 的 `Add-Type` 每次编译 C# 要 **约 6 秒**
 * ——点击后等 6 秒才出现完全不可接受。因此这里常驻一个 worker：启动时编译一次并
 * 预生成三个状态点 HICON，之后每次「提窗口 / 换状态点」只是往 stdin 写一行（毫秒级）。
 * 空闲 10 分钟自动退出释放内存，下次需要再按需拉起；**只要状态点还亮着就不会自动
 * 退出**，否则 HICON 随进程结束可能被销毁、任务栏上的点会消失。
 *
 * ## 失败姿态
 *
 * 整个机制是**尽力而为**的：PowerShell 不存在、被策略拦住、窗口句柄还在但进程已退，
 * 都只记一条日志。客户端那边的跳转（`ctx.uiWorkspace.openSession`）不依赖它。
 *
 * @module dsh-session-hub/raise-window
 */

import { spawn as nodeSpawn } from 'node:child_process'

/** 默认 PowerShell 可执行文件（Windows PowerShell 5.1 在每台 Windows 上都有）。 */
export const DEFAULT_POWERSHELL = 'powershell.exe'

/** worker 空闲多久自动退出（毫秒）。 */
export const DEFAULT_IDLE_SHUTDOWN_MS = 10 * 60 * 1000

/** 任务栏状态点的全部合法取值；`none` 表示清除。 */
export const OVERLAY_STATES = Object.freeze(['red', 'yellow', 'green', 'none'])

/**
 * worker 协议版本。
 *
 * 2 起：`Raise` 只在窗口最小化时使用 `SW_RESTORE`，最大化时用 `SW_SHOWMAXIMIZED`
 * 保持最大化（旧版本无条件 `SW_RESTORE`，会把最大化窗口打回普通尺寸）。
 * 宿主半在 `/ping` 里回报它，便于确认运行中的 worker 是否已经是新协议。
 */
export const WORKER_PROTOCOL = 2

/**
 * 判断一个值是否是合法的任务栏状态。
 * @param {unknown} value 待判断值。
 * @returns {boolean} 是否合法。
 */
export function isOverlayState(value) {
  return typeof value === 'string' && OVERLAY_STATES.includes(value)
}

/**
 * worker 脚本体。
 *
 * 用 `-EncodedCommand` 投递（base64 的 UTF-16LE），因此不落临时文件、也不需要
 * `-ExecutionPolicy Bypass`；stdin 也不会被脚本解析占用，`[Console]::In.ReadLine()`
 * 可以干净地一行一行收指令。
 *
 * 指令协议（一行一条）：
 *   - `<pid>`                  ：把该进程的主窗口提到前台（兼容旧格式）
 *   - `raise:<pid>`            ：同上
 *   - `overlay:<state>:<pid>`  ：设置 / 清除该进程窗口的任务栏状态点
 */
export const WORKER_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090")]
public class DshTaskbarListCoClass { }

[ComImport, Guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDshTaskbarList3 {
  [PreserveSig] int HrInit();
  [PreserveSig] int AddTab(IntPtr hwnd);
  [PreserveSig] int DeleteTab(IntPtr hwnd);
  [PreserveSig] int ActivateTab(IntPtr hwnd);
  [PreserveSig] int SetActiveAlt(IntPtr hwnd);
  [PreserveSig] int MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool fFullscreen);
  [PreserveSig] int SetProgressValue(IntPtr hwnd, ulong ullCompleted, ulong ullTotal);
  [PreserveSig] int SetProgressState(IntPtr hwnd, int tbpFlags);
  [PreserveSig] int RegisterTab(IntPtr hwndTab, IntPtr hwndMDI);
  [PreserveSig] int UnregisterTab(IntPtr hwndTab);
  [PreserveSig] int SetTabOrder(IntPtr hwndTab, IntPtr hwndInsertBefore);
  [PreserveSig] int SetTabActive(IntPtr hwndTab, IntPtr hwndMDI, uint dwReserved);
  [PreserveSig] int ThumbBarAddButtons(IntPtr hwnd, uint cButtons, IntPtr pButtons);
  [PreserveSig] int ThumbBarUpdateButtons(IntPtr hwnd, uint cButtons, IntPtr pButtons);
  [PreserveSig] int ThumbBarSetImageList(IntPtr hwnd, IntPtr himl);
  [PreserveSig] int SetOverlayIcon(IntPtr hwnd, IntPtr hIcon, [MarshalAs(UnmanagedType.LPWStr)] string pszDescription);
  [PreserveSig] int SetThumbnailTooltip(IntPtr hwnd, [MarshalAs(UnmanagedType.LPWStr)] string pszTip);
  [PreserveSig] int SetThumbnailClip(IntPtr hwnd, IntPtr prcClip);
}

public class DshWinRaise {
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();

  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  private static IntPtr found;
  private static uint wanted;

  // 找出属于该进程的一个顶层窗口：优先可见的，其次隐藏的（窗口被收进托盘时也拿得到）。
  public static IntPtr Find(uint pid) {
    wanted = pid;
    found = IntPtr.Zero;
    EnumWindows(new EnumWindowsProc(Visit), IntPtr.Zero);
    return found;
  }

  private static bool Visit(IntPtr hWnd, IntPtr lParam) {
    uint pid;
    GetWindowThreadProcessId(hWnd, out pid);
    if (pid != wanted) return true;
    if (GetWindow(hWnd, 4) != IntPtr.Zero) return true;   // GW_OWNER：跳过工具窗口
    if (GetWindowTextLength(hWnd) == 0) return true;      // 无标题的多半是隐藏辅助窗口
    if (IsWindowVisible(hWnd)) { found = hWnd; return false; }
    if (found == IntPtr.Zero) found = hWnd;
    return true;
  }

  // 把该进程的窗口提到前台；成功与否都返回，绝不抛。
  //
  // 调用顺序是实测出来的关键：AttachThreadInput 必须**先**执行，之后
  // ShowWindow / BringWindowToTop / SetForegroundWindow 才越过 Windows 前台锁；
  // 把 ShowWindow 提到 AttachThreadInput 之前会让 SetForegroundWindow 返回 false
  // 且前台窗口不变。
  //
  // 窗口状态必须保留（这是「点一下对话，最大化被取消」的根因）：
  // ShowWindow(hwnd, SW_RESTORE) 对**最大化**窗口的语义是「恢复成原始大小」，
  // 所以无条件调用 SW_RESTORE 会把最大化的 DSH 窗口打回普通尺寸。正确做法：
  //   - 最小化（IsIconic）才 SW_RESTORE；
  //   - 最大化（IsZoomed）用 SW_SHOWMAXIMIZED 保持最大化；
  //   - 普通/隐藏才 SW_SHOW。
  public static bool Raise(uint pid) {
    IntPtr target = Find(pid);
    if (target == IntPtr.Zero) return false;

    IntPtr fore = GetForegroundWindow();
    uint dummy;
    uint foreThread = GetWindowThreadProcessId(fore, out dummy);
    uint thisThread = GetCurrentThreadId();
    AttachThreadInput(thisThread, foreThread, true);
    if (IsIconic(target)) ShowWindow(target, 9);            // SW_RESTORE：仅最小化时还原
    else if (IsZoomed(target)) ShowWindow(target, 3);       // SW_SHOWMAXIMIZED：保持最大化
    else if (!IsWindowVisible(target)) ShowWindow(target, 5); // SW_SHOW：托盘隐藏时显示
    BringWindowToTop(target);
    bool ok = SetForegroundWindow(target);
    AttachThreadInput(thisThread, foreThread, false);
    return ok;
  }

  // 设置 / 清除任务栏覆盖图标（状态点）。hicon 为 IntPtr.Zero 表示清除。
  // 跨进程调用是可行的：ITaskbarList3 以 HWND 为目标，由 Explorer 侧绘制。
  public static bool SetOverlay(uint pid, IntPtr hicon, string description) {
    IntPtr target = Find(pid);
    if (target == IntPtr.Zero) return false;
    try {
      IDshTaskbarList3 list = (IDshTaskbarList3)new DshTaskbarListCoClass();
      if (list.HrInit() != 0) return false;
      return list.SetOverlayIcon(target, hicon, description ?? "") == 0;
    } catch {
      return false;
    }
  }
}
'@

# 预生成三个状态点图标。它们是 HICON 句柄，必须一直活到 worker 退出；
# 因此放在 script 作用域里，而不是每次命令创建后丢掉。
Add-Type -AssemblyName System.Drawing
function New-DshDotIcon([string]$hex) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $ring = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $g.FillEllipse($ring, 1, 1, 30, 30)
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($hex))
  $g.FillEllipse($brush, 4, 4, 24, 24)
  $g.Dispose()
  return $bmp.GetHicon()
}
$script:dotIcons = @{
  red = New-DshDotIcon '#E5484D'
  yellow = New-DshDotIcon '#F5A524'
  green = New-DshDotIcon '#22C55E'
}

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -match '^overlay:(red|yellow|green|none):([0-9]+)$') {
    $state = $Matches[1]
    $target = [uint32]$Matches[2]
    if ($state -eq 'none') {
      [void][DshWinRaise]::SetOverlay($target, [IntPtr]::Zero, '')
    } else {
      [void][DshWinRaise]::SetOverlay($target, $script:dotIcons[$state], "DSH $state")
    }
    [Console]::Out.WriteLine("OVERLAY:$state")
    [Console]::Out.Flush()
    continue
  }
  if ($line -match '^raise:([0-9]+)$') {
    [void][DshWinRaise]::Raise([uint32]$Matches[1])
    continue
  }
  if ($line -match '^[0-9]+$') {
    [void][DshWinRaise]::Raise([uint32]$line)
  }
}
`

/**
 * 创建窗口前置 / 任务栏状态器。
 *
 * @param {object} [options] 注入点（单测靠它替换 spawn）。
 * @param {typeof nodeSpawn} [options.spawn] 进程创建函数。
 * @param {string} [options.powershellPath] PowerShell 可执行文件路径。
 * @param {number} [options.idleShutdownMs] 空闲多久自动退出 worker；0 表示不自动退出。
 * @param {(message: string, error?: unknown) => void} [options.onWarn] 告警回调。
 * @returns {{
 *   raise: (pid: number) => boolean,
 *   warmup: () => boolean,
 *   overlay: (state: string, pid: number) => boolean,
 *   shutdown: () => void,
 *   dispose: () => void,
 *   isRunning: () => boolean,
 *   isReady: () => boolean,
 *   overlayState: () => string,
 * }} 前置 / 状态器接口。
 */
export function createWindowRaiser(options = {}) {
  const {
    spawn = nodeSpawn,
    powershellPath = DEFAULT_POWERSHELL,
    idleShutdownMs = DEFAULT_IDLE_SHUTDOWN_MS,
    onWarn = () => {},
  } = options

  const encoded = Buffer.from(WORKER_SCRIPT, 'utf16le').toString('base64')
  let child = null
  let idleTimer = null
  let ready = false
  let disposed = false
  let failedOnce = false
  /** 当前任务栏状态；`none` 表示没有状态点。 */
  let currentOverlay = 'none'

  /** 起 worker（幂等）。 */
  const start = () => {
    if (disposed || child !== null) return child !== null
    try {
      child = spawn(powershellPath, [
        '-NoProfile',
        '-NonInteractive',
        '-NoLogo',
        '-WindowStyle', 'Hidden',
        '-EncodedCommand', encoded,
      ], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      })
    } catch (error) {
      child = null
      if (!failedOnce) {
        failedOnce = true
        onWarn('[session-hub] 无法启动 PowerShell，通知点击将只跳转会话、不前置窗口', error)
      }
      return false
    }

    child.on?.('error', (error) => {
      if (!failedOnce) {
        failedOnce = true
        onWarn('[session-hub] PowerShell worker 启动失败', error)
      }
      child = null
      ready = false
    })
    child.on?.('exit', () => {
      child = null
      ready = false
    })
    // 只用来判断「编译完成」；stdout 内容本身不关心。
    child.stdout?.on?.('data', () => { ready = true })
    child.on?.('spawn', () => {})
    return true
  }

  /** 空闲到点就退出，别让一个 PowerShell 常驻占内存；状态点亮着时不退出。 */
  const armIdleTimer = () => {
    if (idleShutdownMs <= 0) return
    if (currentOverlay !== 'none') return
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = null
      shutdown()
    }, idleShutdownMs)
  }

  /** 关掉 worker（幂等）。 */
  const shutdown = () => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    const running = child
    child = null
    ready = false
    if (running === null) return
    try {
      running.stdin?.end?.()
    } catch {
      /* 已经关了 */
    }
    try {
      running.kill?.()
    } catch {
      /* 已经退了 */
    }
  }

  /** 写一行指令；失败只告警一次。 */
  const write = (line) => {
    if (disposed) return false
    if (!start()) return false
    try {
      child.stdin?.write?.(`${line}\n`)
    } catch (error) {
      if (!failedOnce) {
        failedOnce = true
        onWarn('[session-hub] 向 PowerShell worker 写入失败', error)
      }
      return false
    }
    return true
  }

  return {
    /**
     * 把某个进程的主窗口提到前台（尽力而为）。
     * @param {number} processId 目标进程（桌面端就是宿主进程的父进程）。
     * @returns {boolean} 指令是否已交给 worker。
     */
    raise(processId) {
      if (!Number.isInteger(processId) || processId <= 0) return false
      const ok = write(`raise:${processId}`)
      if (ok) armIdleTimer()
      return ok
    },

    /** 预热：提前付掉 Add-Type 的编译时间，别让第一次点击等 6 秒。 */
    warmup() {
      if (disposed) return false
      const started = start()
      if (started) armIdleTimer()
      return started
    },

    /**
     * 设置 / 清除任务栏状态点。
     * @param {string} state `red` | `yellow` | `green` | `none`。
     * @param {number} processId 目标进程（桌面端就是宿主进程的父进程）。
     * @returns {boolean} 指令是否已交给 worker。
     */
    overlay(state, processId) {
      if (!isOverlayState(state)) return false
      if (!Number.isInteger(processId) || processId <= 0) return false
      const ok = write(`overlay:${state}:${processId}`)
      if (!ok) return false
      currentOverlay = state
      if (state === 'none') armIdleTimer()
      else if (idleTimer !== null) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
      return true
    },

    shutdown,

    /** 卸载：清掉状态点、关 worker 并拒绝后续调用。 */
    dispose() {
      if (currentOverlay !== 'none' && child !== null) {
        // 与 overlay() 使用同一个目标进程解析口径：目标进程号拿不到时不写半截指令。
        const target = resolveTargetProcessId()
        if (target !== undefined) {
          try {
            child.stdin?.write?.(`overlay:none:${target}\n`)
          } catch {
            /* 尽力而为 */
          }
        }
      }
      disposed = true
      shutdown()
    },

    /** @returns {boolean} worker 是否在跑。 */
    isRunning: () => child !== null,
    /** @returns {boolean} worker 是否已经编译完成、可以秒回。 */
    isReady: () => ready,
    /** @returns {string} 当前任务栏状态。 */
    overlayState: () => currentOverlay,
  }
}

/**
 * 解析「要操作窗口的进程号」。
 *
 * 宿主进程是 Electron 主进程的直接子进程，因此默认目标就是父进程；父进程号拿不到时
 * 回落到 `undefined`（调用方会跳过前置 / 任务栏）。
 * @param {object} [proc] 类似 process 的对象。
 * @returns {number|undefined} 目标进程号。
 */
export function resolveTargetProcessId(proc = globalThis.process) {
  const ppid = proc?.ppid
  return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined
}
