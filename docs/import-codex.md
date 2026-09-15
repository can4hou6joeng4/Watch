# Claude Code → Codex 官方单会话导入（实验性）

> 2026-09-08：官方路径已采用目标目录保护。项目先建的 `--desktop-project` 合成样本已通过技术预检和项目列表人工验收；用户接受该限定 P1 证据后，Watch UI 已接入预览、确认、状态和独立打开。当前本机 CodexPilot 的既有续写失败记录仍保留。

## 范围

只处理用户指定的本地 Claude Code 会话，通过 Codex 官方 `externalAgentConfig/detect` / `externalAgentConfig/import` 提交一个 `SESSIONS` 项。不会回退到 Watch 私有转换器，不选择设置、记忆、插件、MCP、hooks 或权限；不发送模型 turn、不批准服务器工具请求、不打开应用。

当前版本门禁为 `codex-cli 0.153.4`，来自已记录的原生样本版本，并非完整兼容性认证。其他版本先重新核验，不自动放行。官方依据和既有实验见 [COMPATIBILITY.md](COMPATIBILITY.md)。

## 推荐的项目先建流程

以下是使用说明，不是自动执行授权。先准备专用测试会话；真实会话导入、退出应用、GUI 打开和模型调用仍分别授权。

```bash
# 先在 Codex Desktop 添加并保留 /absolute/project，再生成绑定该项目的预览
npm run watch -- import-codex prepare <claude-session-id> --cwd /absolute/project --desktop-project --experimental --json

# 读完预览中的源 ID、项目、目标 home 和降级警告后，明确确认该计划
npm run watch -- import-codex confirm <plan-id> --experimental --json

# 仅查询本地执行记录，不启动 Codex、不重复导入
npm run watch -- import-codex status <plan-id> --json
```

`prepare` 是此实验命令的预览。桌面端仅在来源识别为 Claude Code 且目标为 Codex 时调用它，并始终启用 `--desktop-project`；其他目标卡仍走原有路径。该选项只读检查 Desktop 全局状态，要求 cwd 精确匹配唯一已有项目，并绑定其 legacy ID 与 app-server ID。`confirm` 会启动官方 app-server，只发送与计划路径及 cwd 精确匹配的单条会话；导入后设置并验证原生项目成员关系，再只读确认目标没有落入 Desktop 私有 `projectless` 排除。项目状态在确认前发生变化会拒绝提交。

不需要项目列表归属时可以省略 `--desktop-project`，但结果会明确保留 `desktop: unverified`。检测可能读取其他配置元数据，官方进程也可能维护自身运行时数据；不能把它称为零写入的纯文件查询。

直接写文件的 Codex 转换器仍保留原桌面进程守卫，未作修改。官方 API 路径采用单独的保护条件，不因其他桌面进程存在就拒绝，也不退出用户应用或回退到私有写入。确认时用进程内参数关闭分析/反馈，不改写配置文件。

### 官方路径的目标保护

- 预览绑定目标目录的规范路径、设备/inode 身份和 `config.toml` 摘要；确认连接前、提交前及读回后重新检查。目录需由当前用户拥有，不能允许其他用户写入；配置不允许符号链接。
- app-server 的 `CODEX_HOME` 显式指定为已确认的规范路径。原生 `config/read` 若声明独立 SQLite 数据目录，当前路径在提交前拒绝，等待额外验证；启动原生服务本身仍可能维护其运行时数据，不承诺零初始化写入。
- 在目标目录创建 `.watch-official-import.lock`，在连接原生服务前取得并持有到退出。它跨不同 `WATCH_DB` 和目标路径别名串行化 Watch 提交，**不是原生 Codex 互斥锁**，也不停止原生任务。
- 成功完成或提交前失败时释放自己的锁；提交后结果不确定、进程崩溃或锁身份变化时保留，不能通过新计划 ID 或另一份 Watch 日志重试同一目标目录。
- 原生返回的目标文件必须位于确认的数据目录内，不接受符号链接指向目录外。只读状态返回锁路径，便于人工核查。

新策略之前的未执行计划需要重新预览，不自动升级授权。上述条件不证明真实 GUI 缓存、活跃模型 turn 或其他原生写入者全部兼容，因此入口仍为显式实验模式。

## 结果及重试边界

| 状态 | 含义 | 下一步 |
|---|---|---|
| `prepared` | 源文件摘要、cwd、home、CLI 版本及目标目录/配置身份已绑定 | 检查后才可明确确认；来源或目标变化则重新预览 |
| `imported` | 官方完成通知精确对应一条来源，目标 ID/cwd/非空历史元数据读回通过 | 记录目标；重复确认只返回原结果，不再次导入 |
| `uncertain` | 已开始提交但没有足够成功证据，或进程中断、部分成功、读回/来源检查失败 | 停止重试写入，按 importId/目标 ID 人工核实；不删除执行标记或目标锁来“解锁” |

工具记录可能转为文本；本命令不验证完整内容、附件、原生工具结构或模型理解。`nativeRead: metadata-only` 不是内容一致性证明。项目模式成功时返回 `desktop: project-membership-and-visibility-preflight-verified`，只表示官方成员关系与当前私有排除状态通过；`guiAcceptance: pending-manual-review` 和 `modelContinuation: not-run` 仍然保留。返回目标 ID 也不等于已在 GUI 打开。

提交前以独占文件创建并 sync 执行标记；两个并发确认最多一个提交。此标记跨进程保留，不能因超时推断服务端未写入。相同源快照、目标 home 和版本生成相同计划 ID，不能通过重复 prepare 绕过标记。修改来源后生成新计划，不提供跨快照增量去重保证。

记录默认在 `~/.watch/imports/<plan-id>/`；指定 `WATCH_DB` 时放在 `<WATCH_DB>.imports/`。文件权限 0600，仅保存路径、摘要、版本和执行结果，不保存聊天正文或原生错误原文。记录不可写则不允许开始导入；`:memory:` 不适用。保留记录用于结果核实，不提交到 Git。

## 本轮验证与下一步

自动测试通过隔离 HOME/USERPROFILE、数据库和模拟 stdio 服务检查范围筛选、乱序完成通知、版本/来源变化、目标目录替换、路径越界、配置变更、跨计划占用、旧文件守卫、崩溃标记、部分结果和 CLI 单行 JSON。不启动真实 Codex app-server、不读取真实会话、不调用模型。

新封装的合成原生导入、读回、恢复和成功后重复确认已通过下述限定场景。获授权的 CLI 模型控制组证明历史可消费，但当前用户配置的既有续写尝试仍失败。用户接受该限定证据后，桌面端仅开放 Claude Code → Codex 的受控按钮；后续仍需界定 provider prompt-audit 兼容并扩大内容和失败恢复样本。

桌面 UI 的 prepared/imported/uncertain 状态与窄窗布局已使用纯合成 invoke 响应检查，Rust 桥接通过 host 编译与严格 ID/deep-link 单测，见 UI 实现记录。2026-09-10 又在真实 Tauri 窗口连接授权合成源，完成预览、确认与两次同目标打开，见 P2 原生点击记录；模型继续、其他平台和版本仍需单独验收。

## 新封装的原生验收入口

```bash
npm run validate:codex-native -- --watch-importer --expect-text-tools

# 同一个临时数据目录中，保持另一个原生 app-server 连接再导入
npm run validate:codex-native -- --watch-importer --shared-reader --expect-text-tools

# 项目先建：临时环境内先创建项目，再走产品的 --desktop-project 导入
npm run validate:codex-native -- --watch-importer --desktop-project --expect-text-tools
```

该模式执行实际 `prepare` → `confirm` → `status` CLI，使用产品中真实的目标保护，不注入空检查或运行旧私有转换器作跳板。只有确认成功才检查重复确认不改目标数据，并继续原生历史读回与恢复；始终不发送模型 turn 或打开 GUI。使用合成源文件、临时 HOME/USERPROFILE、无凭据和不可用的本机模型地址，结束后清理整个实验目录。日常 CLI 的持久执行标记仍保留，不按此实验清理规则处理真实导入。

旧策略在 2026-09-07 的结果：CLI 0.153.4；`prepare` 通过，`confirm` 返回桌面进程阻断，`status` 仍为 `prepared`，无执行标记或导入结果。该历史记录只证明旧策略阻断，并不是官方要求退出桌面的证据。

- 首次快照检查失败：未进入确认步骤。Codex `--version` 会创建临时运行文件，原检查错误拒绝其中的符号链接；保留原报告，不覆盖。
- 修正后的写入前阻断报告：`acceptance: blocked-write-guard`、`importSubmitted: false`。快照明确排除原生 `tmp/`，其他持久数据仍比较；符号链接只比较链接值，不读取链接目标。

新策略的原生证据：

- 目标保护验收：ChatGPT 进程始终存在，独立临时目录中确认、查询、重复确认、原生读取/恢复通过；源与配置不变，工具参数和长结果为文本。
- 同目录原生服务并存：额外 reader 在导入前已连接同一临时 `CODEX_HOME`，导入后能读到目标；其他检查同样通过。没有活跃模型 turn，不推导 GUI 或所有并发写入均安全。
- 最终实现复测：最终代码再次通过共享 reader 场景，报告中的实现摘要与本轮最终封装一致。自动隔离测试为 174 项通过，根类型检查及新增测试严格类型检查通过。
- 项目先建原生复测：真实产品 CLI 的 `--desktop-project` 准备/确认/状态、原生成员关系、私有排除预检、read/resume 与重复确认通过；GUI/模型未运行。

复跑无需因为无关桌面进程存在而退出应用，但仍须遵守目标目录检查、锁和实验授权范围。使用新的 `--report docs/evidence/<新文件名>.json` 留存结果。实现摘要绑定运行时的脚本和封装文件，不能把当前未提交工作区视为只有 HEAD 的内容。

## 为什么项目必须先存在

项目列表不是只按 cwd 或 app-server `projectId` 查询。对当前 ChatGPT Desktop 26.901.51231 的只读解包确认，客户端还读取 `.codex-global-state.json` 中的 `projectless-thread-ids` 与 `thread-project-assignments`，构建项目筛选的 `includeThreadIds` / `excludeThreadIds`。

真实验收中的第一条合成线程在会话已存在后才添加项目，被 Desktop 持久化为 projectless。即使官方 `thread/metadata/update` 成功、`thread/list.projectId` 能查询到目标，重启、刷新或重建项目仍不能让它进入列表。这证明：

- app-server 成员关系成功不等于 Desktop 项目列表可见；
- 公开接口没有已验证的方式解除 Desktop 私有 projectless 排除；
- Watch 不应直接删除私有状态来制造成功；
- 反复移除项目会产生新项目 ID，不是刷新手段。

受控对照在项目已经存在后才导入第二条合成线程。目标 `01a07ebd-3f50-7fb0-8d63-57ab8bf44869` 的 cwd、原生项目成员关系、非空历史和目标路径均通过，Desktop 状态中没有 projectless 排除或冲突 assignment；深度链接可由 Desktop 读取和恢复。用户随后在现有 `project with spaces` 项目列表中确认标题包含 `WATCH_PROJECT_FIRST_20260908`，见 人工 GUI 记录。

获授权的后续模型控制组使用 `codex exec resume --ignore-user-config` 在同一线程精确返回该标记，新增 turn 没有工具调用，测试文件摘要和项目归属未变，见 控制组记录。这不是当前用户配置的验收。去掉该参数后，`gpt-5.6-sol` / `CodexPilot` 已实际生效，但 provider prompt audit 返回 503，未产生回复，见 本机配置失败记录。Desktop 持有该线程 writer 时仍不允许 CLI 同时续写；退出应用只为释放续写锁，导入本身已在 Desktop 运行时通过。

隔离产品探针随后以最终代码再次执行同一顺序，结果见 项目先建原生复测：190 项自动回归、根类型检查和原生导入均通过。该报告的 `desktopUI: not-run` 仍禁止把技术预检写成 GUI 已验收。

## 旧后置关联命令

`project-prepare` / `project-confirm` / `project-status` 暂时保留，用于已有导入的 app-server 成员关系诊断和兼容。它们使用独立最小权限 profile，不重新导入、创建项目或发送 turn；`associated` 只是一份后端历史回执。

这些命令不能修复已经 projectless 的线程，也不能取代推荐的 `--desktop-project` 流程。若旧线程按深度链接可打开但项目列表为空，应保留证据并重新创建一条“项目先建”的专用合成验收线程；不要重复导入真实聊天、清理执行锁或编辑 Desktop 私有状态。

历史后端关联与项目重建实验仍保留为边界证据：协议对照、封装验收、项目重建。它们证明官方成员关系及重建生命周期，不证明 GUI 可见。
