import path from 'node:path';
import { escapeControlChars } from './display.js';

/**
 * 原生 CLI 可能从会话 cwd 启动，Watch 则可能在安装目录运行。
 * 相对目录不能由 Watch 自行绝对化，否则扫描、writer 锁和原生恢复会指向不同位置。
 * 只把未设置和空字符串当默认值；空白属于路径，不替原生进程 trim。
 * tildeHome 仅供原生明确支持展开 ~ 的 Pi 使用。
 */
export function providerDirectoryFromEnv(name: string, fallback: string, tildeHome?: string): string {
  const value = process.env[name];
  if (!value) return fallback;
  let dir = value;
  if (tildeHome !== undefined) {
    if (value === '~') dir = tildeHome;
    else if (value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\'))) {
      dir = path.join(tildeHome, value.slice(2));
    }
  }
  // Windows 的 \data 仍依赖当前盘符，无法在两个不同 cwd 之间固定同一目录。
  const currentDriveRoot = process.platform === 'win32' && /^[\\/](?![\\/])/.test(dir);
  if (!path.isAbsolute(dir) || currentDriveRoot) {
    throw new Error(
      `${name} 需要绝对路径，收到：${escapeControlChars(value)}；Watch 与原生 CLI 可能从不同工作目录启动，相对路径会指向不同的数据目录。请将 ${name} 改为完整绝对路径后重试`,
    );
  }
  return dir;
}
