# 审查任务书 · pi-ultra-workflow（第 5 轮）

给独立 reviewer 的自包含上下文。目标是找**当前代码里还没被发现的缺陷**。前三轮加上一轮自审共处置了 30 余条，都列在下面的排除项里。

## 范围

`index.ts`（842 行）与 `child-guard.ts`（236 行），以及 `tests/` 里对它们的覆盖。**两个文件都在范围内** —— 上一轮刚各改了 5 处和 2 处。

只读审查。**禁止修改任何文件，禁止 commit，禁止运行真 `pi` 会话**（会消耗订阅额度）。`tests/verify.mjs`（135 项）与 `tests/harness/cli.js`（72 项）可以跑，它们不发 provider 请求。不要写 `.md` 文件，结论直接回复。

## 审查性质

核对"实现出的行为"与"声明的意图"是否一致。意图有两条：child 只读、且只作用于 workspace 内。用规则文件与命令文档逐条推理，**不要构造或运行破坏性命令**。需要核实某条规则的判定时，把 `child-guard.ts` 的 default export 单独 import 出来喂普通字符串取返回值即可（`tests/verify.mjs` 里有现成的 jiti 加载写法）；临时脚本写 `/tmp` 下不用清理，也不要用 `rm`。

## 它是什么

Pi 的 extension，注册单个 `Workflow` tool。主 agent 传 phase 列表，调度器 spawn 若干只读 child（`pi --mode json --print` 子进程），phase 间串行、phase 内最多 3 并发，最后汇总成一份报告。TUI 会话下默认后台交付（`sendMessage` + `triggerTurn`），其他宿主自动降级为前台。

## 刻意的取舍 —— 不是缺陷，别报

1. 无跨进程锁、无 resume、无状态版本迁移。状态 JSON 只是事后日志，`writeLog` 整个 try/catch 吞错，永不参与控制流。
2. 失败降级：单 child 失败记为证据缺口，兄弟与后续 phase 继续；只有某 phase 全灭或全部 task 失败才终止。
3. 输出超限截断标注，不判失败；撞 per-task 预算同样保留已有答案。
4. 固定并发 `min(taskCount, 3)`，无爬坡。
5. 同一会话一次只允许一个 run。
6. 禁止 child 递归派发（`PI_ULTRA_WORKFLOW_CHILD` 守卫）。
7. `MODEL` 硬编码。
8. 任务数由调用方按 prompt 里的规模阶梯决定，代码只兜硬上限（`MAX_TASKS=8`、`CONCURRENCY=3`）。不做独立的规划 agent。
9. token 计数把每个 response 的 `totalTokens`（含 `cacheRead`）逐轮求和。这**高估**了计费成本（缓存前缀每次请求都计一次），刻意偏向早停。
11. **预算上限是防失控，不是省钱**。默认 per-task 250k token / 900 秒、全 run 1.5M。这些数字刻意定得宽：审 800 行代码约 4–6 万 token，深挖一个面可到十几万，压低上限只会让 worker 在写出结论前被切断。不要建议下调这些默认值，也不要把"消耗大"本身当缺陷报。
12. 报告尺寸的约束轴不是成本而是**调用方的上下文窗口**：单 task 32k 字符、整份报告 80k（含 header）、fan-in 280k。完整答案留在日志里。
10. shell 命令策略是**粗筛**，不是边界。已知放行大量选项组合，结论见 README known limitations。适合审自己的代码，不适用于不信任的代码。把它改成固定命令模板是独立的一轮工作 —— **本轮不要报 shell 命令白名单的覆盖面问题**，也不要重复那 22 条已记录的边界形式。

## 已知限制 —— 已承认，别重复报

1. `maxTotalTokens` 是派发闸门；`maxTokensPerTask`（默认 80000）才是可执行的上限。最坏约为 per-task 上限乘并发数。
2. Pi 无任何内置 web/fetch 工具，child 不能联网。
3. macOS / Linux only，Windows 在 tool 入口 fail-fast。
4. `git log -p` 会打印历史里的文件内容，包括受保护的文件名。
5. 后台 run 在 `session_shutdown` 时被取消，报告只留日志。

## 已修 —— 别当新发现报

**路径与 guard**：与 Pi 归一化不一致（`file://`、`@`、Unicode 空格、`~`）；指向 workspace 外的 symlink；未解析路径退回词法检查（现对文件工具直接拒绝，shell 参数仍走词法）；递归 `grep` 读到受保护后代（现要求单文件）；`grep` 凭据 pattern；workspace 判据放行 `~/.config`、`~/.docker`、`~/Library`（含 CloudStorage 与 iCloud）；误拒名为 `tmp` 的真项目；glob 展开在检查之后；`git show HEAD:.env`；`npm publish`/`install`、`cargo install`；`git branch`/`tag` 被当只读；带值选项跳过路径检查；`--pre`/`--pyargs`/`--exec-path` 等外部执行开关；全局 flag 黑名单误伤 `git log -p`、`head -c`、`pytest -m`。

**调度层**：`registerTool` 返回的 `isError` 被 Pi 丢弃（已全改 `throw`）；phase 级连坐终止；无 token 上限；输出超限判失败；全局单一 deadline；多轮 `toolUse` 的 token 对预算不可见；`exit` 兜底未清理子进程；SIGKILL 升级被"leader 还活着"挡住；事件流超限后继续 buffer；已 settle 的 child 用尾部残片重建预算占用；预算 reservation 写在 `spawn` 可能抛错之前；被 ceiling 留成 `pending` 的 task 让上游证据算作已消费；报告与 fan-in 的长度在转义前计算；`slice` 劈开 surrogate pair；`phase.name` 未转义进 header；诊断未序列化进报告；同 phase 重复 task id；`piInvocation` 无入口校验；`hasUI` 被误用作宿主生命周期判据（改 `ctx.mode`）；shutdown 时反向触发 provider turn；Windows 分支静默失效；两处不可达分支。

**一条被推翻又改回的**：`usage.totalTokens` 曾被误判为会话累计值、求和改成取最大值。它其实是单次请求的 `input + output + cacheRead + cacheWrite`，看起来像累计只因 `cacheRead` 随对话增长。已改回求和。

## 请重点审这些

0. **新预算数值下的最坏情况**。per-task 250k × 并发 3 = 单 phase 约 750k，4 phase 理论上界远超 run 的 1.5M；`maxTokensPerTask` 被 `Math.min(..., maxTotalTokens)` clamp。请算出真实的 token 与墙钟上界，指出这套数字有没有内部矛盾（例如 run 预算先撞、导致后面 phase 永不派发而报告仍宣称成功），以及 900 秒 × 4 phase 的串行等待是否需要一个总 deadline。

1. **进程组升级的时序**（`index.ts` 的 `terminate`）。已经改过两轮：第一版只在 leader 存活时升级（漏杀忽略 SIGTERM 的后代），第二版无条件升级（把 pid 复用风险带回来），现在按调用时刻的 leader 状态分三路 —— 已退出则立即升级、仍运行则等 `exit`、无响应则靠 5 秒 timer，并用一个 latch 保证只发一次信号，`close` 时清 timer。请找出这个时序仍会漏杀或误杀的情形。

2. **`checkPath` 的 `requireResolve` 两个调用点**（`child-guard.ts`）。文件工具传 `true`（不解析即拒），shell 参数传 `false`（保留词法检查）。请核对这个划分：有没有文件工具的路径本该允许不存在的情形；shell 侧保留词法检查是否留下了能读到 workspace 外文件的具体写法。

3. **`grep` 限单文件之后的等价绕过**。`grep` 现在必须指定单个文件且不能是目录。`find` 与 `ls` 仍可作用于目录（它们只列名字不读内容）。请判断这个区分是否站得住：`find`/`ls`/`read` 的组合能否达到"批量读取受保护文件内容"的同等效果。

4. **per-task 预算的两个检查点**。`message_update` 时按 `tokens + live` 判、`message_end` 时按累加后的 `tokens` 判，撞上限则终止并保留已有文本。请判断真实上界，以及有没有让 `inFlight` 条目残留、或让预算判定被单个超长 response 绕过的路径。

5. **后台交付路径**。tool 立刻返回 run id，跑完 `sendMessage({triggerTurn: true, deliverAs: "followUp"})`；run 被 abort 时不投递。请找 `active` 计数漂移、投递重复、或报告在非 shutdown 情形下丢失的路径。

6. **报告汇总的边界**。转义后的份额收缩现在把 header 与编码后的 gap 列表算进同一份预算（`overhead` / `reportCap`）。请构造能让有效证据静默消失、或让最终返回值超出 `MAX_REPORT_CHARS` 的输入 —— 注意 `overhead` 依赖 `gaps` 与 `header` 已先构造，这个求值顺序刚出过一次 temporal dead zone。

7. **死代码与可合并的重复**。`index.ts` 与 `child-guard.ts` 里还有没有无人调用的函数、不可达分支、或两处几乎相同的逻辑。给出调用路径依据。

8. **上一轮已修两条的回归面**。（a）`terminate()` 在 leader 已退出时调用的路径；（b）header 与报告共用预算。这两处刚改完，请专门验证有没有引入新的失效模式。

## 硬约束

- 不要建议加 hash / checksum / 完整性链。
- 不要建议把跨进程锁、resume、状态版本迁移、并发爬坡加回来。
- 不要建议引入运行时依赖（当前零依赖，只用 Node 内置模块 + Pi 自带的 typebox）。
- 不要建议做独立的规划 agent 决定任务数。
- 不要报 shell 命令白名单的覆盖面（见取舍 10）。
- 防御要成比例：不为基本不可能发生的情况加分支、断言或 try/except。
- 不要建议下调 token/超时预算，也不要把消耗量本身当缺陷（见取舍 11）。

## 交付格式

每条给：`文件:行号 → 一句话缺陷 → 触发条件 → 后果 → 最小修补（≤5 行代码）`。按严重度排序，最多 10 条。判定"实现正确"的项用一行说明依据。第 0、1、7、8 项无论结论如何都要明确表态。最后一句总体判断：能不能直接用，最该先修哪一条。
