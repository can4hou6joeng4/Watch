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
                body: '依据官方通用导入协议要求，目标项目必须已经存在于 Codex Desktop 中。如果尚未添加，请先在 Codex Desktop 中打开该目录并完成首次信任确认，确保 Codex 的项目数据库能识别该工作空间。',
              },
              {
                title: '步骤 3：准备导入计划并核查字段（Prepare）',
                body: '在 Watch 桌面端选择来源会话并点击 OpenAI Codex，或在终端执行 prepare 命令生成导入计划。此阶段仅建立计划并核验目标锁状态，不会向目标文件写入任何记录。',
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
            code: '# 1. 准备导入计划（只读探测与生成计划）\nnpm run watch -- import-codex prepare <claude-id> --cwd /abs/project/path --desktop-project --experimental --json\n\n# 2. 明确确认并写入（使用计划返回的 planId）\nnpm run watch -- import-codex confirm <plan-id> --json\n\n# 3. 查看执行状态（发生异常时只读查询）\nnpm run watch -- import-codex status <plan-id> --json',
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
                body: 'Under official external agent import requirements, the destination workspace must already be registered in Codex Desktop. Open the folder in Codex Desktop beforehand to establish local trust and project recognition.',
              },
              {
                title: 'Step 3: Prepare the import plan (Prepare)',
                body: 'In Watch Desktop, select the source session and click OpenAI Codex, or run the prepare CLI command. This stage performs read-only checks, verifies lock status, and establishes an execution journal without modifying target files.',
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
            code: '# 1. Prepare import plan (read-only probe and plan generation)\nnpm run watch -- import-codex prepare <claude-id> --cwd /abs/project/path --desktop-project --experimental --json\n\n# 2. Confirm and execute import (using planId from prepare output)\nnpm run watch -- import-codex confirm <plan-id> --json\n\n# 3. Check execution status (read-only probe if interrupted)\nnpm run watch -- import-codex status <plan-id> --json',
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
        answer: 'OpenCode 的会话在本机 ~/.local/share/opencode/opencode.db，可用 WATCH_OPENCODE_DB 换库。Watch 用一次 SQLite 事务写入 sessions、messages、parts；事务失败会回滚。不支持的工具参数降级为文本，续写质量取决于你配置的模型。',
        blocks: [
          {
            type: 'callout',
            tone: 'info',
            title: '核心适用场景',
            body: 'OpenCode 采用单文件关系型 SQLite（默认位于 ~/.local/share/opencode/opencode.db）存储会话，天生具备 ACID 事务与结构化索引优势。当你希望将包含私有代码或需要离线运行的任务交接给本地开源大模型（如通过 Ollama 或 vLLM 驱动的 OpenCode），或者在 OpenCode 完成阶段性排查后需要调用云端前沿模型（Claude/Codex）继续攻坚时，Watch 提供了双向转换通道。',
          },
          {
            type: 'paragraph',
            text: '与基于单一 JSONL 追加日志的工具不同，OpenCode 的会话由 sessions、messages 和 parts 等数据表构成。直接修改或手工插入易破坏外键约束与自增索引。Watch 通过内置的 OpenCode 适配器，将跨 Agent 的统一时间线（UnifiedTurn）映射为合法的 OpenCode SQLite 记录，并保持工作目录（cwd）与时间戳对齐。',
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
                body: '在 Watch 终端使用 --check 参数探测目标数据库状态。Watch 会检查 ~/.local/share/opencode/opencode.db 的可写性与事务锁状态（如果配置了 WATCH_OPENCODE_DB 环境变量则优先检查自定义库），确保目标不存在并发写入冲突。',
              },
              {
                title: '步骤 3：执行双向流转写入（Handoff）',
                body: '在 Watch 桌面端选择来源会话卡片并点击 OpenCode，或在终端执行 open 命令。Watch 会原子提取增量回合，开启 SQLite 事务批量写入 sessions、messages 和 parts 记录，并生成目标会话 ID。',
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
            code: '# 1. 预检：检查从 Claude Code 转入 OpenCode 的目标数据库写入状态\nnpm run watch -- open <claude-session-id> --to opencode --check --json\n\n# 2. 写入：将指定会话导入 OpenCode 本地 SQLite 数据库并输出恢复命令\nnpm run watch -- open <claude-session-id> --to opencode --json\n\n# 3. 反向接力：从 OpenCode 会话接力至 Claude Code 或 Codex\nnpm run watch -- open <opencode-session-id> --to claude --json',
          },
          {
            type: 'callout',
            tone: 'info',
            title: 'OpenCode SQLite 表结构与数据隔离验证',
            body: 'OpenCode 会话库（~/.local/share/opencode/opencode.db）采用三层核心表组织数据：\n• sessions: 存储会话 ID、标题、项目绝对路径（directory）与更新时间\n• messages: 记录所属 session_id、角色（user / assistant）与时间戳\n• parts: 存储具体消息文本、代码块与结构化数据\n通过环境变量 WATCH_OPENCODE_DB=/tmp/isolated.db 可切分测试库，验证写入完全在独立 SQLite 事务中完成，异常时原子回滚。',
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
            answer: 'SQLite 支持 ACID 事务与行级锁定，避免在多终端并发写入或非正常退出时发生 JSON 文件损坏或行截断。同时，通过环境变量 WATCH_OPENCODE_DB 可以轻松进行数据库切分与本地开发隔离。',
          },
          {
            question: '反向转出时，OpenCode 中的自定义模型推理记录会丢失吗？',
            answer: 'Watch 会复制能映射的用户指令、助手文本、思考链和工具输出。不支持的工具字段降级为文本，所以这不是 OpenCode 原行的完整副本。',
          },
          {
            question: '如何确认恢复时的工作目录没有错乱？',
            answer: 'Watch 在写入 OpenCode 时严格绑定来源会话记录的绝对 cwd。当你在终端运行 opencode -s <session-id> 时，OpenCode 会自动锁定该项目目录，防止代码改写到错误仓库。',
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
        answer: 'OpenCode keeps sessions in ~/.local/share/opencode/opencode.db. WATCH_OPENCODE_DB points Watch at another file. Watch writes sessions, messages, and parts in one SQLite transaction and rolls back if it fails. Unsupported tool fields become text. Later replies depend on the model you configure.',
        blocks: [
          {
            type: 'callout',
            tone: 'info',
            title: 'Key Operational Boundary',
            body: 'OpenCode utilizes a single relational SQLite database (defaulting to ~/.local/share/opencode/opencode.db) for session storage, providing ACID transactional integrity and structured queries. When you wish to transition sensitive tasks to locally hosted open-source models (via Ollama or vLLM in OpenCode) or hand off back to frontier cloud models (Claude/Codex), Watch provides a verified bidirectional bridge.',
          },
          {
            type: 'paragraph',
            text: 'Unlike tools that rely strictly on append-only JSONL files, OpenCode organizes sessions across normalized relational tables including sessions, messages, and parts. Direct external tampering can corrupt foreign key constraints. Watch maps the UnifiedTurn abstraction cleanly into OpenCode\'s relational schema while preserving exact directory context (cwd) and timestamps.',
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
                body: 'Run Watch CLI with --check to probe the target OpenCode database. Watch validates write permissions and locks on ~/.local/share/opencode/opencode.db (or the custom path specified by WATCH_OPENCODE_DB) to prevent concurrent write contention.',
              },
              {
                title: 'Step 3: Execute bidirectional handoff (Handoff)',
                body: 'Select the source session in Watch Desktop and target OpenCode, or run the CLI open command. Watch extracts incremental turns, executes atomic SQLite transactions across sessions, messages, and parts, and issues the destination session ID.',
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
            code: '# 1. Preflight: Verify target OpenCode database writability\nnpm run watch -- open <claude-session-id> --to opencode --check --json\n\n# 2. Handoff: Transfer session into OpenCode SQLite database\nnpm run watch -- open <claude-session-id> --to opencode --json\n\n# 3. Reverse handoff: Transfer from OpenCode back to Claude or Codex\nnpm run watch -- open <opencode-session-id> --to claude --json',
          },
          {
            type: 'callout',
            tone: 'info',
            title: 'OpenCode Relational Schema & SQLite Transaction Isolation',
            body: 'OpenCode session storage (~/.local/share/opencode/opencode.db) is structured across three core relational tables:\n• sessions: tracks session ID, title, absolute workspace directory, and timestamps\n• messages: maps session_id, role (user / assistant), and creation time\n• parts: stores text chunks, code blocks, and structured tool call representations\nSetting WATCH_OPENCODE_DB=/tmp/isolated.db routes writes to a separate SQLite database. Transfers execute inside an atomic SQLite transaction, rolling back completely on any interruption.',
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
            answer: 'SQLite provides ACID transactions and robust indexing, eliminating the risk of line truncation or file corruption during unexpected termination. The WATCH_OPENCODE_DB override also facilitates isolated test environments.',
          },
          {
            question: 'Are custom model reasoning thoughts retained when handing off out of OpenCode?',
            answer: 'Watch copies the saved user prompts, assistant text, thinking traces, and tool outputs it can map. Unsupported tool fields become text, so the copy is not a complete replica of the OpenCode row.',
          },
          {
            question: 'How does Watch prevent working directory mismatch?',
            answer: 'Watch strictly binds the source session\'s absolute cwd to the OpenCode session entry. When resuming via opencode -s <session-id>, OpenCode locks to that workspace, preventing accidental edits in the wrong directory.',
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
            answer: '因为 /compact 自身也需要调用大模型完成历史摘要提炼。如果你的账户已经处于限额状态（Usage Limit Exceeded），任何向模型发起的请求（包括压缩指令）都将被服务端拒绝。此时接力到其他有额度的 Agent 是唯一的继续途径。',
          },
          {
            question: '切换到 Codex 或 OpenCode 后，上下文是否会被重置？',
            answer: '目标 Agent 会获得一个崭新的上下文窗口，并将前序 Agent 记录的指令与执行结果作为初始输入载入，从而使你摆脱了旧会话由于历史累积导致的上下文饱和。',
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
            label: 'Watch Guide Source Matrix & Boundaries',
            url: 'https://github.com/can4hou6joeng4/Watch/blob/main/docs/guide-source-matrix-2026-09-17.md',
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
            answer: '/compact requires calling the underlying LLM to generate the conversation summary. When your account quota is exhausted, all API requests are blocked. In this scenario, switching to another agent via Watch is the only immediate continuation path.',
          },
          {
            question: 'Does handing off to Codex or OpenCode reset context?',
            answer: 'The destination agent receives a fresh context window initialized with the preceding task summary and command outputs, resolving context saturation from the previous session.',
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
            label: 'Watch Guide Source Matrix & Boundaries',
            url: 'https://github.com/can4hou6joeng4/Watch/blob/main/docs/guide-source-matrix-2026-09-17.md',
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
];
