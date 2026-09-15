import { homedir } from 'node:os';
import path from 'node:path';

export function opencodeDbPath(): string {
  if (process.env.WATCH_OPENCODE_DB) return process.env.WATCH_OPENCODE_DB;
  return path.join(opencodeNativeDataRoot(), 'opencode.db');
}

export function opencodeSessionsRoot(): string {
  return path.dirname(opencodeDbPath());
}

/** Data root used by the real OpenCode CLI; WATCH_OPENCODE_DB is Watch-only. */
export function opencodeNativeDataRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(dataHome, 'opencode');
}
