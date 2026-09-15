# 贡献指南

本指南面向使用本仓库源码的贡献者。它只描述公开可复现的部分；原生客户端的验收记录与内部工程约定不随仓库分发。

## 环境要求

- **Node ≥ 22.13**：核心依赖 `node:sqlite`，更低版本会在模块加载阶段直接失败，不会降级。
- 桌面端另需 Rust 工具链与 Tauri 的系统依赖。
- 各 Agent CLI（Claude Code / Codex / OpenCode / Kimi / Pi）按需自行安装并认证；仓库不代管凭据。

## 安装与命令

```bash
npm install                                  # 仓库根
npm --prefix desktop install                 # 桌面端依赖另装

npm test                                     # 隔离环境下的回归测试
npm run typecheck                            # tsc --noEmit，只覆盖 src/
npm --prefix desktop run build               # 桌面前端构建（tsc && vite build）
npm run desktop:dev                          # 本地运行桌面端（Vite 在 1420）

cargo check --manifest-path desktop/src-tauri/Cargo.toml   # 快速检查
cargo test  --manifest-path desktop/src-tauri/Cargo.toml   # Rust 桥接单测
```

`npm test` 支持定向运行：`npm test -- tests/handoff.test.ts`（任何参数都会整体替换默认文件表）。

仓库**没有 lint 脚本**（无 eslint / biome / prettier），代码风格靠约定与评审维护。

## 目录结构

```
src/cli.ts          CLI 入口与子命令分派
src/open.ts         会话反查与转入（启动器路径）
src/core/           引擎：存储、链式交接、原子写、校验、导入执行日志
src/providers/      各 Agent 适配器；新增一家 = 新增目录 + 在 registry.ts 注册一行
desktop/src/        React + Vite 前端
desktop/src-tauri/  Rust 桥：CLI 子进程、deep link、终端拉起
tests/              node:test 回归用例
scripts/            隔离测试运行器、站点构建、手动验收器
site/               官网静态资源
```

业务逻辑全部在 TypeScript；Rust 只做 CLI 桥接与必须由 GUI 进程完成的系统操作。桌面端要新增能力时，先加 CLI 子命令并支持单行 `--json`，再在 Rust 加一条薄转发命令。

## 代码风格

- 严格 TypeScript、两个空格缩进、函数 `camelCase`、类型与组件 `PascalCase`、单引号。
- 相对导入**一律带 `.js` 后缀**指向 `.ts` 文件（如 `import { Store } from './core/store.js'`）。
- Rust 使用 `rustfmt`。
- `docs/` 与 `README.md` 为中文主稿，`README.en.md` 是英文镜像，共同内容需同步修改。

## 提交规范

- Conventional Commits，作用域小写英文，主题一行中文，例如 `fix(store): 修复旧数据库迁移顺序`。
- 只写一行 subject，不加 body 或 trailers。
- 一次提交聚焦一个模块；涉及行为变更的 PR 请说明验证方式、已知问题与平台限制。

## 测试约定

- 使用 `node:test` 与 `node:assert/strict`，文件名 `<feature>.test.ts`，新增用例统一 strict。
- 测试必须经 `scripts/run-tests.mjs` 运行：它会重建环境，只透传 `PATH` / `TERM` 等少数变量，把 `HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、四个 `XDG_*`、`TMPDIR`、`WATCH_DB`、`WATCH_OPENCODE_DB` 全部指向临时根，并剔除 API key 与代理设置。
- **测试不得读取真实 Agent 历史，也不得调用模型。** 用例内部同样自隔离：用临时目录，或通过可注入的根参数覆盖。
- CI（`.github/workflows/quality.yml`）跑类型检查、隔离测试、前端构建，以及在 Linux 上运行 Rust 桥接单测。本地通过不等于对应平台的客户端验收通过。

## 修改写入路径时的安全要求

会话写入是项目的核心风险面，改动相关代码请保持既有约定：

- **原子写**：新文件或整文件重写一律走 `src/core/atomic.ts` 的 `writeFileAtomic` / `appendFileAtomic`，不要直接写文件。
- **写后自校验**：写出后用本 provider 的 `parse` 反解并对账（`src/core/verify.ts`），不一致即视为失败。
- **写前比对目标指纹**：目标会话在解析后若被外部改动，必须中止写入而不是覆盖。
- **降级必须披露**：任何「失败但继续」的分支都要记录到 `warnings` 或 `findings`（`exact` / `degraded` / `skipped` / `synthesized` / `blocked`），不要静默丢弃内容。
- 新增适配器时，接口可选成员的缺省后果不同（例如不实现 `contentFingerprint` 等于跳过写前比对），请逐条确认。

## 新增一个 Agent 适配器

1. 阅读 `src/providers/adapter.ts` 的接口契约。
2. 参考结构最接近的 `src/providers/<id>/`（`index.ts` / `parse.ts` / `build.ts`）。
3. 在 `src/providers/registry.ts` 注册；桌面端目标卡片另有独立列表，需要同步。
4. 补 `tests/<id>-adapter.test.ts`，覆盖解析、写回与 round-trip。
5. 各家原生格式有无法通过内部校验发现、只有真机恢复才会暴露的约束；改动前请以实际 CLI 行为为准。

## 数据与隐私

不要把真实凭据、聊天记录或 Agent 数据库提交到仓库。部分路径会调用目标 CLI 并可能联网（例如新建会话），本地转换不等于全流程离线。测试与演示请使用合成数据。

## 许可

提交即表示同意以本仓库的 [MIT 许可](LICENSE) 发布你的贡献。
