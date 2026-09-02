# 审计任务书 · pi-ultra-workflow

给独立 reviewer（codex）的自包含审计上下文。目标是找**当前代码里还没被发现的真缺陷**，不是复述已知项。

## 待审对象

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `index.ts` | 600 | 调度器：plan 校验、phase 串行、phase 内并发、spawn child、解析 NDJSON、汇总报告 |
| `child-guard.ts` | 123 | child 的 `tool_call` 边界：路径检查 + shell 命令白名单 |
| `tests/verify.mjs` | 207 | 81 项静态检查 |
| `tests/harness/cli.js` | 228 | 28 项端到端检查（真 spawn，假 child） |

只读审计。**禁止修改任何文件，禁止 commit，禁止运行真 `pi` 会话**（会消耗订阅额度）。跑 `tests/` 里两个脚本是允许的，它们不发任何 provider 请求。

## 它是什么

Pi 的一个 extension，注册单个 `Workflow` tool。主 agent 传入 phase 列表，调度器 spawn 若干只读 child（`pi --mode json --print` 子进程），phase 之间串行、phase 内最多 3 并发，最后把证据汇总成一份报告返回。前台阻塞调用。

上一版是 1442 行，本版 723 行，砍掉的是 background 模式、跨进程锁、PID 存活检测、pause/resume/restart、状态版本迁移、并发爬坡、溢出 artifact 落盘、usage 归一化四函数、`workflow_control` tool、slash command。

## 刻意的设计取舍 —— 这些不是缺陷，别报

1. **前台阻塞**，无 background、无 resume、无锁。理由：这是一次 10–30 分钟的只读审计，崩了重跑即可；durability 的收益接近零，成本是整套状态机加"resume 复用陈旧证据"这个新的正确性风险。
2. **状态 JSON 只是日志**（`writeLog` 整个 try/catch 吞错），永不参与控制流。
3. **失败降级**：单个 child 失败记为证据缺口，兄弟继续、后续 phase 继续；只有"某 phase 全灭"或"全部 task 失败"才终止。上一版是一个失败就杀光同 phase 兄弟，那是被刻意修掉的。
4. **输出超限截断标注**，不判失败。
5. **固定并发 `min(taskCount, 3)`**，没有爬坡。
6. **shell 白名单允许跑项目自己的脚本**（`npm run`、`make`、`python3 script.py`）。这是 `shell: true` 的全部意义；禁掉它等于取消这个功能。
7. **`child-guard.ts` 不是沙箱**，child 以同一用户身份运行。它防的是误操作和 repo 内容注入。
8. **`MODEL` 硬编码**为单一常量。

## 已知限制 —— 已在 README 承认，别重复报

1. `maxTotalTokens` 是"派发闸门 + in-flight 估算"，不是硬上限；已派发的 task 会跑完，真实上界约为预算加上每个在飞 child 一轮。
2. Pi 没有任何内置 web/fetch 工具，child 无法联网（源码级确认：`dist/core/tools/index.js` 的 `allToolNames` 只有 8 项）。
3. 长 run 占住 Pi 会话。

## 已修的历史缺陷 —— 别当新发现报

上一版被两轮审计定位、本版已修：phase all-or-nothing 连坐；`registerTool` 返回的 `isError` 被 Pi 无条件丢弃（12 处失败上报无效，已全改 `throw`）；无任何 token 上限；输出超 6000 字符判失败且溢出 artifact 无人消费；全局单一 deadline 导致末段 phase 饿死；guard 的目录预扫让 repo 根 `grep` 恒被拒；child 无 shell 能力；UTF-8 分块截断毁中文报告（已用 `StringDecoder`）；单 phase 时全部 task 误升 `max + Fast`；`stopReason:"length"` 硬判失败丢正文；report 无总量上限；失败与在飞 token 不计入预算；`session_shutdown` 只 abort 不等待留孤儿；同 phase 内重复 task id 未拦；`piInvocation` 无入口校验（可递归执行非 pi 宿主脚本）；`checkPath` 用 `resolve` 而非 `realpath`，workspace 内指向外部的 symlink 可绕过。

## 测试已覆盖的部分 —— 在这些上不必重复投入

- `verify.mjs`：真 Pi loader 加载、只注册一个 tool、`executionMode`、planner 五类拒绝、workspace 三类拒绝、防递归、guard 60 条边界（复合命令 / 命令替换 / 重定向 / 反引号 / `python3 -m` / `--eval=` / 聚合短选项 / `git --exec-path` / `git` 全局选项 / `sudo` / `env` 前缀 / 路径穿越 / 绝对路径外部 / symlink 逃逸 / 大小写变体 / `.git` 子路径 / 凭据 pattern）
- `harness/cli.js`：3 child 真并发重叠、并发峰值恰为 3、phase 屏障、失败降级全链、超长截断、空输出成缺口、token 熔断阻断整个下一 phase 且未派发项进 gaps、phase 全灭终止、per-task deadline 真等 30 秒
- 真 `pi` + 真 Sol 联调 3 轮（含 `shell: true` 真跑 `git log`），最后一轮 2 phase / 3 task / 3955 token 全 completed

## 请重点审这些 —— 已知的测试盲区

1. **in-flight token 追踪从未被真实触发过**。`processLine` 里 `message_update` 分支负责把在飞用量写进 `inFlight` map，但 `harness` 的假 child 只发 `message_end`，所以这条路径零覆盖。请核对：字段路径 `event.usage.totalTokens` 是否与 Pi 的 `message_update` 事件真实形状一致（见 `dist/modes/json-event.js`）；`inFlight.delete` 的三个时机（`message_end`、`finish`、超时）是否存在漏删导致预算被永久占用。
2. **`exit` 兜底 timer 与 `close` 的交互**。`proc.on("exit")` 里挂了一个 2 秒 `unref()` 定时器兜底"stdout 被孙进程占住导致 close 永不触发"。请判断：`unref()` 是否会让这个兜底在父进程即将空闲时失效；正常路径下它是否真的是 no-op；有没有让 promise 双 settle 的可能。
3. **报告汇总的边界**。`chosen.length` 参与除法算份额；`unused` 检测用 `chosen.includes(task)` 做引用比较；`lastPhase` 取"最后一个含非 pending task 的 phase"。请构造能让证据静默消失、报告重复、或除零/`Infinity` 的输入。
4. **截断的字符边界**。`slice(0, MAX_RESULT_CHARS)` 按 UTF-16 code unit 切，可能劈开 surrogate pair（emoji、部分 CJK 扩展区），产生半个字符。影响与修法。
5. **`plan()` 的依赖语义**。`dependsOn` 缺省取上一 phase 全部；显式传值时只校验"必须已在更早 phase 出现"。请找出能让某个 completed task 的证据既不进任何下游 prompt、也不进最终报告的构造（`unused` 警告是否真的兜住了全部情况）。
6. **shell 白名单的剩余绕过**。已拦项见上。请针对 `ALLOWED_COMMANDS` 里每个命令逐个判断：有没有不含 shell 元字符、不含被禁 flag、且参数路径都在 workspace 内，却仍能写文件 / 发网络请求 / 执行 workspace 外代码的具体命令字符串。给出实测判定（用 `tests/verify.mjs` 里的 jiti 加载方式喂给 handler，**不要真的执行这些命令**）。
7. **Windows 分支**。`detached`、`process.kill(-pid)`、`sep` 相关逻辑在 `platform === "win32"` 下的行为。仅需指出会不会静默失效。

## 硬约束

- 不要建议加 hash / checksum / 完整性链 / 指纹校验。
- 不要建议把 background、跨进程锁、resume、状态版本迁移、并发爬坡加回来。
- 不要建议改用容器或 VM 沙箱。
- 不要建议引入任何运行时依赖（当前零依赖，只用 Node 内置模块 + Pi 自带的 typebox）。
- 防御要成比例：不为"基本不可能发生"的情况加分支、断言或 try/except。
- 不要写 `.md` 报告文件，结论直接回复。

## 交付格式

每条 finding 给：`文件:行号 → 一句话缺陷 → 触发条件 → 后果 → 最小修补（≤5 行代码）`。按严重度排序，最多 10 条。凡是判定"实现正确"的项，也用一行说明依据。最后给一句总体判断：能不能直接用，最该先修哪一条。
