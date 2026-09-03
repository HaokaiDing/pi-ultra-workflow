# 审计任务书 · pi-ultra-workflow（第 3 轮 · 只审调度层）

给独立 reviewer（codex）的自包含上下文。目标是找**这一轮新增代码里还没被发现的缺陷**。

## 本轮范围

**只审 `index.ts`（728 行）的调度层**，以及 `tests/` 里对它的覆盖。

**明确不在本轮范围内：`child-guard.ts` 和 shell 命令策略。** 第 2 轮已经查明那套 per-option 策略覆盖不了无界的选项空间（22 条边界形式全部放行），结论已写进 README 的 known limitations：shell 策略是粗筛，适合审自己的代码，不适用于不信任的代码。把它改成固定命令模板是独立的一轮工作，本轮不要花时间，也不要重复报那 22 条。

只读审计。**禁止修改任何文件，禁止 commit，禁止运行真 `pi` 会话**（会消耗订阅额度）。`tests/verify.mjs`（127 项）和 `tests/harness/cli.js`（49 项）可以跑，它们不发任何 provider 请求。不要写 `.md` 文件，结论直接回复。

## 它是什么

Pi 的一个 extension，注册单个 `Workflow` tool。主 agent 传入 phase 列表，调度器 spawn 若干只读 child（`pi --mode json --print` 子进程），phase 之间串行、phase 内最多 3 并发，最后把证据汇总成一份报告。

**默认后台交付**：tool 立刻返回 run id，跑完用 `pi.sendMessage({triggerTurn: true, deliverAs: "followUp"})` 把报告送回会话。已在真实交互式会话端到端验证过（tool 返回 → 主 agent 结束回合 → 14 秒后报告自己抵达 → 主 agent 读到）。非交互宿主（`pi --print`）自动降级为前台，因为那种进程在回合结束时退出，会取消 run 并丢掉报告（实测：138 token 花掉、产出为零）。

## 刻意的设计取舍 —— 不是缺陷，别报

1. 无跨进程锁、无 resume、无状态版本迁移。状态 JSON 只是事后日志，`writeLog` 整个 try/catch 吞错，永不参与控制流。
2. 失败降级：单 child 失败记为证据缺口，兄弟继续、后续 phase 继续；只有某 phase 全灭或全部 task 失败才终止。
3. 输出超限截断标注，不判失败。
4. 固定并发 `min(taskCount, 3)`，无爬坡。
5. 同一会话一次只允许一个 run（`active` 计数）。
6. 禁止 child 递归派发（`PI_ULTRA_WORKFLOW_CHILD` 环境变量守卫）。
7. `MODEL` 硬编码为单一常量。
8. 任务数由调用方按 prompt 里的规模阶梯自行决定，代码只兜硬上限（`MAX_TASKS=8`、`CONCURRENCY=3`）。这是照 Anthropic 的做法：prompt 引导加确定性上限，两者都要，**不做独立的规划 agent**。

## 已知限制 —— 已承认，别重复报

1. `maxTotalTokens` 是派发闸门加 in-flight 估算，不是硬上限；已派发的 task 会跑完。
2. Pi 无任何内置 web/fetch 工具，child 不能联网。
3. macOS / Linux only，Windows 在 tool 入口 fail-fast。
4. `git log -p` 会打印历史里的文件内容，包括受保护的文件名。
5. shell 策略是粗筛（见上文范围说明）。

## 前两轮已修 —— 别当新发现报

涉及：`registerTool` 返回的 `isError` 被 Pi 无条件丢弃（已全改 `throw`）、phase 级连坐终止、无 token 上限、输出超限判失败、全局单一 deadline、路径归一化与 Pi 不一致、多轮 `toolUse` 的 token 对预算不可见、`exit` 兜底未清理子进程、被 ceiling 留成 `pending` 的 task 让上游证据算作已消费、报告长度在转义前计算、`slice` 劈开 surrogate pair、同 phase 重复 task id、`piInvocation` 无入口校验、Windows 分支静默失效。

## 请重点审这些（全部是本轮新增）

1. **后台交付的 promise 链**（`index.ts` 尾部 `execute` 分支）。形状是 `void execute(...).then(text=>text, error=>msg).then(deliver).finally(settle)`。请判断：`settle` 是否恰好执行一次（`active` 计数会不会漂）；`sendMessage` 抛错时报告只剩日志（我用 try/catch 吞了）这样处理是否可接受；后台 run 与 `liveChildren` 集合的生命周期是否一致。

2. **`ctx.hasUI` 作为降级判据**。`input.background !== false && ctx.hasUI === true` 才走后台。请核对 Pi 里 `hasUI` 的真实语义（`dist/core/extensions/types.d.ts` 附近）：有没有"交互式会话但 hasUI 为 false"或反之的情形，会让这个判断反向。

3. **后台 run 与 `session_shutdown` 的交互**。shutdown 时 abort 所有 controller、terminate `liveChildren`、等 500ms 再 SIGKILL。后台 run 此时被取消、报告丢失（只留日志）。请评估这个语义是否合理，以及有没有让 shutdown 挂住或让子进程逃过清理的路径。

4. **同一会话单 run 的锁定代价**。后台 run 期间 `active > 0`，第二个 `Workflow` 调用被拒。最坏 4 phase × 300s per task，会话可能被锁十几分钟。请判断：有没有让 `active` 永不归零的路径（那会永久锁死会话）；这个取舍是否需要一个逃生口。

5. **in-flight 记账的真实上界**。当前：spawn 前按 `prompt.length / 4` 垫下界；`message_update` 时取 `Math.max(已有, 已完成轮 tokens + 本轮 live)`；`message_end` 若 `stopReason === "toolUse"` 保留 `tokens` 否则删除；失败时把 `Math.max(tokens, inFlight)` 计入总量。请判断真实上界，以及有没有让 `inFlight` 条目永久残留、从而永久占用预算阻断后续派发的路径。

6. **报告收缩迭代的收敛性**。按 `MAX_REPORT_CHARS / chosen.length` 算份额、构建、若 `safeJson` 后超限则按实际比例收缩，最多 3 轮，份额下界 256。我的论证是必然收敛：256 × 最多 8 task × 最坏 6 倍转义膨胀 ≈ 13k < 48k。请证伪或确认，并尝试构造 3 轮后仍超限的输入。

7. **新的 workspace 判据**。顺序是：拒 Home 及其祖先 → 拒含敏感段的路径 → 拒 `UMBRELLA_DIRS` 里的目录名 → 有 marker（往上 12 层）则放行 → 否则若在 Home 下且深度 ≥ 2 则放行 → 否则要求 `.pi-workflow-root`。请找出反直觉的判定：应该放行却被拒、或应该拒却放行的真实目录形状。特别是符号链接下的 Home、`UMBRELLA_DIRS` 的大小写与本地化目录名、以及 `depth >= 2` 在深层嵌套 Home 布局下的表现。

8. **委派契约的 prompt 构造**。每个 child 的 prompt 现在含 objective、自己的任务、`<other_workers>`（同 phase 兄弟的 id 与任务描述前 160 字符）、`<untrusted_workflow_evidence>`（上游证据）。请评估：把兄弟的任务描述注入每个 child 有什么副作用（prompt 体积、以及兄弟描述里的文本被 child 当成自己待办的可能）；`<other_workers>` 的措辞是否足以让它被读成边界说明。

9. **`clip()` 的字符边界**。只去掉尾部孤立的高代理，不处理组合字符与 ZWJ emoji 序列。请表态是否值得修。

## 硬约束

- 不要建议加 hash / checksum / 完整性链。
- 不要建议把跨进程锁、resume、状态版本迁移、并发爬坡加回来。
- 不要建议引入运行时依赖（当前零依赖，只用 Node 内置模块 + Pi 自带的 typebox）。
- 不要建议做独立的规划 agent 来决定任务数（见取舍 8）。
- 不要碰 `child-guard.ts` 与 shell 策略（见范围说明）。
- 防御要成比例：不为基本不可能发生的情况加分支、断言或 try/except。

## 交付格式

每条 finding 给：`文件:行号 → 一句话缺陷 → 触发条件 → 后果 → 最小修补（≤5 行代码）`。按严重度排序，最多 10 条。判定"实现正确"的项也用一行说明依据。第 3、4、6、9 项无论结论如何都必须明确表态并给理由。最后一句总体判断：调度层能不能直接用，最该先修哪一条。
