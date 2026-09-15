<p align="center"><img src="assets/app-icon@2x.png" width="112" height="112" alt="Watch app icon"></p>

# Watch

**Relieving the watch · The voyage never stalls.**

> [中文](README.md) · Website [relay.bobochang.cn/en](https://relay.bobochang.cn/en/) · Part of [The Fleet](https://github.com/can4hou6joeng4/Homeport)

## What is Watch?

Watch is an independent local session-handoff desktop tool. When an agent reaches its limit, gets stuck, or you want to switch tools, transfer the saved context and continue the same work.

The current implementation primarily handles CLI sessions and terminal resume. The product direction includes verified desktop and IDE entry points, but an official interoperability feature is not proof of Watch integration. See [client compatibility](docs/COMPATIBILITY.md).

## Demo

![Claude Code → OpenCode session handoff (CLI, real output replayed from an isolated environment)](assets/cli-claude-to-opencode.gif)

<p><img src="assets/desktop-03-imported.png" alt="Desktop synthetic demo: Claude Code → Codex Desktop official import preview and simulated confirmation" width="800"></p>

These assets were generated from synthetic sessions in an isolated environment. They show real program output but are not native acceptance evidence; see [assets](assets/README.md) for how they were produced and their limits.

## Current Workflow

1. Get a session ID from the original agent and paste it into Watch.
2. Check the detected source agent and project directory. Do not try another tool's resume action when detection fails.
3. Select the source agent to resume, or another agent and execute the handoff. Selecting a target does not write anything. The target may be a new session or a matching existing session with incremental additions.
4. Continue in the selected terminal, or choose copy-only mode and run the command yourself. Terminal launch failures have a clipboard fallback.

Claude Code → Codex Desktop uses an official single-session import preview and submits only after explicit confirmation. Opening the target thread is a separate action after import. Other targets use the existing conversion after the execute button is clicked; a source ID is never displayed as a target resume command before the target ID is returned. Failed opening retains the target for delivery-only retries without repeating conversion. YOLO is off by default and adds bypass flags to supported CLI commands when enabled. It is not a desktop permission setting.

The desktop has four views: session handoff, handoff history, supported routes and settings, with light, dark and system appearance options. Browser previews do not read local agent records. Loading the demo uses synthetic fixtures without session writes, client launches or model requests. Chinese and English site pages share their structure and interactions; demos are not native acceptance evidence.

## Capabilities and Limits

| Entry point | Current status |
|---|---|
| Claude Code, Codex, Kimi, OpenCode, Pi CLI | Lookup, conversion, and resume implementations exist. OpenCode supports SQLite session resume plus Watch's path-isolation and native-ID fixes; versions and directions still require validation |
| Grok CLI | Core adapter retained, no desktop target card |
| Codex desktop | Claude Code sources now use a project-first preview, confirmation, status, and separate-open flow; a synthetic fixture passed real Watch Tauri clicks and two same-target opens. The existing local CodexPilot continuation attempts remain recorded as 503 failures |
| Claude Desktop Code | The official `/desktop` implementation has been reviewed; it depends on saving and flushing the current CLI session and is not yet integrated or natively validated by Watch |
| OpenCode Web, TUI, and IDE | The official JSON import/export path, read-only server API, Web UI, standalone local TUI, and attached-TUI history visibility passed isolated native validation on Darwin arm64 with 1.18.29. One tool-disabled continuation request produced no reply because of a provider 429, so the official multi-client enhancement remains unintegrated. This does not block the existing OpenCode CLI card; the IDE extension reuses an integrated terminal |
| Antigravity | The official interactive 2.0 → CLI picker has been researched but not natively validated; Watch has no cross-agent import protocol or adapter |

History formats, attachments, and tool events may degrade; result reporting still needs improvement. File replacement uses atomic writes and some round-trip verification, but append paths do not have equivalent protection. Watch does not guarantee zero corruption, automatically create worktrees, migrate code, or guarantee identical model behavior.

## Environment and Privacy

You need a Node environment capable of running this project's `node:sqlite` and tsx dependencies, plus the agent CLIs you use. Native agent execution requires working authentication. Packaged desktop builds currently also depend on external Node.

Conversion primarily handles local records, but the complete workflow is not necessarily offline: creating a Kimi session invokes its CLI, and some Codex execution paths may read authentication configuration and call a model. Validate with dedicated test sessions first. Never commit real credentials, chats, or databases.

## Development

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

Rust tests cover only the current compilation host. Run `npx tauri build` inside `desktop/` to package the current platform. A successful build or installer does not validate session handoff on that platform.

Developer experiment: [official single-session Claude Code → Codex import](docs/import-codex.md), with `prepare`, explicit `confirm`, and read-only `status`; importing requires `--experimental`. To target an existing desktop project, first add and retain the folder in Codex Desktop, then pass `--desktop-project` during preparation. The plan binds the desktop project, applies native membership after import, and read-only checks Desktop's private exclusion state.

```bash
npm run watch -- import-codex prepare <claude-id> --cwd /absolute/project --desktop-project --experimental --json
npm run watch -- import-codex confirm <plan-id> --experimental --json
```

The official route binds the target directory/configuration and uses a Watch import lock; an unrelated desktop process is not a reason to quit. Direct-file converters retain their existing protection. Native evidence covers synthetic fixtures and idle-server coexistence on macOS arm64 with Codex CLI 0.153.4; the P2 Tauri click-through additionally binds ChatGPT Desktop 26.903.61454. Neither result covers every concurrent workload, other versions, or model continuation.

Legacy `project-prepare`, `project-confirm`, and `project-status` commands can still inspect or update the app-server `projectId`, but they cannot clear a persisted Desktop `projectless` exclusion and are not a project-list repair. Do not repeatedly remove the project or reimport the same session as a refresh mechanism. A project-first synthetic session is user-confirmed in the tested project list, and the real Tauri preview, confirmation, and two-open P2 flow is complete. Imported-history consumption still passed only in a control that ignored user config; the local CodexPilot failure record remains.

## Documentation

- [Product requirements and implementation plan](docs/PLAN.md): scope and completion criteria.
- [Client compatibility evidence](docs/COMPATIBILITY.md): official sources, implementation status, and local preflight.
- [Architecture and safety boundaries](docs/ARCHITECTURE.md): implementation and gaps.
- [Contributing guide](CONTRIBUTING.md) (written in Chinese): environment requirements, code style, test isolation and commit conventions.

## License

[MIT](LICENSE).

---

## ⚓ The Fleet

| Ship | Metaphor | Voyage |
|---|---|---|
| 🧭 [Homeport](https://github.com/can4hou6joeng4/Homeport) | Homeport | Personal homepage · Where the fleet comes home |
| **⏱️ Watch** | **Watch** | **Cross-agent session handoff tool** |
| 🗺️ [Atlas](https://github.com/can4hou6joeng4/Atlas) | Atlas | AI coding usage menubar application |
| 🐋 [Sonar](https://github.com/can4hou6joeng4/Sonar) | Sonar | Color-palette-driven iOS music player |
| 🚩 [Semaphore](https://github.com/can4hou6joeng4/Semaphore) | Semaphore | In-browser zero-upload ASCII art tool |
| 🛟 [Buoy](https://github.com/can4hou6joeng4/Buoy) | Buoy | AnyRouter multi-account check-in utility |
| 🗼 [Beacon](https://github.com/can4hou6joeng4/Beacon) | Beacon | PDF certificate validity auditor |
