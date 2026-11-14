import { formatCommandArgv } from '../../core/command-argv.js';
import { escapeControlChars } from '../../core/display.js';
import { asJsonObject } from '../../core/jsonl.js';
import { pushEvent, WATCH_CONTEXT_DISCLOSURE_PREFIX } from '../../core/rich.js';
import type { ProcessEvent, UnifiedTurn } from '../../core/types.js';
import { codexMediaPlaceholder, codexMediaRefFromContentItem } from './media.js';

/** 对齐 ToolName::is_default_namespace 与 MCP 的 join_tool_name。 */
export function codexToolName(name: string, namespace: unknown): string {
  if (typeof namespace !== 'string' || !namespace || namespace === 'functions') return name;
  const prefix = `${namespace.replace(/_+$/, '')}__`;
  return name.startsWith(prefix) ? name : prefix + name.replace(/^_+/, '');
}

export function codexLabel(value: string, limit = 120): string {
  const escaped = escapeControlChars(value);
  return escaped.length > limit ? `${escaped.slice(0, limit)}…` : escaped;
}

export function addCount(counts: Map<string, number>, type: unknown): void {
  const key = typeof type === 'string' && type ? type : '（空类型）';
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** 清单有界展示，省略种类显式计数；未知类型名不能把控制字符带进终端。 */
export function codexTypeCounts(counts: Map<string, number>): string {
  const entries = [...counts];
  const shown = entries.slice(0, 8).map(([type, n]) => `${codexLabel(type, 60)}×${n}`);
  if (entries.length > 8) shown.push(`另有 ${entries.length - 8} 种`);
  return shown.join('、');
}

export type CodexOutputProjection = {
  text: string;
  images: number;
  audio: number;
  encrypted: number;
  unknown: Map<string, number>;
};

/** 工具输出只投影文字与占位；媒体载荷不伪装成可携带的 attachment。 */
export function codexToolOutputText(output: unknown): CodexOutputProjection {
  const result: CodexOutputProjection = { text: '', images: 0, audio: 0, encrypted: 0, unknown: new Map() };
  const project = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return asJsonObject(value) ? JSON.stringify(value) : '';
    return value.map((item) => {
      if (typeof item === 'string') return item;
      const b = asJsonObject(item);
      if (!b) {
        addCount(result.unknown, '（非对象内容块）');
        return '（非对象内容块）';
      }
      if (b.type === 'input_image' || b.type === 'input_audio') {
        const media = b.type === 'input_image' ? 'image' : 'audio';
        if (media === 'image') result.images += 1;
        else result.audio += 1;
        return codexMediaPlaceholder(codexMediaRefFromContentItem(b, media)!, media);
      }
      if (b.type === 'encrypted_content') {
        result.encrypted += 1;
        return '[工具输出包含加密内容，Watch 读不到明文]';
      }
      if (b.type === 'input_text' || b.type === 'output_text' || b.type === 'text' || b.type === undefined) {
        if (typeof b.text === 'string') return b.text.trim() ? b.text : '';
        if (b.type === undefined && 'content' in b) return project(b.content);
      }
      addCount(result.unknown, b.type);
      return `[未识别的工具输出内容项：${codexLabel(typeof b.type === 'string' ? b.type : '（空类型）', 60)}]`;
    }).filter(text => text.trim()).join('\n');
  };
  result.text = project(output);
  return result;
}

/** 只读取命令 argv；action.env / user / working_directory 不进入交接产物。 */
export function localShellCommand(action: unknown): string {
  const a = asJsonObject(action);
  if (a?.type !== 'exec' || !Array.isArray(a.command) || !a.command.length || !a.command.every(v => typeof v === 'string')) return '';
  return formatCommandArgv(a.command as string[]);
}

export function webSearchDetail(p: Record<string, unknown>): string {
  const a = asJsonObject(p.action);
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && Boolean(v.trim())) : [];
  let detail = '';
  if (a?.type === 'search') {
    const queries = [...new Set([...(typeof a.query === 'string' && a.query.trim() ? [a.query] : []), ...strings(a.queries)])];
    if (queries.length) detail = `查询：${queries.join('；')}`;
  } else if (a?.type === 'open_page' && typeof a.url === 'string') detail = `打开页面：${a.url}`;
  else if (a?.type === 'find_in_page') detail = `页内查找：${typeof a.pattern === 'string' ? a.pattern : '（未记录关键词）'}；页面：${typeof a.url === 'string' ? a.url : '（未记录）'}`;
  if (!detail && typeof p.query === 'string' && p.query.trim()) detail = `查询：${p.query}`;
  const status = typeof p.status === 'string' && p.status !== 'completed' ? `\n状态：${codexLabel(p.status)}` : '';
  return `[Codex 网页搜索] ${detail || '日志没有记录具体动作'}${status}\n日志未记录可交接的搜索结果。`;
}

export function imageGenerationNote(p: Record<string, unknown>): string {
  const raw = typeof p.result === 'string' ? p.result : '';
  const format = raw.startsWith('iVBORw0KGgo') ? 'PNG' : raw.startsWith('R0lGOD') ? 'GIF' : raw.startsWith('/9j/') ? 'JPEG' : raw.startsWith('UklGR') ? 'WebP' : '未知格式';
  const bytes = Math.max(0, Math.floor(raw.length * 3 / 4) - (raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0));
  const status = typeof p.status === 'string' ? codexLabel(p.status) : '未记录';
  const prompt = typeof p.revised_prompt === 'string' && p.revised_prompt.trim() ? `\n修订提示词：${p.revised_prompt}` : '';
  return `[Codex 图片生成] 状态：${status}${prompt}\n${raw ? `[图片：${format}，约 ${bytes} 字节；只保留占位，原始数据没有并入交接]` : '日志未记录图片数据。'}`;
}

type PendingNote = { event: ProcessEvent; index: number; turn?: UnifiedTurn; placement: 'before' | 'turn' };

/** 文本标记不能在空正文助手轮上变成伪造的答复，也不能随新增尾轮搬迁。 */
export class CodexItemNotes {
  private readonly pending: PendingNote[] = [];
  constructor(private readonly turns: UnifiedTurn[]) {}

  add(event: ProcessEvent, placement: 'before' | 'turn'): void {
    const last = this.turns.at(-1);
    if (placement === 'turn' && last?.role === 'assistant') {
      pushEvent(last, event);
      this.pending.push({ event, placement, index: this.turns.length - 1, turn: last });
    } else this.pending.push({ event, placement, index: placement === 'before' ? this.turns.length - 1 : this.turns.length });
  }

  finish(): void {
    if (!this.pending.length || !this.turns.length) return;
    const first = this.turns.find(t => t.role === 'user' || t.text.trim());
    if (!first) throw new Error('Codex 过程记录没有用户消息或非空助手正文可安全保留标记，请在来源文件中核对。');
    let assistant: UnifiedTurn | undefined;
    let user: UnifiedTurn | undefined;
    const carriers = this.turns.map(t => {
      if (t.role === 'assistant' && t.text.trim()) assistant = t;
      if (t.role === 'user') user = t;
      return assistant ?? user;
    });
    const prepend = new Map<UnifiedTurn, ProcessEvent[]>();
    for (const { event, index, turn, placement } of this.pending) {
      if (turn?.text.trim()) continue; // 已在本轮原位置；终稿存在时不搬动。
      if (turn) turn.events = turn.events?.filter(e => e !== event);
      const next = this.turns[index];
      if (!turn && placement === 'turn' && next?.role === 'assistant' && next.text.trim()) {
        const list = prepend.get(next) ?? [];
        list.push(event);
        prepend.set(next, list);
      } else pushEvent(carriers[placement === 'before' ? index : index - 1] ?? first, event);
    }
    for (const [turn, events] of prepend) turn.events = [...events, ...(turn.events ?? [])];
  }
}

export function appendCodexDisclosure(turns: UnifiedTurn[], detail: string): void {
  const turn = [...turns].reverse().find(t => t.role === 'user' || t.text.trim()) ?? turns.at(-1);
  if (!turn || !detail) return;
  const text = `${WATCH_CONTEXT_DISCLOSURE_PREFIX}${detail}]`;
  pushEvent(turn, { kind: 'text', summary: text, detail: text, timestamp: turn.timestamp, provider: 'codex' });
}
