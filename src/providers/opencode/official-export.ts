import { createHash } from 'node:crypto';
import path from 'node:path';
import { dedupeCallEvents, mergeConsecutiveAssistant } from '../../core/rich.js';
import type { ProcessEvent, TokenUsage, UnifiedTurn } from '../../core/types.js';

export const SUPPORTED_OPENCODE_EXPORT_VERSION = '1.18.29';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const NATIVE_ID = /^(ses|msg|prt)_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

type JsonRecord = Record<string, unknown>;

export type OfficialOpenCodeMessage = {
  info: JsonRecord & { id: string; sessionID: string; role: 'user' | 'assistant' };
  parts: Array<JsonRecord & { id: string; sessionID: string; messageID: string; type: string }>;
};

export type OfficialOpenCodeExport = {
  info: JsonRecord & {
    id: string;
    slug: string;
    projectID: string;
    directory: string;
    title: string;
    version: string;
    time: { created: number; updated: number };
  };
  messages: OfficialOpenCodeMessage[];
};

export type OfficialOpenCodeExportSummary = {
  sessionId: string;
  version: string;
  directory: string;
  targetModel: OpenCodeTargetModel;
  messages: number;
  parts: number;
  users: number;
  assistants: number;
  partTypes: Record<string, number>;
};

export type OpenCodeTargetModel = {
  providerID: string;
  modelID: string;
  variant?: string;
};

type BuildOptions = {
  seed: string;
  sourceProvider: string;
  targetModel: OpenCodeTargetModel;
  version?: string;
  sessionId?: string;
};

function modelIdentifier(value: unknown, label: string, allowSlash: boolean): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.trim() !== value) {
    throw new Error(`OpenCode 的 ${label} 不合法`);
  }
  if (/\s|[\u0000-\u001f\u007f]/u.test(value) || (!allowSlash && value.includes('/'))) {
    throw new Error(`OpenCode 的 ${label} 不合法`);
  }
  return value;
}

export function normalizeOpenCodeTargetModel(value: OpenCodeTargetModel): OpenCodeTargetModel {
  const providerID = modelIdentifier(value?.providerID, 'target provider ID', false);
  const modelID = modelIdentifier(value?.modelID, 'target model ID', true);
  const variant = value?.variant === undefined
    ? undefined
    : modelIdentifier(value.variant, 'target model variant', true);
  return { providerID, modelID, ...(variant ? { variant } : {}) };
}

function deterministicId(
  prefix: 'ses' | 'msg' | 'prt',
  timeMs: number,
  sequence: number,
  seed: string,
  descending = false,
): string {
  const current = BigInt(Math.floor(Math.max(0, timeMs))) * 0x1000n + BigInt(sequence % 0x1000);
  const packed = descending ? ~current : current;
  const hex = (packed & 0xffffffffffffn).toString(16).padStart(12, '0');
  const bytes = createHash('sha256').update(`${seed}:${prefix}:${sequence}`).digest().subarray(0, 14);
  let suffix = '';
  for (const byte of bytes) suffix += BASE62[byte % BASE62.length];
  return `${prefix}_${hex}${suffix}`;
}

export function createOfficialOpenCodeSessionId(seed: string, createdAt: number): string {
  if (!seed) throw new Error('OpenCode 导出需要 ID 种子（seed）');
  return deterministicId('ses', createdAt, 1, seed, true);
}

function timestamp(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function inputRecord(value: unknown): JsonRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord;
  return value === undefined ? {} : { value };
}

function tokenShape(usage?: TokenUsage): JsonRecord {
  const input = Number.isFinite(usage?.inputTokens) ? Math.max(0, usage!.inputTokens) : 0;
  const output = Number.isFinite(usage?.outputTokens) ? Math.max(0, usage!.outputTokens) : 0;
  return { total: input + output, input, output, reasoning: 0, cache: { read: 0, write: 0 } };
}

function attachmentPart(event: ProcessEvent): JsonRecord | null {
  const attachment = event.attachment;
  if (!attachment) return null;
  const mime = attachment.mediaType ?? 'application/octet-stream';
  const url = attachment.data
    ? `data:${mime};base64,${attachment.data}`
    : attachment.url;
  if (!url) return null;
  return {
    type: 'file',
    mime,
    url,
    ...(attachment.filename ? { filename: attachment.filename } : {}),
  };
}

function eventParts(events: ProcessEvent[], baseTime: number): JsonRecord[] {
  const parts: JsonRecord[] = [];
  const pending = new Map<string, JsonRecord>();

  for (const [index, event] of events.entries()) {
    const at = Math.max(baseTime + index + 1, timestamp(event.timestamp, baseTime + index + 1));
    const attachment = attachmentPart(event);
    if (attachment) {
      parts.push(attachment);
      continue;
    }
    if (event.kind === 'thinking') {
      parts.push({ type: 'reasoning', text: event.detail ?? event.summary ?? '', time: { start: at, end: at + 1 } });
      continue;
    }
    if (event.kind === 'text') {
      const value = event.detail ?? event.summary ?? '';
      if (value) parts.push({ type: 'text', text: value, synthetic: true, time: { start: at, end: at + 1 } });
      continue;
    }
    const callID = event.callId || `watch-call-${index}`;
    if (event.kind === 'tool_call') {
      const part: JsonRecord = {
        type: 'tool', callID, tool: event.name ?? 'tool',
        state: {
          status: 'error', input: inputRecord(event.input),
          error: '工具结果在迁移时不可用', metadata: {}, time: { start: at, end: at + 1 },
        },
      };
      parts.push(part);
      pending.set(callID, part);
      continue;
    }

    const matched = pending.get(callID);
    if (matched) {
      const state = matched.state as JsonRecord;
      matched.state = {
        status: 'completed', input: state.input ?? {}, output: text(event.detail ?? event.summary),
        title: typeof matched.tool === 'string' ? matched.tool : 'tool',
        metadata: {}, time: { start: (state.time as JsonRecord | undefined)?.start ?? at, end: at + 1 },
      };
      pending.delete(callID);
    } else {
      parts.push({
        type: 'tool', callID, tool: event.name ?? 'tool',
        state: {
          status: 'completed', input: {}, output: text(event.detail ?? event.summary),
          title: event.name ?? 'tool', metadata: {}, time: { start: at, end: at + 1 },
        },
      });
    }
  }
  return parts;
}

function assistantInfo(
  id: string,
  sessionID: string,
  parentID: string,
  cwd: string,
  created: number,
  completed: number,
  finish: string,
  targetModel: OpenCodeTargetModel,
  usage?: TokenUsage,
): OfficialOpenCodeMessage['info'] {
  return {
    id, sessionID, role: 'assistant', parentID,
    time: { created, completed },
    modelID: targetModel.modelID, providerID: targetModel.providerID, mode: 'build', agent: 'build',
    path: { cwd, root: path.parse(cwd).root },
    cost: 0, tokens: tokenShape(usage), ...(targetModel.variant ? { variant: targetModel.variant } : {}), finish,
  };
}

function partEndTime(part: JsonRecord, fallback: number): number {
  const own = part.time;
  if (own && typeof own === 'object' && !Array.isArray(own)) {
    const end = (own as JsonRecord).end;
    if (typeof end === 'number' && Number.isFinite(end)) return end;
  }
  const state = part.state;
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const time = (state as JsonRecord).time;
    if (time && typeof time === 'object' && !Array.isArray(time)) {
      const end = (time as JsonRecord).end;
      if (typeof end === 'number' && Number.isFinite(end)) return end;
    }
  }
  return fallback;
}

export function buildOfficialOpenCodeExport(
  inputTurns: UnifiedTurn[],
  cwd: string,
  options: BuildOptions,
): OfficialOpenCodeExport {
  if (!path.isAbsolute(cwd)) throw new Error('OpenCode 官方导出需要绝对路径的 cwd');
  if (!options.seed || !options.sourceProvider) throw new Error('OpenCode 官方导出需要来源身份（seed 与来源 provider）');
  const targetModel = normalizeOpenCodeTargetModel(options.targetModel);
  const turns = mergeConsecutiveAssistant(dedupeCallEvents(inputTurns));
  if (turns[0]?.role !== 'user') throw new Error('OpenCode 官方导出不能以 assistant 轮开始');
  if (!turns.some((turn) => turn.role === 'user')) throw new Error('OpenCode 官方导出需要至少一轮 user');

  const firstTime = timestamp(turns[0]!.timestamp, 0);
  const sessionID = options.sessionId ?? createOfficialOpenCodeSessionId(options.seed, firstTime);
  if (!NATIVE_ID.test(sessionID) || !sessionID.startsWith('ses_')) throw new Error('OpenCode 目标会话 ID 不合法');

  const messages: OfficialOpenCodeMessage[] = [];
  let sequence = 1;
  let lastTime = Math.max(0, firstTime - 1);
  let lastUserID = '';
  const nextId = (prefix: 'msg' | 'prt', at: number) => deterministicId(prefix, at, sequence++, `${options.seed}:${sessionID}`);
  const attachParts = (
    messageID: string,
    raw: JsonRecord[],
    start: number,
  ): OfficialOpenCodeMessage['parts'] => raw.map((part, index) => {
    if (typeof part.type !== 'string') throw new Error('OpenCode 导出缺少 part 类型');
    return {
      ...part,
      type: part.type,
      id: nextId('prt', start + index + 1), sessionID, messageID,
    };
  });

  for (const turn of turns) {
    const created = Math.max(lastTime + 1, timestamp(turn.timestamp, lastTime + 1));
    lastTime = created;
    if (turn.role === 'user') {
      const id = nextId('msg', created);
      lastUserID = id;
      const rawParts: JsonRecord[] = [{ type: 'text', text: turn.text, time: { start: created, end: created + 1 } }];
      for (const event of turn.events ?? []) {
        const attachment = attachmentPart(event);
        if (attachment) {
          rawParts.push(attachment);
        } else if (event.kind === 'text') {
          const value = event.detail ?? event.summary ?? '';
          if (value) rawParts.push({ type: 'text', text: value, synthetic: true });
        } else {
          throw new Error(`OpenCode 官方导出不支持 user 轮里的 ${event.kind} 事件`);
        }
      }
      messages.push({
        info: {
          id, sessionID, role: 'user', time: { created }, agent: 'build',
          model: targetModel,
          summary: { diffs: [] },
        },
        parts: attachParts(id, rawParts, created),
      });
      continue;
    }
    if (!lastUserID) throw new Error('OpenCode assistant 轮没有对应的 user 消息');

    const events = turn.events ?? [];
    const richParts = eventParts(events, created);
    const hasTool = richParts.some((part) => part.type === 'tool');
    const addAssistant = (rawParts: JsonRecord[], finish: string, usage?: TokenUsage) => {
      const id = nextId('msg', lastTime);
      const latestPart = rawParts.reduce((latest, part) => Math.max(latest, partEndTime(part, lastTime)), lastTime);
      const completed = Math.max(lastTime + Math.max(2, rawParts.length + 1), latestPart + 1);
      messages.push({
        info: assistantInfo(id, sessionID, lastUserID, cwd, lastTime, completed, finish, targetModel, usage),
        parts: attachParts(id, [
          { type: 'step-start' }, ...rawParts,
          { type: 'step-finish', reason: finish, cost: 0, tokens: tokenShape(usage) },
        ], lastTime),
      });
      lastTime = completed;
    };

    if (hasTool) {
      addAssistant(richParts, 'tool-calls', turn.text.trim() ? undefined : turn.usage);
      if (turn.text.trim()) {
        lastTime += 1;
        addAssistant([{ type: 'text', text: turn.text, time: { start: lastTime, end: lastTime + 1 } }], 'stop', turn.usage);
      }
    } else {
      const raw = [...richParts];
      if (turn.text.trim()) raw.push({ type: 'text', text: turn.text, time: { start: created, end: created + 1 } });
      addAssistant(raw, 'stop', turn.usage);
    }
  }

  const result: OfficialOpenCodeExport = {
    info: {
      id: sessionID,
      slug: `watch-${sessionID.slice(-8).toLowerCase()}`,
      projectID: 'global',
      directory: cwd,
      title: `Imported from ${options.sourceProvider}`,
      version: options.version ?? SUPPORTED_OPENCODE_EXPORT_VERSION,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: firstTime, updated: Math.max(firstTime, lastTime) },
    },
    messages,
  };
  inspectOfficialOpenCodeExport(result);
  return result;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`OpenCode 导出字段不合法：${label}`);
  return value as JsonRecord;
}

function stringField(row: JsonRecord, key: string, label: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`OpenCode 导出字段不合法：${label}`);
  return value;
}

function optionalStringField(row: JsonRecord, key: string, label: string): void {
  if (row[key] !== undefined && typeof row[key] !== 'string') throw new Error(`OpenCode 导出字段不合法：${label}`);
}

function optionalBooleanField(row: JsonRecord, key: string, label: string): void {
  if (row[key] !== undefined && typeof row[key] !== 'boolean') throw new Error(`OpenCode 导出字段不合法：${label}`);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`OpenCode 导出字段不合法：${label}`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (!Number.isInteger(number) || number < 0) throw new Error(`OpenCode 导出字段不合法：${label}`);
  return number;
}

function nonNegativeFinite(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (number < 0) throw new Error(`OpenCode 导出字段不合法：${label}`);
  return number;
}

function validateTime(
  value: unknown,
  label: string,
  options: { end?: 'required' | 'optional'; createdOnly?: boolean } = {},
): JsonRecord {
  const time = record(value, `${label} time`);
  if (options.createdOnly) {
    nonNegativeFinite(time.created, `${label} created time`);
    return time;
  }
  nonNegativeInteger(time.start, `${label} start time`);
  if (options.end === 'required') nonNegativeInteger(time.end, `${label} end time`);
  if (options.end === 'optional' && time.end !== undefined) nonNegativeInteger(time.end, `${label} end time`);
  return time;
}

function validateTokens(value: unknown, label: string): void {
  const tokens = record(value, `${label} tokens`);
  if (tokens.total !== undefined) finiteNumber(tokens.total, `${label} total tokens`);
  finiteNumber(tokens.input, `${label} input tokens`);
  finiteNumber(tokens.output, `${label} output tokens`);
  finiteNumber(tokens.reasoning, `${label} reasoning tokens`);
  const cache = record(tokens.cache, `${label} cache tokens`);
  finiteNumber(cache.read, `${label} cache read tokens`);
  finiteNumber(cache.write, `${label} cache write tokens`);
}

/** Validate Watch's strict v1.18.29 export subset and all cross-record references. */
export function inspectOfficialOpenCodeExport(value: unknown): OfficialOpenCodeExportSummary {
  const root = record(value, 'root');
  const info = record(root.info, 'session info');
  const sessionId = info.id;
  if (typeof sessionId !== 'string' || !NATIVE_ID.test(sessionId) || !sessionId.startsWith('ses_')) {
    throw new Error('OpenCode 导出的会话 ID 不合法');
  }
  if (info.version !== SUPPORTED_OPENCODE_EXPORT_VERSION || typeof info.directory !== 'string' || !path.isAbsolute(info.directory)) {
    throw new Error('不支持的 OpenCode 导出格式版本或目录');
  }
  stringField(info, 'slug', 'session slug');
  stringField(info, 'projectID', 'session project ID');
  stringField(info, 'title', 'session title');
  optionalStringField(info, 'path', 'session path');
  optionalStringField(info, 'agent', 'session agent');
  if (info.cost !== undefined) finiteNumber(info.cost, 'session cost');
  if (info.tokens !== undefined) validateTokens(info.tokens, 'session');
  if (info.model !== undefined) {
    const model = record(info.model, 'session model');
    stringField(model, 'id', 'session model ID');
    stringField(model, 'providerID', 'session model provider ID');
    optionalStringField(model, 'variant', 'session model variant');
  }
  const sessionTime = record(info.time, 'session time');
  const sessionCreated = nonNegativeInteger(sessionTime.created, 'session created time');
  const sessionUpdated = nonNegativeInteger(sessionTime.updated, 'session updated time');
  if (sessionUpdated < sessionCreated) throw new Error('OpenCode 导出的会话时间线不合法');
  if (!Array.isArray(root.messages) || root.messages.length === 0) throw new Error('OpenCode 导出里没有任何消息');

  const ids = new Set<string>([sessionId]);
  const messageIds = new Set<string>();
  const partTypes: Record<string, number> = {};
  let users = 0;
  let assistants = 0;
  let parts = 0;
  let lastUser = '';
  let targetModel: OpenCodeTargetModel | undefined;
  const bindTargetModel = (candidate: OpenCodeTargetModel) => {
    const normalized = normalizeOpenCodeTargetModel(candidate);
    if (targetModel && (
      targetModel.providerID !== normalized.providerID ||
      targetModel.modelID !== normalized.modelID ||
      targetModel.variant !== normalized.variant
    )) {
      throw new Error('OpenCode 导出里的消息使用了不一致的目标模型');
    }
    targetModel = normalized;
  };

  for (const item of root.messages) {
    const message = record(item, 'message');
    const messageInfo = record(message.info, 'message info');
    const id = messageInfo.id;
    if (typeof id !== 'string' || !NATIVE_ID.test(id) || !id.startsWith('msg_') || ids.has(id)) {
      throw new Error('OpenCode 消息 ID 无效或重复');
    }
    if (messageInfo.sessionID !== sessionId) throw new Error('OpenCode 消息指向了另一个会话');
    ids.add(id);
    messageIds.add(id);
    if (messageInfo.role === 'user') {
      users += 1;
      lastUser = id;
      const model = record(messageInfo.model, 'user model');
      const providerID = stringField(model, 'providerID', 'user model provider ID');
      const modelID = stringField(model, 'modelID', 'user model ID');
      optionalStringField(model, 'variant', 'user model variant');
      bindTargetModel({ providerID, modelID, ...(typeof model.variant === 'string' ? { variant: model.variant } : {}) });
      validateTime(messageInfo.time, 'user message', { createdOnly: true });
      stringField(messageInfo, 'agent', 'user message agent');
      optionalStringField(messageInfo, 'system', 'user message system prompt');
      if (messageInfo.summary !== undefined) {
        const summary = record(messageInfo.summary, 'user summary');
        optionalStringField(summary, 'title', 'user summary title');
        optionalStringField(summary, 'body', 'user summary body');
        if (!Array.isArray(summary.diffs)) throw new Error('OpenCode 导出的 user 摘要 diffs 不合法');
      }
    } else if (messageInfo.role === 'assistant') {
      assistants += 1;
      if (!lastUser || messageInfo.parentID !== lastUser) throw new Error('OpenCode assistant 的父消息不合法');
      validateTokens(messageInfo.tokens, 'assistant');
      const assistantPath = record(messageInfo.path, 'assistant path');
      stringField(assistantPath, 'cwd', 'assistant cwd');
      stringField(assistantPath, 'root', 'assistant root');
      const assistantTime = record(messageInfo.time, 'assistant time');
      const assistantCreated = nonNegativeInteger(assistantTime.created, 'assistant created time');
      if (assistantTime.completed !== undefined) {
        const assistantCompleted = nonNegativeInteger(assistantTime.completed, 'assistant completed time');
        if (assistantCompleted < assistantCreated) throw new Error('OpenCode 导出的 assistant 时间线不合法');
      }
      for (const field of ['modelID', 'providerID', 'mode', 'agent'] as const) {
        if (typeof messageInfo[field] !== 'string') throw new Error(`OpenCode assistant 缺少 ${field}`);
      }
      finiteNumber(messageInfo.cost, 'assistant cost');
      optionalStringField(messageInfo, 'variant', 'assistant variant');
      optionalStringField(messageInfo, 'finish', 'assistant finish');
      bindTargetModel({
        providerID: String(messageInfo.providerID),
        modelID: String(messageInfo.modelID),
        ...(typeof messageInfo.variant === 'string' ? { variant: messageInfo.variant } : {}),
      });
    } else {
      throw new Error('不支持的 OpenCode 消息角色');
    }
    if (!Array.isArray(message.parts)) throw new Error('OpenCode 消息的 parts 必须是数组');
    for (const rawPart of message.parts) {
      const part = record(rawPart, 'part');
      const partId = part.id;
      if (typeof partId !== 'string' || !NATIVE_ID.test(partId) || !partId.startsWith('prt_') || ids.has(partId)) {
        throw new Error('OpenCode 片段（part）ID 无效或重复');
      }
      if (part.sessionID !== sessionId || part.messageID !== id || !messageIds.has(id)) {
        throw new Error('OpenCode 的 part 引用不合法');
      }
      if (typeof part.type !== 'string') throw new Error('OpenCode 缺少 part 类型');
      if (part.type === 'text') {
        if (typeof part.text !== 'string') throw new Error('OpenCode 的 text part 不完整');
        optionalBooleanField(part, 'synthetic', 'text synthetic flag');
        optionalBooleanField(part, 'ignored', 'text ignored flag');
        if (part.time !== undefined) validateTime(part.time, 'text part', { end: 'optional' });
      } else if (part.type === 'reasoning') {
        if (typeof part.text !== 'string') throw new Error('OpenCode 的 reasoning part 不完整');
        validateTime(part.time, 'reasoning part', { end: 'optional' });
      } else if (part.type === 'file') {
        if (typeof part.mime !== 'string' || typeof part.url !== 'string') throw new Error('OpenCode 的 file part 不完整');
        optionalStringField(part, 'filename', 'file part filename');
      } else if (part.type === 'tool') {
        if (typeof part.callID !== 'string' || typeof part.tool !== 'string') throw new Error('OpenCode 的 tool part 不完整');
        if (part.metadata !== undefined) record(part.metadata, 'tool metadata');
        const state = record(part.state, 'tool state');
        record(state.input, 'tool input');
        if (state.status === 'completed') {
          if (typeof state.output !== 'string' || typeof state.title !== 'string') throw new Error('已完成的 OpenCode 工具状态不完整');
          record(state.metadata, 'tool metadata');
          validateTime(state.time, 'completed tool', { end: 'required' });
        } else if (state.status === 'error') {
          if (typeof state.error !== 'string') throw new Error('失败的 OpenCode 工具状态不完整');
          if (state.metadata !== undefined) record(state.metadata, 'failed tool metadata');
          validateTime(state.time, 'failed tool', { end: 'required' });
        } else {
          throw new Error('不支持的 OpenCode 工具状态');
        }
      } else if (part.type === 'step-finish') {
        if (typeof part.reason !== 'string') throw new Error('OpenCode 的 step finish 不完整');
        finiteNumber(part.cost, 'step finish cost');
        validateTokens(part.tokens, 'step finish');
        optionalStringField(part, 'snapshot', 'step finish snapshot');
      } else if (part.type === 'step-start') {
        optionalStringField(part, 'snapshot', 'step start snapshot');
      } else {
        throw new Error(`不支持的 Watch OpenCode part 类型：${part.type}`);
      }
      ids.add(partId);
      parts += 1;
      partTypes[part.type] = (partTypes[part.type] ?? 0) + 1;
    }
  }
  if (users === 0) throw new Error('OpenCode 导出需要至少一条 user 消息');
  if (!targetModel) throw new Error('OpenCode 导出缺少目标模型');
  return {
    sessionId,
    version: String(info.version),
    directory: String(info.directory),
    targetModel,
    messages: root.messages.length,
    parts,
    users,
    assistants,
    partTypes,
  };
}
