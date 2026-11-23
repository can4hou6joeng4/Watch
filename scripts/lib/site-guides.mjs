export const guides = [
  {
    id: 'claude-code-limit-to-codex',
    published: '2026-09-17',
    modified: '2026-10-14',
    status: 'published',
    locales: {
      zh: {
        slug: 'claude-code-limit-to-codex',
        title: 'Claude Code 达到使用限额后转入 Codex 继续实操教程 | Watch 指南',
        description: '当 Claude Code 明确提示账户使用限额（如 5 小时重置或周限额）时，如何在保留工作目录与已记录会话历史的前提下，通过 Watch 安全转入 OpenAI Codex 继续任务。',
        h1: 'Claude Code 达到使用限额后转入 Codex 继续实操指南',
        summary: '当 Claude Code 遇到使用限额或排查停滞时，本指南说明如何保留工作目录与历史记录，通过 Watch 桌面端或 CLI 准备官方导入计划，并在核验后转入 OpenAI Codex 继续开发。',
        answer: 'Claude Code 提示 5 小时或周限额时，/compact 不能恢复额度。Watch 只读取本机 ~/.claude/projects/<编码目录>/<会话>.jsonl，核对工作目录后转入 Codex；原文件不改，工具事件可能降级为文本。',
        blocks: [
          {
            type: 'callout',
            tone: 'info',
            title: '核心判断依据',
            body: '使用限额（Usage Limit）约束一段时间内可用额度，与单会话的上下文长度限制（Context Window）是两类不同问题。若仅是上下文过长，应优先在 Claude Code 内部执行 /compact 压缩；若确定是账户达到额度限制且需要更换工具，再使用 Watch 接力已保存的历史记录。Watch 不绕过限额，也不迁移磁盘代码。',
          },
          {
            type: 'paragraph',
            text: '在长任务调试过程中，Claude Code 界面可能会显示达到使用限额及预计重置时间。此时已探索的思路、报错结论和测试命令都保存在本机会话文件中。Watch 提供了将该会话记录转入 OpenAI Codex 的限定通道，确保新工具能够读取此前的上下文，而不必由人工重新向新 Agent 叙述整个背景。',
          },
          {
            type: 'steps',
            items: [
              {
                title: '步骤 1：核对来源会话 ID 与工作目录',
                body: '在原终端或会话目录确认 Claude Code 的 Session ID。Claude Code 会话记录保存在 ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl 中。检查当前项目目录（cwd）与会话记录所属目录完全一致，避免 Worktree 路径与主仓库路径发生混淆。',
              },
              {
                title: '步骤 2：在 OpenAI Codex 中预先建立项目',
                body: '本指南使用 Watch 的 --desktop-project 路径，要求项目已在 Codex Desktop 中登记并同步到 app-server。请先在 Codex Desktop 中打开目标目录，再准备导入计划；这是该桌面接力路径的保护条件。',
              },
              {
                title: '步骤 3：准备导入计划并核查字段（Prepare）',
                body: '在 Watch 桌面端选择来源会话并点击 OpenAI Codex，或执行 prepare。Watch 核对来源、工作目录、目标与 Codex 版本，并保存本地导入计划；此时不提交会话导入，也不取得确认阶段的 Watch 目标锁。原生版本检查可能维护自身运行时文件，因此不能把这一步称为全流程零写入。',
              },
              {
                title: '步骤 4：确认导入并核查降级项（Confirm）',
                body: '在预览窗口核对检测到的来源路径、消息条数与工具调用记录后，显式点击确认导入。Watch 将调用本地 Codex app-server 的会话导入接口并写入目标记录。工具调用与执行结果在 Codex 侧可能降级为文本展示。',
              },
              {
                title: '步骤 5：独立打开目标客户端（Open）',
                body: '导入完成后，通过桌面端或目标恢复命令独立唤起 Codex Desktop。导入过程与打开客户端是严格分离的两个步骤；如果打开失败，仅需重试打开动作，切勿重复发起导入。',
              },
            ],
          },
          {
            type: 'code',
            language: 'sh',
            code: '# 1. 核对环境并保存本地计划（不提交会话导入）\nnpm run watch -- import-codex prepare <claude-id> --cwd /abs/project/path --desktop-project --experimental --json\n\n# 2. 明确确认并写入（使用计划返回的 planId）\nnpm run watch -- import-codex confirm <plan-id> --experimental --json\n\n# 3. 只读查询本地执行日志（不启动原生客户端）\nnpm run watch -- import-codex status <plan-id> --json',
          },
          {
            type: 'callout',
            tone: 'info',
            title: '高频限额报错原文对照（Error Signatures）',
            body: '终端出现以下明确提示时，表明触及了账户级额度限制而非单会话上下文容量：\n• "You have reached your 5-hour limit for Claude 3.7 Sonnet / Opus. Limit will reset at 14:30."\n• "Weekly usage limit reached. Your quota resets on Monday at 00:00 UTC."\n• "Rate limit exceeded for organization. Please wait before retrying."\n此类情况下，在 Claude Code 内部执行 /compact 无法重置或释放可用额度。',
          },
          {
            type: 'paragraph',
            text: 'Claude Code 的会话记录保存在 ~/.claude/projects/<编码目录>/<会话>.jsonl。当执行 Watch 导入时，Claude 格式中的工具调用事件（如 tool_use: Bash 与 tool_result）会被结构化重构为 Codex 可读的只读文本记录并写入 rollout 日志，确保接手的 Agent 拥有清晰的上下文足迹，同时杜绝伪造原生结构破坏 Codex 的状态机。',
          },
          {
            type: 'callout',
            tone: 'warning',
            title: '边界与安全限制',
            body: '1. 不支持无损还原：工具调用记录在 Codex 端将作为文本参考呈现，模型的自动延续不在当前限定验收范围内。\n2. 遇到 uncertain 状态必须立即停止：若提交过程中断或网络超时，状态会保持锁定，请通过 status 命令只读排查，严禁强制删除锁或重复再次提交。\n3. 本地转换不等于全流程离线：Watch 自身无中继服务器，但在触发 Codex 原生接口时，Codex 会遵循其本地配置与模型云端鉴权。',
          },
        ],
        faq: [
          {
            question: 'Claude Code 限额后，Watch 会帮我自动续订或绕过限制吗？',
            answer: '不会。Watch 是本地会话接力工具，不接触用户账户、不提供额度注入、也不破解官方限制。它的作用是将您此前已保存在本地的调试足迹转录给另一个有可用额度的 Agent。',
          },
          {
            question: '转入 Codex 后，是否可以直接继续提问模型？',
            answer: 'Codex 会加载此前会话的消息记录，但模型针对接力会话的续写质量受目标 Agent 自身上下文长度和 Prompt 解释能力影响。建议在首轮提问中先要求 Codex 简要复述任务目标，确认理解后再分配代码编辑任务。',
          },
          {
            question: '如果不小心点了两次导入，会导致会话重复或冲突吗？',
            answer: '不会。Watch 设计了持久锁与计划幂等机制。同一来源与工作目录在未完成前不会重复创建新计划；对已完成计划再次执行将保持原样并返回已导入的会话指向。',
          },
        ],
        sources: [
          {
            label: 'Anthropic Support: How do usage and length limits work?',
            url: 'https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work',
            accessed: '2026-09-21',
          },
          {
            label: 'Anthropic Claude Code CLI Documentation',
            url: 'https://docs.anthropic.com/en/docs/claude-code/cli-usage',
            accessed: '2026-09-21',
          },
          {
            label: 'OpenAI ChatGPT: Import from another agent',
            url: 'https://learn.chatgpt.com/docs/import',
            accessed: '2026-09-21',
          },
          {
            label: 'Watch Import Codex Specification & Acceptance',
            url: 'https://github.com/can4hou6joeng4/Watch/blob/main/docs/import-codex.md',
            accessed: '2026-09-21',
          },
        ],
      },
      en: {
        slug: 'claude-code-limit-to-codex',
        title: 'How to Continue in Codex When Claude Code Hits Limit | Watch Guide',
        description: 'Step-by-step practical guide on handing off a saved Claude Code session to OpenAI Codex without losing working directory context when encountering usage limits.',
        h1: 'Continuing in Codex After Claude Code Reaches Usage Limit',
        summary: 'When Claude Code hits a usage limit (5-hour window or weekly quota) or troubleshooting stalls, this guide explains how to retain your working directory and session history, prepare an official import plan, and resume in OpenAI Codex via Watch.',
        answer: 'When Claude Code reports a five-hour or weekly limit, /compact does not restore quota. Watch reads only the local ~/.claude/projects/<encoded-cwd>/<session>.jsonl, checks the working directory, and copies that record into Codex. The original file stays unchanged. Tool events may become text.',
        blocks: [
          {
            type: 'callout',
            tone: 'info',
            title: 'Key Operational Boundary',
            body: 'A usage limit restricts how much Claude can be used over a given time window, whereas context window limits constrain a single conversation\'s capacity. If your context window is simply full, use /compact or /clear inside Claude Code. If you have hit an account usage limit and need to switch agents, Watch transfers your saved local session history into Codex. Watch does not bypass limits or alter local repository files.',
          },
          {
            type: 'paragraph',
            text: 'During prolonged engineering tasks, Claude Code may report that you have reached your plan limit along with a reset timestamp. The reasoning, failed iterations, and command outputs accumulated so far remain on your disk. Watch bridges this saved session into OpenAI Codex, allowing the new tool to inspect preceding context without requiring you to manually summarize the investigation.',
          },
          {
            type: 'steps',
            items: [
              {
                title: 'Step 1: Verify source session ID and working directory',
                body: 'Locate the active Claude Code session ID. History is stored under ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl. Ensure the directory path (cwd) matches the actual project workspace to prevent worktree and repository misalignments.',
              },
              {
                title: 'Step 2: Ensure target project exists in Codex Desktop',
                body: 'This guide uses Watch\'s --desktop-project route, which requires the project to be registered in Codex Desktop and synchronized with app-server. Open the destination directory in Codex Desktop before preparing the plan. This is a guard for this desktop handoff route.',
              },
              {
                title: 'Step 3: Prepare the import plan (Prepare)',
                body: 'Select the source session and click OpenAI Codex in Watch Desktop, or run prepare. Watch checks the source, working directory, destination and Codex version, then saves a local import plan. It does not submit the session import or acquire the Watch target lock used during confirmation. The native version check may maintain its own runtime files, so this is not an entirely write-free operation.',
              },
              {
                title: 'Step 4: Confirm import and review degradation items (Confirm)',
                body: 'Review the previewed message count, working directory, and tool call traces. Explicitly confirm to initiate the transfer via the local Codex app-server import protocol. Note that tool call events may degrade into text representations.',
              },
              {
                title: 'Step 5: Launch the target client independently (Open)',
                body: 'Once confirmed, open Codex Desktop using the app interface or resume command. Import and opening are strictly separated: if launching fails, retry opening only without repeating the import phase.',
              },
            ],
          },
          {
            type: 'code',
            language: 'sh',
            code: '# 1. Check the environment and save a local plan (no session import submitted)\nnpm run watch -- import-codex prepare <claude-id> --cwd /abs/project/path --desktop-project --experimental --json\n\n# 2. Confirm and execute import (using planId from prepare output)\nnpm run watch -- import-codex confirm <plan-id> --experimental --json\n\n# 3. Read the local execution journal (does not launch a native client)\nnpm run watch -- import-codex status <plan-id> --json',
          },
          {
            type: 'callout',
            tone: 'info',
            title: 'Verbatim Rate & Quota Error Signatures',
            body: 'When your terminal displays these messages, you have hit an account-level usage limit rather than a conversation context limit:\n• "You have reached your 5-hour limit for Claude 3.7 Sonnet / Opus. Limit will reset at 14:30."\n• "Weekly usage limit reached. Your quota resets on Monday at 00:00 UTC."\n• "Rate limit exceeded for organization. Please wait before retrying."\nIn these scenarios, running /compact inside Claude Code cannot restore or free up model quota.',
          },
          {
            type: 'paragraph',
            text: 'Claude Code records sessions under ~/.claude/projects/<encoded-cwd>/<session>.jsonl. During Watch import, proprietary tool_use and tool_result events are converted into structured plain-text markdown records inside Codex rollout sessions. This supplies the target agent with complete investigation history while avoiding forged native blocks that break Codex resume integrity.',
          },
          {
            type: 'callout',
            tone: 'warning',
            title: 'Safety Constraints & Disclaimers',
            body: '1. No lossless guarantee: Tool call structures degrade to plain text in Codex, and model continuation is outside the limited validation scope.\n2. Stop on uncertain state: If the process is interrupted or times out, the lock is retained. Inspect with the status command rather than forcibly deleting locks or re-submitting.\n3. Local conversion is not fully offline: While Watch operates without external servers, Codex invokes its own app-server daemon and authenticates with its upstream model provider.',
          },
        ],
        faq: [
          {
            question: 'Does Watch bypass or reset Claude Code rate limits?',
            answer: 'No. Watch is a local handoff utility. It does not tamper with Anthropic accounts or inject credits; it transfers locally saved session artifacts into another agent that has active capacity.',
          },
          {
            question: 'Can I immediately prompt Codex to continue coding?',
            answer: 'Codex will inspect the imported conversation history, but model performance on resumed tasks depends on the target agent\'s context capacity. We recommend asking Codex to summarize the current objective before assigning new code edits.',
          },
          {
            question: 'What happens if I submit an import twice?',
            answer: 'Watch enforces persistent locks and plan idempotency. Duplicate prepare requests for the same source and directory return the existing plan without duplicating records.',
          },
        ],
        sources: [
          {
            label: 'Anthropic Support: How do usage and length limits work?',
            url: 'https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work',
            accessed: '2026-09-21',
          },
          {
            label: 'Anthropic Claude Code CLI Documentation',
            url: 'https://docs.anthropic.com/en/docs/claude-code/cli-usage',
            accessed: '2026-09-21',
          },
          {
            label: 'OpenAI ChatGPT: Import from another agent',
            url: 'https://learn.chatgpt.com/docs/import',
            accessed: '2026-09-21',
          },
          {
            label: 'Watch Import Codex Specification & Acceptance',
            url: 'https://github.com/can4hou6joeng4/Watch/blob/main/docs/import-codex.md',
            accessed: '2026-09-21',
          },
        ],
      },
    },
  },
  {
    id: 'opencode-handover-sqlite-isolation',
    published: '2026-09-21',
    modified: '2026-10-14',
    status: 'published',
    locales: {
      zh: {
        slug: 'opencode-handover-sqlite-isolation',
        title: 'OpenCode 与 Claude/Codex 双向会话接力与 SQLite 数据隔离教程 | Watch 指南',
        description: '详解如何在保留完整工作目录与排查足迹的前提下，将 Claude Code 或 Codex 会话双向转入 OpenCode 本地 SQLite 存储继续开发，并利用事务机制保障数据隔离。',
        h1: 'OpenCode 与 Claude/Codex 双向会话接力与 SQLite 数据隔离指南',
        summary: '当你需要从商业云端 Agent 切换到支持本地开源模型的 OpenCode（或从 OpenCode 导出至其他 Agent）时，本指南说明如何利用 Watch 实现双向会话接力，并借助 OpenCode 的 SQLite 事务机制保护数据不被污染。',
        answer: 'OpenCode 的会话在本机 ~/.local/share/opencode/opencode.db，可用 WATCH_OPENCODE_DB 换库。Watch 用一次 SQLite 事务写入 session、message、part 三张表（2.x 布局为 session_v2 / session_message / session_part）；事务失败会回滚。不支持的工具参数降级为文本，续写质量取决于你配置的模型。',
        blocks: [
          {
            type: 'callout',
            tone: 'info',
            title: '核心适用场景',
            body: 'OpenCode 采用单文件关系型 SQLite（默认位于 ~/.local/share/opencode/opencode.db）存储会话，天生具备 ACID 事务与结构化索引优势。当你希望将包含私有代码或需要离线运行的任务交接给本地开源大模型（如通过 Ollama 或 vLLM 驱动的 OpenCode），或者在 OpenCode 完成阶段性排查后需要调用云端前沿模型（Claude/Codex）继续攻坚时，Watch 提供了双向转换通道。',
          },
          {
            type: 'paragraph',
            text: '与基于单一 JSONL 追加日志的工具不同，OpenCode 的会话由 session、message 和 part 等数据表构成（2.x 布局为 session_v2、session_message、session_part）。直接修改或手工插入易破坏外键约束与自增索引。Watch 通过内置的 OpenCode 适配器，将跨 Agent 的统一时间线（UnifiedTurn）映射为合法的 OpenCode SQLite 记录，并保持工作目录（cwd）与时间戳对齐。',
          },
          {
            type: 'steps',
            items: [
              {
                title: '步骤 1：确认来源会话 ID 与项目目录',
                body: '在原终端或会话目录确认正在进行的会话 ID。Claude Code 会话保存在 ~/.claude/projects/ 中；Codex 保存在 ~/.codex/sessions/ 中；OpenCode 内部由全局唯一会话 ID 索引。检查当前项目目录（cwd）为绝对路径，确保工作空间上下文在目标端完全一致。',
              },
              {
                title: '步骤 2：执行目标写入预检（Check）',
                body: '使用 --check 预览目标与待写轮次，并核对返回的 writable、blocked 和 warnings。规划出待写轮次时，OpenCode 预检检查存储布局与已有目标的 revert 状态；2.x 布局只读。它不向目标会话写入，也不测试写权限或取得 SQLite 写锁，不能保证稍后的写入没有并发冲突。',
              },
              {
                title: '步骤 3：执行双向流转写入（Handoff）',
                body: '在 Watch 桌面端选择来源会话卡片并点击 OpenCode，或在终端执行 open 命令。Watch 会原子提取增量回合，开启 SQLite 事务批量写入 session、message 和 part 记录，并生成目标会话 ID。',
              },
              {
                title: '步骤 4：通过 OpenCode 原生命令恢复（Resume）',
                body: '转换完成后，在原工作目录下运行 opencode -s <session-id>（或通过 Watch 桌面端唤醒终端）。OpenCode 会加载已写入的会话记录和该工作目录。',
              },
            ],
          },
          {
            type: 'code',
            language: 'sh',
            code: '# 1. 预览目标与待写轮次，检查布局与 revert 守卫\nnpm run watch -- open <claude-session-id> --to opencode --check --json\n\n# 2. 写入：将指定会话导入 OpenCode 本地 SQLite 数据库并输出恢复命令\nnpm run watch -- open <claude-session-id> --to opencode --json\n\n# 3. 反向接力：从 OpenCode 会话接力至 Claude Code 或 Codex\nnpm run watch -- open <opencode-session-id> --to claude --json',
          },
          {
            type: 'callout',
            tone: 'info',
            title: 'OpenCode SQLite 表结构与数据隔离验证',
            body: 'OpenCode 会话库（~/.local/share/opencode/opencode.db）采用三层核心表组织数据：\n• session: 存储会话 ID、标题、项目绝对路径（directory）与更新时间\n• message: 记录所属 session_id、角色（user / assistant）与时间戳\n• part: 存储具体消息文本、代码块与结构化数据\n（2.x 布局对应 session_v2 / session_message / session_part）\n通过环境变量 WATCH_OPENCODE_DB=/tmp/isolated.db 可切分测试库，验证写入完全在独立 SQLite 事务中完成，异常时原子回滚。',
          },
          {
            type: 'callout',
            tone: 'warning',
            title: '边界与安全限制',
            body: '1. 数据库隔离与备份：Watch 默认操作 ~/.local/share/opencode/opencode.db，支持通过 WATCH_OPENCODE_DB 环境变量切分测试库。写入使用一次 SQLite 事务，失败则回滚。\n2. 工具调用映射：OpenCode 的 tool 记录在跨转时按 schema 映射，不支持的专有工具参数将降级为结构化文本展示。\n3. 模型继续：Watch 写入已保存的会话记录和工作目录，不保证工具事件完整保留。启动 OpenCode 后的续写质量由你所配置的模型决定。',
          },
        ],
        faq: [
          {
            question: 'OpenCode 的本地 SQLite 存储相比 JSONL 有何优势？',
            answer: 'SQLite 的事务可以让一次会话写入在提交时整体生效，失败时回滚；它不提供行级写锁，多个写入者仍可能争用数据库。WATCH_OPENCODE_DB 可将 Watch 的读写指向独立测试库；它不自动改变 OpenCode 原生客户端使用的数据库。',
          },
          {
            question: '反向转出时，OpenCode 中的自定义模型推理记录会丢失吗？',
            answer: 'Watch 会复制能映射的用户指令、助手文本、思考链和工具输出。不支持的工具字段降级为文本，所以这不是 OpenCode 原行的完整副本。',
          },
          {
            question: '如何确认恢复时的工作目录没有错乱？',
            answer: 'Watch 将选定的绝对 cwd 写入会话记录，并在完整恢复命令中先切换目录、再运行 opencode -s <session-id>。请核对返回的工作目录并使用完整命令；只运行 opencode -s 不包含 Watch 的切目录步骤。cwd 记录不是文件访问沙箱，仍需在目标工具中核对路径与权限。',
          },
        ],
        sources: [
          {
            label: 'OpenCode Documentation: Server & Sessions',
            url: 'https://opencode.ai/docs/server/',
            accessed: '2026-09-21',
          },
          {
            label: 'OpenCode Documentation: CLI reference',
            url: 'https://opencode.ai/docs/cli/',
            accessed: '2026-09-21',
          },
          {
            label: 'Watch System Architecture & Storage',
            url: 'https://github.com/can4hou6joeng4/Watch/blob/main/docs/ARCHITECTURE.md',
            accessed: '2026-09-21',
          },
          {
            label: 'Watch Client Compatibility Evidence',
            url: 'https://github.com/can4hou6joeng4/Watch/blob/main/docs/COMPATIBILITY.md',
            accessed: '2026-09-21',
          },
        ],
      },
      en: {
        slug: 'opencode-handover-sqlite-isolation',
        title: 'OpenCode, Claude & Codex Bidirectional Handoff with SQLite Isolation | Watch Guide',
        description: 'How to hand off coding agent sessions bidirectionally between OpenCode (SQLite store), Claude Code, and Codex while preserving working directories and tool histories.',
        h1: 'OpenCode, Claude & Codex Bidirectional Session Handoff Guide',
        summary: 'When switching from commercial cloud agents to local open-source models in OpenCode (or handing off back to cloud agents), this guide explains how to use Watch for bidirectional handoff with SQLite transactional data isolation.',
        answer: 'OpenCode keeps sessions in ~/.local/share/opencode/opencode.db. WATCH_OPENCODE_DB points Watch at another file. Watch writes the session, message, and part tables (2.x layouts use session_v2, session_message, session_part) in one SQLite transaction and rolls back if it fails. Unsupported tool fields become text. Later replies depend on the model you configure.',
        blocks: [
          {
            type: 'callout',
            tone: 'info',
            title: 'Key Operational Boundary',
            body: 'OpenCode utilizes a single relational SQLite database (defaulting to ~/.local/share/opencode/opencode.db) for session storage, providing ACID transactional integrity and structured queries. When you wish to transition sensitive tasks to locally hosted open-source models (via Ollama or vLLM in OpenCode) or hand off back to frontier cloud models (Claude/Codex), Watch provides a verified bidirectional bridge.',
          },
          {
            type: 'paragraph',
            text: 'Unlike tools that rely strictly on append-only JSONL files, OpenCode organizes sessions across normalized relational tables: session, message, and part (session_v2, session_message, session_part on 2.x layouts). Direct external tampering can corrupt foreign key constraints. Watch maps the UnifiedTurn abstraction cleanly into OpenCode\'s relational schema while preserving exact directory context (cwd) and timestamps.',
          },
          {
            type: 'steps',
            items: [
              {
                title: 'Step 1: Identify source session ID and working directory',
                body: 'Locate your active session ID. Claude Code stores files in ~/.claude/projects/; Codex in ~/.codex/sessions/; OpenCode indexes sessions via globally unique IDs. Verify that the working directory is an absolute path to maintain project boundary alignment.',
              },
              {
                title: 'Step 2: Preflight target database status (Check)',
                body: 'Run --check to preview the destination and pending turns, then inspect writable, blocked and warnings. When pending turns exist, OpenCode preflight checks the storage layout and an existing target\'s revert state; 2.x layouts are read-only. It does not write the target session, test write permissions or acquire a SQLite write lock, and cannot guarantee that a later write will face no concurrent changes.',
              },
              {
                title: 'Step 3: Execute bidirectional handoff (Handoff)',
                body: 'Select the source session in Watch Desktop and target OpenCode, or run the CLI open command. Watch extracts incremental turns, executes atomic SQLite transactions across the session, message, and part tables, and issues the destination session ID.',
              },
              {
                title: 'Step 4: Resume session natively in OpenCode (Resume)',
                body: 'After conversion, execute opencode -s <session-id> in the workspace directory or trigger the launch button in Watch Desktop. OpenCode loads the recorded conversation in that working directory.',
              },
            ],
          },
          {
            type: 'code',
            language: 'sh',
            code: '# 1. Preview the destination and pending turns; check layout and revert guards\nnpm run watch -- open <claude-session-id> --to opencode --check --json\n\n# 2. Handoff: Transfer session into OpenCode SQLite database\nnpm run watch -- open <claude-session-id> --to opencode --json\n\n# 3. Reverse handoff: Transfer from OpenCode back to Claude or Codex\nnpm run watch -- open <opencode-session-id> --to claude --json',
          },
          {
            type: 'callout',
            tone: 'info',
            title: 'OpenCode Relational Schema & SQLite Transaction Isolation',
            body: 'OpenCode session storage (~/.local/share/opencode/opencode.db) is structured across three core relational tables:\n• session: tracks session ID, title, absolute workspace directory, and timestamps\n• message: maps session_id, role (user / assistant), and creation time\n• part (session_v2, session_message, session_part on 2.x layouts): stores text chunks, code blocks, and structured tool call representations\nSetting WATCH_OPENCODE_DB=/tmp/isolated.db routes writes to a separate SQLite database. Transfers execute inside an atomic SQLite transaction, rolling back completely on any interruption.',
          },
          {
            type: 'callout',
            tone: 'warning',
            title: 'Safety Constraints & Disclaimers',
            body: '1. Database isolation & backups: Watch operates on ~/.local/share/opencode/opencode.db by default and respects WATCH_OPENCODE_DB for testing environments. The write is one SQLite transaction and rolls back if it fails.\n2. Tool call representations: Tool records map across schemas; unsupported proprietary parameters degrade into structured text representations.\n3. Model continuation: Watch writes the saved session record and working directory. It does not guarantee that every tool event is preserved. Later replies depend on the model you configure.',
          },
        ],
        faq: [
          {
            question: 'What is the advantage of OpenCode\'s SQLite storage over JSONL?',
            answer: 'A SQLite transaction commits a session write as a unit and rolls it back on failure. SQLite does not provide row-level write locks; concurrent writers can still contend for the database. WATCH_OPENCODE_DB redirects Watch\'s reads and writes to a separate test database; it does not automatically change the database used by the native OpenCode client.',
          },
          {
            question: 'Are custom model reasoning thoughts retained when handing off out of OpenCode?',
            answer: 'Watch copies the saved user prompts, assistant text, thinking traces, and tool outputs it can map. Unsupported tool fields become text, so the copy is not a complete replica of the OpenCode row.',
          },
          {
            question: 'How does Watch prevent working directory mismatch?',
            answer: 'Watch records the selected absolute cwd and returns a complete resume command that changes directory before running opencode -s <session-id>. Verify the working directory and use that complete command; opencode -s alone does not include Watch\'s directory change. A cwd record is not a file-access sandbox, so check paths and permissions in the destination tool as well.',
          },
        ],
        sources: [
          {
            label: 'OpenCode Documentation: Server & Sessions',
            url: 'https://opencode.ai/docs/server/',
            accessed: '2026-09-21',
          },
          {
            label: 'OpenCode Documentation: CLI reference',
            url: 'https://opencode.ai/docs/cli/',
            accessed: '2026-09-21',
          },
          {
            label: 'Watch System Architecture & Storage',
            url: 'https://github.com/can4hou6joeng4/Watch/blob/main/docs/ARCHITECTURE.md',
            accessed: '2026-09-21',
          },
          {
            label: 'Watch Client Compatibility Evidence',
            url: 'https://github.com/can4hou6joeng4/Watch/blob/main/docs/COMPATIBILITY.md',
            accessed: '2026-09-21',
          },
        ],
      },
    },
  },
  {
    id: 'context-limit-vs-usage-limit-handoff',
    published: '2026-09-21',
    modified: '2026-10-14',
    status: 'published',
    locales: {
      zh: {
        slug: 'context-limit-vs-usage-limit-handoff',
        title: 'Claude Code 上下文容量超限与账户使用限额的区别及应对实操教程 | Watch 指南',
        description: '深度解析 Claude Code 单会话上下文长度（Context Window）与账户使用额度限制（Usage Limit）的底层区别。详解何时使用 /compact 压缩，何时使用 Watch 进行跨 Agent 会话接力。',
        h1: 'Claude Code 上下文满与账户限额的本质区别与应对实操指南',
        summary: '当使用 Claude Code 遇到开发阻断时，本指南帮助你准确识别是单会话上下文容量触顶还是账户套餐额度耗尽，并提供原生压缩（/compact）与跨 Agent 会话接力的规范操作流程。',
        answer: '上下文满了是这一次对话太长，在 Claude Code 里执行 /compact 或 /clear。账户限额到了会给出重置时间，此时 /compact 无效。Watch 不扩大上下文，也不恢复额度，只把已保存的会话记录转入另一个仍可用的 Agent。',
        blocks: [
          {
            type: 'callout',
            tone: 'info',
            title: '核心概念辨析：两类完全不同的物理限制',
            body: '1. 上下文长度限制（Context Window Limit）：约束单个会话内模型能够同时处理的 Token 总量。超限时模型通常会自动触发压缩或提示上下文已满。\n2. 账户使用限额（Usage Limit）：约束一段时间内（如 5 小时重置窗口或周限额）你可以向 Claude 发起的总请求量或 Token 量。超限时界面会明确提示 "You have exceeded your current usage limit" 及预计重置时间戳。',
          },
          {
            type: 'paragraph',
            text: '很多开发者误以为“上下文满了”就是“账号被限额了”，或者误以为跨 Agent 会话接力工具可以“无限扩充 Claude 的上下文”。实际上，Watch 从不绕过限额，也不替换 Claude 内置的上下文管理机制。理清两者的应对分支，能让你在长任务中选择最合适的工作流。',
          },
          {
            type: 'steps',
            items: [
              {
                title: '步骤 1：观察终端报错信号，精准判断阻断类型',
                body: '若提示 "exceeded your limit" 并带有重置时间：说明是账户使用限额（Usage Limit），此时在 Claude 内部执行 /compact 无效，需等待重置或转入其他可用 Agent（如 Codex / OpenCode）。若提示会话过长或响应延迟骤增：说明是单会话上下文超长（Context Window Limit），应优先执行 /compact。',
              },
              {
                title: '步骤 2：针对上下文超长的原生处理（/compact 与 /clear）',
                body: '在 Claude Code 中输入 /compact，模型会自动对前序历史做摘要归约，释放宝贵的上下文空间；若不需要旧的历史探索过程，输入 /clear 开启全新会话。',
              },
              {
                title: '步骤 3：当遭遇账户使用限额时，保存会话并切换接力',
                body: '确认 Claude Code 已将当前会话写入 ~/.claude/projects/<enc-cwd>/<session-id>.jsonl；使用 Watch 检查工作目录与目标 Agent（Codex / OpenCode）的写入可用性。',
              },
              {
                title: '步骤 4：无损接力至备选 Agent 继续工程任务',
                body: '通过 Watch 将已保存的思考过程、测试执行与代码变更记录结构化转录至目标 Agent；唤醒新 Agent 带着历史继续开发，无需重述背景。',
              },
            ],
          },
          {
            type: 'table',
            headers: ['限制类别', '典型报错与表现', '处理机制与命令', '是否需要 Watch'],
            rows: [
              ['上下文超限 (Context Limit)', 'Prompt too long for context window', '在 Claude 终端执行 /compact 压缩或 /clear 清空', '否（工具内部自主消化）'],
              ['5小时账户限额 (5-Hour Limit)', '5-hour limit reached. Resets at HH:MM', '/compact 无效；等待重置或切换工具', '是（转入 Codex / OpenCode）'],
              ['周度总配额耗尽 (Weekly Quota)', 'Weekly usage limit reached for org', '/compact 无效；切换至其他可用 Agent', '是（转入其他备选 Agent）'],
              ['终端或网络中断 (Crash / Restart)', 'Process exit / Terminal closed', '运行 claude --resume <id> 恢复原会话', '否（原生 CLI 恢复即可）']
            ],
          },
          {
            type: 'code',
            language: 'sh',
            code: '# 情况 A：单会话上下文过长时的官方原生处理（在 Claude Code 交互终端中）\n/compact   # 自动摘要压缩当前会话历史，腾出上下文容量\n/clear     # 清除当前会话上下文并保留当前工作目录\n\n# 情况 B：账户使用限额时的跨 Agent 本地会话接力（在系统 Shell 中）\nnpm run watch -- open <claude-session-id> --to codex --json\nnpm run watch -- open <claude-session-id> --to opencode --json',
          },
          {
            type: 'callout',
            tone: 'warning',
            title: '安全边界与常见误区',
            body: '1. Watch 不扩展单会话 Context：转入新 Agent 后，依然受目标 Agent 自身的上下文窗口约束。\n2. 工具调用表示差异：Claude 的 tool_use 事件转入 Codex 时将降级为只读文本参考，避免目标解析器冲突。\n3. 不可暴力清空：在未确认会话保存状态前，切勿手动强杀进程或删除 JSONL 会话，以免排查结论丢失。',
          },
        ],
        faq: [
          {
            question: '执行 /compact 后会丢失之前写过的代码吗？',
            answer: '不会。磁盘上的代码修改已经落盘，/compact 仅对内存中的对话历史做语义压缩。但某些细粒度的中间报错信息可能会被模型概括，建议在压缩前将关键日志记录在本地文档中。',
          },
          {
            question: '为什么账户限额到了之后，执行 /compact 仍然报错？',
            answer: '/compact 用于整理会话历史，不会恢复账户额度；额度耗尽时，生成摘要的请求也可能被限额阻止。你可以等待重置，或选择仍可用的工具，按已验证路径交接；也可用 watch prompt 导出裁剪后的交接文档再手动交给目标工具。Watch 不恢复或绕过额度。',
          },
          {
            question: '切换到 Codex 或 OpenCode 后，上下文是否会被重置？',
            answer: '接力会把已保存且能转换的历史带入目标会话，这些历史仍占用目标模型的上下文。Watch 不扩大窗口，也不按目标 token 预算自动摘要，因此不能保证消除上下文饱和。需要缩短输入时，可使用目标工具的原生压缩，或通过 watch prompt 的档位与 --last 选项导出较短的交接文档，并核对省略项。',
          },
        ],
        sources: [
          {
            label: 'Anthropic Support: How do usage and length limits work?',
            url: 'https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work',
            accessed: '2026-09-21',
          },
          {
            label: 'Anthropic Support: Models, usage, and limits in Claude Code',
            url: 'https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code',
            accessed: '2026-09-21',
          },
          {
            label: 'Watch System Architecture & Storage',
            url: 'https://github.com/can4hou6joeng4/Watch/blob/main/docs/ARCHITECTURE.md',
            accessed: '2026-11-14',
          },
          {
            label: 'Watch Client Compatibility Evidence',
            url: 'https://github.com/can4hou6joeng4/Watch/blob/main/docs/COMPATIBILITY.md',
            accessed: '2026-09-21',
          },
        ],
      },
      en: {
        slug: 'context-limit-vs-usage-limit-handoff',
        title: 'Claude Code Context Window Full vs Usage Limits: Differences & Action Guide | Watch Guide',
        description: 'Technical comparison between Claude Code context window length limits and account usage limits. When to use /compact versus when to hand off across agents.',
        h1: 'Context Window Full vs Usage Limits in Claude Code: Practical Guide',
        summary: 'When interrupted during complex tasks in Claude Code, learn to distinguish between context window exhaustion and account usage quotas, and apply either /compact or Watch multi-agent session handoff effectively.',
        answer: 'A full context window means this conversation is too long: run /compact or /clear inside Claude Code. An account limit names a reset time, and /compact does nothing then. Watch neither enlarges the window nor restores quota. It copies the saved session into another agent that can still run.',
        blocks: [
          {
            type: 'callout',
            tone: 'info',
            title: 'Key Operational Boundary: Two Distinct Physical Limits',
            body: '1. Context Window Limit: Constrains the total number of tokens the model can process simultaneously within a single session. When full, the model prompts for compaction or automatically compresses history.\n2. Account Usage Limit: Restricts total request volume or token consumption over a rolling time window (e.g. 5-hour resets or weekly quotas). When reached, Claude displays "You have exceeded your current usage limit" with a reset timestamp.',
          },
          {
            type: 'paragraph',
            text: 'Developers often confuse a full context window with an account rate limit, or assume session handoff tools artificially expand Claude\'s context window. Watch does not bypass usage quotas or replace Claude\'s native compaction. Understanding the difference ensures you choose the correct recovery path.',
          },
          {
            type: 'steps',
            items: [
              {
                title: 'Step 1: Check terminal error signals to identify the limit type',
                body: 'If Claude reports "exceeded your limit" with a reset time, it is an account Usage Limit: running /compact will fail because the model quota is exhausted; wait for reset or hand off to Codex / OpenCode. If Claude reports conversation length limits or high latency, it is a Context Window Limit: run /compact.',
              },
              {
                title: 'Step 2: Apply native resolution for context length (/compact & /clear)',
                body: 'Inside Claude Code, run /compact to compress conversation history into a distilled summary. If historical investigative turns are no longer required, run /clear to begin a clean slate in the current workspace.',
              },
              {
                title: 'Step 3: Save session state upon hitting account usage quotas',
                body: 'Verify Claude Code has flushed its session transcript to ~/.claude/projects/<enc-cwd>/<session-id>.jsonl. Use Watch to inspect the working directory and target readiness for Codex or OpenCode.',
              },
              {
                title: 'Step 4: Hand off to an alternative agent without repeating context',
                body: 'Use Watch to convert the recorded reasoning and test results into the destination agent\'s format, then resume in the new CLI with full preceding context.',
              },
            ],
          },
          {
            type: 'table',
            headers: ['Limit Category', 'Typical Error & Symptom', 'Remediation Command', 'Use Watch?'],
            rows: [
              ['Context Window Exceeded', 'Prompt too long for context window', 'Run /compact or /clear inside Claude Code', 'No (resolved within Claude)'],
              ['5-Hour Account Limit', '5-hour limit reached. Resets at HH:MM', '/compact fails; wait for reset or switch tool', 'Yes (handoff to Codex / OpenCode)'],
              ['Weekly Org Quota Exceeded', 'Weekly usage limit reached for org', '/compact fails; hand off to alternate agent', 'Yes (handoff to other agents)'],
              ['Process Crash / Close', 'Terminal closed / network drop', 'Run claude --resume <id> directly', 'No (native CLI resume)']
            ],
          },
          {
            type: 'code',
            language: 'sh',
            code: '# Scenario A: Native resolution for context window limits (inside Claude Code)\n/compact   # Automatically compress history to free up context capacity\n/clear     # Clear conversation while keeping working directory context\n\n# Scenario B: Multi-agent handoff upon hitting account usage limits (in Shell)\nnpm run watch -- open <claude-session-id> --to codex --json\nnpm run watch -- open <claude-session-id> --to opencode --json',
          },
          {
            type: 'callout',
            tone: 'warning',
            title: 'Safety Constraints & Disclaimers',
            body: '1. Watch does not expand single-agent context: Resuming in a new agent is subject to that agent\'s own context window limits.\n2. Tool representation changes: Claude tool_use events degrade to structured text representations in Codex to prevent schema parsing errors.\n3. Do not kill processes abruptly: Ensure session files are written before terminating terminal windows.',
          },
        ],
        faq: [
          {
            question: 'Will /compact discard code modifications made on disk?',
            answer: 'No. File edits already exist on your local filesystem. /compact only compresses in-memory conversation history. However, detailed sub-error messages may be summarized.',
          },
          {
            question: 'Why does /compact fail when hitting an account usage limit?',
            answer: '/compact organizes conversation history; it does not restore account quota, and a request to generate a summary may also be blocked by the limit. You can wait for the reset, choose another available tool and follow a validated handoff route, or export a shorter document with watch prompt for manual handoff. Watch does not restore or bypass quota.',
          },
          {
            question: 'Does handing off to Codex or OpenCode reset context?',
            answer: 'Handoff carries saved history that can be converted into the destination session, where it still consumes context. Watch does not enlarge the window or automatically summarize to a target token budget, so it cannot guarantee that saturation is resolved. To shorten the input, use the destination tool\'s native compaction or export a shorter handoff document with watch prompt presets and --last, then review its omission disclosures.',
          },
        ],
        sources: [
          {
            label: 'Anthropic Support: How do usage and length limits work?',
            url: 'https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work',
            accessed: '2026-09-21',
          },
          {
            label: 'Anthropic Support: Models, usage, and limits in Claude Code',
            url: 'https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code',
            accessed: '2026-09-21',
          },
          {
            label: 'Watch System Architecture & Storage',
            url: 'https://github.com/can4hou6joeng4/Watch/blob/main/docs/ARCHITECTURE.md',
            accessed: '2026-11-14',
          },
          {
            label: 'Watch Client Compatibility Evidence',
            url: 'https://github.com/can4hou6joeng4/Watch/blob/main/docs/COMPATIBILITY.md',
            accessed: '2026-09-21',
          },
        ],
      },
    },
  },
  {
    id: 'opus-5-5-five-hour-limit',
    published: '2026-09-23',
    modified: '2026-10-14',
    status: 'published',
    locales: {
      zh: {
        slug: 'opus-5-5-five-hour-limit',
        title: 'Claude Opus 5.5 提高 5 小时限额后，仍被拦住时怎么继续 | Watch 指南',
        description: 'Anthropic 于 2026-09-22 发布 Claude Opus 5.5，并提高 Pro、Max、Team 与按席位 Enterprise 的 5 小时使用限额，另提供可保存的限额重置。本文说明这不能代替会话接力，以及仍被限额拦住时如何转入 Codex。',
        h1: 'Claude Opus 5.5 提高 5 小时限额之后，限额和会话接力分别怎么处理',
        summary: 'Opus 5.5 提高的是指定套餐的 5 小时使用限额，并让订阅用户保存一次限额重置。Watch 不恢复 Claude 额度。若重置后仍然被拦住，沿用既有的 Codex 接力步骤。',
        answer: 'Opus 5.5 提高的是 Pro、Max、Team 和按席位 Enterprise 的 5 小时限额，并给一次可保存的重置，不是取消限额。Watch 不读取、不增加 Claude 额度。官方重置用完后若仍被拦住，再把本机会话转入 Codex。',
        blocks: [
          {
            type: 'callout',
            tone: 'info',
            title: '这次公告实际改了什么',
            body: '2026-09-22，Anthropic 发布 Claude Opus 5.5。公告写明两件和限额有关的事：Pro、Max、Team，以及按席位计费的 Enterprise，5 小时使用限额提高；订阅用户会得到一次可以保存、以后自己选择何时使用的限额重置。公告没有写周限额被取消，也没有写 Watch 或任何第三方工具可以恢复额度。',
          },
          {
            type: 'paragraph',
            text: '模型变快或限额变宽，都不改变两类限制的区别。上下文窗口满了，仍然是当前会话太长，应在 Claude Code 里压缩。账户使用限额到了，Claude 会提示超出当前用量并给出重置时间。Opus 5.5 提高的是后者里面的 5 小时窗口，不是把上下文窗口变大。',
          },
          {
            type: 'steps',
            items: [
              {
                title: '步骤 1：先看提示是哪一种限制',
                body: '若提示超出当前使用限额并带有重置时间，这是账户限额。此时 /compact 不能恢复额度。若提示的是会话长度或上下文已满，先在 Claude Code 内压缩，不要把模型升级当成解法。',
              },
              {
                title: '步骤 2：使用套餐自己的 5 小时限额和可保存重置',
                body: '公告说明提高后的 5 小时限额适用于 Pro、Max、Team 和按席位的 Enterprise。可保存的限额重置由订阅产品提供，Watch 没有核验过对应的 CLI 开关，因此不要假设某条命令已经替你存下重置。用尽官方给出的重置之后若仍然被拦住，再考虑换工具。',
              },
              {
                title: '步骤 3：仍然被拦住时，再做会话接力',
                body: 'Watch 不读取、不增加、也不绕过 Claude 额度。它只把本机已经保存的会话记录转入仍有额度的 Codex，并保留工作目录。操作沿用《Claude Code 达到使用限额后转入 Codex》指南：先核对会话 ID 与目录，再 prepare、confirm，最后单独打开 Codex。',
              },
            ],
          },
          {
            type: 'callout',
            tone: 'warning',
            title: '不要从热搜推断出的结论',
            body: '新加坡和澳大利亚的 48 小时趋势里出现过查询 “opus 5.5”，这只说明有人在搜这个名字，不是全球搜索量排行，也不能证明周限额、上下文长度或会话格式已经改变。GPT-6 等同时出现的模型名称与 Watch 的接力步骤无关。工具调用在 Codex 侧仍可能降级为文本。',
          },
        ],
        faq: [
          {
            question: '升级到 Claude Opus 5.5 之后，还会遇到 5 小时限额吗？',
            answer: '会。公告是提高 Pro、Max、Team 和按席位 Enterprise 的 5 小时限额，不是取消限额。到顶时仍然会看到重置时间。',
          },
          {
            question: '可保存的限额重置能不能由 Watch 自动使用？',
            answer: '不能。那是 Claude 订阅自己的额度控制。Watch 不登录 Claude 账户，也不代为消耗或保存重置。',
          },
          {
            question: '限额提高后，还需要把会话转入 Codex 吗？',
            answer: '官方重置仍然不够用、而 Codex 一侧还有额度时才需要。转入步骤没有因为 Opus 5.5 改变。',
          },
        ],
        sources: [
          {
            label: 'Anthropic: Introducing Claude Opus 5.5',
            url: 'https://www.anthropic.com/claude-opus-5-5',
            accessed: '2026-09-23',
          },
          {
            label: 'Anthropic Support: How do usage and length limits work?',
            url: 'https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work',
            accessed: '2026-09-23',
          },
          {
            label: 'Watch: Claude Code 限额后转入 Codex',
            url: 'https://relay.bobochang.cn/guides/claude-code-limit-to-codex/',
            accessed: '2026-09-23',
          },
        ],
      },
      en: {
        slug: 'opus-5-5-five-hour-limit',
        title: 'Claude Opus 5.5 Raised 5-Hour Limits. What If Claude Code Is Still Capped? | Watch Guide',
        description: 'On 22 September 2026 Anthropic shipped Claude Opus 5.5, increased five-hour usage limits on Pro, Max, Team, and seat-based Enterprise, and added a savable rate-limit reset. This guide states what that does not change, and when to hand a saved session to Codex.',
        h1: 'What Claude Opus 5.5 changes about five-hour limits, and what to do when you are still capped',
        summary: 'Opus 5.5 raises the five-hour usage limit on named Claude plans and adds a rate-limit reset you can save. Watch does not restore Claude quota. If you are still blocked, use the existing Codex handoff.',
        answer: 'Opus 5.5 raises the five-hour limit on Pro, Max, Team, and seat-based Enterprise, and adds one reset you can save. It does not remove the limit. Watch does not read or raise Claude quota. Hand the saved session to Codex only after that official reset is still not enough.',
        blocks: [
          {
            type: 'callout',
            tone: 'info',
            title: 'What the announcement actually changes',
            body: 'On 22 September 2026 Anthropic introduced Claude Opus 5.5. On limits, the announcement says two things: five-hour usage limits increase on Pro, Max, Team, and seat-based Enterprise plans, and subscription users receive a rate-limit reset they can save and spend when they choose. It does not say weekly limits were removed, and it does not say any third-party tool can refill Claude quota.',
          },
          {
            type: 'paragraph',
            text: 'A faster or cheaper model does not merge the two limits. A full context window is still a long conversation: compact it inside Claude Code. An account usage limit still stops requests until the window resets. Opus 5.5 widens the five-hour usage window on the plans named above. It does not enlarge the context window.',
          },
          {
            type: 'steps',
            items: [
              {
                title: 'Step 1: Read which limit the product is reporting',
                body: 'A message that you have exceeded the current usage limit, with a reset time, is an account limit. /compact does not restore that quota. A message about conversation length is a context-window limit. Compact inside Claude Code. Switching the model name is not the fix for either case.',
              },
              {
                title: 'Step 2: Use the plan’s own five-hour limit and saved reset',
                body: 'The higher five-hour limit applies to Pro, Max, Team, and seat-based Enterprise. The savable reset belongs to the Claude subscription. Watch has not verified a CLI flag that stores it, so do not assume a Watch command has banked the reset for you. If you are still blocked after the reset Anthropic provides, then consider another agent.',
              },
              {
                title: 'Step 3: Hand off only if Claude is still blocked',
                body: 'Watch does not read, raise, or bypass Claude quota. It copies a session already saved on disk into Codex, keeping the working directory. Follow the existing guide, Continuing in Codex after Claude Code reaches its usage limit: check the session id and directory, then prepare, confirm, and open Codex separately.',
              },
            ],
          },
          {
            type: 'callout',
            tone: 'warning',
            title: 'What a trending query does not establish',
            body: 'The query “opus 5.5” appeared in Singapore and Australia trending searches over 48 hours. That is an approximate trending bucket, not a global ranking of search volume, and it does not show that weekly limits, context length, or session files changed. Other model names in the same news cycle are unrelated to this handoff. Tool calls may still be degraded to text on the Codex side.',
          },
        ],
        faq: [
          {
            question: 'Does Claude Opus 5.5 remove the five-hour usage limit?',
            answer: 'No. Anthropic increased the five-hour limit on Pro, Max, Team, and seat-based Enterprise. The limit still exists, and hitting it still shows a reset time.',
          },
          {
            question: 'Can Watch spend the savable rate-limit reset for me?',
            answer: 'No. That control belongs to the Claude subscription. Watch does not sign in to a Claude account, and it neither stores nor spends the reset.',
          },
          {
            question: 'Do I still hand the session to Codex after the limit increase?',
            answer: 'Only when the official reset is not enough and Codex still has quota. The handoff steps did not change with Opus 5.5.',
          },
        ],
        sources: [
          {
            label: 'Anthropic: Introducing Claude Opus 5.5',
            url: 'https://www.anthropic.com/claude-opus-5-5',
            accessed: '2026-09-23',
          },
          {
            label: 'Anthropic Support: How do usage and length limits work?',
            url: 'https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work',
            accessed: '2026-09-23',
          },
          {
            label: 'Watch: Continue in Codex when Claude Code hits its limit',
            url: 'https://relay.bobochang.cn/en/guides/claude-code-limit-to-codex/',
            accessed: '2026-09-23',
          },
        ],
      },
    },
  },
  {
    id: 'empty-session-resume-check',
    published: '2026-11-17',
    modified: '2026-11-23',
    status: 'published',
    locales: {
      zh: {
        slug: 'empty-session-resume-check',
        title: '为什么 resume 打开是空会话：0 轮会话的识别与恢复 | Watch 指南',
        description: 'resume 命令只是打开一条既有会话，能不能接着聊取决于那条会话文件里有没有对话。本指南说明 0 轮可读会话与 0 字节文件的区别、Watch 在 status / switch / new 里的披露，以及备份恢复、换绑与另起一条链三条恢复路径。',
        h1: '为什么 resume 打开是空会话：0 轮会话的识别与恢复',
        summary: 'Watch 会把链尾会话连同工作目录交到目标工具，resume 命令本身只负责打开。本指南从 status 的链尾行读起，区分 0 轮可读会话与 0 字节文件，并给出备份恢复、adopt 换绑与另起一条链三条路径。',
        answer: 'resume 打开空会话，通常是因为这条会话文件里没有可继续的对话：可能是 watch new 建出的合法空会话、内容被清空只剩占位头，也可能是 0 字节文件。用 watch status 看链尾行的轮数即可判断；Watch 不会替你重建历史，只能从备份恢复、换绑到另一条会话，或另起一条链。',
        blocks: [
          {
            type: 'callout',
            tone: 'info',
            title: '核心判断依据',
            body: 'resume（以及各家的原生恢复命令）只做一件事：打开指定的那条会话。它能不能接着聊，取决于那条会话文件里还有多少对话。文件在、读得出来，不等于有内容——这正是「看起来一切正常，打开什么也没有」的来源。Watch 从 v0.1.84 起在 open / switch / new / status 各入口分别披露这一档，两者要分开看。',
          },
          {
            type: 'paragraph',
            text: '会话文件有两种「空」：一种是 0 轮可读——文件里有合法的会话头（Claude Code 的占位 user 行、Codex rollout 的 session_meta），但没有任何对话轮次；另一种是 0 字节——进程被杀、磁盘写满或只写了一半，文件本身空了。两者的下一步不同：0 轮可读可能只是刚建出来的新会话，也可能内容被清空；0 字节则连会话元数据都可能一起丢了，Codex 的归属写在 rollout 首行，截成 0 字节后连反查都会失败。',
          },
          {
            type: 'paragraph',
            text: '还有一种「打开是空的」发生在文件已经不在的时候：Claude Code 会按 cleanupPeriodDays 在会话启动后清理过期 transcript，官方默认 30 天，这个键允许写在任意设置文件里，项目设置可以覆盖用户设置。超期会话不再出现在 /resume 里，Watch 的 open 与 resume 自然也找不到。watch doctor 会只读核对用户设置、当前目录项目设置，以及在普通 Git 仓库子目录运行时的仓库根目录本地设置（scope 为 repository-local），低于默认值或无法确认时给出警告；它不会把这个值说成实际生效值，--settings 与管理设置也不在探测范围。调大保留期只能减少以后被清理的会话，不会恢复已经删除的文件——重要会话请提前备份。',
          },
          {
            type: 'steps',
            items: [
              {
                title: '步骤 1：看 status 的链尾行',
                body: '执行 watch status。链尾那一行在 v0.1.90 起会显示轮数，例如「← 链尾（12 轮）」；解析出 0 轮时写「（解析出 0 轮，原因见上方警告）」；文件读不出来或不存在时不给轮数。JSON 输出里对应 chainTipTurns 与 chainTipEmpty 两个字段，chainTipTurns 只在解析成功时存在。多条链时 watch chain list 的链尾行同样带轮数（v0.1.93）；拿不准时 watch doctor 的 store.emptyTips 会列出解析出 0 轮的链尾（v0.1.92）。watch new 的 --json 也报实际解析出的轮数（v0.1.94）：claude / pi 会写出一条占位 user，所以显示 1 轮，codex / grok / opencode 是 0 轮。watch usage 从 v0.1.95 起把「解析出 0 轮的空会话」与「有内容却没记 usage」分档，新建的空链不会再被说成统计缺失；v0.1.96 起内容文件坏行与 Codex 压缩记录也不再冒充空会话；v0.1.97 起旁路用量仍可读时，内容文件被删掉也会明说对话已丢失；v0.1.98 起内容坏行会进入警告与字段，不再静默；v0.1.99 起已有轮次的内容坏行不再被说成「解析出 0 轮」；v0.1.100 起文本摘要按 0 轮与已读到用量分档，坏行扫描失败会说明数量未知；v0.1.101 起 0 轮摘要不再附带「用量已计入」，并更正 v0.1.98 的历史表述。',
              },
              {
                title: '步骤 2：按警告分档读原因',
                body: '同一份结果里，警告会区分：0 字节（「会话文件是空的」）、可读 0 轮（「解析出 0 轮（没有可继续的对话）」）、文件读不出来（权限或内容问题）、文件不存在（被删或被移走）、内容解析失败（文件读得出来，但会话格式损坏或 OpenCode 库缺正文表等；v0.1.279 起警告写「内容解析失败，Watch 未能核对它的轮数与收尾状态」）。五档的下一步不同，不要只看到「空」就去换绑：文件不存在时先找文件，0 字节时先确认有没有备份；解析失败这一档连「是不是空」都不知道，不能当空会话处理，先用 watch switch 或 watch open 打开一次，让预检给出具体原因。',
              },
              {
                title: '步骤 3：确认是不是刚建出来的空会话',
                body: 'watch new <provider> 建出来的会话本来就是空的，这是首条链的正常起点：下一次 switch 或 open --to 会把它当作目标，把来源内容并进去。如果链尾是这条新会话、你还没切过去，它就是 0 轮，不是损坏。',
              },
              {
                title: '步骤 4：按原因恢复',
                body: '内容被清空：从备份恢复该文件，再重试 resume（Watch 不替你重建历史）。会话选错了：watch adopt <provider> --session <另一个会话 id> 换绑链尾。两边都要保留：watch chain new <新名字> 另起一条链，原链记录不动。0 字节且没有备份：这条会话已经没有可恢复的内容，按新会话处理。',
              },
            ],
          },
          {
            type: 'code',
            language: 'sh',
            code: '# 1. 看链尾轮数与警告（v0.1.90 起链尾行带轮数）\nnpm run watch -- status --json\n\n# 2. 链尾是空会话时的三条路\nnpm run watch -- adopt <provider> --session <another-session-id>   # 换绑到另一条会话\nnpm run watch -- chain new <new-chain-name>                       # 另起一条链\n# 3. 有备份时先恢复文件，再重试 resume\nnpm run watch -- switch <provider>',
          },
          {
            type: 'callout',
            tone: 'warning',
            title: '边界与安全限制',
            body: '1. Watch 不重建历史：0 轮会话只能从备份恢复，工具不会替你补写对话内容。\n2. Watch 不会自动删除或修复 0 字节文件：那是你的原生会话文件，需要你自己决定恢复还是放弃。\n3. 可读 0 轮不一定等于「被清空」：watch new 建出来的合法空会话就是这个形状，判断依据是上下文而不是轮数本身。\n4. 这些披露只是读取本地文件得出的结论，不代表原生客户端一定能打开该会话；客户端验收仍按各自的版本与平台单独记录。',
          },
        ],
        faq: [
          {
            question: 'resume 打开什么也没有，是 Watch 把历史弄丢了吗？',
            answer: '通常不是。Watch 在交接时会先读来源、再用写前守卫与原子写追加到目标；0 轮会话多数是本来就空的（watch new 建出的空会话）或在此之前就被清空 / 截断的。要确认是不是 Watch 写入导致，先看交接结果里的轮数与 warnings，再对比备份文件。',
          },
          {
            question: '0 轮和 0 字节有什么区别？',
            answer: '0 轮是文件可读、有合法会话头但没有对话，可能是新会话或只剩占位头；0 字节是文件本身空了，进程被杀、磁盘满或只写了一半都会造成，连会话元数据都可能一起丢失。前者可能只是还没开始，后者要优先找备份。',
          },
          {
            question: 'Watch 能帮我自动恢复被清空的会话吗？',
            answer: '不能。Watch 只读写本地会话文件，没有历史备份能力，也不会凭空重建对话。恢复只能来自你自己的备份（Time Machine、git 之外的副本、编辑器历史等），恢复文件后再 resume 即可。',
          },
          {
            question: 'Claude Code 会自己删掉旧会话吗？',
            answer: '会。官方 settings 里的 cleanupPeriodDays 默认 30 天，会话启动后后台清理超过期限的 transcript，超期会话不再出现在 /resume 里。它允许写在任意设置文件里，项目设置可以覆盖用户设置；watch doctor 会只读核对用户设置、当前目录项目设置与仓库根目录本地设置，但 --settings 与管理设置不在探测范围，报告不代表实际生效值。调大这个值只能减少以后被删除的会话，不能找回已经删掉的文件。',
          },
        ],
        sources: [
          {
            label: 'Anthropic Claude Code settings reference',
            url: 'https://code.claude.com/docs/en/settings-reference',
            accessed: '2026-11-18',
          },
          {
            label: 'Watch repository',
            url: 'https://github.com/can4hou6joeng4/Watch',
            accessed: '2026-11-17',
          },
          {
            label: 'Watch releases',
            url: 'https://github.com/can4hou6joeng4/Watch/releases',
            accessed: '2026-11-17',
          },
        ],
      },
      en: {
        slug: 'empty-session-resume-check',
        title: 'Why resume Opens an Empty Session: Detecting and Recovering 0-Turn Sessions | Watch Guide',
        description: 'A resume command only opens an existing session. Whether it continues depends on whether that session file still has turns. This guide separates readable 0-turn sessions from zero-byte files, explains what Watch discloses in status, switch and new, and gives three recovery paths: backup restore, rebinding and a new chain.',
        h1: 'Why resume Opens an Empty Session: Detecting and Recovering 0-Turn Sessions',
        summary: 'Watch hands the chain-tip session and its working directory to the target tool; the resume command itself only opens the session. This guide starts from the chain-tip row in status, separates readable 0-turn sessions from zero-byte files, and gives three recovery paths: backup restore, rebinding with adopt, and a new chain.',
        answer: 'An empty session after resume usually means the file has no turns left: a legitimate empty session created by watch new, content cleared with only a placeholder header left, or a zero-byte file. Check the turn count on the chain-tip row in watch status. Watch does not rebuild history for you; restore the file from backup, rebind to another session, or start a new chain.',
        blocks: [
          {
            type: 'callout',
            tone: 'info',
            title: 'Key Distinction',
            body: 'A resume command, and the native resume command of each client, does one thing: open the specified session. Whether it can continue depends on how many turns remain in that file. Existing and readable do not mean it has content, which is exactly how a resume opens into an empty session while everything looks fine. Since v0.1.84 Watch discloses this case separately in open, switch, new and status.',
          },
          {
            type: 'paragraph',
            text: 'There are two kinds of empty. A readable 0-turn file still has a valid session header (the placeholder user line in Claude Code, the session_meta line in a Codex rollout) but no conversation turns. A zero-byte file was killed mid-write, ran out of disk, or was truncated, so even the session metadata may be gone; Codex stores attribution in the first rollout line, so truncating to zero bytes also breaks lookup.',
          },
          {
            type: 'paragraph',
            text: 'A third way to open an empty session is that the file no longer exists. Claude Code deletes transcripts older than cleanupPeriodDays after a session starts; the official default is 30 days, and the key is allowed in any settings file, so project settings can override user settings. Expired sessions no longer appear in /resume, and watch open or resume cannot find them either. watch doctor reads, without writing, your user settings, the current directory project settings and, inside a subdirectory of a normal Git repository, the repository-root local settings (scope repository-local), and warns when a value is below the default or cannot be confirmed. It does not present that value as the effective one, and --settings plus managed settings are out of scope. Raising the retention period only reduces future deletions; it does not restore files already removed, so back up important sessions in advance.',
          },
          {
            type: 'steps',
            items: [
              {
                title: 'Step 1: Read the chain-tip row in status',
                body: 'Run watch status. Since v0.1.90 the chain-tip row shows its turn count, for example a chain tip with 12 turns; a 0-turn parse says it parsed 0 turns and points at the warning above; an unreadable or missing file carries no count. In JSON the fields are chainTipTurns and chainTipEmpty, and chainTipTurns exists only when the parse succeeds. With several chains, the tip row in watch chain list carries the same count (v0.1.93); when in doubt, store.emptyTips in watch doctor lists tips that parse to 0 turns (v0.1.92). watch new --json also reports the actual parsed turn count (v0.1.94): claude and pi write a placeholder user message, so it shows 1 turn, while codex, grok and opencode show 0. Since v0.1.95, watch usage separates a 0-turn empty session from a session that has content but no recorded usage, so a freshly created chain is no longer reported as a statistics gap. Since v0.1.96, unparsable content lines and Codex compaction records are no longer misreported as empty sessions. Since v0.1.97, a deleted content file is disclosed even when sidecar usage is still available. Since v0.1.98, bad content lines are disclosed in warnings and fields instead of staying silent; since v0.1.99, a bad content line with existing turns is no longer described as a 0-turn parse; since v0.1.100, the text summary separates 0-turn sessions from sessions with usage, and a failed scan says the bad-line count is unknown; since v0.1.101, the 0-turn summary no longer adds a usage-counted clause, and the v0.1.98 note describes a disclosure gap rather than lost usage.',
              },
              {
                title: 'Step 2: Read the five warning cases',
                body: 'The same result separates zero bytes (the session file is empty), readable 0 turns (parsed 0 turns, nothing to continue), unreadable content (permissions or content), a missing file (deleted or moved), and a failed content parse (the file reads fine, but the session format is damaged or the OpenCode database is missing its message table; since v0.1.279 the warning says the content failed to parse and Watch could not verify the turn count or tail state). Each case has a different next step; do not rebind just because you saw the word empty. The last case does not even tell you whether the session is empty, so do not treat it as an empty session: run watch switch or watch open once and let the preflight report the specific reason.',
              },
              {
                title: 'Step 3: Check whether it is a brand-new empty session',
                body: 'A session created by watch new is empty by design. It is the normal starting point for a first chain: the next switch or open --to uses it as the target and merges the source content in. If the chain tip is that new session and you have not switched yet, 0 turns is expected, not damage.',
              },
              {
                title: 'Step 4: Recover according to the case',
                body: 'Content cleared: restore the file from backup and retry resume; Watch does not rebuild history. Wrong session: rebind the chain tip with watch adopt <provider> --session <another-session-id>. Keep both sides: start another chain with watch chain new <new-chain-name> and leave the original records untouched. Zero bytes with no backup: nothing is left to recover, treat it as a new session.',
              },
            ],
          },
          {
            type: 'code',
            language: 'sh',
            code: '# 1. Read the chain-tip turn count and warnings (since v0.1.90)\nnpm run watch -- status --json\n\n# 2. Three paths when the chain tip is an empty session\nnpm run watch -- adopt <provider> --session <another-session-id>   # rebind to another session\nnpm run watch -- chain new <new-chain-name>                       # start another chain\n# 3. Restore from backup first, then retry resume\nnpm run watch -- switch <provider>',
          },
          {
            type: 'callout',
            tone: 'warning',
            title: 'Boundaries',
            body: '1. Watch does not rebuild history: a 0-turn session can only come back from your own backup. 2. Watch never deletes or repairs a zero-byte file on its own; that is your native session file, and the decision to restore or abandon it is yours. 3. A readable 0-turn session is not necessarily cleared content: watch new creates exactly that shape, so judge by context, not by the number alone. 4. These disclosures come from reading local files; they do not guarantee that the native client will open the session, and client acceptance stays recorded per version and platform.',
          },
        ],
        faq: [
          {
            question: 'Did Watch lose the history when resume opened an empty session?',
            answer: 'Usually not. Watch reads the source first and appends to the target with write guards and atomic writes; a 0-turn session is usually empty from the start (a new session from watch new) or was cleared or truncated earlier. To check whether a Watch write caused it, compare the turn count and warnings in the handoff result with your backup file.',
          },
          {
            question: 'What is the difference between 0 turns and 0 bytes?',
            answer: '0 turns means the file is readable and has a valid session header but no conversation; it may be a new session or only a placeholder header left behind. 0 bytes means the file itself is empty, from a killed process, a full disk or a half write, and even the session metadata may be gone. The first may just not have started; the second should send you to backups first.',
          },
          {
            question: 'Can Watch restore a cleared session automatically?',
            answer: 'No. Watch only reads and writes local session files. It has no history backup and does not invent conversation. Recovery comes from your own backup (Time Machine, copies outside the repo, editor history), and you resume after restoring the file.',
          },
          {
            question: 'Does Claude Code delete old sessions on its own?',
            answer: 'Yes. cleanupPeriodDays in the official settings reference defaults to 30 days; after a session starts, Claude Code sweeps transcripts older than that in the background, and expired sessions stop appearing in /resume. The key is allowed in any settings file, so project settings can override user settings. watch doctor reads your user settings, the current directory project settings and the repository-root local settings without writing, but --settings and managed settings are out of scope, so the report is not the effective value. Raising the value only reduces future deletions; it cannot bring back files already removed.',
          },
        ],
        sources: [
          {
            label: 'Anthropic Claude Code settings reference',
            url: 'https://code.claude.com/docs/en/settings-reference',
            accessed: '2026-11-18',
          },
          {
            label: 'Watch repository',
            url: 'https://github.com/can4hou6joeng4/Watch',
            accessed: '2026-11-17',
          },
          {
            label: 'Watch releases',
            url: 'https://github.com/can4hou6joeng4/Watch/releases',
            accessed: '2026-11-17',
          },
        ],
      },
    },
  },
  {
    id: 'prompt-handoff-without-adapter',
    published: '2026-11-18',
    modified: '2026-11-18',
    status: 'published',
    locales: {
      zh: {
        slug: 'prompt-handoff-without-adapter',
        title: '没有原生适配器时用 watch prompt 交接会话 | Watch 指南',
        description: '目标 CLI 还没有 Watch 适配器，或原生格式刚发生变化时，如何用 watch prompt 生成只读 Markdown 摘要交接文档，并读懂裁剪与降级说明。',
        h1: '没有适配器时，用 watch prompt 交接会话',
        summary: 'watch prompt 从本机原生会话记录生成一份 Markdown 摘要交接文档，不写任何文件、不启动目标 CLI。目标工具不会继承原生恢复能力，所有裁剪与来源状态都写在正文和 findings 里。',
        answer: '目标工具没有适配器或原生格式刚变化时，用 watch prompt <session-id> 生成只读 Markdown 交接文档；它不写会话文件、不启动 CLI，裁剪计数与降级说明写进正文和 --json 的 findings，目标端只能把它当作摘要而不是原生会话。',
        blocks: [
          {
            type: 'callout',
            tone: 'info',
            title: '什么时候用这一条',
            body: '三条原生接力路径（启动器、链式交接、Codex 官方导入）都要求目标端有对应适配器与可验证的格式。目标 CLI 尚无适配器、原生格式刚变化，或你只想把上下文交给一个网页端助手时，用 watch prompt 生成只读摘要。它不是原生会话，只是可复制、可审阅的交接材料。',
          },
          {
            type: 'paragraph',
            text: 'watch prompt 只读取来源助手在本机保存的会话记录，把轮次、工具过程与改动概览整理成 Markdown。文档头会写明来源助手、会话 ID、源文件、工作目录、工作树类型与当前分支；正文会逐项说明裁剪了多少轮、哪些内容被省略、用量是否可能偏少。整个命令不写会话文件、不建库、不启动任何 CLI。',
          },
          {
            type: 'steps',
            items: [
              {
                title: '步骤 1：确定来源会话与目录',
                body: '显式给出会话 ID，或用 --cwd 指定工作目录后省略 ID。省略 ID 时 Watch 按当前目录最新的可读会话自动挑选，并在文档头标注「自动挑选」；不确定时请显式指定，避免把另一条会话当成来源。',
              },
              {
                title: '步骤 2：选择档位与窗口',
                body: '--profile minimal|standard|verbose|full 控制每条正文与过程记录的展开程度；--last N 只保留最近 N 个用户轮，会省略首条任务描述，正文会明确写出；--since-compact 从最近一次压缩摘要开始，找不到可用摘要时不裁剪并说明。',
              },
              {
                title: '步骤 3：检查 findings 与来源状态',
                body: '加 --json 时，除 markdown 外还会返回 findings 与 warnings。degraded 表示已降级但说清了，skipped 表示按你的选项省略了内容；正文里的来源状态、坏行、用量与分支行用于判断这份文档能不能直接交给目标助手。工作目录不可用时另有 sourceCwd: { state }（missing / not-directory / denied / unknown，unknown 附 reason），健康目录不输出；普通仓库根返回结构化 sourceBranch（{ branch, repoRoot }，detached HEAD 为 { detached: true, repoRoot }），链接工作树返回 sourceWorktree（{ mainWorktree, branch }）。读取前后来源文件的大小或修改时间有变化时，sourceDrift（{ from, to, growth }）报告字节数和增长方向，无法确认正文包含了哪些记录。明确标记失败的工具调用另有 failedAttempts（工具、路径或命令与次数，不复制工具输出），正文保留「失败与中断」一节。生成文档时，「改动概览」还会核对清单里的文件是否仍在会话目录里：确定不在的标「磁盘上已不在」，无法确认的标「没能核对」，本会话补丁删掉或移走的标「已删除 / 移走」，会话目录之外的单独计数；抬头也会写明这次核对了几个、或为什么没核对。--json 另有 manifestDisk（checked / missing / unverified / outside / removed），缺字段不代表都还在。未闭合工具调用与悬空尾轮另有 stats.danglingToolCalls、stats.unansweredTail 及对应 finding：前者按整条会话计数，后者只在尾部用户轮有正文时报告；正文元信息与「继续工作」都写明下一步，--json 保留同源字段。',
              },
              {
                title: '步骤 4：明确说明这是摘要交接',
                body: '把 Markdown 粘贴或保存成文件交给目标工具，并在首轮说明这是摘要交接而不是原生会话。目标端不能原生恢复，工具调用、思考过程与附件可能已被裁剪，未包含的部分无法从文档恢复。',
              },
            ],
          },
          {
            type: 'code',
            language: 'sh',
            code: '# 1. 自动挑选当前目录最近的会话，生成 standard 档位摘要\nnpm run watch -- prompt --cwd /abs/project\n\n# 2. 显式指定会话，只保留最近 5 个用户轮\nnpm run watch -- prompt <session-id> --cwd /abs/project --last 5\n\n# 3. 输出 JSON，检查 findings 与正文\nnpm run watch -- prompt <session-id> --cwd /abs/project --json',
          },
          {
            type: 'callout',
            tone: 'warning',
            title: '边界与安全限制',
            body: '1. 只读：不写会话文件、不建本地库、不启动目标 CLI，生成的 Markdown 由你决定如何交付。\n2. 摘要不等于原生会话：工具调用、思考过程与附件可能被裁剪，未包含的部分无法从文档恢复。\n3. 裁剪必须计数：档位、--last 与 --since-compact 的省略会写进正文与 findings；找不到摘要时宁可不裁剪，也会说明。\n4. 0 轮或来源损坏不会假装成功：正文会说明来源为空或坏行，无法确认的用量与坏行数会标注可能偏少或无法确认。',
          },
        ],
        faq: [
          {
            question: 'watch prompt 会写入目标工具的会话吗？',
            answer: '不会。它只读取来源记录并输出 Markdown，不写目标会话文件、不建库、不启动任何 CLI。需要目标端原生恢复时，请改用对应适配器的启动器或链式路径；支持官方导入的只有 Claude Code 到 Codex 桌面这一条。',
          },
          {
            question: '为什么文档说「首条任务描述未保留」？',
            answer: '使用 --last N 时，Watch 从倒数第 N 条用户轮开始截取，更早的轮次会被省略，其中就包括最初的任务描述。需要完整背景时去掉 --last，或改用 --since-compact 与更高的档位；正文会按实际发生的裁剪逐项说明。',
          },
          {
            question: '目标助手能像原生会话一样继续吗？',
            answer: '不能。目标端拿到的是一份摘要文档，不继承原生恢复能力，也看不到被裁剪的工具执行细节。建议在首轮要求目标助手复述任务目标与当前分支，确认理解后再分配修改任务。',
          },
        ],
        sources: [
          {
            label: 'Watch repository README',
            url: 'https://github.com/can4hou6joeng4/Watch#readme',
            accessed: '2026-11-18',
          },
          {
            label: 'Watch releases',
            url: 'https://github.com/can4hou6joeng4/Watch/releases',
            accessed: '2026-11-18',
          },
        ],
      },
      en: {
        slug: 'prompt-handoff-without-adapter',
        title: 'Hand Off a Session with watch prompt When No Adapter Exists | Watch Guide',
        description: 'When the target CLI has no Watch adapter yet or its native format just changed, use watch prompt to produce a read-only Markdown handoff and read its trimming and degradation notes.',
        h1: 'Using watch prompt When There Is No Adapter',
        summary: 'watch prompt turns local native session records into a Markdown summary handoff without writing any file or launching the target CLI. The target does not inherit native resume, and every trim and source state is written into the document and findings.',
        answer: 'When the target tool has no adapter or its native format just changed, run watch prompt <session-id> to build a read-only Markdown handoff. It writes no session files and starts no CLI; trimming counts and degradations go into the document and the --json findings, and the target must treat it as a summary, not a native session.',
        blocks: [
          {
            type: 'callout',
            tone: 'info',
            title: 'When to use this path',
            body: 'The three native handoff paths (launcher, chained handoff and official Codex import) require an adapter and a verifiable target format. When the target CLI has no adapter yet, its native format just changed, or you only need to hand context to a web assistant, use watch prompt to produce a read-only summary. It is not a native session, only copyable and reviewable handoff material.',
          },
          {
            type: 'paragraph',
            text: 'watch prompt reads only the source assistant local session record and renders turns, tool events and a work manifest into Markdown. The header names the source assistant, session ID, source file, working directory, worktree type and current branch; the body states how many turns were trimmed, what was omitted and whether usage may be undercounted. The command writes no session files, opens no database and launches no CLI.',
          },
          {
            type: 'steps',
            items: [
              {
                title: 'Step 1: Identify the source session and directory',
                body: 'Pass the session ID explicitly, or pass --cwd and omit the ID. Without an ID, Watch picks the newest readable session in the current directory and marks it as auto-picked in the header; when unsure, name the ID so another session is not mistaken for the source.',
              },
              {
                title: 'Step 2: Choose a profile and window',
                body: '--profile minimal|standard|verbose|full controls how much text and how many tool events are expanded. --last N keeps only the newest N user turns and drops the original task description, which the document states. --since-compact starts at the latest compaction summary; when no usable summary exists it does not trim and says so.',
              },
              {
                title: 'Step 3: Review findings and source state',
                body: 'With --json the result includes markdown, findings and warnings. degraded means the downgrade was disclosed, skipped means content was omitted by your options. The source state, bad lines, usage and branch lines in the document tell you whether it is safe to hand over. An unavailable source working directory is returned as sourceCwd: { state } (missing, not-directory, denied or unknown, with reason for unknown); a healthy directory emits no such field. A normal repository root returns a structured sourceBranch ({ branch, repoRoot }; a detached HEAD returns { detached: true, repoRoot }) and a linked worktree returns sourceWorktree ({ mainWorktree, branch }). If the source file size or modification time changes between checks, sourceDrift ({ from, to, growth }) reports byte counts and growth direction. This does not establish which records made it into the document. Explicitly failed tool calls are returned as failedAttempts (tool, path or command and count, never tool output), with the 失败与中断 (Failures and interruptions) section in the document. At render time the change overview also checks whether the files it lists are still in the session directory: a file confirmed gone is marked as no longer on disk, one that cannot be confirmed as unchecked, a file the session patch deleted or moved away is labelled as such, and paths outside the session directory are counted separately; the section header states how many were checked, or why the check did not run. --json adds manifestDisk (checked, missing, unverified, outside, removed) so scripts never read a missing field as all present.Unfinished tool calls and a hanging user tail are reported as stats.danglingToolCalls, stats.unansweredTail and matching findings; the first counts the whole session and the second only fires when the trailing user turn has real text. Both are described in the document metadata and the Continue working section, with the same fields in --json.',
              },
              {
                title: 'Step 4: State that it is a summary handoff',
                body: 'Paste the Markdown or save it as a file and tell the target assistant in the first turn that this is a summary handoff, not a native session. The target cannot resume natively, and tool calls, reasoning and attachments may have been trimmed; anything omitted cannot be recovered from the document.',
              },
            ],
          },
          {
            type: 'code',
            language: 'sh',
            code: '# 1. Auto-pick the newest session in the current directory at the standard profile\nnpm run watch -- prompt --cwd /abs/project\n\n# 2. Name the session and keep only the newest 5 user turns\nnpm run watch -- prompt <session-id> --cwd /abs/project --last 5\n\n# 3. Emit JSON to review findings with the document\nnpm run watch -- prompt <session-id> --cwd /abs/project --json',
          },
          {
            type: 'callout',
            tone: 'warning',
            title: 'Boundaries',
            body: '1. Read-only: it writes no session files, opens no local database and launches no target CLI; you decide how to deliver the Markdown.\n2. A summary is not a native session: tool calls, reasoning and attachments may be trimmed, and omitted parts cannot be recovered from the document.\n3. Trimming is counted: profile, --last and --since-compact omissions go into the body and findings; when no summary exists it does not trim and says so.\n4. A 0-turn or damaged source is not reported as success: the body states an empty source or bad lines, and unreadable usage or bad-line counts are marked as possibly undercounted or unconfirmed.',
          },
        ],
        faq: [
          {
            question: 'Does watch prompt write into the target tool session?',
            answer: 'No. It only reads the source record and prints Markdown; it writes no target session file, opens no database and launches no CLI. When you need native resume in the target, use the launcher or chained path for that adapter; the only official import path is Claude Code to Codex desktop.',
          },
          {
            question: 'Why does the document say the first task description was not kept?',
            answer: 'With --last N, Watch starts at the Nth user turn from the end, so earlier turns, including the original task description, are omitted. Drop --last for full background, or use --since-compact with a larger profile; the body lists each trim that actually happened.',
          },
          {
            question: 'Can the target assistant continue exactly like a native session?',
            answer: 'No. It receives a summary document without native resume and cannot see trimmed tool execution detail. Ask it in the first turn to restate the task goal and current branch, and only then assign edits.',
          },
        ],
        sources: [
          {
            label: 'Watch repository README',
            url: 'https://github.com/can4hou6joeng4/Watch#readme',
            accessed: '2026-11-18',
          },
          {
            label: 'Watch releases',
            url: 'https://github.com/can4hou6joeng4/Watch/releases',
            accessed: '2026-11-18',
          },
        ],
      },
    },
  },
  {
    id: 'codex-compressed-rollout-recovery',
    published: '2026-11-23',
    modified: '2026-11-23',
    status: 'published',
    locales: {
      zh: {
        slug: 'codex-compressed-rollout-recovery',
        title: 'Codex 会话只剩 .jsonl.zst：Watch 的读取边界与恢复路径 | Watch 指南',
        description: 'Codex 会把本地线程压缩为同名 .jsonl.zst。Watch 只读未压缩的 .jsonl，因此这些会话不会出现在 sessions / recent / status 里，watch doctor 会把它们计入「读不出目录归属」。本指南说明原因、非空副本与 0 字节副本的区别，以及何时可以让 Codex 重新展开会话。',
        h1: 'Codex 会话只剩 .jsonl.zst：Watch 的读取边界与恢复路径',
        summary: 'Watch 只读取 ~/.codex/sessions 下未压缩的 rollout .jsonl；文件被 Codex 压缩后原 .jsonl 不在、只剩同名 .jsonl.zst，这些会话无法被列出、解析或交接。watch doctor 与列表命令会披露数量，而不是假装它们不存在。若副本确实由 Codex 压缩且内容完好，可尝试在 Codex 里继续该会话并确认 .jsonl 是否重新出现。',
        answer: 'Codex 压缩本地线程后，原 rollout 只剩 .jsonl.zst；Watch 不读压缩格式，这些会话不会出现在任何列表里。用 watch doctor 看「读不出目录归属」的数量，并在 Codex 里继续该线程触发重新展开。副本是 0 字节时内容已丢失，只能从备份恢复；不要删除或改名 .zst 文件。',
        blocks: [
          {
            type: 'callout',
            tone: 'info',
            title: '核心判断依据',
            body: 'Watch 读取的是 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 这类未压缩文件。Codex 压缩本地线程后，原文件不在，同目录只剩同名 .jsonl.zst（例如 rollout-....jsonl.zst）。Watch 不解压、不改写，也不会把「读不出来」讲成「没有这条会话」：列表、status、doctor 与 search 都会披露这一档的数量，并说明它们无法归属到任何目录。',
          },
          {
            type: 'paragraph',
            text: 'Codex 的会话归属写在 rollout 首行 session_meta 的 cwd 字段里，而压缩副本无法读取首行，Watch 因此无法判断它属于哪个工作目录。这就是 watch doctor 的「读不出目录归属」与 watch sessions 的 unattributable 字段：它们不是错误，而是「这些文件存在，但这一版看不到里面的内容」。同一台机器上积累大量压缩历史时，这个数量可能很大，属于正常现象。',
          },
          {
            type: 'paragraph',
            text: '副本有两种状态，下一步相反。非空副本：如果确实是 Codex 的本地线程压缩且副本完好，在 Codex 里继续该会话可能重新展开为 .jsonl，之后 Watch 才能读取。0 字节副本：内容已经丢失，重新展开也拿不回对话，只能从备份恢复或当作新会话处理。Watch 只 stat 副本是否存在、是否 0 字节，不打开、不解压，因此披露里写的是「若是 Codex 的本地线程压缩且副本完好」。',
          },
          {
            type: 'steps',
            items: [
              {
                title: '步骤 1：确认数量与文件形态',
                body: '执行 watch doctor --json：storage 里 codex 一行的 count 只统计可读会话，unattributable 给出压缩副本等读不出归属的文件数；文本模式会在会话数旁显示「另有 M 个文件读不出目录归属」。watch sessions --json 与 watch recent --json 带同名字段。警告里会按文件形态写明「只有 .jsonl.zst 压缩副本」或「0 字节的同名压缩副本」，两种情况下一步不同。',
              },
              {
                title: '步骤 2：区分非空副本与 0 字节副本',
                body: '找到对应的 .jsonl.zst。非空只说明还有字节，不代表副本完好或可解压；0 字节则说明这份副本没有可恢复的内容，需另找备份。如果该会话是不可用的链尾，watch doctor --json 的 store.brokenTips[].compressedPath 给出副本路径，compressedEmpty 为 true 表示 0 字节。列表的 unattributable 只给文件数。',
              },
              {
                title: '步骤 3：在 Codex 里继续该会话',
                body: '在 Codex 中打开或继续该线程。若副本是 Codex 的本地线程压缩且完好，Codex 会把它重新展开为 .jsonl；回到终端执行 watch sessions，这条会话就会重新出现，status / switch / open 也能读到。Watch 不会替你触发展开，也不会改 .zst。',
              },
              {
                title: '步骤 4：展开后再交接',
                body: '拿到重新展开的会话 id 后，按常规路径交接：watch open <id> --to <provider> 或 watch switch <provider>。watch prompt 也不读压缩文件；显式指定该会话时会报错，不生成交接文档。',
              },
            ],
          },
          {
            type: 'code',
            language: 'sh',
            code: '# 1. 只读：数量与原因\nnpm run watch -- doctor --json\nnpm run watch -- sessions --json\n\n# 2. 找到具体文件（原 .jsonl 不在、只剩同名 .zst）\nls ~/.codex/sessions/*/*/*/*.jsonl.zst\n\n# 3. 在 Codex 里继续该会话，让它重新展开；随后 Watch 可列出\nnpm run watch -- sessions --json\n\n# 4. 展开后再交接\nnpm run watch -- open <session-id> --to <provider>',
          },
          {
            type: 'callout',
            tone: 'warning',
            title: '边界与不要做的事',
            body: '1. Watch 不解压、不改写、不删除 .jsonl.zst，也不会替你判断内容是否可解；它只 stat 副本是否存在、是否 0 字节。\n2. .zst 也可能是你自己归档的，Watch 不假定压缩一定是 Codex 做的；「在 Codex 里继续会重新展开」只在确实是 Codex 本地线程压缩且副本完好时成立。\n3. 不要手工解压后放回 sessions 目录：Watch 不校验这种手写文件的形状，Codex 是否接受也没有验证记录。\n4. 不要直接删除或改名 .zst：那是你的原生会话数据，删掉后没有任何恢复路径。\n5. 本指南依据本地文件与 Watch 的披露行为；原生客户端是否接受展开后的会话，按各自版本与平台单独验收，本指南不构成原生验收。',
          },
        ],
        faq: [
          {
            question: 'Watch 会把我的 Codex 会话压缩或删掉吗？',
            answer: '不会。压缩是 Codex 自己的行为；Watch 不读取、改写或删除 .zst；列出和解析会话时读的是未压缩的 .jsonl。以 Codex 为目标的写入式交接是另一回事，可能新建或更新目标端未压缩的会话文件。',
          },
          {
            question: '为什么 doctor 说「读不出目录归属」，而不是直接说文件被压缩了？',
            answer: '因为 Watch 只 stat、不打开压缩文件：它能确认原 .jsonl 不在、同名 .zst 在，并把这一档按「压缩副本」写进警告，但无法确认副本内容是否可解，也无法读出 Codex 归属所在的 session_meta 首行。措辞里保留「若是 Codex 的本地线程压缩且副本完好」就是为了不替未验证的事实背书。',
          },
          {
            question: '能自己把 .zst 解压回 .jsonl 吗？',
            answer: '不推荐。那是原生存储目录，手写文件的形状 Watch 不校验，Codex 是否接受也没有验证记录；最稳妥的路径是在 Codex 里继续该会话，让原生自己展开。',
          },
          {
            question: '0 字节副本和完好副本有什么区别？',
            answer: '0 字节副本内容已经丢失，重新展开也拿不回对话，只能从备份恢复或当作新会话；完好副本在 Codex 里继续时可能被重新展开为 .jsonl，之后 Watch 就能读取。',
          },
          {
            question: '这些压缩会话还能交接给别的 Agent 吗？',
            answer: '不能直接交接。先让 Codex 重新展开，再按常规路径用 watch open <id> --to <provider> 或 watch switch。交接前仍建议核对工作目录与会话 id，并阅读结果里的 warnings。',
          },
        ],
        sources: [
          {
            label: 'OpenAI Codex repository',
            url: 'https://github.com/openai/codex',
            accessed: '2026-11-23',
          },
          {
            label: 'Watch repository',
            url: 'https://github.com/can4hou6joeng4/Watch',
            accessed: '2026-11-23',
          },
          {
            label: 'Watch releases',
            url: 'https://github.com/can4hou6joeng4/Watch/releases',
            accessed: '2026-11-23',
          },
        ],
      },
      en: {
        slug: 'codex-compressed-rollout-recovery',
        title: 'Codex Sessions Left as .jsonl.zst: Watch Read Boundaries and Recovery | Watch Guide',
        description: 'Codex compresses local threads into a same-name .jsonl.zst. Watch only reads uncompressed .jsonl, so those sessions do not appear in sessions, recent or status, and watch doctor counts them as unattributable. This guide explains why, what a nonempty or zero-byte copy tells you, and when to try re-expanding it in Codex.',
        h1: 'Codex Sessions Left as .jsonl.zst: Watch Read Boundaries and Recovery',
        summary: 'Watch reads uncompressed rollout .jsonl files under ~/.codex/sessions. After Codex compresses a local thread, the original .jsonl is gone and only a same-name .jsonl.zst remains; those sessions cannot be listed, parsed or handed off. watch doctor and the list commands disclose the count instead of pretending they do not exist. If Codex compressed the file and the copy is intact, try continuing the session in Codex and check whether the .jsonl reappears.',
        answer: 'After Codex compresses a local thread, the rollout remains only as a .jsonl.zst; Watch does not read the compressed format, so the session appears in no list. Use watch doctor to see the unattributable count and continue the thread in Codex to trigger re-expansion. A zero-byte copy has lost its content; restore from backup. Do not delete or rename the .zst file.',
        blocks: [
          {
            type: 'callout',
            tone: 'info',
            title: 'Key Distinction',
            body: 'Watch reads uncompressed files such as ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. After Codex compresses a local thread, the original file is gone and only a same-name .jsonl.zst remains in the same directory. Watch does not decompress or rewrite it, and it does not report unreadable as nonexistent: lists, status, doctor and search all disclose the count and say these files cannot be attributed to any directory.',
          },
          {
            type: 'paragraph',
            text: 'Codex stores session attribution in the cwd field of the first session_meta line, and a compressed copy cannot have that line read. Watch therefore cannot tell which working directory the session belongs to. That is what the unattributable count in watch doctor and the unattributable field in watch sessions report: not an error, but files that exist while this version cannot see inside them. Large compressed histories can produce a large count, and that is expected.',
          },
          {
            type: 'paragraph',
            text: 'A copy has two states with opposite next steps. For a nonempty copy, continuing the session in Codex may re-expand it into .jsonl if Codex made the copy and it is intact. Watch can read the plain file after it reappears. A zero-byte copy has lost its content; re-expansion cannot bring the conversation back, so restore from backup or treat it as a new session. Watch only stats whether a copy exists and whether it is zero bytes; it never opens or decompresses it, which is why the disclosure says it holds only if the copy is intact Codex compression.',
          },
          {
            type: 'steps',
            items: [
              {
                title: 'Step 1: Check the count and file shape',
                body: 'Run watch doctor --json. For codex, count includes only readable sessions while unattributable counts files whose directory cannot be read, such as compressed copies. The text output shows the unattributable total next to the session count. watch sessions --json and watch recent --json carry the same field. The warning names the shape: a same-name .jsonl.zst compressed copy, or a zero-byte same-name copy. The two call for different next steps.',
              },
              {
                title: 'Step 2: Distinguish nonempty copies from zero-byte copies',
                body: 'Find the matching .jsonl.zst. A nonempty file still has bytes, but that does not prove it is intact or can be decompressed. A zero-byte copy holds no recoverable content; look for a backup. If the session is an unusable chain tip, watch doctor --json shows the copy path in store.brokenTips[].compressedPath and sets compressedEmpty to true for a zero-byte copy. The list field unattributable only reports counts.',
              },
              {
                title: 'Step 3: Continue the session in Codex',
                body: 'Open or continue the thread in Codex. If the copy is intact Codex local thread compression, Codex re-expands it into .jsonl. Run watch sessions afterward and the session appears again; status, switch and open can read it too. Watch never triggers the re-expansion and never touches the .zst.',
              },
              {
                title: 'Step 4: Hand off after re-expansion',
                body: 'Once you have the re-expanded session id, use the usual paths: watch open <id> --to <provider> or watch switch <provider>. watch prompt does not read the compressed file either. If you specify that session, it reports an error and produces no handoff document.',
              },
            ],
          },
          {
            type: 'code',
            language: 'sh',
            code: '# 1. Read-only: count and cause\nnpm run watch -- doctor --json\nnpm run watch -- sessions --json\n\n# 2. Find the files (the original .jsonl is gone; only .zst remains)\nls ~/.codex/sessions/*/*/*/*.jsonl.zst\n\n# 3. Continue the session in Codex to re-expand it; Watch can then list it\nnpm run watch -- sessions --json\n\n# 4. Hand off after re-expansion\nnpm run watch -- open <session-id> --to <provider>',
          },
          {
            type: 'callout',
            tone: 'warning',
            title: 'Boundaries and What Not To Do',
            body: '1. Watch does not decompress, rewrite or delete .jsonl.zst, and it does not judge whether the content can be decoded; it only stats existence and zero size.\n2. A .zst file may also be your own archive. Watch does not assume Codex produced it, so the re-expansion path holds only for intact Codex local thread compression.\n3. Do not decompress by hand and put the result back into the sessions directory: Watch does not validate hand-made files, and Codex acceptance has no verification record.\n4. Do not delete or rename the .zst: it is your native session data, and deleting it leaves no recovery path.\n5. This guide follows local files and Watch disclosure behavior. Whether a native client accepts a re-expanded session is validated per version and platform separately, and this guide is not native acceptance.',
          },
        ],
        faq: [
          {
            question: 'Does Watch compress or delete my Codex sessions?',
            answer: 'No. Compression is Codex behavior. Watch does not read, rewrite, or delete .zst files; listing and parsing use uncompressed .jsonl. A write-enabled handoff into Codex is separate and may create or update an uncompressed target session file.',
          },
          {
            question: 'Why does doctor say the directory cannot be attributed instead of saying the file is compressed?',
            answer: 'Because Watch only stats the compressed file and never opens it. It can confirm the original .jsonl is gone and a same-name .zst exists, and its warning names that compressed-copy case, but it cannot confirm the copy decodes or read the session_meta first line that holds attribution. The wording stays conditional so it does not vouch for an unverified fact.',
          },
          {
            question: 'Can I decompress the .zst back into a .jsonl myself?',
            answer: 'Not recommended. That is the native storage directory; Watch does not validate hand-made files, and Codex acceptance has no verification record. The safer path is continuing the session in Codex and letting the native client re-expand it.',
          },
          {
            question: 'What is the difference between a zero-byte copy and an intact copy?',
            answer: 'A zero-byte copy has lost its content; re-expansion cannot bring the conversation back, so restore from backup or treat it as a new session. An intact copy may be re-expanded when you continue the session in Codex, after which Watch can read it.',
          },
          {
            question: 'Can these compressed sessions still be handed off to another agent?',
            answer: 'Not directly. Re-expand in Codex first, then use watch open <id> --to <provider> or watch switch. Before handing off, still check the session id and working directory and read the warnings in the result.',
          },
        ],
        sources: [
          {
            label: 'OpenAI Codex repository',
            url: 'https://github.com/openai/codex',
            accessed: '2026-11-23',
          },
          {
            label: 'Watch repository',
            url: 'https://github.com/can4hou6joeng4/Watch',
            accessed: '2026-11-23',
          },
          {
            label: 'Watch releases',
            url: 'https://github.com/can4hou6joeng4/Watch/releases',
            accessed: '2026-11-23',
          },
        ],
      },
    },
  },
];
