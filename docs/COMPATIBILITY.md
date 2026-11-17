# Watch · 客户端兼容性证据

> 更新：2026-09-10。按路径、方向、客户端和版本记录，不按品牌笼统宣布支持。
>
> 本仓库不分发 `docs/evidence/` 下的原始 JSON 验收记录；正文提到的记录名仅作标识，对应文件保留在本地开发环境中。

## 1. 状态约定

- **实现存在 / 待验收**：代码有对应能力，尚无本清单要求的完整原生证据。
- **官方有依据 / 待集成**：官方记录互通能力，但 Watch 未完成集成和验证。
- **已验证**：指定平台与版本下，来源内容、目标 ID、cwd 和原生继续均有证据。此文当前没有新增此类结论。
- **仅可读出 / 摘要交接**：不具备完整原生转入能力；必须明确方向或降级性质。
- **未支持 / 待调研**：没有实现或缺少可证明的协议，不生成可用入口。

## 2. 当前路径矩阵

| 来源或目标入口 | 当前实现/官方依据 | Watch 状态与限制 |
|---|---|---|
| Claude Code CLI、Codex CLI、Kimi CLI、OpenCode CLI、Pi CLI | 本地解析、转入与恢复命令，桌面有五张目标卡 | 实现存在 / 待逐方向、版本验收；OpenCode 产品入口使用基础 CLI 适配器，不意味着五家全组合通过 |
| Kimi 新建会话 | 【2026-09-16 决策 A：保持 fail-closed，不提供离线自建会话入口】无 `into` 时必须在目标 cwd 调用真实 `kimi -p .`（真实模型调用）才能拿到原生 session id 并登记 `session_index.jsonl`；**追加到既有会话不走 CLI，无 CLI 时也照常工作**（已由本地回归固定）。验证阻塞：本机未安装 kimi CLI、无 `~/.kimi-code`、仓库也无「无 prompt 建会话」文档证据，因此既无法验收也无法改为无副作用路径；Kimi 侧的模型继续同样未验收（本机无 CLI）。2026-09-16 额外检索了本机既有实现与缓存，看是否有可复用的离线创建逻辑：唯一另一份 Kimi wire 实现是同源上游项目 tongbu（第三方仓库 `czm15053/tongbu`，当时在本机保留只读副本，现已移除；其实现同样是 `kimi -p .`，无可复用新逻辑（且它仍带 Watch 已修的三处问题：缺 cwd 预检、错误分类、追加保留历史）；`boss-agent-cli` 文档只把 Moonshot 当 API provider，不含 CLI 会话格式；npm 缓存、全局 `node_modules`、常见 bin 目录与 Applications 均无 kimi CLI 或其包 | 已知限制；解除条件：装有 kimi CLI 后确认是否存在无 prompt 的会话创建方式（若存在再评估是否开设显式 opt-in 入口） |
| Grok CLI | 适配器已注册，桌面已接入目标卡（`grok -r <id>`，YOLO `--always-approve`） | 实现存在；2026-09-14 隔离原生验收通过 `sessions list` / `export` / ACP `session/load` 回放（不发 prompt）。真实终端 TUI 画面与模型继续未验证 |
| Codex CLI → 桌面端 | S1 `/app`；S2 指定本地会话深链接 | Watch 已为官方导入的目标线程接入固定 deep link；其他来源仍待集成和验证 |
| 已导入 Codex 会话 → 桌面项目成员 | S7 实验性项目查询与元数据接口；S8 当前 Desktop 私有筛选 | 后置 app-server 关联可验证后端成员关系，但不能解除 projectless 排除；不再作为 GUI 修复路径 |
| Claude Code → 官方 Codex/桌面导入 | S3 用户流程；S6 官方 app-server；S8 当前 Desktop 私有筛选 | `--desktop-project` 要求项目先存在；真实合成样本已通过技术预检、项目列表及 Watch Tauri 预览/确认/两次独立打开验收。当前本机 CodexPilot 的既有续写失败仍阻止标记完整模型继续可用 |
| Claude Code → Watch 转换 → Codex 桌面端 | 现有 Codex 构建器 + S2 候选入口 | 原生读回/resume 可用，但工具结果未出现在查询历史中；严格验收失败，不开放桌面入口，保留写入守卫 |
| Codex 桌面会话 → 其他 Agent | Watch 扫描 Codex rollout，可能覆盖兼容的本地记录 | 来源版本、路径和内容覆盖待测；不推导远程会话支持 |
| Claude Code CLI → Claude Desktop Code | S4 明确历史分离；S13 确认交互式 `/desktop` 的本地 handoff 顺序 | 官方有依据 / 待验收；仅 macOS、x64 Windows及订阅登录。直接 deep link 不会保存/flush 当前 transcript，不能作为 Watch 自动迁移入口；最终复核时本机 CLI 与 Desktop 均不存在 |
| OpenCode CLI ↔ OpenCode Web/TUI | 基础适配器提供 SQLite 转入和 `opencode -s` 恢复；S5/S9/S12 覆盖官方多客户端增强 | 现有 OpenCode CLI 卡片继续沿用基础基线。Darwin arm64 / 1.18.29 的官方 import/export、server API、Web、独立 local TUI 与 attached TUI 历史可见已通过；单次无工具继续请求因 provider 429 未生成回复，因此只是不接入新的官方多客户端入口；当前官方索引未提供独立 Desktop 客户端契约。Watch 的 SQLite 适配器只在 1.x 布局（`session` / `message` / `part`）上验证；2.x 布局（`session_v2` / `session_message`，迁移库可能同时留着旧表）尚无实现，读写入口都会明确拒绝并披露，不宣称兼容 |
| OpenCode IDE 扩展 | S9 扩展在 IDE 集成终端启动或聚焦 OpenCode | 不是独立会话存储；不能由扩展安装推导外部历史已导入 |
| Antigravity 2.0 → Antigravity CLI | S10 `/resume` 的 Antigravity 页签可确认后克隆 history、context 与 tool trajectories；S14 本机 CLI/官方文档复核 | 官方有依据 / 待验收；这是同产品交互式单向导入，不是其他 Agent → Antigravity 接口。本机有 `agy 1.1.26`，无 2.0/IDE 应用；未打开 picker |
| Antigravity ↔ 其他 Agent | 当前 registry 无适配器；S11 SDK 是独立 Agent runtime | 未支持；未发现外部会话导入/导出契约，不生成目标入口 |
| Claude 普通聊天、Cowork、云端或 SSH 会话 | 有些官方工具覆盖其中部分产品形态 | 不在本轮默认范围，不因 S3 扩大 Watch 承诺 |

## 3. 官方依据及不能推出的结论

文档核查日期为 2026-09-07 至 2026-09-09。页面可能更新；实现前重新核查相关章节和本机版本，不将此记录当成永久协议。

| 编号 | 官方页面及章节 | 本次记录的契约 | 限制 |
|---|---|---|---|
| S1 | [Developer commands](https://developers.openai.com/codex/cli/slash-commands.md)，Continue in the desktop app with `/app` | macOS/Windows 从 CLI 打开同一段已保存聊天；应用需已安装并运行 | `/app` 是会话内命令，不是 `codex app`；不证明手工文件已被原生登记 |
| S2 | [Commands](https://learn.chatgpt.com/codex/reference/commands.md)，Deep links / Chats | `codex://threads/<thread-id>` 打开指定本地聊天，使用技术 thread ID | 不能替换为来源 Claude ID；协议受理不等于加载成功，不推导远程会话支持 |
| S3 | [Import from another agent](https://learn.chatgpt.com/codex/import.md) | 桌面设置中的导入流程及 CLI `/import` 可选支持的项目、设置与近期聊天；保留原设置 | CLI 当前最多近 30 天的 50 个聊天，并有运行任务/远程/daemon 限制；编程接口单独以 S6 与本机行为核验 |
| S4 | [Claude Desktop application](https://code.claude.com/docs/en/desktop.md)，Coming from the CLI? | Code 桌面端与 CLI 共用引擎但历史独立；有受平台和认证方式限制的 `/desktop` 迁移 | 不等于 Chat/Cowork 会话格式兼容，也不证明反向路径 |
| S5 | [OpenCode Server](https://opencode.ai/docs/server/)，Sessions / Messages | 有会话列表、详情和消息接口，可研究复用 | 有接口不等于允许任意历史原样导入；Watch 当前未连接这套服务接口 |
| S6 | [Codex app-server](https://learn.chatgpt.com/docs/app-server)，`externalAgentConfig/detect` / `externalAgentConfig/import`；本机 `app-server generate-json-schema` | 显式指定 `SESSIONS`、会话路径与 cwd；完成通知通过 importId 关联，并报告 source/target | 仅验证 0.153.4 的合成单会话；工具原生结构未保留，文本参数与结果通过校验；生成 schema 不保证所有接口已实现 |
| S7 | 官方 CLI 0.153.4 的 `app-server generate-json-schema --experimental`，`ProjectReadParams` / `ThreadMetadataUpdateParams` / `ThreadListParams`；下方原生报告 | `project/read` 检查现有项目，`thread/metadata/update` 指定 `projectId`，`thread/list` 按项目筛选 | 需要实验性握手；只验证单根目录、不迁走其他项目会话。当前合成样本的 GUI 列表已通过；本机配置的模型继续仍失败 |
| S8 | 本机 ChatGPT Desktop 26.901.51231 的只读 bundle/状态检查，记录 | 项目筛选同时使用 cwd、私有 assignment 与 `projectless-thread-ids`；projectless 可排除 cwd 匹配线程 | 非公开实现且可能随版本变化；只能用于保守拒绝和测试设计，Watch 不写这些私有字段 |
| S9 | [OpenCode CLI](https://opencode.ai/docs/cli/)，`export` / `import` / `models` / `--session`；[Web](https://opencode.ai/docs/web/)；[Server](https://opencode.ai/docs/server/) | 会话可导出 JSON并从本地文件或 share URL 导入；Web 与 attached TUI 可共享同一 server 的 sessions/state；Server 提供 session/message/provider API | 文档未承诺可导入任意第三方 schema。Watch 的 1.18.29 合成 export 已获真实 import、多客户端历史可见和目标模型有效证据；唯一一次无工具 prompt 到达 provider 后返回 429，未生成回复，模型继续仍未通过 |
| S10 | [Antigravity CLI Resume](https://antigravity.google/docs/cli/commands/resume)；[Managing conversations](https://antigravity.google/docs/cli/conversations) | `agy --conversation <id>` 恢复指定 CLI 会话；picker 可将 Antigravity 2.0 会话确认后克隆到 CLI；CLI 历史按 cwd 作用域 | 该导入在交互式 picker 内完成，文档未给出外部格式或无交互导入 API；不能推广为 Watch 可写入 Antigravity |
| S11 | [Antigravity SDK](https://antigravity.google/docs/sdk/overview)；[IDE](https://antigravity.google/docs/ide/overview) | SDK 提供独立的 stateful runtime；IDE 是带 editor/terminal/browser 的本地 agent 环境 | SDK 会话生命周期不等于 Antigravity 2.0、CLI 或 IDE 的用户会话存储协议 |
| S12 | OpenCode v1.18.29 的 `export.ts`、`import.ts`、ID schema 与 `import.test.ts`，源码检查记录 | 顶层为 `info` + `messages`，没有独立格式版本；导入保留 session/message/part ID，并把 project、directory、path 改绑到当前实例；原生 ID 为 12 hex + 14 Base62，session descending、子项 ascending | 同 ID session 会更新归属，message/part 冲突会跳过；命令没有显式整体事务，官方测试也未覆盖完整本地导入和重复导入。源码检查不是原生验收 |
| S13 | 本机 Claude Code 2.1.258 编译产物只读检查，实现检查记录 | `/desktop` 取得当前 transcript，保存 `desktop_handoff`、flush 状态、打开 `claude://resume?session=<id>`，成功后约 500ms 退出 CLI；最低 Desktop 版本为 1.1.9669 | 该 slash command 不是普通 CLI 子命令；直接打开链接跳过保存/flush。产物最终复核时已不存在，且未安装 Desktop，因此没有原生转移或 GUI 证据 |
| S14 | Antigravity CLI 1.1.26 本机帮助与官方 Markdown，检查记录 | 2.0 导入只记录为 `/resume` picker 内带二次确认的交互流程；`--conversation` 恢复既有 CLI ID，`-c` 按绝对 cwd 查缓存并向后端验证 | 未记录任意外部格式或无交互 2.0 import；`-c` 在缓存/目标缺失时会新建会话，不能用于无副作用探测。未直接读取本机缓存或运行 picker；一次失败启动是否访问 cache 无法确认，mtime 未变 |

当前 OpenAI 页面将桌面应用称为 ChatGPT desktop app，并记录兼容的 `codex://` 协议。产品显示名、进程名与会话协议要分开判断；不凭“Codex.app 不存在”认定没有桌面入口。

OpenCode 的 内部实现记录 只证明 Watch 的生成、计划、单次提交和失败关闭逻辑通过隔离测试，不能单独作为原生证据。修复后的 native、server、Web/attached TUI 与 独立 local TUI 记录确认 1.18.29 接受生成的 export，三个客户端显示同一目标历史与有效模型。获单独授权后的 模型继续尝试 使用全局工具 deny，只产生一条合成 user 消息和一条 provider 429 assistant 错误；没有回答、token 或新增工具 part，不能宣称模型继续已验证。后续 只读复核 确认服务、消息数量、错误和权限状态未变，且没有第二次请求。

Watch 的 `src/providers/opencode/index.ts` 配合桌面卡片和恢复命令作为基础产品路径；现有实现包含环境变量、共享路径解析、原生 ID 修正和相应隔离测试。官方 JSON 路径位于额外文件中且未注册到 provider registry，因此其 429 不影响基础 OpenCode CLI 卡片。

OpenCode v1.18.29 的 多客户端命令检查 进一步区分了独立 `--session` TUI 与 `attach`：只有 `attach <url>` 才连接由 `web` 或 `serve` 启动的既有 server。后续共享状态验收必须同时记录 server URL、目标 session、cwd 与只读 API 结果，不能用两个各自启动的本地客户端替代。

当前 Darwin arm64 主机的 只读安装预检 固定了 `opencode-ai@1.18.29` 与对应原生包的 registry integrity。后续下载的两个 tarball 均匹配记录；wrapper `postinstall` 未执行，原生包只在私有临时 prefix 和隔离 HOME/XDG 中运行。预检本身仍只是历史包元数据，客户端结论来自新的原生与 GUI 报告。

Claude 的 本机实现检查 解释了为什么不能把 `claude://resume` 当成独立导入 API：保存 transcript 和 flush 状态发生在链接打开之前。它只支持设计候选流程，不代表 Watch 已验证 Claude Desktop。

Antigravity 的 本机与官方检查 将交互式 2.0 import、既有 CLI ID 恢复和按 cwd 的 `-c` 恢复分开。CLI 命令存在不等于 Watch 获得了外部会话写入协议。

Grok 的桌面卡片曾因 `resume` 打开不正常而被移除。2026-09-14 定位到根因并修复：Grok 内置文档 `docs/user-guide/17-sessions.md` 明确 **`updates.jsonl`（ACP `session/update` 日志）才是 `/resume` 与 session restore 的权威会话来源**，`chat_history.jsonl` 只是发给 model 的原始消息；Watch 原先只写后者，因此原生打开时看不到任何对话。修复后 `src/providers/grok/build.ts` 同步写 ACP 日志（`user_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `agent_message_chunk` / `turn_completed`，`timestamp` 为 epoch 秒），并从本机最近原生会话探测 `current_model_id` / `agent_name` / `reasoning_effort`（此前硬编码的 `grok-4.5-build-free` 在本机根本不存于模型列表）。

隔离验收（`GROK_HOME` 指向临时目录、合成来源、全程不发 prompt / 不调用模型、不读写真实 `~/.grok`）：`grok sessions list`（会话 cwd 下）列出该会话；`grok export <id>` 完整渲染对话与工具；`grok agent stdio` 的 ACP `session/load` 回放全部 `session/update`。

**TUI 逐帧验收（2026-09-16）**：裸 PTY 下 grok 只发终端标题转义（屏幕无法确认）；改用 PTY + 终端查询应答器（DA1/DA2/DSR/`CSI 18t`/OSC 10-11）+ 正确的 `TIOCSWINSZ` 窗口尺寸后，`grok -r <id>` 真实渲染出会话内容：帧里出现 `TUI_FRAME_MARKER 请回答 4242` / `TUI_REPLY_MARKER 已记住 4242`（含 `42 / 500K` 上下文计量）。同一帧还暴露了身份缺陷：`Model "grok-4.5-build-free" is no longer available for your account. Switched to "grok-4.6".` —— 硬编码 model id 已被原生判为不可用。

**身份保真（承上修复）**：model id 改为探测顺序「本机最近原生会话 `current_model_id` → 非交互 `grok models` 的 `Default model` → 常量」，`agent_name` / `reasoning_effort` / `sandbox_profile` 同样探测，`model_fingerprint` **只沿用同一 `model_id` 的原生 assistant 行**（探测不到就不写，不伪造）；并修复了「新建空会话抢‘最新会话’位置」导致身份与 fingerprint 丢失的双重探测问题。用新写入器重跑：`sessions list` / `export` / ACP `session/load` 仍通过，且写出的 `current_model_id` 与 assistant 行均为原生默认 `grok-4.6`。

**`grok usage` 的验证否定（2026-09-16）**：`grok usage <session-id>` 是非交互命令，但本机隔离合成会话与真实原生会话均返回 `No usage recorded`；原生 `signals.json` 只有 `contextTokensUsed` / `contextWindowTokens` 等聚合计数，没有 in/out token 总额。因此 `grokSessionUsage` 仍返回 `null`（不接 CLI、不解析拿不到的数据）。

**模型继续验收（2026-09-16，真实凭据）**：在临时 cwd 用 Watch 写出一条合成会话（写入真实 `~/.grok`），再用真实 `grok agent stdio` 走 ACP：`initialize` → `session/load` → `session/prompt`（一个最小提示词）→ 模型返回 `已记住收到`。验收后已执行 `grok sessions delete <id>` 并复核会话目录与临时 cwd 均不存在。这是单条合成样本、单轮、无工具调用的限定结论；不推广到其他版本、平台或远程会话，也不改变其他 Provider 的旧结论。记录名 grok-model-continuation-native-2026-09-16（本地 `docs/evidence/`，不随仓库分发）。

**Grok 分组目录规则对照（2026-11-15，文档对照 + 合成目录检查）**：grok 1.0.77 内置文档 `docs/user-guide/17-sessions.md` 写明分组目录名是工作目录的 URL 编码；编码名超过 255 字节时改用「slug + hash」，并在分组里用 `.cwd` 记录原路径。Watch 原先只按 `encodeURIComponent` 取一个目录：深层中文路径（每个汉字占 9 个编码字节）在列出与新建会话时得到 `ENAMETOOLONG`，slug 分组里的会话按 id 反查时会被静默跳过或把分组名当成工作目录。v0.1.51 起按「分组名解码后等于该目录，或分组里的 `.cwd` 记录的是该目录」认领分组，新会话优先写进已有分组；`.cwd` 先 `lstat` 要求普通文件（符号链接可能指向 FIFO 导致命令永久阻塞）并限 4 KB、内容必须是绝对路径且无控制字符；无法归属的分组走 `unattributable()` 在 `sessions` / `recent` / `status` / `doctor` 披露，不合并不静默丢弃。slug / hash 的算法与原生的转义字符集没有公开，Watch 不猜——长路径且没有原生分组时拒绝写入，并说明先用 grok 在该目录启动一次。本项没有运行原生客户端创建长路径会话，不能当作原生验收。

**目录变量的跨 cwd 约束（2026-11-15，v0.1.59，代码复核 + 隔离合成检查）**：`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GROK_HOME`、`KIMI_CODE_HOME`、`PI_CODING_AGENT_DIR` 与 `PI_CODING_AGENT_SESSION_DIR` 共用 `providerDirectoryFromEnv()`，要求完整绝对路径。Watch 与目标 CLI 的 cwd 可能不同，不能把相对值只按 Watch 的 cwd 绝对化，也不能原样交给另一 cwd 的原生进程后仍宣称路径一致。仅 Pi 保留其原生支持的 `~` / `~/` 展开（Windows 另认 `~\`）；其他变量的字面 `~` 值拒绝并提示写绝对路径。未设置或空字符串使用默认目录；不再 trim，绝对路径的空格原样保留，纯空白值会报相对路径错误。错误回显转义控制字符；聚合命令保留逐家失败披露，官方导入在目录解析失败时不建立执行日志。Windows 当前盘符根路径（如 `\data`）同样拒绝。本轮未运行原生 CLI，不能增加原生恢复或 Windows 真机验收结论。v0.1.59 同轮确认的 Pi 平铺目录缺陷已在 v0.1.60 修复，详见下条；设置项仍未读取。

**Kimi 工作区分组读取故障的披露（2026-11-15，v0.1.71，行为提交 `275b79b`，隔离合成检查）**：Kimi 会话按 `sessions/<workspaceId>/<sessionId>/agents/main/wire.jsonl` 存放，归属由 `session_index.jsonl` 决定。以前 `scanKimiSessionDirs()` 对分组 `readdir` 失败一律静默跳过，`kimiUntrackedSessions()` 与 `kimiIndexLoss()` 都少一片，列表可能把「没查成」讲成「这个目录没会话」。现在：一次 `scanKimiDisk()` 同时给出会话目录、故障分组与根目录故障；`unattributable` 新增 `locations` 档，按「位置」披露读不出来的分组 / 根目录，不与会话文件混算；列表不再因无关分组故障整家失败，仅在本 cwd 的分组不可读且没有任何条目时拒绝「没会话」的结论；索引文件缺失而磁盘仍有会话目录时，列表与按 id 反查都报「查不了」，反查为 `SessionLookupFailureError(incomplete)`。识别 `wd_..._[0-9a-f]{12}` 名称被非目录占住、目录能列出但会话 stat 不了两档；符号链接不跟随并按路径类型故障披露。10 项新增检查与 104 项相关回归通过，完整隔离回归 2140 项通过、0 失败、0 跳过；未读取真实历史、凭据或启动原生客户端。

**Codex 压缩副本的链路披露与普通文件口径（2026-11-17，v0.1.72，隔离合成检查）**：v0.1.70 只在列表 / 反查发现只剩 `.jsonl.zst` 时披露，但链路上的 `status` / `switch` / `new` / `chain list` / `doctor` 仍只对原路径 `stat`，把它讲成「文件已不存在」并建议重新绑定——而原生继续该会话会把它重新展开成 `.jsonl`。现在 `sessionFilePresence()` 在原路径缺失时只读 `lstat` 一次同名 `.zst`（不解压、不打开、不改动），命中返回 `{ state: 'missing', compressed }` 与共用文案 `compressedSessionNote()`；`.zst` 是目录 / 符号链接时不算压缩副本。链路各入口据此改说「已被 Codex 压缩、文件还在」，`doctor` 的 `brokenTips` 增加 `compressed` 并在摘要单独计数，`sessions --chain` 单列披露。全局反查的递归扫描改用 `lstat`、只认普通文件：符号链接（含悬空链接）不再被当成普通副本或 rollout，与列表侧 `Dirent.isFile()` 一致；`stat` 跟随链接的旧行为与「只识别普通文件」的文档口径冲突。同轮修正混合计数建议（坏首行 + 压缩副本不再说「文件本身是完好的」）与 `adopt` / `open` 的相反指引。11 项新增隔离检查与完整回归 2151 项通过；`.zst` 内容仍未读取，不构成原生验收。

**Codex 压缩副本的 switch 主路径与结构化分档（2026-11-17，v0.1.73，隔离合成检查）**：v0.1.72 的压缩识别只覆盖「一个会话都挑不到」的零结果分支，`switch` 常见的链上配对目标、mtime 兜底、already-at-target 与来源解析仍把「原路径不在、同名 `.jsonl.zst` 在」讲成「文件已不存在」并静默改绑，`open --to` 的链配对复用同理。现在这五处都先 `sessionFilePresence()`：目标复用失败时披露「已被压缩」并说明改为新建，already-at-target 改说压缩与「先让它重新展开」，来源解析错误不再出现「已不存在」，`open --to` 的 diagnostics 同口径。`chainUsage` 的 Codex 分支以前不可达（`codexSessionUsage()` 对缺失文件抛错），现在 catch 中按 presence 分档。`doctor` 的 `brokenTips` 由布尔 `compressed` 改为 `compressedPath`，逐链行打印真正存在的 `.zst`；`pathPresence()` 的二次复查得到 unknown 时返回 unknown，不按 missing。`adopt` 零结果改按 `ProviderAdapter.unattributable().kinds`（`damaged` / `compressed`）分档：压缩给「展开后接入」、坏归属给「恢复后接入」并保留开新会话、混合档两者都说，不再匹配 advice 子串。`.zst` 只认非空普通文件，文案限定「若是 Codex 的本地线程压缩且副本完好」；Codex 反查遇名字匹配的符号链接 rollout 或日期目录时记入 `errors`，由 `SessionLookupFailureError('incomplete')` 改说无法确认。`open` 的 found-unreadable headline 对 0 字节文件补「从备份恢复或重新开一次会话」。10 项新增隔离检查与完整回归 2161 项通过、0 失败、0 跳过；`.zst` 仍只 `lstat`、不读取不解压，未启动原生客户端，不构成原生验收。

**Codex 0 字节压缩副本的披露分档（2026-11-17，v0.1.74，隔离合成检查）**：v0.1.73 的 `compressedSessionNote()` 只把非空普通文件认作压缩副本，0 字节 `.jsonl.zst` 被静默当成「没有副本」，链路与反查于是讲回「文件已不存在」，或给出「在 Codex 里继续该会话重新展开」的假承诺（展开一个 0 字节副本拿不回内容）。现在 `sessionFilePresence()` 的 `missing` 新增 `emptyCompressed`，共用返回 `compressedCopy()` 一次给出说明与下一步：完好副本「先让它重新展开」，0 字节副本「从备份恢复或重新开一次会话，再重试」。`switch` 的五处路径、`status`、`chain list`（tip 新增 `compressedEmpty`，绑定未列出分档）、`doctor`（`brokenTips` 新增 `compressedEmpty`，摘要与逐链行单独计「0 字节压缩副本」）、`chainUsage` 与 `open --to` diagnostics 全部套用。`HandoffBlockedError` 可带覆盖 hint：同一 `target_missing` 下不再落回「已不存在 / 重新选择目标会话」。Codex `unattributable` 新增 `compressed-empty` kind，`adopt` 零结果给「从备份恢复后接入」并保留开新会话备选；`findCodexSessionById` 命中 0 字节副本时说内容已丢失。扫描仍只按扩展名收集，字节数在披露前 `lstat` 一次补齐；不读取、不解压、不修改 `.zst`。8 项新增隔离检查与完整回归 2169 项通过、0 失败、0 跳过；未启动原生客户端，不构成原生验收。

**链尾已是目标 provider 时的 0 字节压缩副本下一步（2026-11-17，v0.1.75，隔离合成检查）**：v0.1.74 把 0 字节 `.jsonl.zst` 的单条 advice 定为「从备份恢复或重新开一次会话，再重试」，但 `switch` 的 already-at-target 分支与 `createChainSession()` 的「链尾已是目标 provider」分支里，链记录仍指向这条副本——重开会话不会改动链记录，重试必然再次撞上同一处。现在 `CompressedCopyNote` 增加 `kind: 'intact' | 'empty'`，两处按需改口径：0 字节副本给「从备份恢复后再试，或 watch chain new <新名字> 另起一条链」（`switch` 另给 `watch adopt … 换绑`），完好副本仍先说「先让它重新展开」。其余调用点的 advice 不变，因为它们的下一步不是立刻重试同一条链。2 项新增隔离检查（empty / intact 两档）与 r157 的 8 项断言通过，完整隔离回归 2171 项通过、0 失败、0 跳过；`.zst` 仍只 `lstat`、不读取不解压，未启动原生客户端，不构成原生验收。

**0 字节压缩副本的「先恢复备份、再重试」接齐调用点（2026-11-17，v0.1.76，隔离合成检查）**：v0.1.75 只在 `switch` 的 already-at-target 与 `createChainSession()` 同家分支按 `kind` 分档，其余七处仍在 advice 后直接拼「再重试 / 再重跑 watch doctor」：写前守卫的 message 与 hint、`status` 链尾、零结果链尾、`switch` 来源解析、`doctor` 链尾、`doctor` 来源内容对账、`chain list` 链尾。0 字节副本下「重新开一次会话」得到的是另一条会话，原路径与链绑定不会恢复，重试必然再次撞上同一处。新增 `compressedRetryAdvice(copy, retry)`：empty →「从备份恢复后{再重试|再重跑 watch doctor}」，intact →「先让它重新展开，{retry}」；上述七处统一改用它。4 项新增隔离检查（helper 两档、doctor 来源对账、`switch` 来源解析、`chain list` 链尾）与 r157 的 8 项断言、r158 的 2 项一并通过；完整隔离回归 2175 项通过、0 失败、0 跳过。`.zst` 仍只 `lstat`、不读取不解压，未启动原生客户端，不构成原生验收。

**open --to 链上配对目标为 0 字节压缩副本时的链绑定披露（2026-11-17，v0.1.77，隔离合成检查）**：`open` 的链上配对复用失败分支对压缩副本只说「本次不沿用：<copy.note>（改用内容匹配或新建）」，而 `open` 不写链记录——链绑定仍指向这条死副本，下一次 `switch` 会再次撞上。同分支的 `pairedEmpty`（0 字节普通文件）从 v0.1.73 起就明说「链绑定仍指向它」。现在 0 字节压缩副本追加「链绑定仍指向这条 0 字节副本——本次改用内容匹配或新建不会改动链记录，之后的 switch 仍会撞上它」，并给「从备份恢复后再试 / `watch adopt <provider> --session <另一个会话 id>` 换绑 / `watch chain new <新名字>` 另起一条链」；完好压缩副本不追加，因为重新展开后同一链上会话可照常复用。1 项新增隔离检查与 r157 / r158 / r159 的 14 项 15/15 通过；完整隔离回归 2176 项通过、0 失败、0 跳过。`.zst` 仍只 `lstat`、不读取不解压，未启动原生客户端，不构成原生验收。

**watch status 的链尾轮数显示（2026-11-17，v0.1.90，隔离合成检查）**：v0.1.89 已让 `status` 对可读 0 轮链尾披露；这一版把同一份 `parse` 结果里的轮数也显示出来——文本模式链尾行从 `← 链尾` 变成 `← 链尾（N 轮）`，`--json` 新增 `chainTipTurns`。0 轮仍写「（解析出 0 轮，原因见上方警告）」，不写成「（0 轮）」那种像正常计数的写法；`chainTipTurns` 只在 `parse` 成功时存在，0 字节（`probeSessionReadable` 判空）与 `parse` 抛错时为 `undefined`，不拿 0 冒充「没解析成功」。3 项新增隔离检查与 `cli-status-*`、`cli-doctor*`、`cli-store-reason-*`、`doctor-*` 等 status 与 doctor 用例联合 63/63 通过；完整隔离回归 2213 项通过、0 失败、0 跳过。未启动原生客户端，不构成原生验收。

**watch status 对可读 0 轮链尾的披露（2026-11-17，v0.1.89，隔离合成检查）**：`chainStatus()` 的链尾检查分四档——文件不存在 / 不是普通文件 / 状态无法确认 / 读不出来——全只看文件本身；一个可读却解析出 0 轮的链尾（`watch new codex` / `watch new grok` 建出的合法空会话，或内容被清空只剩占位头）照样以 `← 链尾` 推荐给用户，照抄 resume 打开的是空会话。v0.1.84–v0.1.88 已覆盖 `open` / `switch` / `new` 的交互路径，`status` 是最后一个只看路径不看内容的入口。现在文件可读时用同一 provider 的 `parse` 判 0 轮，命中时在 `warnings` 点名「解析出 0 轮（没有可继续的对话）」与「可能已被清空」，给原生客户端打开确认与备份恢复，结果新增 `chainTipEmpty`；文本模式在 `← 链尾` 后标注。0 字节仍由 `probeSessionReadable` 的「会话文件是空的」承担，不叠加；`parse` 抛错不在这一档（读不出来已由上一档披露，格式损坏由 `open` / `switch` 预检报）。每份 status 只多 parse 链尾这一个会话。3 项新增隔离检查与 `cli-status-*`、`cli-doctor*`、`cli-store-reason-*`、`doctor-*` 等 status 与 doctor 用例联合 60/60 通过；完整隔离回归 2210 项通过、0 失败、0 跳过。未启动原生客户端，不构成原生验收。

**switch 把内容并入可读 0 轮目标会话时的结果说明（2026-11-17，v0.1.88，隔离合成检查）**：`switch` 的非零增量分支里，目标会话解析出 0 轮（有 `into`、文件可读、不是 0 字节）时，来源内容照常并入，结果只说「已从 A 交接 → B（N 轮）」——用户看不出这条会话现在只有这 N 轮，也不知道它本该有更早历史时该去哪找。`open <目标> --from <来源>` 从 v0.1.82 起就在 notes 层说这句，`switch` 是 resume 命令最常被复制的地方，却比它安静。现在 `HandoffResult` 新增可选 `notes` 字段（与 `warnings` 的降级原因分开：`watch new` 建一个空会话再切过去是首条链的正常路径，不该每次都冒降级警告），命中时说明「本次并入的 N 轮就是它的全部内容」并提示本该有更早历史时先从备份恢复该文件（Watch 不会替你重建历史）；文本模式把 note 打到 stdout，`--json` 带结构化 `notes`。0 字节目标仍由 `emptiedTarget` 的「会话文件是空的」警告承担，不叠加这句；目标已有内容或零增量（`outgoing.length === 0`）时不出现。3 项新增隔离检查（可读 0 轮目标、目标已有内容反例、0 字节目标不叠加）与 r169、r170、`cli-switch-*`、`cli-new-*`、`handoff` 等 switch / new / handoff 用例联合 113/113 通过；完整隔离回归 2207 项通过、0 失败、0 跳过。未启动原生客户端，不构成原生验收。

**watch new 在链尾已就位时的 0 轮披露（2026-11-17，v0.1.87，隔离合成检查）**：链尾已停在目标 provider 时 `createChainSession()` 抛「链尾已是 X：会话 <id>（resume），直接 resume 即可；要开新对话请先切到另一侧」。这句此前只判文件在不在、读不读得出来、有没有断在半路，不判会话有没有内容：`watch new codex` / `watch new grok` 建出的合法空会话与「内容被清空、只剩占位头」都解析出 0 轮，用户拿到的却是「直接 resume 即可」——打开进去什么也没有。现在同一处 parse 结果复用为 0 轮判定，命中时点名「解析出 0 轮（没有可继续的对话）」与「可能已被清空」，给「先在原生客户端里打开确认」与「从备份恢复该文件」，保留「要开新对话请先切到另一侧」，不再说「直接 resume 即可」；有内容与断在半路的链尾结论不变，解析失败仍只说「读不出内容」，不猜轮数。0 字节更早由 `probeSessionReadable` 拦住，不归这里。3 项新增隔离检查与 r169、r168、`cli-new-*`、`cli-switch-*`、`handoff` 等 new / switch 用例联合 87/87 通过；完整隔离回归 2204 项通过、0 失败、0 跳过。未启动原生客户端，不构成原生验收。

**switch 退化为「直接打开即可」时的 0 轮链尾披露（2026-11-17，v0.1.86，隔离合成检查）**：没有可交接的来源、链尾已停在目标 provider 时，`switch` 走 `alreadyAtTarget` 分支，只回一句结论加一条 resume。此前只探文件读不读得出来：`watch new codex` / `watch new grok` 建出的合法空会话与「内容被清空、只剩占位头」都解析出 0 轮、文件可读，正文照样说「直接打开即可」——打开进去什么也没有，结果里一个字都不提。现在这一档点名「解析出 0 轮（没有可继续的对话）」与「可能已被清空」，给「先在原生客户端里打开确认」与「从备份恢复该文件」，并在文本结论里说明「打开的是空会话（原因见上方警告）」；`--json` 另带 `resumeTargetEmpty`。0 字节链尾仍只由 `probeSessionReadable` 那条说「文件是空的」，不叠加这句；有内容的链尾照常「直接打开即可」，不冒假警。3 项新增隔离检查与 `cli-switch-*`、`cli-zero-byte-tip-session`、`cli-new-at-tip-unfinished`、`switch-empty-chain-tip`、r156、r164、r168 等 switch 与链尾用例联合 119/119 通过；完整隔离回归 2201 项通过、0 失败、0 跳过。未启动原生客户端，不构成原生验收。

**switch 无目标且来源 0 轮的拒绝理由分档（2026-11-17，v0.1.85，隔离合成检查）**：`switch` 在来源解析出 0 轮、目标侧又没有可沿用的会话时走 `!into && turns.length === 0` 拒绝分支，此前只区分 0 字节文件与「没有任何内容」：文件可读却 0 轮的一档（`watch new` 建出的合法空会话 / 内容被清空只剩占位头）只有一句「没有任何可交接的内容」，不给下一步。现在这一档点名「解析出 0 轮（没有可继续的对话）」与「可能已被清空」，给「先在原生客户端里打开它确认」与「从备份恢复该文件」两条路，并保留 `watch new <target>` 的开新会话建议；0 字节来源仍直说「会话文件是空的（0 字节）」，只给备份恢复，不让人去原生里找一个已经空了的东西。3 项新增隔离检查与 `cli-switch-*`、`handoff-zero-rewrite-preserves-dest`、r156、r164 等 switch 相关用例联合 36/36 通过；完整隔离回归 2198 项通过、0 失败、0 跳过。同一版本修回 v0.1.84 升版引入的站点回归：中文首页 `quickIntro` 被英文覆盖、`requirements` / `cli` / `desktopBuild` / `copyAll` / `troubleshooting` 五个字段丢失并在线上渲染成 `undefined`；中英文主文案与字段已恢复，站点四项测试 16/16 通过。未启动原生客户端，不构成原生验收。

**open 纯打开与 --to 的 0 轮可读会话披露（2026-11-17，v0.1.84，隔离合成检查）**：`open <id>` 纯打开、`open <id> --to <同一家>` 快路径与 `--to <另一家>` 的 0 轮来源拒绝此前只区分 0 字节；文件可读、parse 成功却 0 轮的一档（`watch new` 建出的合法空会话 / 内容被清空只剩占位头）没有说明——用户拿到的是一条看起来完全正常的 resume，或一句「没有可转入的内容」。现在纯打开与同一家快路径点名「解析出 0 轮（没有可继续的对话）」并说明 resume 打开的是空会话、给打开确认 / 备份恢复，`--check` 吃同一份 diagnostics；`--to` 另一家的错误保留「没有可转入的内容（0 轮）」并区分「刚建出来」与「被清空」。非 0 字节不得讲成内容已丢失，有内容的健康会话不误报。4 项新增隔离检查与 r165、`cli-open-*`、`open.test` 等 open 相关用例联合 115/115 通过；完整隔离回归 2195 项通过、0 失败、0 跳过。未启动原生客户端，不构成原生验收。
**adopt 接入空会话的披露与措辞（2026-11-17，v0.1.83，隔离合成检查）**：`adopt` 只写链记录、不打印轮数；接入一条文件可读但解析出 0 轮的会话（`watch new` 建出的合法空会话，或内容被清空只剩占位头）时，旧输出只有「已接入链」加一条 resume，resume 打开的是空会话完全看不出来。现在 warnings 点名「解析出 0 轮（没有可继续的对话）」并说明 resume 打开的是空会话，给打开确认 / 备份恢复 / `watch adopt … --session` 换绑；0 字节与「读不出来」分成两档，空文件不再被讲成权限问题、也不再断言 resume 一执行就会失败；`unchanged` 空操作不再说「链记录已写入」。3 项新增隔离检查与 10 个 `cli-adopt-*` 既有用例联合 19/19 通过；完整隔离回归 2191 项通过、0 失败、0 跳过。未启动原生客户端，不构成原生验收。
**open --from 的 0 轮披露与零增量措辞（2026-11-17，v0.1.82，隔离合成检查）**：`open <目标> --from <来源>` 此前只区分 0 字节来源 / 目标；文件不是 0 字节、却解析出 0 轮的一档（`watch new` 建出的合法空会话，或内容被清空、只剩占位头）在零增量分支被写成「<来源> 的内容已全部包含在 <目标> 中，无需并入」——来源什么都没并入，与「来源 0 轮必须披露」相悖。现在来源 0 轮时点名「解析出 0 轮，没有可并入的内容」，说明本次未写入任何内容、目标未被改动，并给「打开确认 / 从备份恢复 / 核对 --from 会话 id」；目标 0 轮时 notes 说明本次并入的 N 轮就是它的全部内容（本该有更早历史则先恢复备份）；来源 0 轮叠加目标 0 字节时，目标那句改为「这次什么都没写」，不再与「本次并入的只有来源的内容」自相矛盾。合法空会话不被说成 0 字节 / 内容已丢失，既有「健康 0 轮会话不得误报」用例继续通过。3 项新增隔离检查与 `cli-open-zero-byte-session`、`open-from-process-events`、`open.test`、`cli-resume-target-unfinished`、`r63-opencode-revert` 等 open 相关用例联合 100/100 通过（含 r165 的 3 项）；完整隔离回归 2188 项通过、0 失败、0 跳过。未启动原生客户端，不构成原生验收。

**switch 零增量分支里来源 0 轮的披露（2026-11-17，v0.1.81，隔离合成检查）**：来源会话解析出 0 轮、链上已有可沿用目标（`into` 存在，走零增量分支）时，旧实现直接回 `ok:true` + `turnCount:0` 且没有任何警告——文本模式还印「已从 X 交接 → Y（0 轮）」，与「来源或目标会话为 0 轮 / 0 字节时必须拒绝或披露」的约定相悖。0 字节来源从 v0.1.73 起已有警告，但「文件不是 0 字节、解析出 0 轮」（`watch new` 建出的合法空会话 / 内容被清空只剩占位头）完全静默。现在点名来源会话「解析出 0 轮，没有可接力的对话」，说明只把链尾切到目标、目标未被改动，并给「先打开确认 / 从备份恢复 / watch adopt 换绑」；来源与目标都为 0 字节时两边分别点名，目标那句说明 resume 打开的是空会话。`HandoffResult` 新增 `zeroIncrementReason`（`source-empty` / `up-to-date`），文本结论按档改为「已切到 X（链尾已更新；来源没有可交接的内容 / 目标已包含全部内容）」，不再共用「已从 X 交接（0 轮）」。4 项新增隔离检查与 r161–r164、`cli-switch-*`、`handoff-zero-rewrite-*`、`switch-empty-chain-tip`、`cli-json-contract` 联合 43/43 通过；完整隔离回归 2185 项通过、0 失败、0 跳过。未启动原生客户端，不构成原生验收。

**open --to 链上配对目标解析出 0 轮时披露链绑定（2026-11-17，v0.1.80，隔离合成检查）**：配对目标文件存在、parse 也成功，但没有一条对话（只剩 rollout 头 / 内容被清空）时，决策 1 的内容校验必然失败，旧实现静默改用内容匹配或新建；链绑定仍指向这条空会话，下一次 `switch` 再撞上。现在披露「解析出 0 轮」，并给「先在原生里继续确认 / watch adopt 换绑 / watch chain new 另起一条链」。同轮把 `doctor` 与 `sessions` 的 0 字节下一步改为「只能从备份恢复；没有备份就只能重新开一次会话（那是另一条会话）」，不再暗示重开能修复这一条。1 项新增隔离检查与 r162 / r163、`open.test`、doctor / degrade / 0 字节列表用例联合 110/110 通过；完整隔离回归 2181 项通过、0 失败、0 跳过。未启动原生客户端，不构成原生验收。

**链上 0 字节压缩副本的下一步不再建议重新开一次会话（2026-11-17，v0.1.79，隔离合成检查）**：v0.1.75–v0.1.78 只在重试类文案里去掉了「重新开一次会话」，`sessions --chain` 的压缩档与 `doctor` 链尾行仍留着它，且前者连换绑路径都没有。重开得到的是另一条会话，链绑定仍指向这条死副本，下次 `switch` 照样撞上。两处改为「只能从备份恢复；可先 watch switch … 重新绑定 / watch adopt … --session <会话 id> 指定会话」；`open --to` 链上配对目标为 0 字节普通文件时也补 `watch adopt` 换绑与 `watch chain new` 另起一条链。3 项新增隔离检查与 r157–r162、`open.test`、`cli-sessions-chain`、doctor 相关用例联合 82/82 通过；完整隔离回归 2180 项通过、0 失败、0 跳过。`.zst` 仍只 `lstat`、不读取不解压，未启动原生客户端，不构成原生验收。

**open --to 链上配对目标不可用时统一披露链绑定（2026-11-17，v0.1.78，隔离合成检查）**：v0.1.77 只给「配对目标只剩 0 字节压缩副本」补了「链绑定仍指向它」；同分支的「文件已删除」「读不出来」两档仍只说「本次不沿用（改用内容匹配或新建）」。`open` 不写链记录，链仍指向这条不可用会话，下一次 `switch` 会再次撞上。现在按 `copy?.kind` 统一：完好压缩副本不追加（重新展开后同一会话可复用）；0 字节副本给「从备份恢复后再试」；其余（缺失 / 权限 / 格式）给「先按上面的原因处理后再试」；三者都带「链绑定仍指向它——本次改用内容匹配或新建不会改动链记录，之后的 switch 仍会落回这条会话」与 `watch adopt …` 换绑 / `watch chain new` 另起一条链。1 项新增隔离检查与 r157–r160、`open.test` 联合 73/73 通过；完整隔离回归 2177 项通过、0 失败、0 跳过。`.zst` 仍只 `lstat`、不读取不解压，未启动原生客户端，不构成原生验收。

**Codex 压缩 rollout 的不可读披露（2026-11-15，v0.1.70，行为提交 `5d4a285`，固定上游源码 + 隔离合成检查）**：依据 [`openai/codex` 固定提交 ee344ca](https://github.com/openai/codex/blob/ee344ca9458351a6ea102795fa73110ad3ede5dc/codex-rs/rollout/src/compression.rs) 与同提交的 `list.rs`、`features/src/lib.rs`：`local_thread_store_compression`（UnderDevelopment、默认关闭）会把 7 天未写的 rollout 压成 `<原名>.jsonl.zst` 并删除普通副本；原生发现阶段把两种扩展名都当 rollout，同目录普通副本优先（`should_skip_compressed_sibling`），读取时按 zstd frame 解压，追加前先 materialize 回 `.jsonl`。Watch 本版只扫 `.jsonl`，因此只有压缩副本的会话此前被静默当成「没有」。现在：全局反查命中压缩副本抛 `SessionLookupFailureError('found-unreadable')` 并点名路径，不再返回 null；列表与 `doctor` 把它计入 `unattributable`（`ProviderAdapter.unattributable` 新增可选 `cause` / `advice`，覆盖默认的「元数据损坏 / 可能是被截断」文案），说明是压缩格式并给出「在 Codex 里继续该会话会重新展开为 `.jsonl`」；同目录存在普通副本时不重复计数，日期占位披露保持 v0.1.69 行为。不读取、不修改、不删除 `.zst` 文件；只识别普通文件形式，符号链接 / 设备类型未纳入。10 项新增与 110 项相关隔离回归通过；未读取真实历史、凭据或启动原生客户端。

**Codex 日期路径的普通文件占位（2026-11-15，v0.1.69，行为提交 `eb24b8d`，隔离合成检查）**：按原有年四位 / 月日两位名称规则，`collectRecentRolloutFiles()` 在 `withFileTypes` 过滤前将普通文件占位记入扫描故障；全局反查的递归扫描同样确认三层日期相对路径并保留错误。列表不再静默报空；有候选的自动选择沿用 v0.1.67 的 `warnings` 范围披露，无候选则拒绝；无 ID 命中时为 `SessionLookupFailureError('incomplete')`。CLI sessions 记 `unavailable` / warnings，doctor 列表硬失败。真正缺失仍保持首次使用，非日期普通文件仍忽略，不修改占位文件。未扩展符号链接 / 设备类型或日期值合法性检查，也未将此扫描诊断接入写权限预检。12 项新增检查通过（旧实现其中 10 项失败），连同 16 项自动选择回归共 28 项通过，完整隔离回归 2120 项通过、0 失败、0 跳过；未读取真实历史、凭据、启动原生客户端或调用模型，不增加原生验收结论。

**Pi 设置中的会话目录（2026-11-15，v0.1.68，固定上游源码 + 隔离合成检查）**：依据 [`SettingsManager` 固定源码 c3cc916](https://github.com/earendil-works/pi/blob/c3cc91632d0a1950fb122605b190233f2aa0006e/packages/coding-agent/src/core/settings-manager.ts) 与同提交的 `main.ts` / `session-manager.ts`，项目 `<cwd>/.pi/settings.json` 覆盖全局 `<agent-dir>/settings.json`，环境变量优先。Watch 的按 cwd 列表、新建、预检与 doctor 接入 `sessionDir`，项目空串 / null / false 覆盖全局并回默认；`~` / `file://` 按原生形式展开，保留空白，其他相对值拒绝。显式目录平铺、共享文件按头部 cwd 筛选，默认与注入根仍分组；旧 Watch 子目录保留只读兼容。不存在或 0 字节设置按未设置处理；无效 JSON、非字符串、设置路径非普通文件、祖先非目录或读取故障拒绝，不能静默退回另一目录；原生会警告后忽略坏设置，这一差异明确保留。只读解析不复制原生的 `withLock`，不建文件或锁。全局 ID 反查没有 cwd，只能读取全局设置与默认目录，项目独立目录可用 `adopt pi --session <id> --cwd <绝对目录>` 绑定；单次 `--session-dir` 仍看不到。全局设置解析失败也包装为 `SessionLookupFailureError('incomplete')`，`open` 报「无法确认」而非「未找到」。小写 `file://` 与首个 BOM 处理对齐固定源码；Windows Git Bash 的 `/c/`、`/mnt/c/`、`/cygdrive/c/` 路径转换尚未接入，需改用完整 Windows 绝对路径。项目设置按给定 cwd 读取，只有与 Pi 启动 cwd 相同时才有同目录依据；未验证并发原生写设置时的锁竞争。本轮 22 项新增检查通过，最初 16 项中旧实现有 13 项失败；最终完整隔离回归 2108 项通过、0 失败、0 跳过（行为提交 99d3d51，版本 0.1.68）。未读取真实历史或凭据、未启动原生客户端或调用模型，不增加 Pi 原生恢复验收结论。

**Codex 自动选择的扫描范围披露（2026-11-15，v0.1.67，隔离合成检查）**：`findLatestCodexRollout()` 找到可读候选后，仍汇总已收集的目录遍历故障与更靠前候选的首行 I/O 故障，通过可选 `warnings` 带出故障位置数、样本路径、原因及恢复建议，并说明无法确认是否为全部会话中最新。`adopt` 把选择标签收窄为「在能读出的会话里按修改时间最新」；`status` / `switch` 保留警告；`watch prompt` 四档正文都写入选择范围，并产生 `prompt_source_selection_incomplete` / `degraded` finding（count 是诊断条数，警告文本另含故障位置数）。仍可使用可读候选和已有绑定，无候选且扫描失败仍拒绝，空首行仍走既有不可归属披露；已知更旧且未读取的文件不新增选择警告。日期层级静态被文件占位的既有边界仍未处理，本轮不扩大扫描支持结论。16 项新增检查中旧实现 13 项缺少披露，修复后全通过；完整隔离回归 2086 项通过、0 失败、0 跳过（行为代码提交 153543f，升版前包版本 0.1.66）。未读取真实历史或凭据、未启动原生客户端或调用模型，不增加原生验收结论。

**官方导入目标路径的错误分档（2026-11-15，v0.1.66，隔离合成检查）**：`inspectTargetDirectory()` 的 `realpath` 与随后 `lstat` 仅把 `ENOENT` 归为数据目录未建立；`ENOTDIR` 明确说明路径上的某一级不是目录，并提示恢复目录结构或修正 `CODEX_HOME`。显式变量的同步前置检查原已能识别该故障；本轮补齐后续目标检查，假版本命令在前置检查通过后把祖先目录替换为文件，实际 CLI JSON / 文本均复现并验证了修复。11 项新增检查中旧实现 4 项失败，修复后相关 44 项通过；保留真正缺失、健康目标与显式路径前置拒绝的反例，控制字符路径仍转义。故障时不建立导入日志或目标锁，来源和占位文件保持。最近完整隔离基线仍为 v0.1.65 的 2059 项，本轮未重跑全套；未读取真实历史或凭据、未运行原生客户端或调用模型，不增加原生验收结论。

**四家目录故障的写入预检（2026-11-15，v0.1.65，隔离合成检查）**：Claude / Kimi / Pi / Grok 的 `preflight()` 与 `writeLimit()` 共用本家目录解析函数，目录类型或读取故障返回 `<provider>_data_dir_unusable`（`kind: fault`）。`open --to --check` 返回 `writable:false` 并退出 1；实际转入、`new` / `switch` 与 `doctor` 共享原因与下一步。空链 `new` 在创建之前调用预检；Kimi 直接新建也在启动 CLI 之前检查数据根和 `sessions` 子目录。`ENOENT` 保持首次使用，不由检查建目录；Pi 的专用会话目录仍优先于 agent 根。目录探测不证明写权限、writer 锁、项目叶子目录或后续路径不变；悬挂符号链接仍按 `stat` 的 ENOENT 语义放行，由写入失败兜底。30 项新增隔离检查及 2059 项完整回归通过；假 Kimi 仅用于检查是否启动，无真实 Agent 历史、凭据、客户端或模型调用，不增加原生验收结论。

**默认数据根的类型检查（2026-11-15，v0.1.64，隔离合成检查）**：未设置目录变量时，五家适配器用 `assertDataDirectory()` 只读检查默认根的路径类型：Claude 配置目录与会话目录、Kimi 数据目录与会话目录、Pi 配置目录与会话目录、Grok 数据目录与会话目录、OpenCode 数据目录（`probeOpencodeDbFile()` 的父目录）。`ENOENT` 仍视为首次使用，由首次写入创建；被普通文件占住、祖先非目录或读取失败会抛中文原因，`sessions` / `recent` 记入 `unavailable`，`doctor` 逐家 `count:null` 并退出 1。上述数据根故障在原生创建前失败；该版 Kimi 的 `sessions` 子目录仍可能在 spawn 之后才检查，v0.1.65 已提前。显式环境变量仍由 `providerDirectoryFromEnv()` 检查，注入的测试根与 `WATCH_OPENCODE_DB` 不被替换。该版四家没有 `preflight` / `writeLimit`，`open --to --check` 不提前报出这类目录故障；v0.1.65 已补齐。未读取真实历史或凭据、未运行原生客户端或调用模型，不增加原生验收结论。

**Codex 默认数据目录与 sessions 的路径类型检查（2026-11-15，v0.1.63，隔离合成检查）**：`codexDir()` 现在每次调用都只读检查数据根与 `sessions` 的路径类型：默认的 `~/.codex` 或其下 `sessions` 被普通文件占住、祖先不是目录或无法访问时报错并点名路径，不再表现为零条会话。显式 `CODEX_HOME` 仍要求根目录已存在；默认根与 `sessions` 的 `ENOENT` 留给首次写入创建，检查本身不建目录，也不承诺写权限。`codexStorageWriteLimit()` 与 `preflight()` 共用这一判定（`codex_home_unusable`）；配置读取失败的下一步改为检查文件及父目录的访问权限、路径与文件类型，只有 `codex_config_invalid` 建议重建配置。写锁路径在 try 之外解析，目录故障原样抛出，不归为 `codex_target_busy`。`sessions` 之下的年 / 月 / 日层级仍不检查：被文件占住的层级由目录项过滤跳过，新建会话时才报错。官方导入只用 `codexHomeDirFrom()`，不经过这项检查。未读取真实 Agent 历史或凭据、未运行原生客户端或调用模型，不增加原生恢复结论。

**Codex 目录故障的诊断分类（2026-11-15，v0.1.62，隔离合成检查）**：`codexStorageWriteLimit()` 先解析和检查 Codex 数据目录，再读取 TOML。目录故障统一返回 `codex_home_unusable` 与目录修复建议，`kind: fault`；配置不可读与语法错误继续分别为 `codex_config_unreadable` / `codex_config_invalid`。预检与 `doctor` 复用同一判定，禁止把目录故障引向重建配置文件。`doctor` 的写入能力探测独立于会话列表，后者失败仍保留 `count:null` / error 与硬失败，同时附带写入限制或 `writeLimitError`；故障写入限制仍进 warnings。未改变目录定位、原子写、writer 锁、官方导入版本门禁或凭据逻辑。合成检查覆盖四类显式目录故障及三类配置反例，未读取真实历史或凭据、未运行原生客户端或调用模型，不增加原生恢复结论。

**目录变量的路径类型检查（2026-11-15，v0.1.61，隔离合成检查）**：`providerDirectoryFromEnv()` 对非空的显式目录变量只读检查路径类型。路径本身是普通文件或设备文件时拒绝；祖先不是目录（`ENOTDIR`）单独说明「有一级不是目录（被文件占住）」，不再讲成目录不存在并建议创建。权限与 I/O 检查失败也抛出中文原因，点名变量与已转义的路径；`sessions` 等聚合命令通过 `unavailable` / `warnings` 披露，不能当成零条会话。未设置或空字符串的默认路径规则不变；显式路径 `ENOENT` 仍交给原有 provider 规则（Codex 仍要求显式 `CODEX_HOME` 存在），不由共享解析函数创建目录。新增检查只读元数据，不检查配置内容、写权限或未来路径是否变化，也不替代写入守卫。合成会话目录检查未读取真实 Agent 历史或调用模型，不增加原生客户端验收结论。

**Pi 显式自定义目录布局（2026-11-15，v0.1.60，固定上游源码 + 合成检查）**：上游 [`SessionManager` 固定源码 c3cc916](https://github.com/earendil-works/pi/blob/c3cc91632d0a1950fb122605b190233f2aa0006e/packages/coding-agent/src/core/session-manager.ts) 的 `create(cwd, sessionDir)` 直接将指定目录用于文件写入；`list(cwd, sessionDir)` 在该目录读取后按头部 cwd 筛选，仅默认目录才拼 encoded-cwd。Watch v0.1.57–v0.1.59 多拼了项目目录，旧合成夹具也镜像了错误。v0.1.60 起在 `PI_CODING_AGENT_SESSION_DIR` 下平铺写入与扫描、按头部的绝对 cwd 筛选共享文件，全局 ID 反查同样支持平铺。保留旧 Watch 分组目录的只读兼容，同 ID 优先平铺文件，不移动或改写旧历史；头部读不出或 cwd 非绝对路径时披露列表不完整，不把归属不明当作别的项目。注入 `sessionsRoot` 的测试与调用方仍保持分组语义；`PI_CODING_AGENT_DIR` 的默认会话布局不变。未运行原生 Pi 客户端、未调用模型，未增加原生 resume 结论；单次参数与 `sessionDir` 设置仍未读取。

**GROK_HOME 覆盖（2026-11-15，v0.1.53，文档对照 + 合成目录检查）**：同一份内置文档写明会话根目录是 `$GROK_HOME/sessions`（未设置时 `~/.grok`）。适配器以前只按 `homedir()` 拼接，设了 `GROK_HOME` 的用户会看到零条会话，新建会话还会写进原生不读的 `~/.grok`；现在 `grokHomeDir()` 优先取 `GROK_HOME`，会话根与写入的 `summary.grok_home` 都跟随它。合成目录与 CLI 级检查覆盖；未运行原生客户端验证 `GROK_HOME` 下的 resume。

**CODEX_HOME 覆盖（2026-11-15，v0.1.55，官方源码对照 + 合成目录检查）**：Codex 官方 `find_codex_home()`（`codex-rs/utils/home-dir/src/lib.rs`）说明数据目录可由 `CODEX_HOME` 指定，未设置时默认 `~/.codex`；设置值会 canonicalize，空字符串等同未设置。直接写文件的 Codex 适配器以前固定 `~/.codex`（只有官方导入路径读该变量），设了变量的用户会看到零条会话，新建 rollout 与 writer 锁也落在原生不读的位置；现在 `codexHomeDirFrom(home)` 统一解析，官方导入与旧适配器共用同一规则，sessions 扫描、新建、预检配置读取与 writer 锁路径都跟随它。`CODEX_HOME` 指向不存在或非目录的路径时，`codexDir()` 直接报出变量名、路径与原因（官方 Codex 在此配置下同样直接失败），`sessions` 等聚合入口把它记进 `unavailable` 与 `warnings`，不再安静地报空。合成目录与 CLI 级检查覆盖；未运行原生客户端验证该变量下的 resume。

**PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR 覆盖（2026-11-15，v0.1.57，官方文档与源码对照 + 合成目录检查）**：Pi 官方文档写明配置目录默认 `~/.pi/agent`、可由 `PI_CODING_AGENT_DIR` 覆盖，会话存储默认 `<agent-dir>/sessions`、可由 `--session-dir` / `PI_CODING_AGENT_SESSION_DIR` / 设置 `sessionDir` 覆盖（`--session-dir` 优先级最高，`main.ts` 中环境变量高于设置）。Watch 以前只按 `homedir()` 拼路径，设了变量的用户会看到零条会话，新建会话还会写进原生不读的位置；现在 `piAgentDirFrom()` / `piSessionsRootFrom()` 解析前两档（`~` 展开；v0.1.59 起拒绝其余相对值）。该版看不到单次运行的 `--session-dir` 与设置 `sessionDir`；v0.1.68 已接入设置，单次参数与项目独立目录的全局反查限制见上文。合成目录与 CLI 级检查覆盖；未运行原生客户端验证该变量下的 resume。

**KIMI_CODE_HOME 覆盖（2026-11-15，v0.1.58，官方源码对照 + 合成目录检查）**：Kimi 官方 `apps/kimi-code/src/utils/paths.ts` 的 `getDataDir()` 注释写明「Priority: `KIMI_CODE_HOME` env var > `~/.kimi-code`」。Watch 以前只按 `homedir()` 拼数据目录，可能漏掉自定义目录里的会话，或在原生 CLI 新建后找不到它登记的会话；现在 `kimidirFrom(home)` 统一解析，会话根、索引读取与新建后的会话定位都跟随它。索引仍由原生 Kimi CLI 登记；v0.1.59 起要求绝对路径并保留路径空白。合成目录与 CLI 级检查覆盖；未运行原生客户端验证该变量下的 resume。

**Codex 直接文件路径改为目标级写保护（2026-09-16）**：原 `preflight()` 只看 `pgrep` 能否匹配 Codex/ChatGPT Desktop，导致两个方向都不准——应用只是开着就一律拒绝（实测：ChatGPT 运行中时非 Claude 来源 → Codex 全部被拒），而应用关闭但 `codex` CLI 正写同一线程时反而放行（正是要防的并发写）。现改为按目标会话判定：读原生 per-thread writer 锁 `~/.codex/thread-writer-locks/<thread-id>.lock`，用 `lsof -Fpc` 探测持有者——锁被活进程持有才拒绝并报出持有者 PID/命令；锁文件不存在（新建会话）或只剩陈旧锁（持有者已退出）则放行；有 ctx 但无目标 ref（新建）放行；无 ctx 或 `lsof` 不可用才回退旧的进程检查。`open --from` 与 `open --to` 两条写入路径同时补上写前的 `contentFingerprint` 比对（写后内容由 rename 前的 parse 反解校验兜底）。

**真实并发写验收（2026-09-16，隔离原生）**：方法为在隔离 `HOME`/`CODEX_HOME` 中用 Watch 写一条合成 rollout，再起真实 `codex app-server --listen stdio://`（0.153.4），通过 `thread/resume` 按 thread id 打开该线程——**不发 turn、不调模型**；`lsof` 确认锁由真实 `codex` 进程持有（PID 实测如 56190）。持有期间 Watch 的 `open --from` 返回 `ok:false` + `code:codex_target_busy` + 该 PID，且写入前后 `contentFingerprint` 完全一致（零写入）；杀死 writer 释放锁后同一命令返回 `ok:true`。`thread/resume` 在无凭据的隔离环境可用，因此本项验收不依赖登录状态。脚本 `scripts/validate-codex-writer-guard.mjs`（`npm run validate:codex-writer-guard`，手动 opt-in）可复现全部十项检查，当前 **10/10** 通过；原始记录 codex-writer-guard-native-2026-09-16 按仓库约定保留在本地 `docs/evidence/`，不随仓库分发。

**协作写锁（2026-09-16 追加）**：仅靠「探测锁 → 写入」仍有窄竞态窗口。现改为在写入期间以 `fcntl.flock(LOCK_EX|LOCK_NB)` **独占持有同一个原生锁文件**（Node 无 flock API、macOS 无 `flock(1)`，因此用一个 python3 helper 子进程持锁；helper 退出即由内核释放；无 python3 时降级为不影响写入）。实测结论：Watch 持锁期间，真实 `codex app-server` 的 `thread/resume` 被明确拒绝——`{"code":-32600,"message":"thread <id> already has an active writer"}`；Watch 释放后同一调用恢复 `ok`。另外发现原生锁文件会在 writer 退出时被删除，因此取锁改为「按需创建目录/文件再 flock」。取锁失败（已被抢）会转成结构化 `codex_target_busy` 拒绝写入，不留部分写。残留边界：flock 只对“遵守同一把锁”的 writer 有效；未提供强制覆盖开关。

**点击前预检**：`watch open <id> --to <provider> --check --json` 只读解析转入会落到哪种目标（`resume` / `chain` / `reuse` / `new`）并跑一次目标级保护探测，返回 `writable` 与 `blocked`，**不写目标会话文件**（回归里用指纹与目录清单断言零写入；命中本地映射时仅刷新 `session_locations.lastSeenAt`，属于本地库缓存）。桌面端在（来源会话 + 目标 Agent）变化后去抖调用它，在目标卡片下显示「可写入：将并入既有会话 <id>」「暂不可写入：… · <hint> · 占用者 PID x codex」；预检不可用时只提示不影响转入。

## 4. 只读本机预检记录

以下是开发环境观察，不是安装要求，也不是版本兼容范围：

| 项目 | 本轮观察 | 结论边界 |
|---|---|---|
| Node | `v24.19.0` | 未据此运行构建或转换 |
| CLI | `codex-cli 0.153.4`，arm64 原生可执行文件 | 隔离 app-server 与真实 Watch Tauri 官方导入路径已运行；不推广到其他版本 |
| 桌面 bundle | `/Applications/ChatGPT.app`，2026-09-10 版本 `26.903.61454`，build `8378` | P2 合成样本两次打开同一目标通过；S8 私有实现检查仍固定在旧版 `26.901.51231`，不是稳定 API |
| 协议声明 | Info.plist 的 `CFBundleURLSchemes` 包含 `codex` | 合成目标深度链接已能打开并触发原生 read/resume；项目列表仍独立验收 |
| Claude | 曾只读检查 CLI `2.1.258`；2026-09-09 最终复核时 `claude`、`Claude.app` 与 URL Handler 均不存在 | 已记录固定二进制摘要和 `/desktop` 流程，但当前无法执行 CLI 或 GUI 验收 |
| OpenCode | 全局仍未发现 `opencode` 命令、默认数据/配置目录或对应应用；私有临时 prefix 使用固定 1.18.29 arm64 二进制 | 基础 CLI 适配器仍是产品基线；官方增强的隔离 JSON 导入、server、Web、独立 local TUI 与 attached TUI 历史及目标模型有效性已验证，一次无工具模型请求因 provider 429 失败，故增强路径的模型继续和 IDE 未通过 |
| Antigravity | `agy 1.1.26`，arm64，SHA-256 已记录；本地 workspace cache 存在但未直接读取；未发现 2.0/IDE 应用 | 只能核对帮助和文件身份，无法验证 2.0 → CLI 导入、CLI 历史显示或继续 |
| 其他 bundle | `/Applications/Codex.app`、`/Applications/Claude.app` 不存在 | 已同时检查 `~/Applications`；不排除未搜索的非标准安装位置 |

## 5. 后续验证记录要求

每条记录必须包含 Watch commit/工作区差异、OS/架构、CLI/桌面版本、源/目标客户端、测试样本来源、可保留与降级内容、实际 cwd、执行步骤、结果与日期。版本升级后保留旧证据，不自动扩展支持范围。

2026-09-16 起 `tests/` 不随版本库分发（本地保留，已在 `.gitignore`）：`quality.yml` 不再运行回归测试（该文件后来内联进 `release.yml` 的 `quality` job），远程 `checks` 只覆盖根类型检查、前端构建与 Rust 测试。因此引用回归数量时必须注明「本地隔离回归」，不能把远程 checks 当作回归证据；本节及以下历史记录中的远程通过结论也仅对当时含测试步骤的提交成立。

Codex 原生实验与 P4 客户端扩展入口各有独立的分客户端门禁。P3 本地可靠性记录 证明隔离回归和本机构建门禁，P3 远程交付记录 证明对应 `main` 提交的 GitHub Actions `checks` 与 Linux `rust` job 通过；两者都不扩大任何客户端兼容性结论。Codex 人工 GUI 验收的两条无敏感合成线程仍保留。OpenCode 私有包 prefix、调研缓存和 `--keep` 隔离根已在验收完成后于 2026-09-09 删除，仓库 evidence 保留；报告中的 retained 字段描述生成报告时的历史状态。OpenCode 曾获一次受限合成 prompt 授权；该请求到达 provider 后以 429 明确失败，未生成文本、token 或工具调用，也未重试。

## 6. 首轮原生证据

环境：macOS / arm64，Darwin 25.6.0，Codex CLI 0.153.4。这里只描述同一个合成样本的两种处理方式，不能推广到所有 Claude 会话或所有客户端版本。

| 路径 | 结果 | 证据 |
|---|---|---|
| Watch 现有转换器 | 原生会话读取与 resume 成功；工具结果仍在序列化文件中，但原生历史查询未呈现它，严格验收失败。不据此断言模型上下文必定丢失，模型调用未测 | 原始报告 |
| 官方单会话导入 | 只选择一条 `SESSIONS` 记录，完成通知返回唯一目标 ID；来源与配置未变；原生历史含完整工具参数和 512 字符以上的结果，但为文本而非结构化工具项 | 原始报告 |

这些早期官方路径报告仅通过“工具记录文本化”的直接接口验收，本身没有验收 GUI 或模型继续，也不能代替后来新增的 [实验 CLI 封装](import-codex.md)。新封装的目标保护及原生集成证据见第 8 节，后续 GUI 与模型记录见第 9 节。未通过原生检查的私有工具事件实验已撤回，原直接文件写入防护保留。

## 7. 新封装原生预检（2026-09-07）

`--watch-importer` 通过真实 CLI 调用实验封装；没有使用注入的假 preflight 或改动写入守卫。macOS arm64、Codex CLI 0.153.4 下，预览通过，确认因检测到运行中的 ChatGPT Desktop 而停止，未提交导入；状态查询仍为 `prepared`，源文件、配置及目标持久数据未变，实验数据已清理。

证据：封装写入前阻断。此前 快照失败 是验收脚本误将 Codex 临时运行符号链接视为非法文件，已经修正并保留原报告。两份报告都不能标为导入成功。

该记录对应旧的全局进程保护策略，因此当时停止了后续步骤；不代表官方导入要求退出应用。后续官方路径改用目标目录保护，见下一节。直接写文件的原始 Codex 守卫仍保留。

## 8. 目标目录保护与原生并存验收（2026-09-07）

经明确授权将官方 API 路径与私有文件写入分开：官方路径绑定规范目录/设备/inode/config 摘要，使用跨 Watch 日志的目标锁，检查原生 SQLite 目录和返回会话路径；不再以全局桌面进程名阻断。锁仅串行化 Watch，不是原生客户端互斥锁。未知结果保留目标锁；原私有转换器的 `preflight()` 未改。

| 场景 | 原生结果 | 证据 |
|---|---|---|
| ChatGPT 进程存在，导入独立临时数据目录 | prepare/confirm/status 与重复确认通过；原生历史/read/resume 通过；源与配置未变 | 目标保护报告 |
| 两个原生 app-server 使用同一临时目录，一个先连接并保持空闲，另一个执行导入 | 原 reader 能读到新目标和长工具结果；重复确认不改目标持久数据；其余检查通过 | 共享 reader 报告 |

两组都是 macOS arm64 / Codex CLI 0.153.4 的合成样本，工具以文本保留。桌面进程仅观察运行状态，没有读写真实桌面数据、打开 GUI 或调用模型；测试目录全部清理。该阶段不能推导到活跃模型任务、所有并发写入、多版本或完整桌面接力；后续受控 UI 入口的依据来自第 9 节新增的项目先建验收与用户推进决定，而不是这两组报告。

最终实现以 共享 reader 复测报告 为准，同样通过。最终自动回归 174 项通过；旧报告保留各自实现摘要，不覆盖历史失败或阻断记录。

## 9. 项目归属与 projectless 根因（2026-09-08）

第一条真实合成测试会话能通过深度链接打开，但相同 cwd 的桌面项目列表为空。最初仅检查 app-server `project_id`，后置关联及项目重建实验都能让 `thread/list.projectId` 返回目标，却始终不能让 GUI 显示。

当前 Desktop bundle 与实时全局状态最终确认额外过滤条件：该线程位于 `projectless-thread-ids`，且没有私有项目 assignment。项目筛选会将它排除；公开 app-server API 更新的是另一层项目元数据，不能据此解除私有排除。证据见 projectless 检查记录。

- 协议对照
- 封装原生验收
- 最终代码原生复测：通过，全量隔离回归 183 项通过，类型检查通过。

因此此前“重新关联后等待 GUI 刷新”的结论已撤回。上述报告仍证明 app-server 成员关系、历史不变及项目删除/重建生命周期，但不证明 Desktop 可见；旧 `project-*` 命令仅保留诊断兼容。

### 项目先建对照

保持桌面项目存在后，导入第二条合成会话作为顺序对照。线程 `01a07ebd-3f50-7fb0-8d63-57ab8bf44869` 的 cwd、原生成员关系、目标路径、非空历史、read/resume 均通过，且不在 projectless 集合中、没有冲突 assignment。用户已确认深度链接打开正确线程，且现有项目列表显示标题标记 `WATCH_PROJECT_FIRST_20260908`。见 人工 GUI 记录。

随后在明确授权下执行真实模型继续。Desktop 持有该线程 writer 时，CLI `exec resume` 会拒绝并发写入；`codex queue` 虽进入原线程，但当前 Desktop provider 在生成回复前确定失败。退出 Desktop 释放 writer 后，带 `--ignore-user-config` 的 ChatGPT CLI 控制组以 `read-only` / `never` 在同一线程精确返回 `WATCH_PROJECT_FIRST_20260908`，无工具项或项目文件变化；该结果只证明导入历史可被另一有效配置消费，见 控制组记录。

针对配置偏差重新验收时，当前 `~/.codex/config.toml` 明确选择 `gpt-5.6-sol` / `CodexPilot`。PATH CLI 与 Desktop bundled CLI 均为 0.153.4；不传 `--ignore-user-config` 后，turn context 也确认生效了 `gpt-5.6-sol`，但 provider 的 prompt audit 经 CLI 内建五次 reconnect 后持续返回 503，未产生 assistant 或工具项。配置、项目文件、cwd、线程 ID 与项目归属不变；没有人工 CLI 重试。Desktop 重开后用户再次确认会话可见，state DB 与新的 Desktop turn 也都显示相同 model/provider，但该 Desktop turn 仍在回复前返回同类 503。见 本机配置失败记录。这证明显示和配置加载正常，不证明 provider 续写成功。导入线程的 `originator=watch_session_import` / `source=vscode` 是候选原因，但缺少 provider 侧契约，根因未确认。

产品入口据此改为同一计划中的 `prepare --desktop-project` / `confirm`：导入前绑定当前 Desktop 项目，导入后设置原生项目 ID，并验证官方项目筛选和私有排除状态。Watch 只读 Desktop 全局状态，不删除 projectless 标记。结果仍返回 `guiAcceptance: pending-manual-review`，不能越过最终画面与模型继续验收。

用户随后明确接受当前限定 P1 证据并授权进入 P2，见 推进决定。这允许在 Watch 中开放上述受控入口，不改变模型失败记录或扩大版本范围。UI 只对已识别的 Claude Code 来源显示 Codex 官方导入预览；确认、状态和 deep link 打开分别调用，打开失败不重复提交。

项目先建原生复测 已用最终产品 CLI 在隔离临时状态中通过：ChatGPT Desktop 全程运行，prepare/confirm/status、成员关系、非 projectless、read/resume、文本工具降级、重复确认、源及配置不变均成立，临时数据已清理。当前全量自动测试 190 项通过；GUI 与模型字段仍为未运行。

### P2 Tauri 原生点击

2026-09-10 使用真实 Watch Tauri 窗口连接保留的无敏感合成源，依次完成项目先建预览、明确确认、打开目标、返回 Watch 后再次打开。用户确认两次均进入线程 `01a088f1-4317-7a40-bd80-fd0df1d69d8f` 并看到 `WATCH_P2_TAURI_20260910`。只读复核确认唯一计划为 `imported`、`canConfirm=false`，项目成员关系与可见性预检成立，目标非 projectless、无冲突 assignment，源与目标摘要未变且目标锁释放。

Computer Use 原生管道未能启动，因此此记录依赖真实窗口中的用户点击确认，不冒充自动截图。没有发送 turn、调用模型或修改项目文件。该结果完成已接入路径在 macOS 26.6.2 arm64、Codex CLI 0.153.4、ChatGPT Desktop 26.903.61454 的 P2 点击验收；模型继续、安装包启动、其他版本和平台仍未覆盖。见 P2 Tauri 原生点击记录。

项目重建复测 保留为历史边界证据；它不再是推荐操作。
**CLAUDE_CONFIG_DIR 覆盖（2026-11-15，v0.1.54，官方文档对照 + 合成目录检查）**：Claude Code 官方设置文档写明，设 `CLAUDE_CONFIG_DIR` 后设置、会话历史与插件改存到该目录（claude.ai 文档原文：To keep the home-directory files somewhere else, set CLAUDE_CONFIG_DIR; Claude Code then stores your settings, session history, and plugins there instead）。Watch 以前只按 `homedir()` 拼 `~/.claude/projects`，设了该变量的用户在 `sessions` / `recent` / `doctor` 里看到零条会话，新建会话还会写进原生不读的 `~/.claude`；现在 `claudeConfigDirFrom(home)` 优先取该变量，Claude 项目根与 Codex 官方导入的「来源会话在别处」扫描都跟随它。合成目录与 CLI 级检查覆盖；未运行原生客户端验证该变量下的 resume。
