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
| Grok CLI | 适配器已注册，桌面已接入目标卡（`grok -r <id>`，YOLO `--always-approve`） | 实现存在；2026-09-14 隔离原生验收通过 `sessions list` / `export` / ACP `session/load` 回放（不发 prompt）。真实终端 TUI 画面与模型继续未验证 |
| Codex CLI → 桌面端 | S1 `/app`；S2 指定本地会话深链接 | Watch 已为官方导入的目标线程接入固定 deep link；其他来源仍待集成和验证 |
| 已导入 Codex 会话 → 桌面项目成员 | S7 实验性项目查询与元数据接口；S8 当前 Desktop 私有筛选 | 后置 app-server 关联可验证后端成员关系，但不能解除 projectless 排除；不再作为 GUI 修复路径 |
| Claude Code → 官方 Codex/桌面导入 | S3 用户流程；S6 官方 app-server；S8 当前 Desktop 私有筛选 | `--desktop-project` 要求项目先存在；真实合成样本已通过技术预检、项目列表及 Watch Tauri 预览/确认/两次独立打开验收。当前本机 CodexPilot 的既有续写失败仍阻止标记完整模型继续可用 |
| Claude Code → Watch 转换 → Codex 桌面端 | 现有 Codex 构建器 + S2 候选入口 | 原生读回/resume 可用，但工具结果未出现在查询历史中；严格验收失败，不开放桌面入口，保留写入守卫 |
| Codex 桌面会话 → 其他 Agent | Watch 扫描 Codex rollout，可能覆盖兼容的本地记录 | 来源版本、路径和内容覆盖待测；不推导远程会话支持 |
| Claude Code CLI → Claude Desktop Code | S4 明确历史分离；S13 确认交互式 `/desktop` 的本地 handoff 顺序 | 官方有依据 / 待验收；仅 macOS、x64 Windows及订阅登录。直接 deep link 不会保存/flush 当前 transcript，不能作为 Watch 自动迁移入口；最终复核时本机 CLI 与 Desktop 均不存在 |
| OpenCode CLI ↔ OpenCode Web/TUI | 基础适配器提供 SQLite 转入和 `opencode -s` 恢复；S5/S9/S12 覆盖官方多客户端增强 | 现有 OpenCode CLI 卡片继续沿用基础基线。Darwin arm64 / 1.18.29 的官方 import/export、server API、Web、独立 local TUI 与 attached TUI 历史可见已通过；单次无工具继续请求因 provider 429 未生成回复，因此只是不接入新的官方多客户端入口；当前官方索引未提供独立 Desktop 客户端契约 |
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

隔离验收（`GROK_HOME` 指向临时目录、合成来源、全程不发 prompt / 不调用模型、不读写真实 `~/.grok`）：`grok sessions list`（会话 cwd 下）列出该会话；`grok export <id>` 完整渲染对话与工具；`grok agent stdio` 的 ACP `session/load` 回放全部 `session/update`。`grok -r <id>` 在裸 PTY 下只能观察到进程启动并把窗口标题置为会话标题，逐帧画面需要真实终端模拟器，未验证；模型继续仍不在通过范围。

**Codex 直接文件路径改为目标级写保护（2026-09-16）**：原 `preflight()` 只看 `pgrep` 能否匹配 Codex/ChatGPT Desktop，导致两个方向都不准——应用只是开着就一律拒绝（实测：ChatGPT 运行中时非 Claude 来源 → Codex 全部被拒），而应用关闭但 `codex` CLI 正写同一线程时反而放行（正是要防的并发写）。现改为按目标会话判定：读原生 per-thread writer 锁 `~/.codex/thread-writer-locks/<thread-id>.lock`，用 `lsof -Fpc` 探测持有者——锁被活进程持有才拒绝并报出持有者 PID/命令；锁文件不存在（新建会话）或只剩陈旧锁（持有者已退出）则放行；有 ctx 但无目标 ref（新建）放行；无 ctx 或 `lsof` 不可用才回退旧的进程检查。`open --from` 与 `open --to` 两条写入路径同时补上写前/写后 `contentFingerprint` 比对。残留边界：writer 锁是 advisory，探测与实际写入之间仍有窄窗口；本轮**未做真实并发写验证**，也**不提供强制覆盖开关**（被占用时必须先结束该 writer）。隔离回归（stub `pgrep`/`lsof` 五种分支 + 零写入断言）见本地测试，不随仓库分发。

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

2026-09-16 起 `tests/` 不随版本库分发（本地保留，已在 `.gitignore`）：`quality.yml` 不再运行回归测试，远程 `checks` 只覆盖根类型检查、前端构建与 Rust 测试。因此引用回归数量时必须注明「本地隔离回归」，不能把远程 checks 当作回归证据；本节及以下历史记录中的远程通过结论也仅对当时含测试步骤的提交成立。

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
