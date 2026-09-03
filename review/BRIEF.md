# 审计任务书 · pi-ultra-workflow（第 2 轮）

给独立 reviewer（codex）的自包含审计上下文。目标是找**当前代码里还没被发现的真缺陷**。第 1 轮的 10 条已全部处置，不要复述。

## 待审对象

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `index.ts` | 644 | 调度器：plan 校验、phase 串行、phase 内并发、spawn child、解析 NDJSON、预算、汇总报告 |
| `child-guard.ts` | 208 | child 的 `tool_call` 边界：路径归一化与检查 + shell 命令策略 |
| `tests/verify.mjs` | 257 | 123 项静态检查 |
| `tests/harness/cli.js` | 285 | 37 项端到端检查（真 spawn，假 child） |

只读审计。**禁止修改任何文件，禁止 commit，禁止运行真 `pi` 会话**（会消耗订阅额度）。跑 `tests/` 里两个脚本是允许的，它们不发任何 provider 请求。

## 它是什么

Pi 的一个 extension，注册单个 `Workflow` tool。主 agent 传入 phase 列表，调度器 spawn 若干只读 child（`pi --mode json --print` 子进程），phase 之间串行、phase 内最多 3 并发，最后把证据汇总成一份报告返回。前台阻塞调用。child 默认只有 `read/grep/find/ls`，task 显式声明 `shell: true` 才额外获得 `bash`。

## 刻意的设计取舍 —— 这些不是缺陷，别报

1. **前台阻塞**，无 background、无 resume、无锁。理由：这是一次 10–30 分钟的只读审计，崩了重跑即可。
2. **状态 JSON 只是日志**（`writeLog` 整个 try/catch 吞错），永不参与控制流。
3. **失败降级**：单个 child 失败记为证据缺口，兄弟继续、后续 phase 继续；只有"某 phase 全灭"或"全部 task 失败"才终止。
4. **输出超限截断标注**，不判失败。
5. **固定并发 `min(taskCount, 3)`**，没有爬坡。
6. **`shell: true` 允许跑项目自己的脚本**（`npm run`、`make`、`cargo build`、`python3 script.py`）。这是该功能的全部意义；禁掉等于取消它。构建/测试命令可能因此拉取依赖而联网 —— 这是运行项目工具链的固有属性，已在 README 声明。
7. **`child-guard.ts` 不是沙箱**，child 以同一用户身份运行。它防的是误操作和 repo 内容注入。README 明确写了：在不信任的 repo 上开 `shell: true` 等于运行那个 repo 的代码。
8. **`MODEL` 硬编码**为单一常量。
9. **flag 策略按命令区分**而非全局黑名单：`-c` 对 python 是执行代码、对 head 是数字节；`-m` 对 python 是模块、对 pytest 是 marker；`-p` 对 pytest 是插件、对 git 是 patch。全局黑名单会同时漏掉危险项和误伤常用项。

## 已知限制 —— 已承认，别重复报

1. `maxTotalTokens` 是"派发闸门 + in-flight 估算"，不是硬上限；已派发的 task 会跑完。
2. Pi 没有任何内置 web/fetch 工具（源码级确认：`dist/core/tools/index.js` 的 `allToolNames` 只有 8 项）。
3. 长 run 占住 Pi 会话。
4. macOS / Linux only，Windows 在 tool 入口 fail-fast。
5. **`git log -p` 与 `git show` 会输出历史中被 commit 文件的完整内容，包括 `.env` 这类被 secret-name 规则保护的文件。** 实测已发生（见下方待审第 4 项）。

## 第 1 轮已修 —— 别当新发现报

第 1 轮 10 条 findings 已全部处置，涉及：路径归一化与 Pi 不一致、glob 展开发生在检查之后、git revision spec 未检查、npm/cargo 子命令未限制、`git branch`/`tag` 被误当只读、以 `-` 开头的参数整体跳过路径检查、加载外部模块的选项未覆盖、多轮 `toolUse` 的 token 对预算不可见、`exit` 兜底未清理子进程、被 ceiling 留成 `pending` 的 task 让上游证据算作已消费、报告长度在转义前计算、`slice` 劈开 surrogate pair、Windows 分支静默失效。

另有三条本轮自查发现并已修：`npm view` / `npm outdated` 会查 registry；`git log -p`、`head -c`、`pytest -m marker` 被全局 flag 黑名单误禁。

## 测试已覆盖 —— 不必重复投入

- `verify.mjs`（123 项）：真 Pi loader 加载、只注册一个 tool、`executionMode`、planner 五类拒绝、workspace 三类拒绝、防递归、path 写回 canonical 绝对路径、指向 workspace 外的 symlink、`file://` 与 `@file://`、Unicode 空格、大小写变体、`.git` 子路径、凭据 pattern、glob 三形式、revision spec、npm/cargo 子命令、per-command flag 策略（`python -c/-m`、`node -e/--require`、`pytest -p`、clustered `-ic` 拦住；`git log -p`、`head -c`、`wc -c`、`pytest -m`、`pytest -xvs`、`npm ls`、`cargo build` 放行）
- `harness/cli.js`（37 项）：3 child 真并发重叠、并发峰值恰为 3、phase 屏障、失败降级全链、超长截断、空输出成缺口、token 熔断阻断整个下一 phase、未派发项进 gaps、phase 全灭终止、per-task deadline 真等 30 秒、转义膨胀后报告仍在上限内、多轮 toolUse 的 in-flight 门禁、显式部分依赖产生的孤儿证据告警
- 真 `pi` + 真 Sol 联调 5 轮，最近一轮两个 `shell: true` task 分别真跑了 `git log -p -1` 和 `head -c 30`

## 审查性质

这是对一个自有开源工具做**正确性与完备性审查**：核对"实现出的行为"与"声明的意图"是否一致。意图有两条：child 只读、且只作用于 workspace 内。

请用规则文件逐条推理，**不要构造或运行任何破坏性命令**。需要核实某条规则的判定时，把 `child-guard.ts` 的 default export 单独 import 出来、喂普通字符串取返回值即可（`tests/verify.mjs` 里有现成的 jiti 加载写法）；临时脚本写在 `/tmp` 下不用清理，我会处理。

## 请重点审这些

1. **选项语义的覆盖面**（`child-guard.ts:52-76`）。`ALLOWED_COMMANDS` 里每个命令逐个核对它的选项文档：哪些选项的实际效果超出"只读、限于 workspace"这个意图（写文件到别处、加载外部模块、访问网络），而现在的 `COMMAND_BANNED_FLAGS` / `CLUSTERED_RISK` 没有覆盖到？重点是 `make`、`cargo`、`npm`、`jq`、`rg`、`diff`、`stat`、`nl` —— 这几个我核对得最粗。每条给选项名 + 它在 man page 里的语义 + 建议归入哪个规则。

2. **`flagValue()` 的解析覆盖面**（`child-guard.ts:约 115`）。当前只从 `--flag=value` 和 clustered `-fvalue` 里取值。空格分隔的 `--flag value` 我的推理是：`value` 是独立 token、不以 `-` 开头，因此走 bare-argument 的路径检查。**请验证这个推理**，并测这些形式：`--flag=`（空值）、`-f=x`、`--`（分隔符）之后的参数、重复 flag、`--flag==x`、以及值本身以 `-` 开头时。

3. **子命令白名单与"无网络"意图是否一致**（`child-guard.ts:44-50`）。`npm run <任意脚本名>` 和 `cargo run` 是刻意允许的（跑项目自己的脚本）。要核对的是列表内其余子命令的实际行为：`npm ls` 在依赖树不完整时会不会请求 registry、`cargo metadata` 会不会写 `Cargo.lock`、`cargo tree` 会不会刷新索引。凡是会联网或写文件的，应该移出白名单。

4. **`git log -p` 的输出范围与 secret-name 规则的意图不一致**。规则声明保护 `.env` 这类文件名，而 `git log -p` 打印的是历史快照里的文件内容，其中就可能包含它们 —— 实测确认过（一个把 `.env` commit 进历史的仓库，`shell: true` 的 child 跑 `git log -p -1` 后 diff 里出现了该文件的内容）。显式路径形式（`git show HEAD:.env`）已被 revision-spec 检查覆盖，全量 diff 没有。请表态：这个不一致该由规则消除，还是该由文档承认？如果该消除，给一个不破坏 `git log -p` / `git diff` 日常可用性的写法（≤5 行）；如果该承认，说明理由。

5. **报告收缩迭代的收敛性**（`index.ts:约 555`）。逻辑是：按 `MAX_REPORT_CHARS / chosen.length` 算份额、构建、若 `safeJson` 后超限则按实际比例收缩份额，最多 3 轮，份额下界 256。我的论证是必然收敛：下界 256 × 最多 8 个 task × 最坏 6 倍转义膨胀 ≈ 13k < 48k。请证伪或确认，并构造能让 3 轮迭代后仍超限的输入。

6. **`normalizeLikePi` 与 Pi 的逐项对齐**（`child-guard.ts:约 88`）。我实现了 Unicode 空格、`@` 前缀、`~` 展开、`file://`，**故意没有**复现 Pi 的 `resolveReadPath` 的三种 fallback（NFD、curly quote、AM/PM narrow space）。我的论证：这三种只改文件名字符、不改目录层级，而 secret 列表（`.env`、`id_rsa`、`auth.json`、`*.pem`、`.git` 等）全是 ASCII，NFD 不改变它们，所以不构成未被规则覆盖;而每个通过检查的路径都被写回 canonical 绝对路径，Pi 对这类路径的解析是幂等的。**请反驳或确认这个论证**，特别是"写回 canonical 路径后 Pi 不会再做变换"这一步。

7. **`clip()` 的字符边界**（`index.ts:约 184`）。它只去掉尾部孤立的高代理，不处理组合字符（`é` = e + U+0301）和 ZWJ emoji 序列（`👨‍👩‍👧` 会被劈成半个家庭）。请评估这在实践中是否要紧、是否值得修。

8. **in-flight 记账的上界**（`index.ts:约 311、348、369、382`）。当前：spawn 前按 `prompt.length / 4` 垫一个下界；`message_update` 时取 `Math.max(已有, 已完成轮 tokens + 本轮 live)`；`message_end` 若 `stopReason === "toolUse"` 保留 `tokens` 而非删除；失败时把 `Math.max(tokens, inFlight)` 记入总量。请判断这套记账的真实上界，以及有没有让 `inFlight` 条目永久残留（从而永久占用预算、阻断后续派发）的路径。

## 硬约束

- 不要建议加 hash / checksum / 完整性链 / 指纹校验。
- 不要建议把 background、跨进程锁、resume、状态版本迁移、并发爬坡加回来。
- 不要建议改用容器或 VM 沙箱。
- 不要建议禁掉 `npm run` / `make` / `cargo build` / 运行项目自己的脚本 —— 那是 `shell: true` 的全部意义。
- 不要建议引入任何运行时依赖（当前零依赖，只用 Node 内置模块 + Pi 自带的 typebox）。
- 防御要成比例：不为"基本不可能发生"的情况加分支、断言或 try/except。
- 不要写 `.md` 报告文件，结论直接回复。

## 交付格式

每条 finding 给：`文件:行号 → 一句话缺陷 → 触发条件 → 后果 → 最小修补（≤5 行代码）`。按严重度排序，最多 10 条。凡是判定"实现正确"的项，也用一行说明依据。对上面第 4、5、6、7 项，无论结论是"该修"还是"不该修"，都必须明确表态并给理由。最后给一句总体判断：能不能直接用，最该先修哪一条。
