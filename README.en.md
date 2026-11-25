<div align="center">
  <img src="assets/app-icon@2x.png" width="112" height="112" alt="Watch app icon" />
  <h1>Watch · 值更</h1>
  <p><b>Relieving the watch. The voyage never stalls.</b></p>
  <a href="https://github.com/can4hou6joeng4/Watch/stargazers"><img src="https://img.shields.io/github/stars/can4hou6joeng4/Watch?style=flat-square" alt="Stars"></a>
  <a href="https://github.com/can4hou6joeng4/Watch/actions/workflows/ci.yml"><img src="https://github.com/can4hou6joeng4/Watch/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/can4hou6joeng4/Watch/releases"><img src="https://img.shields.io/github/v/tag/can4hou6joeng4/Watch?label=version&style=flat-square" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022.13-3c873a?style=flat-square" alt="Node">
  <br>
  <a href="README.md">中文</a> · Website <a href="https://relay.bobochang.cn/en/">relay.bobochang.cn/en</a> · Related <a href="https://github.com/can4hou6joeng4/Homeport">Homeport</a>
</div>

## Why

When the current agent hits its limit, the context window fills up, or an investigation stalls and you want to switch tools, the conclusions, failed attempts and tool history all stay behind in the old tool. Restating that context is expensive, and it is easy to drop a constraint that mattered.

Watch does one thing: **carry the saved session record and the working directory into a target tool so the same work continues.**

The steps are on the site [guides](https://relay.bobochang.cn/en/#guides): [Claude Code limit to Codex](https://relay.bobochang.cn/en/guides/claude-code-limit-to-codex/), [context window versus usage limit](https://relay.bobochang.cn/en/guides/context-limit-vs-usage-limit-handoff/), [OpenCode and SQLite isolation](https://relay.bobochang.cn/en/guides/opencode-handover-sqlite-isolation/), [Opus 5.5 and the five-hour limit](https://relay.bobochang.cn/en/guides/opus-5-5-five-hour-limit/), [detecting and recovering 0-turn sessions](https://relay.bobochang.cn/en/guides/empty-session-resume-check/), and [handing off with watch prompt when there is no adapter](https://relay.bobochang.cn/en/guides/prompt-handoff-without-adapter/), and [recovering Codex sessions left as .jsonl.zst](https://relay.bobochang.cn/en/guides/codex-compressed-rollout-recovery/).

It does not provide models, bypass usage limits, replace native agent chat, or move permissions, credentials and plugins by default. What it transfers is the recorded session, not the model's unrecorded internal state. Today the implementation is centred on CLI sessions and terminal resume; the product direction includes validated desktop entry points, but **official interoperability does not mean Watch has integrated it**.

## Showcase

The images below were generated from synthetic sessions in an isolated environment and show real program output. They are **not native acceptance evidence**.

<table>
<tr>
  <td align="center" colspan="3">
    <img src="assets/cli-claude-to-opencode.webp" alt="CLI: Claude Code → OpenCode session handoff" width="640">
    <br><b>CLI handoff</b> · Claude Code → OpenCode
    <br><sub>status → sessions → switch opencode → status, replayed with original timing</sub>
  </td>
</tr>
<tr>
  <td align="center" width="33%" valign="top">
    <img src="assets/desktop-01-source.webp" alt="Desktop: source session and context">
    <br><b>Source session</b> · cwd and context lookup
    <br><sub>Session ID, working directory, usage and tool traces</sub>
  </td>
  <td align="center" width="33%" valign="top">
    <img src="assets/desktop-02-preview.webp" alt="Desktop: official import preview">
    <br><b>Import preview</b> · read-only before confirm
    <br><sub>Desktop project, cwd, CLI version and plan ID</sub>
  </td>
  <td align="center" width="33%" valign="top">
    <img src="assets/desktop-03-imported.webp" alt="Desktop: import complete and independent open">
    <br><b>Import complete</b> · then open separately
    <br><sub>Target thread is kept; a failed open is only retried, never re-imported</sub>
  </td>
</tr>
<tr>
  <td align="center" width="33%" valign="top">
    <img src="assets/desktop-04-history.webp" alt="Desktop: handoff history (empty state)">
    <br><b>Handoff history</b> · empty state
    <br><sub>This list is the directory's chained handoff history, not an import execution log</sub>
  </td>
  <td align="center" width="33%" valign="top">
    <img src="assets/desktop-05-compat.webp" alt="Desktop: supported routes">
    <br><b>Supported routes</b> · evidence boundary per direction
    <br><sub>Limited pass / per-route validation / not integrated</sub>
  </td>
  <td align="center" width="33%" valign="top">
    <img src="assets/desktop-06-dark.webp" alt="Desktop: dark appearance">
    <br><b>Dark appearance</b> · light / dark / system
    <br><sub>Preference stored locally</sub>
  </td>
</tr>
</table>

## Install

The CLI and desktop app both require **Node ≥ 22.13** at runtime, plus whichever agent CLIs you use. Both `package.json` files declare the same floor in `engines.node`, so npm can warn about a mismatch at install time; the CLI entry point also has its own version guard.

Download the desktop installer for your operating system and processor from [GitHub Releases](https://github.com/can4hou6joeng4/Watch/releases).

| Platform | Installer |
| --- | --- |
| macOS Apple silicon | `*_aarch64.dmg` |
| macOS Intel | `*_x64.dmg` |
| Windows x64 | `*_x64-setup.exe` |
| Debian / Ubuntu amd64 | `*_amd64.deb` |

**From source.** To run or package the desktop app from source, install Rust and the Tauri build dependencies for your platform.

```bash
npm install                                  # repository root
npm --prefix desktop install                 # desktop dependencies are separate

npm run watch -- status --json               # use the CLI directly
npm run desktop:dev                          # run the desktop app locally (Vite on 1420)
npm --prefix desktop run build               # build the desktop frontend
cd desktop && npx tauri build                # package the current platform
```

To preview the website, run `npm run site:build`, then `npm run site:preview`. The preview listens on `127.0.0.1` on port 4173 by default. Open `/en/` or any guide URL directly.

More conventions (code style, test isolation, commit format) are in the [contributing guide](CONTRIBUTING.md).

## Usage

1. Get the session ID from the native agent and paste it into Watch.
2. Check the detected source agent and project directory. **If detection fails, do not simply resume it as another tool.**
3. Continue the original session with the source agent, or hand off to another agent. Selecting a target writes nothing by itself; the target may be a new session, or an existing matching session extended with the delta.
4. Continue in the chosen terminal, or choose "copy command only" and run it yourself. A failed terminal launch falls back to copying.

Common commands (all accept `--json`; success and failure both print a single-line JSON to stdout, diagnostics go to stderr):

```bash
npm run watch -- status --json                  # sessions, chain tip and switch history for this directory
npm run watch -- sessions --json                # native sessions of every agent in this directory
npm run watch -- switch codex                   # hand the chain tip over to Codex, print the resume command
npm run watch -- adopt claude                   # attach an existing Claude session to the chain
npm run watch -- new pi                         # create the other side of the chain (starts a session on an empty chain)
npm run watch -- open <session-id> --json       # resolve the cwd and print a paste-ready command
npm run watch -- open <session-id> --to codex   # transfer that session to Codex
npm run watch -- prompt <session-id> > seed.md  # export a "summary handoff" doc when the target has no adapter
npm run watch -- prompt > seed.md               # omit the id: take the newest readable session in this directory
```

<details>
<summary>All CLI subcommands</summary>
<br>

```text
status   [--cwd <path>] [--chain <id|name>]                  sessions, chain tip and switch history
sessions [--cwd <path>] [--chain <id|name>]                  native sessions per agent in this directory
switch   <provider> [--cwd <path>] [--chain <id|name>]       hand the chain tip to the target provider
adopt    <provider> [--session <id>] [--cwd <path>] [--chain <id|name>]   attach an existing native session
new      <provider> [--cwd <path>] [--chain <id|name>]       create the other side of the chain
chain    list|new|rename|archive|use [--cwd <path>]          manage and select chains
search   <query> [--cwd <path>] [--reset-index]              local full-text search (FTS5); --reset-index clears only the index and vacuums the store (chains untouched)
usage    [--cwd <path>] [--chain <id|name>]                  token usage per session on the chain
recent   [--cwd <path>] [--limit <n>]                        recently resolved sessions (default 8, max 50)
providers                                                    local install detection per agent
capabilities                                                 read/write capability matrix per agent (code facts, no local CLI probing)
doctor   [--cwd <path>] [--strict]                           environment diagnostics (agents / Claude retention / local store / store footprint and index size / import log); native sessions are left untouched and a missing local Watch store is created; exits 1 on hard failures, --strict also fails on warnings
open     <session-id> [--from <id>] [--provider <name>] [--to <provider>] [--check]
prompt   [<session-id>] [--provider <name>] [--profile minimal|standard|verbose|full] [--last <n>] [--since-compact]   summary handoff: render the session as paste-ready Markdown (degraded path, writes nothing)
inspect  <session-id> [--provider <name>] [--json]   read-only session metadata and counts for turns, events, attachments, malformed lines and disclosures
import-codex  prepare|confirm|status|list|project-prepare|project-confirm|project-status   official single-session import (experimental; see docs/import-codex.md)
```

`watch --help` (also `help` / `-h`) prints the full usage to stdout and exits 0, so it can be piped; with `--json` it returns a single-line `{ ok: true, help }`. A mistyped argument still prints usage to stderr and exits 1. `import-codex --help` follows the same convention.

</details>

<details>
<summary>CLI output reference</summary>
<br>

**`open --to` preflight and plan**

Run `watch open <session-id> --to <provider> --check --json` to preview the target and the number of turns to write. A planning failure returns `ok: false`. When planning succeeds but writing is currently blocked, the result includes `ok: true`, `writable: false`, and `blocked`, and the command exits with status 1. Preflight can create Watch’s local database or update session location records. Native sessions are left intact.

Preflight and execution share the same `plan` fields.

- `plan.kind` describes how the target was selected. `resume` uses the original session in the same tool, `chain` uses a paired session on the chain, `reuse` uses an existing session matched by content, and `new` creates a session. `plan.turnCount` is the number of turns planned for writing.
- `plan.reuseScanIncomplete` lists the reasons when the plan creates a session after an incomplete reuse scan. `capped` means the list reached its cap, `candidates-unreadable` means some candidates could not be read, `list-failed` means the list could not be read, and `unattributable` means files were skipped because they could not be assigned to a directory. Creating a session in these cases may produce a duplicate.
- `plan.chainPairSkipped` gives the paired session’s ID and the reason it was skipped. `zero-byte` means an empty file, `zero-turns` means it parsed to zero turns, `unreadable` means the read failed, `compressed` / `compressed-empty` mean only a compressed copy remains, and `diverged` means the paired session is missing at least half of the source turns. The chain still points to the original paired session, so a later `switch` may select it.

`inspect` counts malformed lines in JSONL sessions. In `--json` output, `badLinesStatus: "complete"` means `badLines` is the count from a completed scan. With `"incomplete"`, the count is a confirmed lower bound and `warnings` explains why. SQLite and other sources outside the JSONL scan return `"not-applicable"` with `badLines: null`. Usage numbers follow the same rule: when the session's usage source contains unparsable lines, `--json` includes `usageBadLines` and the text marks the number as a lower bound; if the scan itself fails, `usageBadLinesScanError` says the total may be low by an unknown amount.

In `inspect --json`, `session.storageScope` is `session-file` for an individual session file or `shared-database` for OpenCode. `sizeBytes` and `modifiedAt` describe the file at `filePath`. For OpenCode, `session.recordedUpdatedAt` gives the individual session's recorded update time, or `null` if the value is missing or invalid. When the session's recorded working directory is unusable, `session.recordedCwdState` carries the same values as `cwdState` (`missing`, `not-directory`, `denied` or `unknown`, the last with a `reason`); a healthy directory, or a session with no recorded directory, emits no such field. `inspect`, `providers` and `capabilities` do not read `--cwd` (the first looks the session up by id globally, the other two are independent of any directory); when it is given explicitly, `warnings` states that it took no part, and text mode prints that to stderr. Grok records carry no per-turn timestamps, so `structure.firstTimestamp` / `lastTimestamp` are inferred; in that case `--json` adds `timeRangeNote` describing where they come from, and the text output appends the same note to the time range.

`structure.timestampedTurns` counts the turns included in that range; when some turns lack a timestamp, `--json` adds `timestampNote` with the coverage and the text output appends the same note. `structure.events.danglingToolCalls` counts tool calls with no matching result by callId; they may be waiting for user approval, still running or interrupted, which is not proof of data loss. `structure.events.orphanToolResults` counts tool results with no matching call by callId, often left behind by context compaction; some providers turn these results into context disclosures instead of orphan-result events, in which case check `disclosureEvents` and the related `warnings`. The output gives only counts, never callIds, tool inputs or result text.
The callId preview in `open` / `switch` warnings escapes ESC, newlines and other control characters before display, as do warnings in `inspect` text output; `--json` keeps the original values. Failure and blocked messages, usage and bad-line notes, and the preview of a hanging user tail are escaped before printing as well. Chain names, chain ids and session ids are escaped in `chain` / `status` text output too, while `--json` keeps the original values.

In the `status --json` lineage graph, match `nodes[].key` to `edges[].from` and `edges[].to`. Use the node's original `provider` and `sessionId` to display the session identity.

The `claudeRetention` field in `doctor --json` reports the retention period from Claude Code user settings, and `claudeProjectRetention` reports what project settings say: `.claude/settings.local.json` and `.claude/settings.json` in the current directory, plus the repository-root `.claude/settings.local.json` when running inside a subdirectory of a normal Git repository (`scope` is `repository-local`). An unusable path, unreadable file, or file larger than 1 MiB yields `unknown` with a reason. `cleanupPeriodDays` is allowed in any settings file, so project settings can override user settings; the repository-root file is skipped for worktrees and submodules (`.git` is a file), when the repository root is the home directory, or when ownership does not match (the estimate can therefore be conservative for worktrees), while `--settings` and managed settings remain out of scope, and the effective retention period depends on all settings Claude Code loads. For the chain-tip risk estimate, `doctor` follows the precedence among the files it probed and uses the value Claude Code would read rather than the shortest value found: the repository-root local file outranks the starting-directory local file, project local outranks project shared, and project settings outrank user settings. A short value that is overridden is not reported as a risk, and when a higher-precedence file cannot be read, a lower value is not used to guess. When that retention period is explicitly below the official default and a chain tip is a Claude Code session file older than that many days, `doctor` marks the chain as a cleanup risk, estimated from the file modification time and not a claim that deletion is certain. `store.created` is `true` when this run created the local store because the file did not exist yet; the text output marks this on its local-store line, and the field is omitted when the store already existed.

The `usage` total is only the sum of what could be read: failed reads, sessions without a usage field and adapters that do not provide usage are named in the total line. When a session's usage source has unparsable lines, a line under the total says the number is a lower bound, and that session's row is marked the same way — in `--json` this is `totalExcluded` / `totalMissingUsage` / `totalEmptySessions` / `unsupported` / `byProvider[].usageBadLines`; a legitimate empty session counts only in `totalEmptySessions` and never inflates "no usage data". Bad lines in the content file are disclosed too, with `byProvider[].contentBadLines` carrying the count; usage already read from a sidecar file stays in the total rather than disappearing because of content-file bad lines. When the content cannot be parsed at all, that session counts as a read failure (the text says the content could not be read, not that there is no usage data) and `--json` sets `byProvider[].contentUnreadable: true`, so scripts can tell it from `contentProblem`, which means usage was read while the content file is empty, missing or unavailable — the conversation itself is gone. Only a genuine 0-turn parse is described as not being an empty session; with existing turns the warning says the content may be incomplete.

The same holds for `search`: when a session file has unparsable lines, those lines never reach the index, and the search reports it in `warnings` — including on later runs that reuse the index — instead of just returning no results. `--json` also carries `coverage`: `sessions` is the number of sessions enumerated for this directory (0 means none), while `capped` and `incomplete` list providers that hit their session-list cap or whose sessions did not fully enter the index; those keys appear only when non-empty, so scripts can tell "no match" from "not fully searched".

When `--cwd` is unusable, the `--json` output of `status` / `sessions` / `recent` / `usage` / `search` / `doctor` / `chain list` also carries `cwdState: { state }` (`missing`, `not-directory`, `denied` or `unknown`, the last with a `reason`); a healthy directory emits no such field. `new --json` carries it after a successful write too: the session and chain record **were written**, but `resume` will fail to enter that directory — it means the directory is unusable, not that the operation was blocked. The same holds for `chain new` (the chain record was written), and successful `chain rename` / `chain archive` / `chain use` carry it as well: chains are grouped by the literal `--cwd` string, so they remain editable after the directory disappears, but the chain is bound to an unusable path. Successful `switch` / `adopt` carry it too: the session content was written to the target provider's native file and the chain record was written for that literal string, but `resume` will fail to enter the directory. Successful `open` / `open --to` / `open --check` carry it as well: the command returns `cd` plus `resume`, but the `cd` will fail on the session's recorded working directory; the text-mode write warning is unchanged. It comes from the same probe as the text-mode warning ("--cwd 目录不存在…"), so an empty list, zero hits or `total: 0` with `ok: true` must not be read as "this directory has no sessions or matches" — check `cwdState` first.

When the local store cannot be opened, `sessions --json` and `usage --json` carry `storeAvailable: false`: the former lists native scan results only (a `--chain` filter is not applied), and in the latter `chain: null` / `byProvider: []` only mean the report could not be read. When `--chain` is given but not applied (no such chain in this directory, the chain query failed, or the store did not open), `sessions --json` also carries `chainFilterApplied: false` — `providers` is then the full session list, not a filtered one; the field is absent without `--chain` or when filtering did take effect. `status --json` carries `storeAvailable: false` too, separating the two cases behind `historyAvailable: false` — the store did not open versus the store opened but switch history could not be read. `recent --json` carries `storeAvailable: false` too and still lists `本地库` (local store) under `unavailable`; none of these commands emits `storeAvailable` when the store opens normally. The write commands `new` / `switch` / `adopt` still finish writing the native session and return `ok: true` when the store cannot be opened; they then carry `storeAvailable: false` as well, meaning the binding was not written to the chain record (a later `status` / `switch` will not recognize it). When the store opened but writing the chain record threw, they carry `chainRecordFailed: true`. Both fields appear only in the abnormal case, and the reason stays in `warnings`. `open`, `open --to` and `open --check` still succeed when the store cannot be opened, and their `--json` carries `storeAvailable: false` as well: the lookup was a full scan and the hit was not written back to the session-location mapping. `status` / `usage` / `recent` always echo the `cwd` they used (`--cwd` omitted means the process working directory), matching sessions / search / doctor.

**Handoff results**

- `sourceDrift: { from, to, growth }` reports byte counts before and after a source file changes during a handoff and the direction of the change. For a write handoff, rerun the same command to pick up appended turns. Check the file first if it was rewritten or truncated. `sourceDriftUnknown` explains why the check could not confirm whether the source changed. Refer to the original session for its latest state. `switch`, `open --from`, `open --to`, and `prompt` share these fields.
- `targetRecreated: { previousSessionId }` means the original target was moved or deleted before the write. The returned session ID points to a new session containing only what this run wrote. `switch`, `open --from`, and `open --to` share this field.
- `crossDirectory: { sourceCwd, targetCwd }` means `open --from` merged content from a source with a different recorded directory. The field preserves the original paths. Use them to check for a renamed directory or a mistyped session ID.
- `unparsableLines: { source?, target? }` applies to `switch`, `open --from`, and `open --to`, including `--check`. Each side has `{ count, error? }`. Bad source lines can leave gaps in the transfer. Bad target lines can cause existing content to be appended again. With `error`, `count` is a confirmed lower bound. Each side is reported only if lines were skipped or the scan failed. If `open --to` refuses an empty source, the failure result also reports any bad lines found or scan error. When `open <id>` or a same-provider `--to` resume parses zero turns, `target` also reports bad lines or errors found by that scan. `adopt` of a zero-turn session and `switch` when the chain tip is such a session report the same field. When `status --json` parses zero turns at the chain tip and the scan finds bad lines or fails, it also reports `chainTipBadLines: { count, error? }` from the same scan as the warning; a clean empty session omits it, and `count` remains a lower bound when `error` is present. `chain list --json` gives the same `{ count, error? }` as `chains[].tip.badLines` for a zero-turn chain tip and omits it for a clean tip; its text-mode tip line then says "file has unparsable lines" rather than calling it an empty session. `doctor --json` carries the same `badLines` on `store.emptyTips[]` entries for zero-turn tips.
- `contentLoss` counts content the target format cannot preserve. `attachments: { images, files }` covers attachments reduced to placeholders, `textEvents` covers standalone process text, `toolFailures` covers native failure markers on tool results, and `bashControls: { workdirs, timeouts, backgrounds }` covers Bash execution settings. Counts match `warnings`. With `--check` they describe the proposed transfer. Only nonzero categories appear.
- `sourceUnfinished` describes unfinished work in the source. `danglingToolCalls` counts calls with no result. `unansweredTail` means the last user message is still unanswered. Its value is `cancelled` or `error` when marked in the source log, and `unknown` when the reason could not be verified.
- `targetUnfinished` uses the same keys for the existing session named by the resume command. It applies to plain `open <id>`, `open --from`, same-tool resume, chain pairing or reuse with `open --to`, and `switch`. Calls with no result always count. An unanswered message counts only if this run merged no content.
- `contextDisclosures: { source?, target? }` gives the distinct context disclosures per side, such as compaction records, backgrounded sessions, unrecognized record types, or failed requests. The disclosure text appears in `warnings`. Only sides with disclosures appear.
- `emptySessions: { source?, target? }` describes an empty session at the time `open` read it. `zero-byte` means a 0-byte session file and `zero-turns` means it parsed to zero turns. This identifies an empty source even when `mergedTurns` is 0. If `open --to` refuses an empty source, the failure result includes this field. `adopt` of an empty session reports the same values under `target`.
- `pairedTurnsMissingEvents` counts turns where the existing target already has replies with the same text but lacks source process events it can preserve. This applies to `open --from` and to chain pairing and content-based reuse in `open --to`. Those turns count as already included. The field is omitted when the count is zero or the target is newly created.

When the source per-turn timestamps are inferred (currently only Grok), `switch`, `open --from` and `open --to` say so in the result notes after actually writing, including how the timestamps were derived and how many turns were written unchanged; a zero-increment run that rewrites the target to repair its format also discloses the source turn count. `--check` and same-provider resume write nothing and carry no such note.

</details>

<details>
<summary><code>prompt</code> summary handoff reference</summary>
<br>

When the target has no adapter yet (or that agent's format just drifted and writing back is risky), use `prompt`: it is read-only and renders the session as Markdown whose opening states "this is a summary handoff, not the target agent's native session".

**Choosing a source session**

With the session id omitted, it picks the most recently modified readable session under `--cwd` (the current directory by default), and `--provider` narrows that search to one agent; the document header says the session was auto-picked and `--json` carries `autoPicked: true`. When nothing can be picked it emits no partial document, and "unreadable" is reported separately from "no sessions here". When a session id is given explicitly, `--cwd` does not participate (the session is looked up by id globally and the body comes from the session's own records); passing it anyway is reported in `warnings`.

**Transcript window**

- `--profile` controls how much is kept.
- `--last <n>` keeps only the last n user turns (an explicit window that no longer force-keeps the first turn, and the document says so; `--json` reports `stats.includedUserTurns` for the real user turns actually kept, excluding a compaction-summary anchor, and `stats.taskDescription` as `kept` / `omitted` / `summarized` / `absent` from the same rule as the document's task-description line; `absent` means the source has no user turns at all, not that they were trimmed).
- `--since-compact` starts rendering from the latest recognizable compaction summary (Claude Code, Pi, Kimi and OpenCode record formats are all recognized; Codex's compacted records and OpenCode 2.x provider-native compactions are only disclosed, not merged into the summary), so the turns that summary already covers are not repeated (the summary itself states which agent generated it and that it is not user speech; when no usable summary exists it does not trim for that reason and the body says so, and any `--last` / profile trimming is stated separately; `--json` reports `stats.sinceCompactResult` as `off` / `applied` / `unavailable` to distinguish "not requested" from "found" and "not found", and `stats.compactSource` as `claude-code` / `opencode` / `pi` / `kimi` only when applied).

Anything trimmed is counted in the `--json` `findings` and explained on stderr.

**Timestamps, usage, and read status**

The header's time range states where each endpoint comes from (the start is the first record; the end may be the file's modification time; Grok records carry no per-turn timestamps, so those are derived in order from the session summary's creation time, and anchored to the chat file's modification time when that summary is missing — the header says so, and says that value is not the real per-turn time; when the first record has no timestamp, the start is taken from the first record that has one and the note says so, and when some turns lack a timestamp the note gives the coverage, such as `2/3 轮有时间戳`, meaning 2 of 3 turns have a timestamp). `--json` carries the same text as `timeRangeNote` (where inferred times come from) and `timestampNote` (coverage), and counts the turns without a timestamp under the `prompt_turns_without_timestamp` finding. When usage cannot be read or its data source has been emptied, that line gives the reason and says it does not mean the session has no usage, instead of falling back to "no usage record"; when the source has unparsable lines, the number is still printed but marked as a lower bound; when the session file itself has unparsable lines, the header says so and notes that records may be missing; when the source yields zero turns, the body says whether the file is empty (0 bytes, restore from backup) or readable but has nothing to hand off.

**Working directory and branch**

The header also reports the current working-directory state, worktree type and current branch; a repository subdirectory walks up to the nearest repository root and names it. When that directory is unavailable, `--json` also returns `sourceCwd: { state }` (`missing`, `not-directory`, `denied` or `unknown`, the last with a `reason`); a healthy directory emits no such field. `--json` additionally returns a structured `sourceBranch` (`{ branch, repoRoot }` for a normal repository root, `{ detached: true, repoRoot }` for a detached HEAD) or `sourceWorktree: { mainWorktree, branch }` for a linked worktree; when worktree detection fails it returns `sourceWorktreeUnknown: <reason>` plus the `prompt_source_worktree_unreadable` finding, so an absent `sourceWorktree` must not be read as "not a linked worktree".

**Source changes during rendering**

If the source file size or modification time changes between checks, `--json` returns `sourceDrift: { from, to, growth }`; when the stat itself fails it returns `sourceDriftUnknown: <reason>` instead — a missing `sourceDrift` can mean unchanged or unverifiable, so scripts must not read it as "nothing changed". These byte counts and growth direction cannot establish which records made it into the document.

If `prompt` detects a source change during rendering, it states in the document body that the content reflects the moment reading began. Rerunning the command generates a new document.

**Unfinished operations**

The `prompt` handoff document also discloses unfinished tool calls in its metadata and "Continue working" section (counted over the whole session, regardless of profile or `--last`): they may be waiting for user approval, still running or interrupted. They are not confirmed failures — do not assume they completed or redo them without checking. `--json` reports the same count in `stats.danglingToolCalls` and `findings` as `prompt_dangling_tool_calls`. Only the count is included, never callIds, tool inputs or result text. The opposite gap is disclosed the same way: tool results with no matching call may come from context compaction or a truncated record. They are not proof of failure, but they cannot be used to reconstruct the original sequence; `--json` reports `stats.orphanToolResults` and the `prompt_orphan_tool_results` finding, again as counts only.

The document also flags a half-finished tail: a last user message with no assistant reply (Ctrl-C, exhausted usage, a killed process or a truncated file can all cause this). Sources explicitly marked failed or cancelled are described as such; `--json` exposes `stats.unansweredTail` and a `prompt_unanswered_tail` finding; `stats.unansweredTailReason` reports `cancelled` / `error` when the source explicitly marks it and `unknown` when it cannot be confirmed, and appears only for a half-finished tail. The check only applies when the trailing user turn has real text, not a placeholder empty turn. That message is usually the task to continue on the target side; the document no longer asks the user to reconfirm whether to take it. It asks for a check only when the source may already have started work.

Explicitly failed tool calls are also returned as `failedAttempts` (tool, path or command, count; never tool output), with the `失败与中断` (Failures and interruptions) section in the document; neither appears without an explicit failure marker.

**Change manifest and disk check**

The body also lists the files the session wrote or edited and the commands it ran (the `改动概览` / changes overview, independent of profile trimming) and compares them with the disk at render time: a path that is definitely gone is marked as no longer on disk, a relative path that was not found or could not be read is marked as unconfirmed, and a file removed or moved by the session's own patch is marked as such; paths outside the session directory are only counted, never checked. When the recorded working directory is unusable or unrecorded, the body says the check was not performed instead of looking the same as "all still there". `--json` gives `manifest.files[].disk` as `missing`, `unverified` or `removed` (an absent value may mean either "all present" or "not checked"), plus `manifestDisk: { checked, missing, unverified, outside, removed }`, which appears only when the recorded directory is usable and the manifest lists files.

**Credential masking**

Because this document is meant to be pasted into another agent, **fixed-format** keys and tokens found in the session (common vendor API keys, GitHub / GitLab / Slack / npm / Hugging Face tokens, AWS access key IDs, JWTs and PEM private-key blocks, plus PGP-armored private keys), plus four values identified by position (the password inside a connection string such as `postgres://user:password@host`, the value of key headers such as `X-Api-Key` / `X-Auth-Token`, the `name=value` value of a `Cookie` / `Set-Cookie` header or `curl --cookie` (preserving subsequent command arguments; request headers and quoted arguments are still scanned past an earlier variable reference for later cookies), and the Bearer / Token / Basic value of an `Authorization` header), are replaced with `[已隐去：种类]` (masked: kind) before they reach the document; the header states the kinds and counts, and `--json` adds `credentialsMasked: { total, kinds }` (kinds and counts only). The source file is not modified and still holds the original text. Only fixed formats and fixed positions are recognized: standalone passwords, internal addresses and keys without a fixed prefix are not detected, the absence of that line does not mean the document is free of sensitive content, and you should still review it before handing it over. This applies to `prompt` only; paths that write a native session, such as `open --to`, carry the record as it is.

</details>

The desktop app has four views — **session handoff, handoff history, supported routes, settings** — with light, dark and system appearance. A browser preview never reads local agent records; "load demo" uses synthetic fixtures without session writes, client launches or model requests.

YOLO is off by default. Enabling it adds no-confirmation flags to the CLI commands it supports, which relaxes the target agent's permissions or sandbox; it is not a desktop permission setting.

**Claude Code → Codex Desktop (official single-session import)**

Nothing is submitted until you explicitly confirm, and the target thread is opened separately after a successful import. To land in a desktop project, the folder must already be added and kept in Codex Desktop, then `--desktop-project` is used at the prepare stage.

```bash
npm run watch -- import-codex list --json
npm run watch -- import-codex prepare <claude-id> --cwd /absolute/project --desktop-project --experimental --json
npm run watch -- import-codex confirm <plan-id> --experimental --json
npm run watch -- import-codex status <plan-id> --json
```

`list` read-only lists the plans and statuses in the execution journal (no Codex connection, no file writes); use it first if you no longer know the plan id.

The legacy `project-prepare` / `project-confirm` / `project-status` commands can still inspect or update the app-server `projectId`, but they cannot clear a persisted Desktop `projectless` exclusion and are not a project-list repair. Do not repeatedly remove the project or reimport the same session as a refresh mechanism — that changes the project ID and can leave the target excluded.

## Capabilities and limits

| Entry point | Current status |
|---|---|
| Claude Code, Codex, Kimi, OpenCode, Pi, Grok CLI | Lookup, conversion and resume are implemented, and the six desktop target cards reuse each adapter resume command verbatim; OpenCode supports SQLite session resume with path isolation and native ID fixes, but specific versions and directions still need validation |
| Grok CLI desktop entry | Integrated as the sixth target card (`grok -r <id>`, YOLO `--always-approve`); after writing the native ACP `updates.jsonl`, isolated validation passed `sessions list`, `export` and ACP `session/load`; a limited PTY sample confirmed TUI frames and one model reply, without broader version, platform or remote-session claims |
| Codex Desktop | The Claude Code source is wired into the project-first preview, confirm, status and independent open flow; synthetic samples passed a real Watch Tauri click-through and two opens of the same target. The local CodexPilot continuation attempt is still recorded as 503 |
| Claude Desktop Code | The official `/desktop` flow has been investigated; it depends on the current CLI session being saved and flushed, and is neither integrated nor natively validated by Watch |
| OpenCode Web, TUI, IDE | On Darwin arm64 / 1.18.29, official JSON import/export, the read-only server API, Web, a standalone local TUI and an attached TUI all showed the same history in isolated native validation; a single no-tool continuation request produced no reply due to provider 429, so the multi-client enhancement is not integrated. This does not block the existing OpenCode CLI card; the IDE extensions reuse the integrated terminal |
| Antigravity | The 2.0 → CLI official interactive picker has been reviewed but not natively validated; there is no cross-agent import protocol or Watch adapter |

**Historical formats, attachments and tool events may degrade**, and the result reporting still needs work. New files, whole-file replacement and Claude/Codex incremental appends all use same-directory atomic writes and parse-back verification before rename, and the target fingerprint is compared before writing; Codex targets additionally go through a write preflight: every platform first checks that the Codex data directory and configuration are readable, and on macOS it also probes the native per-thread writer lock and holds that lock cooperatively during the write (those two lock layers only apply on macOS; on Windows and Linux only the fingerprint check, the atomic write and parse-back verification remain). OpenCode reconciles rows in a SQLite transaction, and other providers protect writes according to their own storage format, so coverage is not fully equivalent; **zero damage is not promised**. Watch does not create worktrees automatically, does not move code, and does not guarantee identical behaviour across models.

The official route binds the target directory/configuration and uses a Watch import lock, and **an unrelated running desktop app is not a reason to quit**; the direct-file converters rely on target fingerprints, atomic writes and, for Codex, a cooperative writer lock (macOS only), so the two routes differ in coverage. Native evidence covers only synthetic fixtures and idle-server coexistence on macOS arm64 with Codex CLI 0.153.4, while the real Tauri click-through additionally binds ChatGPT Desktop 26.903.61454 — neither covers every concurrent workload, other versions, or model continuation.

Opening and continuing are two different states: when a handoff succeeds but the client fails to open, only opening is retried, never the transfer.

## Design

- **TypeScript carries the business logic**; Rust only bridges the CLI and performs system operations that must come from a GUI process.
- **One adapter per agent** (`src/providers/<id>/`); the unified timeline is produced and written back at the adapter boundary.
- **Three write-safety layers**: target fingerprint comparison before writing (TOCTOU), same-directory atomic writes, and parse-back verification before rename.
- **Two official routes stay isolated**: the Codex official import and the OpenCode official enhancement use their own execution journal and target lock instead of the converters above.
- **Degradation must be disclosed**: every "failed but continued" branch is recorded in warnings or findings rather than silently dropping content.

Details and protection gaps are in [architecture and safety boundaries](docs/ARCHITECTURE.md).

## Origin

Coding agents each keep their own session records. Switching tools should be routine, but every switch means restating the background: the earlier conclusions, the attempts that failed, and the constraints already established all stay behind in the old tool — and those are exactly the parts that are hardest to restate.

So Watch does not aggregate, does not proxy, and does not add another chat layer. It tries to make one segment solid: the handoff of "existing record + working directory". Findable first, verifiable next, protected on write, and continuable after delivery.

## Environment and privacy

Session conversion mostly handles local records, but it is **not an entirely offline workflow**: creating a Kimi session invokes its CLI, some Codex execution paths may read authentication configuration and call a model, and the target agent communicates under its own service rules when you continue.

Paths that invoke a native agent require it to be properly authenticated. Validate with a dedicated test session first, and never commit real credentials, chat content or agent databases to the repository.

**Search builds a local index.** `watch search` writes the turn text plus tool-call and tool-result records of agent sessions in the current directory into a full-text index (`messages_fts`) inside `~/.watch/watch.db`, so later searches do not re-parse the files. The index stays on this machine: on Unix the database directory is 0700 and the file is 0600, and Watch does not upload either. `WATCH_DB` relocates the database; deleting the file (with its `-wal` / `-shm`) removes that text, at the cost of losing chains and switch history with it. Sessions you never searched are not indexed.

## Where session files live

| Agent | On disk | Resume |
|---|---|---|
| Claude Code | `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` | `claude --resume <id>` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `codex resume <id>` |
| OpenCode | `~/.local/share/opencode/opencode.db` | `opencode -s <id>` |
| Kimi CLI | `~/.kimi-code/sessions/` and `session_index.jsonl` | `kimi -r <id>` |
| Pi | `~/.pi/agent/sessions/` | `pi --session <id>` |
| Grok CLI | `~/.grok/sessions/` | `grok -r <id>` |

Paths follow each CLI's current version. Watch looks a session up by ID and checks the working directory. The difference between a full context window and an account limit is in [context window versus usage limit](https://relay.bobochang.cn/en/guides/context-limit-vs-usage-limit-handoff/). The OpenCode database path and its transaction are in [OpenCode and SQLite isolation](https://relay.bobochang.cn/en/guides/opencode-handover-sqlite-isolation/).

## Documentation

- **Release notes and version history**: see [Releases](https://github.com/can4hou6joeng4/Watch/releases).

- [Product requirements and implementation plan](docs/PLAN.md): scope and completion criteria.
- [Client compatibility evidence](docs/COMPATIBILITY.md): official sources, implementation status, and local preflight.
- [Architecture and safety boundaries](docs/ARCHITECTURE.md): implementation and gaps.
- [Comparison with similar tools](docs/alternatives.md#english) groups tools by handoff output and workflow.
- [Codex official import guide](docs/import-codex.md): full flow and limits of the experimental route.
- [Contributing guide](CONTRIBUTING.md) (written in Chinese): environment, code style, test isolation and commit format.

## Support

- If Watch is useful to you, a star helps, and so does [sharing it with anyone who keeps switching between agents](https://twitter.com/intent/tweet?url=https://github.com/can4hou6joeng4/Watch&text=Watch%20-%20local%20session%20handoff%20for%20coding%20agents).
- For problems or new routes, open an issue or a PR; please read the [contributing guide](CONTRIBUTING.md) first.

## License

Code and documentation in this repository are released under [MIT](LICENSE).

- Site icons come from [Lucide](https://lucide.dev) (ISC). The agent icons under `site/agents/` and `desktop/public/` are each brand's own asset and are used for identification only.
- Desktop installers bundle `tsx` and `esbuild` (both MIT) into `watch-core`; running the app still requires Node ≥ 22.13 on the user's machine.
- Each agent CLI is bound by its own license and terms of service; Watch does not redistribute their models or credentials.

---

## Related projects

- 🧭 [Homeport](https://github.com/can4hou6joeng4/Homeport) — personal site
- 🐋 [Sonar](https://github.com/can4hou6joeng4/Sonar) — cover-art colour driven iOS music player
- 🚩 [Semaphore](https://github.com/can4hou6joeng4/Semaphore) — local browser ASCII art converter
- 🛟 [Buoy](https://github.com/can4hou6joeng4/Buoy) — AnyRouter multi-account check-in tool
- 🗼 [Beacon](https://github.com/can4hou6joeng4/Beacon) — PDF credential expiry audit
