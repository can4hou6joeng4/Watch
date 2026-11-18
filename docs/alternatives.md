# 同类工具对照 · Related tools

[English](#english)

## 中文

按交接产物和使用场景选择工具。第三方条目依据项目公开说明，Watch 的支持范围以[兼容性记录](COMPATIBILITY.md)为准。

| 需要什么 | 可参考的项目 |
| --- | --- |
| 把本机记录转成目标工具的原生格式 | [cross_agent_session_resumer](https://github.com/Dicklesworthstone/cross_agent_session_resumer)、[session-migrate](https://github.com/xhluca/session-migrate) 提供原生会话格式转换。[catchup](https://github.com/wilbeibi/catchup) 侧重转录文本，也提供 `fork` 和 `fork --into`。 |
| 在桌面端同步，或在额度用尽前自动接班 | [ccx](https://github.com/AaronWong1999/ccx) 用 macOS 菜单栏在 Claude Code、Codex 与 Antigravity 桌面端之间同步会话，并提醒额度。[Sno Station](https://github.com/sno-ai/sno-station) 通过 `rotate-agent` 生成交接记录，让另一 Agent 从同一提交继续。 |
| 生成可阅读或可分享的交接材料 | [ThreadPort](https://github.com/Frankie-Xu/threadport) 用可校验的 Capsule 记录可观察的工作状态。[ACDC](https://github.com/awithi-co/acdc) 以 Skill 交接结构化摘要，支持按名称或 UUID 找回历史。[handoff](https://github.com/rosehgal/handoff) 为项目维护人类可读的交接文档。[Relayvora](https://github.com/Dagimassefa/Relayvora) 先跑项目检查，再生成带来源标注的摘要，并支持通过 Git 仓库分享。 |
| 回溯交接、索引历史或审计存储 | [Möbius](https://github.com/TardisBooo/Mobius) 用交接图回溯来源会话和消息范围。[agent-sessions](https://github.com/jazzyalex/agent-sessions) 分开显示索引、刷新、失败、筛选无结果与真正空库。[deja-vu](https://github.com/vshulcz/deja-vu) 只读审计本地 Agent 存储，并提示 `cleanupPeriodDays` 对会话记录的影响。 |

Watch 从本机原生会话记录和工作目录出发，由用户发起接力。各写入路径有独立的防护措施，具体取决于走启动器、链式接力还是 Codex 官方导入。目标缺少适配器时，可用 `watch prompt` 导出只读 Markdown 摘要。`status --json` 可从切换记录回溯会话血缘，桌面接力记录显示同一份计数。桌面近期列表区分扫描中、读取失败和空列表。各路径的防护范围见[架构说明](ARCHITECTURE.md)。

## English

Choose by the handoff output and workflow you need. Third-party entries describe what each project documents publicly. See the [compatibility records](COMPATIBILITY.md) for Watch's validated scope.

| What you need | Projects to look at |
| --- | --- |
| Convert local records into the target's native format | [cross_agent_session_resumer](https://github.com/Dicklesworthstone/cross_agent_session_resumer) and [session-migrate](https://github.com/xhluca/session-migrate) convert native session formats. [catchup](https://github.com/wilbeibi/catchup) focuses on transcripts and also offers `fork` and `fork --into`. |
| Sync desktop sessions or rotate agents before a usage limit | [ccx](https://github.com/AaronWong1999/ccx) syncs sessions across Claude Code, Codex and Antigravity desktop apps from the macOS menu bar and warns about usage limits. [Sno Station](https://github.com/sno-ai/sno-station) uses `rotate-agent` to write a handover so another agent can continue from the same commit. |
| Generate readable or shareable handoff notes | [ThreadPort](https://github.com/Frankie-Xu/threadport) captures observable work state in a verifiable Capsule. [ACDC](https://github.com/awithi-co/acdc) passes structured summaries through a Skill and retrieves history by name or UUID. [handoff](https://github.com/rosehgal/handoff) maintains a human-readable handoff document per project. [Relayvora](https://github.com/Dagimassefa/Relayvora) runs project checks, labels the sources in its summaries and supports sharing through Git repositories. |
| Trace handoffs, index history, or audit local storage | [Möbius](https://github.com/TardisBooo/Mobius) traces handoffs to source sessions and message ranges. [agent-sessions](https://github.com/jazzyalex/agent-sessions) distinguishes indexing, refresh, failures, filtered-out results and an empty library. [deja-vu](https://github.com/vshulcz/deja-vu) offers a read-only audit of local agent stores and highlights how `cleanupPeriodDays` affects transcripts. |

Watch starts from local native session records and the working directory. The user initiates each handoff. The launcher, chained handoff and official Codex import have separate entry points and write protections. Use `watch prompt` for a read-only Markdown summary when the target lacks an adapter. `status --json` traces lineage from recorded switches, with the same counts in desktop handoff history. The desktop recent list distinguishes scanning, read failures and an empty list. See the [architecture](ARCHITECTURE.md) for the protection each route provides.
