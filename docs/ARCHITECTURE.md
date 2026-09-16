# Watch · 系统架构与安全边界

> 更新：2026-09-10。区分现有实现、安全缺口与拟议扩展；产品范围以 [PLAN.md](PLAN.md) 为准。

业务逻辑在 TypeScript，Rust 只负责 CLI 桥接和原生系统操作。桌面路径为 `src/open.ts`，链式命令路径为 `src/core/handoff.ts`，两者共用适配器但安全覆盖不等价。

---

## 1. 整体分层架构

```
┌─────────────────────────────────────────────────────────────┐
│                      用户界面 (Tauri v2)                     │
│  - React 19 + TypeScript + Vite                             │
│  - 会话 ID、Agent 选择、终端启动与复制回退                     │
└──────────────────────────────┬──────────────────────────────┘
                               │ Tauri IPC (invoke)
┌──────────────────────────────▼──────────────────────────────┐
│                    Rust 宿主层 (src-tauri)                   │
│  - resolve_cwd: 会话反查                                      │
│  - open_in: 增量转译调用                                     │
│  - launch_terminal: 跨平台原生终端唤起引擎 (AppleScript / WT)  │
│  - list_terminals: 本机终端发现                              │
└──────────────────────────────┬──────────────────────────────┘
                               │ Node + tsx + CLI --json
┌──────────────────────────────▼──────────────────────────────┐
│                 核心引擎 (TypeScript)                       │
│  ├── 统一时间线抽象 (UnifiedTurn, ProcessEvent)              │
│  ├── 增量抽取与对齐 (diffTurns, dedupeCallEvents)            │
│  ├── 写入防护 (writeFileAtomic, verifyWrittenTurns)          │
│  └── 适配器 (Claude Code, Codex, Kimi, OpenCode, Pi, Grok) │
└──────────────────────────────┬──────────────────────────────┘
                               │ 本地文件系统 / 原生数据库
┌──────────────────────────────▼──────────────────────────────┐
│                      原生 Agent 存储载体                     │
│  - Claude:  ~/.claude/projects/<enc-cwd>/<uuid>.jsonl       │
│  - Codex:   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl    │
│  - Kimi:    ~/.kimi-code/sessions/.../wire.jsonl             │
│  - OpenCode:~/.local/share/opencode/opencode.db (SQLite)    │
│  - Pi:      ~/.pi/agent/sessions/<enc-cwd>/...jsonl           │
└─────────────────────────────────────────────────────────────┘
```

这些路径是当前适配器默认值，不是所有客户端或版本的官方契约。Grok 在 CLI 注册，但不在桌面目标卡片中。相同品牌的桌面端、IDE 或远程实例不一定共享本机存储。

当前安装包包含 TS 源码、tsx 和 esbuild 依赖，不是混淆 bundle。Rust 子进程 cwd 是核心目录，新增依赖用户项目的命令必须显式传 cwd。CLI 的成功与失败均输出单行 JSON，诊断写入 stderr；当前桥接取最后一个以 `{` 开头的 stdout 行，不单独根据退出码判断结果。

---

## 2. 核心数据结构设计

下例为字段概览，实际类型以 `src/core/types.ts` 为准。现有 `SessionRef` 只有 provider、sessionId、filePath 和 cwd，没有独立客户端或远程主机字段。

### 2.1 统一时间线 (`UnifiedTurn`)
```typescript
export type UnifiedTurn = {
  role: 'user' | 'assistant';
  text: string;                  // 纯净用户指令或最终助手回复
  timestamp: string;             // ISO 8601
  provider?: string;             // 生成该回合的 Agent ID (如 'claude')
  events?: ProcessEvent[];       // 过程事件 (Thinking、工具调用等)
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
};
```

### 2.2 过程事件 (`ProcessEvent`)
```typescript
export type ProcessEvent = {
  kind: 'thinking' | 'tool_call' | 'tool_result' | 'text';
  summary: string;               // 摘要（如 "Bash: cargo build"）
  detail?: string;               // 完整参数或执行输出
  timestamp: string;
  provider: string;
  name?: string;                 // 工具原名
  callId?: string;               // 跨平台调用的唯一标识
  input?: unknown;
  attachment?: {
    kind: 'image' | 'file';
    mediaType?: string;
    data?: string;               // Base64
    url?: string;
  };
};
```

---

## 3. 各主流 Agent 存储逆向规范

### 3.1 Claude Code
- **路径**：`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`
- **目录编码**：非 ASCII 字母数字全部替换为 `-`；
- **机制**：
  - 行结构包含 `parentUuid` 形成的链式树；
  - 助手消息中可能包含 `<thinking>`（加密或非加密）以及 `tool_use`、`tool_result`；
  - 自动探测本机使用的真实 Model 与 Version，避免伪造字段导致 CLI 报错。

### 3.2 OpenAI Codex CLI
- **路径**：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- **机制**：
  - 日期层级目录分片；首行带 `session_meta` 声明 `cwd`；
  - 工具调用使用 `command_execution` 或 `custom_tool_call`；
  - **Desktop 进程检查**：macOS 匹配到 `Codex.app` 或 `ChatGPT.app` 进程时阻断写入；其他平台跳过，探测异常可能放行。这不是完整互斥锁或所有并发情况的保证。

### 3.3 Kimi Code
- **路径**：`~/.kimi-code/sessions/<workspace>/<sessionId>/agents/main/wire.jsonl`
- **机制**：
  - 依赖 `session_index.jsonl` 进行会话查找映射；
  - 文本与事件分离，消息体附带精确的 Token 消耗记录（`usage.record`）。

### 3.4 OpenCode
- **路径**：`${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`（SQLite 存储）
- **机制**：
  - 直接操作其原生的 `session`、`message`、`part` 表；
  - ID payload 为 12 位时间 hex + 14 位 Base62；session 使用 descending，message/part 使用 ascending。
  - 产品适配器使用基础 `index.ts` 编排、`opencode run` 发送方式和 `opencode -s <id>` 恢复命令；Watch 保留环境变量、共享路径和原生 ID 兼容修复。

---

## 4. 数据安全与已知缺口

| 写入路径 | 已有防护 | 不覆盖的部分 |
|---|---|---|
| `handoff.ts` 目标复用 | provider 提供指纹时比较目标变化 | 可选指纹不是锁；桌面 `open.ts` 没有同等完整守卫 |
| 文件新建/整文件替换 | `writeFileAtomic`，部分调用配置验证和备份 | 不是所有写入路径；备份是可选行为 |
| Claude/Codex 既有文件追加 | `appendFileAtomic`，配置 verify 回读校验与 `.bak` 备份 | 备份仅保留上一代；自家解析器校验通过不证明目标客户端接受该扩展 |
| OpenCode 私有导入 | SQLite 事务与数量核对 | 不证明 GUI 缓存、数据库迁移或并发模型兼容 |
| OpenCode 官方导入增强（内部、未注册） | 来源/版本/目标绑定，三级新 ID，持久化单次 claim，目标锁，官方 export 精确读后核验 | 1.18.29 真实 CLI、server、Web、独立 local TUI 与 attached TUI 历史及显式目标模型已通过；单次继续请求因 provider 429 未生成回复，不证明增强路径的模型继续、IDE 或其他版本，也不阻塞基础的 CLI 适配器 |

`writeFileAtomic` 与 `appendFileAtomic` 的主要顺序是同目录临时文件、sync、verify、可选单代 `.bak`、rename；失败路径抛错并清理临时文件，确保原文件零损坏。

`verifyWrittenTurns` 对比角色、文本、事件计数和 callId，并有后缀匹配及 provider 声明的降级处理。附件不参与完整对账。自家解析器读回成功，不证明目标原生客户端接受该会话格式。

直接写入路径已改为**目标级写保护**：按原生 per-thread writer 锁（`~/.codex/thread-writer-locks/<thread-id>.lock` + `lsof` 探测持有者）判定，只在目标会话真被持有才拒绝；写入期间还会以 `flock` 协作独占同一把锁（python3 helper，不可用时降级），把竞态窗口收窄为原子取锁；无目标上下文或 `lsof` 不可用时才回退桌面进程检查，并在写入前后做 `contentFingerprint` 比对。 桌面端可在点击前调用只读预检（CLI `watch open --to <provider> --check`，Tauri `check_open`）：它复用同一套转入决策解析目标会话（resume/chain/reuse/new）并跑一次目标级探测，返回 `writable`/`blocked` 且零写入，预检不可用时不阻塞转入。官方导入仍采用独立的目标目录保护；限定原生验证见兼容性矩阵。保留旧数据库迁移及已落盘的 `tui-chain`、schema 标识。

---

## 5. 当前终端出口

`launch_terminal(cwd, command, terminal)` 与 `list_terminals()` 在 Rust 实现。macOS 包含 Terminal、Kaku、iTerm2、Ghostty 分支；Windows 使用 Windows Terminal/PowerShell 与 conhost 回退；Linux 按候选终端逐个尝试。具体启动、转义和进程检测约束见 `desktop/src-tauri/src/lib.rs`。

前端保留仅复制模式，终端启动失败时复制恢复命令并提示原因。Claude Code → Codex Desktop 是首条例外：成功导入后通过严格校验的目标 ID 打开 `codex://threads/<id>`。打开成功仍不代表模型继续成功。

## 6. 客户端互通扩展

首条 Claude Code → Codex Desktop 路径已接入桌面 UI。`src/import-codex.ts` 提供 CLI，`src/providers/codex/official-import.ts` 编排预览与确认，`app-server.ts` 按操作选择最小 RPC profile；`src/core/import-jobs.ts` 保存不可盲重试的独占执行标记。`desktop/src/codex-import.ts` 对桥接结果做失败关闭解析，`lib.rs` 暴露 prepare/confirm/status 与独立 open 命令。详情见 [导入说明](import-codex.md)。2026-09-10 的真实 Tauri 点击已验证预览、确认和两次独立打开同一目标，见 P2 原生点击记录；模型继续和其他客户端选择仍未实现或通过，模拟测试也不能替代各自原生验收。

`src/providers/codex/import-target.ts` 是官方路径的真实保护实现：绑定规范数据目录的身份与配置摘要，持有目标目录中的 Watch 排他锁，检查原生配置的 SQLite 目录和返回的会话文件范围。原生连接显式传递规范 `CODEX_HOME`；不发送 turn 或设置写入。提交前失败释放自己的锁，未知结果保留目标锁，不按超时自动解锁。它只约束 Watch 提交，不代表锁住 Codex 自己；独立 SQLite 目录暂不支持。两组隔离原生检查已通过且本身不运行 GUI/模型；独立项目先建样本的 GUI 列表和模型继续证据另行记录。

`desktop-project.ts` 只读解析 Codex Desktop 全局状态，将 cwd 精确绑定到唯一 legacy 项目及其 app-server 项目 ID。`--desktop-project` 在同一导入事务中使用 `desktop-import` RPC profile：允许单会话导入和必要的 `project/read`、`thread/metadata/update`、`thread/list`，仍拒绝项目创建/删除、配置写入与模型 turn。成功前还要确认目标不在 `projectless-thread-ids`，且私有 assignment 不指向其他项目；Watch 不修改这些 Desktop 私有字段。

一条项目先建合成会话已在 ChatGPT Desktop 26.901.51231 中通过项目列表人工验收。忽略用户配置的 CLI 模型控制组能在同一线程回答导入历史标记且未调用工具，但当前 `~/.codex/config.toml` 的 CodexPilot provider 对该导入线程返回 prompt-audit 503，因此用户环境的模型继续未通过。CLI 本身仍不能观察 GUI，导入机器结果保留 `pending-manual-review` / `not-run`，人工 GUI 与模型证据单独记录。Desktop 持有同一线程 writer 时也不能由另一个 CLI writer 并发续写。

`project-binding.ts` 是旧的后置关联路径，只能验证或更新 app-server `projectId`。它保留独立日志、目标锁与最小 `project-binding` RPC profile，但无法解除 Desktop 已持久化的 projectless 排除，因此不得把 `associated` 描述成 GUI 可见或作为失败导入的修复方案。

P4 首轮调查发现三种不同的客户端关系，不能抽象成统一 `openDesktop`：OpenCode 有官方 JSON export/import，并允许 Web 与 attached TUI 共享同一 server 状态；Claude 的 `/desktop` 是受认证和平台限制的交互式 CLI → Desktop 迁移；Antigravity 的 picker 只声明 Antigravity 2.0 → CLI 克隆。实现前需按分客户端门禁分别验证。OpenCode 官方 JSON 路径不能从现有私有 SQLite 写入推导 Web/IDE 可见，也不会因存在官方入口就自动替换基础适配基线；是否切换产品路径需要独立批准和完整验收。

OpenCode 1.18.29 的源码检查进一步表明，“官方 import”本身不等于安全事务边界：它保留全部 ID、在 session 冲突时改绑目标目录，对 message/part 冲突静默跳过，且没有显式整体事务。其默认数据根是 `XDG_DATA_HOME/opencode`，但 `OPENCODE_DB` 可改到内存或任意绝对路径，因此默认目录锁不能保护 override。内部增强封装生成全新且引用一致的三级 ID，并用 schema-v3 计划绑定来源、版本、原生配置摘要、目标实例、cwd、显式目标模型和 provider 专属 catalog 摘要；`confirm` 在加锁前及提交前重新读取 catalog，变化即写前阻断。该增强仍未注册 CLI/UI，不能替换基础产品适配器。固定 Darwin arm64 二进制已通过真实 import/export、只读 server API、Web、独立 local TUI 与 attached TUI 验收；随后单次合成继续请求返回 `FreeUsageLimitError` 429，故只保留为增强实验。源码事实见 P4 OpenCode 记录 及后续 native/server/GUI evidence。

`scripts/validate-opencode-native.mjs` 是独立的手动原生验收器，不是产品入口。它要求绝对 executable、`--confirm-native-import` 及显式 `--target-provider` / `--target-model`，不从 PATH 自动选择、不安装软件；全部来源与 HOME/XDG 均为合成隔离数据。验证器调用同一 `OfficialOpenCodeImport` 状态机，完整成功后才允许默认清理；传 `--keep` 时保留给 Web/TUI 人工检查，并输出不得与宿主环境合并的完整子进程环境白名单，避免真实配置、代理或凭据进入隔离客户端。报告将独立 `--session` TUI 与连接 Web server 的 `attach` TUI 分开，并将 server 限制在 `127.0.0.1`；`--server-port` 允许多个保留验收并存，但端口仍进入报告绑定。任何已提交后的不确定或本地断言失败都保留目录。假 CLI 测试只能证明 harness 编排；2026-09-09 的真实兼容状态由单独 native、server 与 GUI evidence 记录，仍不覆盖模型继续。

`scripts/validate-opencode-server.mjs` 消费上述保留报告，只对报告绑定的 IPv4 loopback origin 发出 health/session/messages/provider GET，并用同一 export 检查器复核版本、目标 ID、cwd、消息摘要、目标 provider 连接状态及模型存在性。可选 `--output` 只在真实 `docs/evidence/` 目录新建 JSON，并记录输入 native report 的 SHA-256。它不启动 server、不发送 prompt、不改变验证结果中的 GUI 字段；HTTP 通过仍不证明 Web 或 attached TUI 已显示目标，也不证明模型调用成功。

`scripts/run-opencode-validation-client.mjs` 只负责根据保留报告启动一个明确选择的本地 TUI、Web 或 attached TUI。它要求 `--confirm-client-start`，重新计算 executable SHA-256，并拒绝报告外参数、非 loopback attach、隔离根外环境路径及未列入白名单的环境键；子进程环境不会继承宿主凭据或代理。该脚本同样不是产品入口，也不把进程退出状态升级为 GUI 验收结果。

Claude Code 2.1.258 的 `/desktop` 也不是可供 Watch 直接调用的通用导入 API。它只能在当前交互会话内先保存 `desktop_handoff`、flush 会话状态，再打开 `claude://resume?session=<id>` 并退出 CLI；单独打开链接缺少前两步。因而候选实现最多在已经转入并打开 Claude CLI 后提示用户执行 `/desktop`，并分别记录 CLI 转入、用户 handoff 与 Desktop 可见/继续结果。在本机 CLI 和 Desktop 共同通过合成会话验收前，不新增命令桥或目标按钮。证据见 Claude `/desktop` 实现检查。

Antigravity 2.0 → CLI 同样不是普通恢复参数。`agy --conversation <id>` 只加载既有 CLI conversation；官方 2.0 import 位于 `/resume` picker 的独立页签并要求用户确认。`agy -c` 依赖绝对 cwd 对应的本地缓存，缓存项缺失或后端目标删除时可能新建会话，不能用作无副作用探测。没有公开的外部格式或非交互 2.0 import 前，Watch 不直接写 Antigravity 数据、不注册 adapter/UI，也不把 IDE 或 SDK 生命周期当成用户会话互通。证据见 Antigravity 检查记录。

第一步保持改动小：只为已经验收的 Claude 属主 → Codex 目标增加专用状态机，不重写其他转换器，也不只增加一个 `desktopSupported` 布尔值。

- 分别判断读取、接收、打开和继续是否验证；描述来源/目标客户端、平台、版本和不可用原因。
- 将准备、确认转入、打开分离。转入成功后保留目标 ID 供重试打开，避免重复调用转换；异步结果绑定来源、目标和请求标识。
- 原生打开使用结构化参数和严格验证的目标 ID，不把未校验协议交给 shell，不在链接中放凭据或整段历史。
- Codex `/app` 和会话深链接为候选入口；应用注册协议不证明手工 rollout 能被加载。依据见 [COMPATIBILITY.md](COMPATIBILITY.md)。
- 官方交互式 `/import` 不视为已存在按 ID 自动导入 API；不能默认导入配置、插件或权限设置。

## 7. 结果、隐私和验证

链式接力有 `warnings`/`findings`，桌面路径主要返回 `notes`，覆盖不等价。后续结果需一致说明精确保留、降级、跳过、合成、阻断，以及目标会话和恢复入口；新建摘要不能叫恢复原会话。

本地转译不代表整个工作流离线。继承的 Codex 执行路径在必要时读取认证配置以调用子进程；Kimi 新建会话会调用原生 CLI。禁止输出环境变量或凭据，不因交接默认迁移登录设置。

自动测试使用临时 provider 根、HOME/USERPROFILE、独立 `WATCH_DB`/`WATCH_OPENCODE_DB` 和模拟启动器，覆盖两条接力入口。原生 GUI 验证需要确认隔离方式与授权；不能假设临时 HOME 隔离了用户桌面应用。

发布 build job 已依赖整个 `quality.yml`：根类型检查、前端构建，以及安装 Tauri 系统依赖后在 Linux 运行 Rust 桥接单测。**仓库不分发测试套件**：`tests/` 与本地测试运行器均已加入 `.gitignore`，根 `package.json` 不再提供 `test` 脚本，CI 也不跑回归测试；测试仅在开发者本地工作区存在。P3 新增目标指纹变化后的零写入/链尾不推进、`verifyWrittenTurns` 重复 user 后缀匹配，以及 OpenCode 锁文件的 `dev`、`ino`、`birthtimeNs`、`size` 替换校验；Rust job 会先安装根 Node 依赖，以满足 Tauri resources 检查。P3 记录的本地 Node 226 项 / Rust 7 项通过属当时本地证据；提交 `adce6a7` 对应的 GitHub Actions run `34374022914` 属当时含测试步骤的远程证据。单一 CI 宿主编译、跨平台类型检查和打包成功均不替代原生会话恢复验收。

`scripts/validate-codex-native.mjs` 是手动原生验收工具，不属于自动单测：创建临时 HOME、关闭认证存储的 keychain 路径与分析反馈、仅连接不可用的本机模型地址，不发送 turn 或批准工具。官方导入须显式传 `--official-import`，且只选择合成样本的 `SESSIONS` 项。结果见兼容性矩阵，不能由脚本退出 0 推导 GUI 或模型继续已验证。
