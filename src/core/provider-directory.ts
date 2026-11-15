import { statSync } from 'node:fs';
import path from 'node:path';
import { escapeControlChars } from './display.js';
import { describePathReadFailureReason } from './read-text.js';

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
  // 未建立的目录仍交给各 provider 的原有规则；已存在的非目录与访问失败不能冒充空历史。
  let info;
  try {
    info = statSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return dir;
    if (code === 'ENOTDIR') {
      throw new Error(
        `${name} 指向的路径有一级不是目录（被文件占住）：${escapeControlChars(dir)}；请修正 ${name} 或恢复该路径后重试`,
      );
    }
    throw new Error(
      `无法读取 ${name} 指向的路径 ${escapeControlChars(dir)}：${describePathReadFailureReason(error)}；请先恢复路径的可访问性后重试`,
    );
  }
  if (!info.isDirectory()) {
    throw new Error(
      `${name} 指向的不是目录：${escapeControlChars(dir)}；请将 ${name} 改为数据目录，或恢复该路径后重试`,
    );
  }
  return dir;
}

/**
 * 默认数据目录（没有显式环境变量时的位置）的路径类型检查。
 *
 * 与 `providerDirectoryFromEnv()` 同一判据，但用于不带变量名的默认根：
 * - `ENOENT` 视为首次使用，交给各 provider 的首次写入创建，检查本身不建目录；
 * - 被普通文件占住、祖先不是目录或读取失败都抛出中文原因，不能当成「没有会话」。
 *
 * 只读 stat，不承诺写权限，也不保证检查之后路径不再变化。
 */
export function assertDataDirectory(dir: string, label: string): void {
  let info;
  try {
    info = statSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (code === 'ENOTDIR') {
      throw new Error(`${label}有一级不是目录（被文件占住）：${escapeControlChars(dir)}；请先恢复目录或修正路径后重试`);
    }
    throw new Error(
      `无法读取 ${label} ${escapeControlChars(dir)}：${describePathReadFailureReason(error)}；请先恢复路径的可访问性后重试`,
    );
  }
  if (!info.isDirectory()) {
    throw new Error(`${label}不是目录（被文件占住）：${escapeControlChars(dir)}；请先恢复目录或修正路径后重试`);
  }
}
