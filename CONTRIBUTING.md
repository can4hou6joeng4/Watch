# 贡献指南

本指南面向使用本仓库源码的贡献者。它只描述公开可复现的部分；原生客户端的验收记录与内部工程约定不随仓库分发。

## 环境要求

- **Node ≥ 22.13**：核心依赖 `node:sqlite`，更低版本会在模块加载阶段直接失败，不会降级。
- 桌面端另需 Rust 工具链与 Tauri 的系统依赖。
- 各 Agent CLI（Claude Code / Codex / OpenCode / Kimi / Pi / Grok）按需自行安装并认证；仓库不代管凭据。

## 安装与命令

```bash
npm install                                  # 仓库根
npm --prefix desktop install                 # 桌面端依赖另装

npm run typecheck                            # tsc --noEmit，只覆盖 src/
npm --prefix desktop run build               # 桌面前端构建（tsc && vite build）
npm run desktop:dev                          # 本地运行桌面端（Vite 在 1420）

cargo check --manifest-path desktop/src-tauri/Cargo.toml   # 快速检查
cargo test  --manifest-path desktop/src-tauri/Cargo.toml   # Rust 桥接单测
```

仓库**不分发测试套件**：`tests/` 与本地测试运行器均不随版本库分发，根 `package.json` 也不提供 `test` 脚本。PR 与推送到 `main` 由 `.github/workflows/ci.yml` 做类型检查、前端构建、站点构建与分享图摘要校验，以及 Ubuntu 上的 `cargo test`；推 `v*` tag 的 `.github/workflows/release.yml` 在打包前重复这些检查。两者都不跑本地回归，远程通过不代表回归通过。贡献者改完 `src/` 后至少跑 `npm run typecheck` 与 `npm --prefix desktop run build`；手写原生验收器（`validate:*`）是可选的手动入口，参见兼容性文档。

仓库**没有 lint 脚本**（无 eslint / biome / prettier），代码风格靠约定与评审维护。

官网文案源在 `scripts/lib/site-content.mjs`、`site-guides.mjs` 与 `scripts/site-content/llms.txt`；页面的 `siteDate` 与指南日期统一按 `Asia/Shanghai` 维护，构建日期使用同一时区，与宿主机时区无关，仍拒绝未来日期。站点图标生成使用桌面依赖中的 React / React DOM / Lucide，先运行 `npm --prefix desktop ci`，改源后运行 `npm run site:build`。升版或改分享图模板后，先运行 `node scripts/media/render-og.mjs`（默认使用 macOS Google Chrome，可用 `CHROME_PATH` 指定可执行文件），再构建站点。渲染器使用独立临时浏览器目录，记录版本及模板、PNG 的 SHA-256；`node scripts/media/render-og.mjs --check` 与站点构建不启动浏览器，发现过期或缺失产物会失败。`site/` 构建产物与渲染清单需要一同提交。

构建后运行 `npm run site:preview`，可在 `http://127.0.0.1:4173` 检查中英文首页和指南。预览从 `site/` 读取产物，目录地址会打开其中的 `index.html`。

## 目录结构

```
src/cli.ts          CLI 入口与子命令分派
src/open.ts         会话反查与转入（启动器路径）
src/core/           引擎：存储、链式交接、原子写、校验、导入执行日志
src/providers/      各 Agent 适配器；新增一家 = 新增目录 + 在 registry.ts 注册一行
desktop/src/        React + Vite 前端
desktop/src-tauri/  Rust 桥：CLI 子进程、deep link、终端拉起
scripts/            站点构建、打包检查、手动验收器
site/               官网静态资源
```

业务逻辑全部在 TypeScript；Rust 只做 CLI 桥接与必须由 GUI 进程完成的系统操作。桌面端要新增能力时，先加 CLI 子命令并支持单行 `--json`，再在 Rust 加一条薄转发命令。

## 代码风格

- 严格 TypeScript、两个空格缩进、函数 `camelCase`、类型与组件 `PascalCase`、单引号。
- 相对导入**一律带 `.js` 后缀**指向 `.ts` 文件（如 `import { Store } from './core/store.js'`）。
- Rust 使用 `rustfmt`。
- `docs/` 与 `README.md` 为中文主稿，`README.en.md` 是英文镜像，共同内容需同步修改。
- README 是产品文档，只写能力、用法、限制与文档入口；不写逐版本更新说明或临时发布状态。版本历史由 [GitHub Releases](https://github.com/can4hou6joeng4/Watch/releases) 维护。

## 提交规范

- Conventional Commits，作用域小写英文，主题一行中文，例如 `fix(handoff): 修复空链来源判定顺序`。
- 只写一行 subject，不加 body 或 trailers。
- 一次提交聚焦一个模块；涉及行为变更的 PR 请说明验证方式、已知问题与平台限制。

## 测试约定

- 公开检出可运行上文列出的构建和 Rust 桥接检查。维护者另在隔离环境运行本地 TypeScript 回归。
- **测试不得读取真实 Agent 历史，也不得调用模型。** 复现时使用合成会话和临时数据目录，通过可注入的根路径或隔离的环境变量指定这些目录。
- 提交行为变更时附上可复现的输入、命令和预期结果，并说明覆盖的平台。

## 修改写入路径时的安全要求

会话写入是项目的核心风险面，改动相关代码请保持既有约定：

- **原子写**：新文件或整文件重写一律走 `src/core/atomic.ts` 的 `writeFileAtomic` / `appendFileAtomic`，不要直接写文件。
- **写后自校验**：写出后用本 provider 的 `parse` 反解并对账（`src/core/verify.ts`），不一致即视为失败。目标写入侧有受控变换（包装、字段映射）时，应提供 `expectToolCall` 让校验同时比较工具名与入参；未提供时只比计数与 callId（v0.1.161 起 Claude / Pi / Kimi / Grok / Codex 已提供，OpenCode 走 SQLite 事务不经此层）。
- **写前比对目标指纹**：目标会话在解析后若被外部改动，必须中止写入而不是覆盖。
- **降级必须披露**：任何「失败但继续」的分支都要记录到 `warnings` 或 `findings`（`exact` / `degraded` / `skipped` / `synthesized` / `blocked`），不要静默丢弃内容。
- 新增适配器时，接口可选成员的缺省后果不同（例如不实现 `contentFingerprint` 等于跳过写前比对），请逐条确认。

## 新增一个 Agent 适配器

1. 阅读 `src/providers/adapter.ts` 的接口契约。
2. 参考结构最接近的 `src/providers/<id>/`（`index.ts` / `parse.ts` / `build.ts`）。
3. 在 `src/providers/registry.ts` 注册；桌面端目标卡片另有独立列表，需要同步。
4. 用合成会话验证解析、写回和回读，随变更提供复现步骤。维护者将用例纳入本地回归。
5. 若要声明目标客户端能原生恢复，需在隔离环境启动该客户端验收，并注明客户端版本和验证方向。

## 数据与隐私

不要把真实凭据、聊天记录或 Agent 数据库提交到仓库。部分路径会调用目标 CLI 并可能联网（例如新建会话），本地转换不等于全流程离线。测试与演示请使用合成数据。

## 许可

提交即表示同意以本仓库的 [MIT 许可](LICENSE) 发布你的贡献。
