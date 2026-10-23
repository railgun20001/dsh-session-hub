# dsh-session-hub —— 会话状态中心（状态栏 / Windows 通知 / 任务栏状态点）

给 DeepSeek Harness 补一个「所有对话现在怎么样了」的统一视图：

- **软件顶端标题栏的状态栏**：按颜色顺序 `红（报错）> 黄（等待回答）> 绿（待查看）> 蓝（运行中）`
  排列当前需要关注的对话，点一下直接跳到该对话；
- **Windows 通知**：对话状态发生变化（完成 / 失败 / 需要你回答）时弹系统通知，
  点击通知跳回对应对话并尽量把 DSH 窗口提到前台；
- **任务栏状态点**：用 `ITaskbarList3.SetOverlayIcon` 在任务栏的 DSH 图标上画
  红 / 黄 / 绿点，优先级 `红 > 黄 > 绿`，窗口最小化或在别的应用前面时也能看到。

---

## 1. 状态定义

| 状态 | 判定依据（客户端受支持服务） | 状态栏 | 任务栏 |
|---|---|---|---|
| **报错** `error` | 宿主投影 `hubTurnOutcome.outcome ∈ error / interrupted`，且该 `seq` 未被确认 | 🔴 红点 + 「报错」 | 红（最高） |
| **等待回答** `answer` | `uiSession.sessionStatus.pendingInteraction.kind ∈ approval / plan-review / question` | 🟡 黄点 + 「等待回答」 | 黄（无红灯时） |
| **待查看** `unread` | `sessionStatus.completionUnread === true`（原生「未读完成」绿点） | 🟢 绿点 + 「待查看」 | 绿（无红/黄时） |
| **运行中** `running` | `sessionStatus.running` 或会话行 `running` | 🔵 蓝点 + 「运行中」 | 绿（无红/黄时） |

- **状态栏 chip 的显示顺序 = 颜色顺序：红 > 黄 > 绿 > 蓝**（`STATE_ORDER`），同一类里更新时间新的靠前。
  最需要你介入的排最前，正在跑的排最后——所以默认只显示的 3 条永远不会被「运行中」占位。
- **判定顺序**（一个会话归到哪一类，取第一个命中的）与显示顺序无关：
  等待回答 > 报错 > 运行中 > 待查看。既在等你回答、上一轮又还没确认失败时按「等待回答」显示。

- 空白「新会话」占位行与子代理会话（`origin: subagent`）不进入状态栏，也不通知。
- 「报错」在**点击该条目**或**正看着该会话且窗口聚焦**时自动确认（记下 `seq`），
  不会永远亮着；同一个会话出现新的报错会重新亮起。
- 「待查看」直接复用原生 `completionUnread`，打开会话即熄灭。

任务栏聚合规则：只要有一个报错就是红灯；否则有等待回答就是黄灯；否则有运行中或待查看
就是绿灯；都没有就清除覆盖图标。

---

## 2. 界面位置

**桌面端**：状态栏注册在官方 `shell.overlay` 浮动层（`replaceRisk: none`），
固定在软件顶端标题栏、**「应用 / 编辑」菜单之后**、窗口控件之前，随顶栏高度（40px）
垂直居中；菜单被侧栏收起改变位置时，用 `--dsh-windows-menu-start` 自动跟随。
该层本身点击穿透，状态栏条目自己恢复 `pointer-events` 并标记 `-webkit-app-region: no-drag`，
所以 chip 可点、标题栏其余空白仍可拖动窗口。

**Web / 非 Windows 顶栏环境**：同一组件回落到官方
`conversation.header.leading`（`replaceRisk: none`），位于会话标题之前、工作区内容之上。

- 每条是一个圆角 chip：状态点 + 会话标题 + 状态短标签；标题过长省略，悬停显示完整标题；
- 默认只显示优先级最高的 3 条；还有更多时显示 `+N`，点一下展开全部，再点「收起」恢复，
  既不挤压标题，也不会把第 4 条截成半截；
- chip 横向排列，超出宽度可横向滚动（隐藏滚动条），不挤压标题；
- 全部空闲时显示一个低调的「全部空闲」；没有可用会话（或插槽钩子缺失）时也不会报错；
- 视觉只用 `--dsw-alias-*` / 设计系统 token，浅色/深色主题都跟随宿主。

点击 chip 的行为：确认该条目的报错 → `uiWorkspace.openSession(sessionId)`。
**chip 点击不请求窗口前置**：窗口本来就在前台，而且这样可以完全避免触碰窗口状态——
旧实现无条件调用 `SW_RESTORE`，会把最大化的 DSH 窗口打回普通尺寸，这就是「点一下对话
最大化被取消」的根因。通知点击也只在窗口确实不在前台时才请求前置；宿主半现在按
`IsIconic` / `IsZoomed` 分支，最小化才 `SW_RESTORE`，最大化用 `SW_SHOWMAXIMIZED` 保持。

---

## 3. Windows 通知

| 通知 | 触发事实 | 默认 |
|---|---|---|
| **需要你回应** | `pendingInteraction` 出现或换成新的 key | ✅ |
| **任务失败** | 新回合结局 `error` / `interrupted`（含账号登出钩子） | ✅ |
| **任务完成** | 新回合结局 `completed` | ✅ |
| **达到输出上限** | 新回合结局 `max-tokens` | ✅ |
| **任务已停止** | 新回合结局 `aborted`（自己按的停止） | ❌ |

**不会**为「正在思考 / 正在执行工具」这类实时活动弹通知；这正是多数通知插件最吵的地方。
「开始运行」默认也不通知——通常是你自己刚发的消息，没有任何新信息值得打扰。

点击通知：`openSession` 跳转 + 宿主半前置窗口。通知带 `tag`，同一会话的新通知会替换旧的；
多标签页共享 `localStorage` 时同一事件只弹一条。

---

## 4. 任务栏状态点（实现说明）

Electron 的 `BrowserWindow.setOverlayIcon` 没有暴露给渲染进程，preload 里也没有任何
任务栏 API。本插件走的是**宿主半 + PowerShell worker + Win32**：

```
渲染进程                          宿主半（Electron 主进程的子进程）
  │ POST dsh-session-hub/taskbar          │
  │ {state: red|yellow|green|none}        │
  └──────────────────────────────────────▶│  createWindowRaiser.overlay()
                                          │  ├─ EnumWindows(ppid) 找主窗口 HWND
                                          │  └─ stdin: overlay:red:13944
                                          ▼
                                  常驻 PowerShell worker
                                  预生成 3 个 HICON（红/黄/绿，32×32，白描边）
                                  ITaskbarList3.SetOverlayIcon(hwnd, hicon, "DSH red")
```

- 跨进程调用已实测有效：宿主进程是 Electron 主进程的直接子进程，`process.ppid` 就是
  持有窗口的 `DeepSeek Harness.exe`；`ITaskbarList3` 以 HWND 为目标，由 Explorer 绘制。
- worker 在启动时一次性 `Add-Type` 编译 C#（约 6 秒），之后每条指令只是写一行 stdin；
  状态点亮着时**不会**因空闲退出（否则 HICON 随进程销毁，任务栏点可能消失）。
- 插件卸载 / 页面卸载 / `pagehide` 都会发 `none` 清掉状态点，避免红灯残留。
- 只有桌面外壳（`location.protocol === 'dsh-app:'`）会发任务栏请求；浏览器里的 Web 页面
  不会互相抢状态。

**颜色优先级**：`red`（任一报错）> `yellow`（任一等待回答）> `green`（任一运行中或待查看）
> `none`。

---

## 5. 架构

```
plugins/dsh-session-hub/
├── index.js                 宿主半：hubTurnOutcome 投影 + 路由（ping/debug/raise/warmup/taskbar）
├── lib/
│   ├── raise-window.js      宿主半：窗口前置 + 任务栏状态点（PowerShell worker）
│   └── client.js            客户端 bundle（build/bundle.mjs 生成，勿手改）
├── src/
│   ├── hub-model.js         状态栏 / 任务栏纯逻辑（可单测）
│   ├── notify-core.js       通知边沿引擎（纯逻辑，可单测）
│   ├── hub-ui.js            顶部状态栏 React 组件
│   └── client-main.js       接线：服务 → 模型 → 通知 / 状态栏 / 任务栏
├── build/bundle.mjs         把四个源文件内联成单文件浏览器 bundle（--check 校验）
├── test/                    65 个用例
├── locale/{zh,en}.json      插件管理器的标题与描述
├── icon.svg                 插件图标
└── cordis.patch.yml         bundle patch：插入 session-hub 行
```

**为什么事件要自己算边沿**：DSH 给客户端的两路数据都是「当前状态」而不是事件流
（`running` 是布尔、`pendingInteraction` 是当前值、投影是「最后一个回合的结局」）。
通知必须由状态边沿推导，不能每收到一次推送就弹一次。

**为什么失败要靠宿主投影**：客户端拿不到「上一轮为什么结束」。`turn/end` 事件带
`reason.kind`，但只在会话被打开（retain）时才有事件流。会话投影是受支持的正解：
框架驱动**所有**会话（含未打开的冷会话）折叠，值经三条受支持通道到达客户端
（会话列表 RPC 的 projections 块 / `session.projections` RPC / 打开会话时的尾页基线）。
因此本插件**不 retain 任何会话**。

**启动基线**：插件刚激活时已有状态只记为水位、不弹通知；只有真正的新边沿才通知。
事件时间早于 2 分钟（`freshnessWindowMs`）的边沿只推进水位，宿主重启后补写的历史事件
不会变成一串迟到的通知。

---

## 6. 安装

```powershell
# 方式一：插件管理器工具（当前会话可用）
#   plugin_manager → install_bundle → target = C:\work\my\dsh\plugins\dsh-session-hub

# 方式二：Web「插件」页 → 添加本地插件 → 选择本目录
```

安装后：

- **宿主半**（`index.js`）由 HMR 在 profile 组合变化时加载，无需重启；
- **客户端半**（`lib/client.js`）需要刷新页面：在 DSH 窗口按 `Ctrl+R`，或完全重启 DSH。

**卸载**：插件管理器移除 `dsh-session-hub` bundle，再刷新页面；宿主半卸载时会自动
清掉任务栏状态点。

---

## 7. 配置

配置在 `localStorage` 的 `dsh-session-hub/config-v1`，默认值已经覆盖「不打扰」：

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关（关掉后仍推进水位，重新打开不会补弹历史） |
| `onComplete` / `onFailure` / `onAnswer` | `true` | 完成 / 失败 / 需要你回应 |
| `onMaxTokens` | `true` | 达到输出上限 |
| `onStopped` | `false` | 手动停止 / 中断 |
| `includeSubagents` | `false` | 子代理会话是否也通知与显示 |
| `silenceCurrentWhenFocused` | `true` | 聚焦且正在看该会话时不弹 |
| `silenceAllWhenFocused` | `false` | 聚焦时一律不弹 |
| `requireVisibleForFocus` | `true` | 最小化/隐藏视作不聚焦（照常弹） |
| `freshnessWindowMs` | `120000` | 超过这个时长的事件只推进水位、不通知（`0` 关闭） |
| `replacePerSession` | `true` | 同一会话的新通知替换旧通知 |
| `sound` | `true` | 系统提示音 |
| `raiseWindow` | `true` | 点击通知 / chip 时请求宿主半前置窗口 |

在 DSH 窗口 DevTools 控制台里改：

```js
__DSH_SESSION_HUB__.getConfig()
__DSH_SESSION_HUB__.setConfig({ silenceAllWhenFocused: true })
```

---

## 8. 诊断与验证

```powershell
cd C:\work\my\dsh\plugins\dsh-session-hub
npm run check      # 1) 校验 lib/client.js 与源码一致  2) 跑 65 个用例
```

DSH 窗口 DevTools 控制台：

```js
__DSH_SESSION_HUB__.inspect()
// → { version, sessions, uiSession, uiWorkspace, permission, statusRows, taskbarState,
//     desktopShell, hostHalf, ... }

__DSH_SESSION_HUB__.getRows()          // 当前状态栏行
__DSH_SESSION_HUB__.getTaskbarState()  // red / yellow / green / none
__DSH_SESSION_HUB__.setTaskbarState('red')    // 手动试任务栏红点（排障）
__DSH_SESSION_HUB__.setTaskbarState('none')   // 清掉
__DSH_SESSION_HUB__.testNotification() // 弹一条测试通知，点它应跳回当前会话
__DSH_SESSION_HUB__.pingHost()         // 'present' / 'absent' / 'unknown'
```

宿主半只读诊断：

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:14489/dsh-session-hub/ping  -Method POST
Invoke-RestMethod -Uri http://127.0.0.1:14489/dsh-session-hub/debug -Method POST
# 注意：Web 端点的鉴权由 DSH 处理；桌面端页面内的 fetch 是已授权的同源通路。
```

手工验收：

1. 在 A 会话发一个长任务，切到 B 会话 / 别的应用 → 任务栏绿灯；
2. 任务完成后 → 弹「DSH · 任务完成」，状态栏出现绿点「待查看」，点 chip / 通知回到 A；
3. 让一轮失败 → 弹「DSH · 任务失败」，状态栏红点「报错」，任务栏变红（优先级高于黄/绿）；
4. 触发提问 / 审批 → 弹「DSH · 需要你回应」，状态栏黄点「等待回答」，任务栏变黄；
5. 点击红点条目 → 报错确认，红点与任务栏红灯消失。

---

## 9. 已知边界

- **宿主半的窗口状态修复需要重启一次 DSH**：`lib/raise-window.js` 的 worker 脚本在宿主
  启动时加载，旧进程里仍是旧协议。`POST /dsh-session-hub/ping` 返回的 `workerProtocol`
  为 `2` 才表示运行中的 worker 已保留最大化；客户端 chip 点击的修复不需要重启，刷新页面即可。
- **窗口前置依赖 Windows 前台锁**：`AttachThreadInput` 组合在本机实测有效，但全屏应用、
  UAC 提权窗口、远程桌面切换等极端场景仍可能拒绝；此时应用内跳转照常发生。
- **第一次点通知可能略慢**：worker 需要先编译一次 C#（本机实测 5.9–9.6 秒，取决于杀软）。
  通知一弹出就会预热；编译期间点击不会丢，指令排队、编译完立即执行。
- **任务栏点只在桌面端**：Web 浏览器页面没有任务栏按钮，`desktopShell=false` 时不会上报。
- **安装前的历史冷会话**不显示报错：投影检查点按 (sessionId, key) 落盘，本插件注册前
  结束的冷会话没有该键的行，需等该会话被打开一次（全量重折叠）才补齐。
- **报错不会自动过期**：需要点击条目或打开该会话确认；这是刻意设计——失败值得你看一眼。
- **`includeSubagents` 打开后**，状态栏可能出现较多行，插件最多渲染 40 行。

---

## 10. 依赖与权限

- **零 npm 依赖**：宿主半只用 `node:child_process` / `node:fs`；客户端半只用浏览器 API、
  React（由客户端模块表提供）与 DSH 服务。
- **宿主半会起一个 PowerShell 进程**（窗口前置 + 任务栏点），可用 `raiseWindow: false`
  关闭窗口前置（任务栏点仍需要 worker）；worker 空闲 10 分钟退出，状态点亮着时保持。
- **宿主半挂内部路由**：`POST /dsh-session-hub/{ping,debug,warmup,raise,taskbar}`。
  同源、无额外鉴权；只做「提窗口 / 画状态点 / 只读诊断」，不读任何用户数据。

## License

MIT
