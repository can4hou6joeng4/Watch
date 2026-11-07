import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface ImportRpc {
  request(method: string, params: unknown): Promise<unknown>;
  completion(importId: string): Promise<unknown>;
  close(): Promise<void>;
}

export type RpcProfile = 'import' | 'desktop-import' | 'project-binding';
const METHODS: Record<RpcProfile, Set<string>> = {
  import: new Set(['initialize', 'config/read', 'externalAgentConfig/detect', 'externalAgentConfig/import', 'thread/read']),
  'desktop-import': new Set([
    'initialize', 'config/read', 'externalAgentConfig/detect', 'externalAgentConfig/import',
    'project/read', 'thread/read', 'thread/list', 'thread/metadata/update',
  ]),
  'project-binding': new Set(['initialize', 'config/read', 'project/read', 'thread/read', 'thread/list', 'thread/metadata/update']),
};
const COMPLETED = 'externalAgentConfig/import/completed';
type Pending = { resolve(value: unknown): void; reject(error: Error): void };

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Codex 返回的响应结构不符合预期');
  return value as Record<string, unknown>;
}

/** Private stdio connection: never sends turns, approves tools, or retries writes. */
export class CodexImportRpc implements ImportRpc {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private completions = new Map<string, unknown>();
  private waiters = new Map<string, Pending>();
  private failure?: Error;
  private closed: Promise<void>;
  private lines;

  constructor(private child: ChildProcessWithoutNullStreams, private timeoutMs = 30_000, private profile: RpcProfile = 'import') {
    this.closed = new Promise((resolve) => child.once('close', () => {
      this.fail(new Error('Codex app-server 已退出'));
      resolve();
    }));
    child.once('error', () => this.fail(new Error('无法启动 Codex app-server')));
    child.stdin.on('error', () => this.fail(new Error('Codex 输入通道已关闭')));
    // Drain diagnostics without exposing native configuration or session text.
    child.stderr.resume();
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', (line) => this.receive(line));
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const entry of this.pending.values()) entry.reject(error);
    for (const entry of this.waiters.values()) entry.reject(error);
    this.pending.clear();
    this.waiters.clear();
  }

  private receive(line: string): void {
    try {
      const message = asRecord(JSON.parse(line));
      if (typeof message.method === 'string') {
        if (message.id !== undefined) {
          this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Watch refuses server requests' } }) + '\n');
        } else if (message.method === COMPLETED) {
          const result = asRecord(message.params);
          if (typeof result.importId !== 'string') throw new Error('Codex 没有返回导入 ID');
          const waiter = this.waiters.get(result.importId);
          if (waiter) {
            this.waiters.delete(result.importId);
            waiter.resolve(result);
          } else {
            if (this.completions.size >= 32) throw new Error('Codex 发来的导入通知过多');
            this.completions.set(result.importId, result);
          }
        }
        return;
      }
      if (typeof message.id !== 'number') return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error('Codex 拒绝了该请求；不要自动重试导入'));
      else entry.resolve(message.result);
    } catch {
      this.fail(new Error('Codex app-server 的响应无法解析'));
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (!METHODS[this.profile].has(method)) return Promise.reject(new Error('这次 Codex 操作不允许调用该方法'));
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex 请求超时'));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      } catch {
        this.fail(new Error('无法向 Codex 发送请求'));
      }
    });
  }

  completion(importId: string): Promise<unknown> {
    const cached = this.completions.get(importId);
    if (cached) {
      this.completions.delete(importId);
      return Promise.resolve(cached);
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.waiters.has(importId)) return Promise.reject(new Error('已经在等待这次导入的结果'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(importId);
        reject(new Error('等待导入完成超时，结果未知'));
      }, this.timeoutMs);
      this.waiters.set(importId, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'watch_session_import', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  }

  async close(): Promise<void> {
    this.fail(new Error('Importer closed'));
    this.lines.close();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
      const kill = setTimeout(() => this.child.kill('SIGKILL'), 2_000);
      await this.closed;
      clearTimeout(kill);
    } else {
      await this.closed;
    }
  }
}

export async function connectImportRpc(executable: string, cwd: string, env: NodeJS.ProcessEnv, profile: RpcProfile = 'import'): Promise<ImportRpc> {
  const rpc = new CodexImportRpc(spawn(executable, [
    '-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false',
    'app-server', '--listen', 'stdio://',
  ], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }), 30_000, profile);
  try {
    await rpc.initialize();
    return rpc;
  } catch (error) {
    await rpc.close();
    throw error;
  }
}
