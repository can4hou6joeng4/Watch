<p align="center"><img src="assets/app-icon@2x.png" width="112" height="112" alt="Watch 应用图标"></p>

# Watch

**值更 · Relieving the watch. The voyage never stalls.**

> [English](README.en.md) · 官网 [relay.bobochang.cn](https://relay.bobochang.cn/) · 隶属于 [The Fleet](https://github.com/can4hou6joeng4/Homeport)

## 这是什么

Watch 是独立的本地会话接力桌面工具。当当前 Agent 限额用完、排查停滞或你想换一家时，把已有记录转入目标工具，继续同一项工作。

当前实现以 CLI 会话和终端恢复为主。产品方向包括经过验证的桌面端与 IDE 入口，但官方支持互通不等于 Watch 已经集成。详见 [客户端兼容性](docs/COMPATIBILITY.md)。

## 演示

![Claude Code → OpenCode 会话接力（CLI，隔离环境真实输出回放）](assets/cli-claude-to-opencode.gif)

<p><img src="assets/desktop-03-imported.png" alt="桌面端合成演示：Claude Code → Codex Desktop 官方导入预览与模拟确认" width="800"></p>

以上素材在隔离环境用合成会话生成，展示真实运行结果，但不是原生验收证据；生成方式与边界见 [assets](assets/README.md)。

## 当前使用方式

1. 从原生 Agent 取得会话 ID，粘贴到 Watch。
2. 核对识别出的来源 Agent 和项目目录；识别失败时不要直接按其他工具恢复。
3. 选择来源 Agent 继续原会话，或选择另一家并执行接力。选择目标本身不会写入；目标可能是新会话，也可能复用匹配的既有会话并补充增量。
4. 使用所选终端继续，或选择“仅复制命令”后自行运行。终端打开失败时有复制回退。

Claude Code → Codex Desktop 使用官方单会话导入预览，只有明确确认后才提交；导入成功后再单独打开目标线程。其他目标在点击执行按钮后使用现有转换，目标 ID 返回前不展示来源 ID 充当目标恢复命令。打开失败后保留目标，仅重试交付，不重复转换。YOLO 默认关闭，开启会在支持的 CLI 命令中加入免确认参数；不应将其视为桌面端权限设置。

桌面端使用会话接力、接力记录、支持路径和设置四个视图，支持亮色、暗色与跟随系统三种外观。浏览器预览不读取本地 Agent 记录；“载入演示”使用合成样本，不写入会话、不启动客户端或调用模型。站点中英文共用同一结构与交互，演示不代替原生验收。

## 能力与限制

| 入口 | 当前状态 |
|---|---|
| Claude Code、Codex、Kimi、OpenCode、Pi CLI | 有查找、转换和恢复实现；OpenCode 支持 SQLite 存储会话恢复与路径隔离、原生 ID 修复，具体版本与方向仍需验收 |
| Grok CLI | 内核适配器保留，桌面没有目标卡片 |
| Codex 桌面端 | Claude Code 来源已接入项目先建的预览、确认、状态和独立打开流程；合成样本已通过真实 Watch Tauri 点击与两次同目标打开验收。当前本机 CodexPilot 的既有续写尝试仍记录为 503 |
| Claude Desktop Code | 官方 `/desktop` 流程已完成实现调查；它依赖当前 CLI 会话保存与 flush，尚未由 Watch 接入或原生验收 |
| OpenCode Web、TUI、IDE | Darwin arm64 / 1.18.29 的官方 JSON import/export、只读 server API、Web、独立 local TUI 与 attached TUI 历史可见已通过隔离原生验收；单次无工具继续请求因 provider 429 未生成回复，因此官方多客户端增强仍未接入。该结果不阻塞现有 OpenCode CLI 卡片；IDE 扩展复用集成终端 |
| Antigravity | 2.0 → CLI 的官方交互式 picker 已调研但未原生验收；没有跨 Agent 导入协议或 Watch 适配器 |

历史格式、附件和工具事件可能降级，现有结果提示仍需完善。文件替换有原子写和部分往返验证，但追加写入等路径防护不等价；不承诺零损坏。Watch 不自动创建 Worktree，不迁移代码或保证不同模型行为一致。

## 环境与隐私

需要可运行本项目 `node:sqlite` 与 tsx 的 Node 环境，以及实际使用的 Agent CLI。调用原生 Agent 的路径需要其正常认证；桌面安装包目前也依赖外部 Node。

会话转译主要处理本地记录，但不等于全过程离线：Kimi 新建会话会调用其 CLI，部分 Codex 执行路径可能读取认证配置并调用模型。请先用专用测试会话验证，不把真实凭据、聊天或数据库提交到仓库。

## 开发

```bash
npm install
npm --prefix desktop install
npm test
npm run typecheck
npm --prefix desktop run build
cargo test --manifest-path desktop/src-tauri/Cargo.toml
npm run desktop:dev
npm run site:build
npm run site:preview
```

Rust 测试只覆盖当前编译宿主；在 `desktop/` 中运行 `npx tauri build` 打包当前平台。构建或产物生成不代表该平台会话接力已经验收。

开发者实验入口：[Claude Code → Codex 官方单会话导入](docs/import-codex.md)，提供 `prepare`、明确 `confirm` 和只读 `status`，需要 `--experimental`。要进入已有桌面项目，必须先在 Codex Desktop 添加并保留该目录，再在准备阶段使用 `--desktop-project`；它会绑定桌面项目、导入后设置官方项目成员关系，并只读检查 Desktop 私有排除状态。

```bash
npm run watch -- import-codex prepare <claude-id> --cwd /absolute/project --desktop-project --experimental --json
npm run watch -- import-codex confirm <plan-id> --experimental --json
```

官方路径使用目标目录/配置绑定和 Watch 导入锁，不因无关桌面应用运行而要求退出。原直接文件转换器保留旧保护；两条路径的限制不同。原生证据只覆盖 macOS arm64 / Codex CLI 0.153.4 的合成样本及空闲服务并存；P2 真实 Tauri 点击另绑定 ChatGPT Desktop 26.903.61454。两者都不保证所有并发场景、其他版本或模型继续。

旧 `project-prepare`、`project-confirm`、`project-status` 仍可验证或更新 app-server 的后端 `projectId`，但不能解除 Desktop 已持久化的 `projectless` 排除，因此不是项目列表修复方案。不要通过反复移除项目或重复导入来刷新；这会改变项目 ID，并可能让验收对象继续处于排除状态。当前版本的项目先建合成会话已由用户确认在项目列表可见，P2 真实 Tauri 预览、确认与两次打开也已完成；模型历史消费仍只在忽略用户配置的控制组通过，本机 CodexPilot 配置的失败记录继续保留。

## 文档

- [产品需求与实施计划](docs/PLAN.md)：当前范围与分阶段完成条件。
- [客户端兼容性证据](docs/COMPATIBILITY.md)：官方依据、实现状态和本机预检。
- [架构与安全边界](docs/ARCHITECTURE.md)：当前实现及缺口。
- [贡献指南](CONTRIBUTING.md)：环境要求、代码风格、测试隔离与提交规范。

## 许可

[MIT](LICENSE)。

---

## ⚓ The Fleet

| 船 | 意象 | 航线 |
|---|---|---|
| 🧭 [Homeport](https://github.com/can4hou6joeng4/Homeport) | 母港 | 个人主页 · 船队大本营 |
| **⏱️ Watch** | **值更** | **跨 CLI 编程 Agent 会话接力台** |
| 🗺️ [Atlas](https://github.com/can4hou6joeng4/Atlas) | 海图 | AI 编程用量菜单栏应用 |
| 🐋 [Sonar](https://github.com/can4hou6joeng4/Sonar) | 声呐 | 封面取色驱动的 iOS 音乐播放器 |
| 🚩 [Semaphore](https://github.com/can4hou6joeng4/Semaphore) | 旗语 | 浏览器本地 ASCII 艺术转换 |
| 🛟 [Buoy](https://github.com/can4hou6joeng4/Buoy) | 浮标 | AnyRouter 多账号签到工具 |
| 🗼 [Beacon](https://github.com/can4hou6joeng4/Beacon) | 灯塔 | PDF 证件有效期审计 |
