# 演示素材（assets）

本目录的图片与 GIF 均由 `scripts/media/` 下的脚本在**隔离环境**生成，可复现；它们展示的是真实运行结果，但**不是**任何方向的原生验收证据（验收记录见 `docs/evidence/`）。

| 文件 | 内容 | 生成方式 | 边界 |
|---|---|---|---|
| `cli-claude-to-opencode.gif` | CLI 链路径：`status` → `sessions` → `switch opencode` → `status` | 在临时 `HOME` / `WATCH_DB` / `WATCH_OPENCODE_DB` 下真实运行 CLI，输出录入 `cli-transcript.json`，再由 `replay-cli-gif.mjs` 在无头 Chrome 中按真实时序回放并合成 GIF | 来源是 `make-demo-fixture.mts` 生成的合成 Claude 会话；写入的是临时 OpenCode 库；路径已改写为 `~/…` 便于阅读；未启动任何原生客户端，不代表 OpenCode 原生续写通过 |
| `app-icon.png` / `app-icon@2x.png` | 应用图标（航线交棒），与 `desktop/src-tauri/icons/` 同源 | 由 `desktop/src-tauri/icons/128x128@2x.png` 复制 / 缩放 | README 顶部使用 |
| `cli-transcript.json` | 上述四条命令的原始 stdout 与耗时 | 同上 | 同上 |
| `desktop-01-source.png` … `desktop-06-dark.png`（六张） | 桌面端三个视图（会话接力 / 接力记录 / 支持路径）与亮、暗两种外观 | `desktop/` 的 Vite 预览 + `?demo=1` 合成演示，无头 Chrome 经 CDP 点击「载入演示 → 预览导入计划 → 模拟确认导入」并切换标签页后整页截图；暗色由脚本写入 `localStorage['watch-theme']=dark` 后重新载入 | 浏览器预览不读取本地记录、不调用 Tauri 命令；页面右上角「DEMO / 无真实写入」为真实渲染的标记 |

## 复现

```bash
# 1. 合成 Claude 会话（隔离 HOME）
DEMO_HOME=/tmp/watch-demo/home DEMO_CWD=/tmp/watch-demo/projects/example-api \
  node --import tsx scripts/media/make-demo-fixture.mts

# 2. 真实运行 CLI 并录下输出（会重置临时库）
bash scripts/media/run-demo-cli.sh            # 仅打印；转录见 replay 脚本读取的 transcript.json

# 3. 桌面端截图（先在 desktop/ 里 npx vite --port 1420）
node scripts/media/shoot-desktop.mjs

# 4. 分享图（内嵌应用图标，1200×630）：用本机 Chrome 渲染 scripts/media/og-zh.html / og-en.html
#    （模板内的 base64 图标由 desktop/src-tauri/icons/128x128@2x.png 生成）

# 5. GIF 回放合成（需要 ffmpeg 与本机 Chrome）
node scripts/media/replay-cli-gif.mjs
```

Codex 方向没有 CLI 录屏：`open --to codex` 与 `switch codex` 的 preflight 在检测到 ChatGPT / Codex Desktop 运行时会拒绝写入，生成素材时不应为此退出使用者的桌面应用；该方向以 `docs/evidence/watch-codex-import-tauri-native-2026-09-10.json` 的真机点击验收为准。
