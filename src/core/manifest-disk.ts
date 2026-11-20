import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { WorkManifest } from './work-manifest.js';

/**
 * 「改动概览」的磁盘对照：会话里写过的那些文件，**现在**还在不在。
 *
 * 为什么值得做：清单只说明「这条会话写过 src/a.ts」，而读文档的人要接着改代码。
 * 如果那个文件已经被删除 / 改名 / 移动（或者这份记录来自另一台机器，路径只是同名的巧合），
 * 清单会把他直接引到一个不存在的文件上；反过来，「清单里没有」也不能被读成「磁盘上没有」
 * ——会话可能只跑过命令。同类工具（baton、deja-vu）给的也是静态清单，这一步是 Watch 的补充。
 *
 * 口径（与「读不出来 ≠ 没有」同一条规则）：
 * - 只核对**会话目录之内**的路径。会话记录的 cwd 现在不可用时整件事都不做，返回 `null`：
 *   拿一个进不去的目录去 stat，只会得到一堆假的「不在」。
 * - 工具参数里写的是**绝对路径**且 `lstat` 报 ENOENT / ENOTDIR → `missing`（确定不在那里）。
 * - 相对路径没找到 → `unverified`：工具可能在自己的子目录里写（Codex 的 `workdir`）、
 *   补丁可能在子目录里应用，会话目录只是默认位置，说「已删除」就是替它猜。
 * - 其它 stat 错误（EACCES / ELOOP / 名称过长…）一律 `unverified`：读不出来不等于没有。
 * - `Delete File` / `Move` 的源路径按定义就不该还在，不参与核对（否则每条删除都变成假警告）。
 * - 会话目录之外的绝对路径不核对（`outside`）：那是另一棵树，可能属于另一台机器。
 *
 * 只用 `lstat`：不跟随符号链接，也不读内容——这份产物是交接文档，不需要、也不该去碰文件内容。
 */

export type ManifestDiskState = 'missing' | 'unverified';

export type ManifestDiskReport = {
  /** 真正做了核对的条数（不含 removed / outside） */
  checked: number;
  /** 确定不在磁盘上的条数 */
  missing: number;
  /** 无法确认的条数 */
  unverified: number;
  /** 会话目录之外、没有核对的条数 */
  outside: number;
  /** 补丁按定义移除、因而不核对的条数（删除 / 移动的源） */
  removed: number;
  /** 路径（与 `manifest.files[].path` 同一个归一化形式）→ 结论；只含被标注的路径 */
  states: Map<string, ManifestDiskState>;
};

/**
 * 核对清单里的文件。
 *
 * `cwdUsable` 由调用方给（它已经为文档头部探测过一次会话目录）：这里不重复探测，
 * 也不在目录不可用时返回「全部不在」——那是把「查不了」讲成「没有」。
 */
export async function inspectManifestFilesOnDisk(
  manifest: WorkManifest,
  cwd: string,
  cwdUsable: boolean,
): Promise<ManifestDiskReport | null> {
  if (manifest.files.length === 0) return null;
  if (!cwdUsable || !cwd.trim() || !path.isAbsolute(cwd)) return null;

  const report: ManifestDiskReport = { checked: 0, missing: 0, unverified: 0, outside: 0, removed: 0, states: new Map() };
  const probes = new Map(manifest.diskProbes.map((probe) => [probe.path, probe]));

  for (const file of manifest.files) {
    const probe = probes.get(file.path);
    if (probe?.removed) {
      report.removed += 1;
      continue;
    }
    // 绝对路径只在 cwd 之内才核对；`files[].path` 本身是绝对的，说明它归一化不掉。
    if (path.isAbsolute(file.path)) {
      report.outside += 1;
      continue;
    }
    if (file.path === '..' || file.path.startsWith(`..${path.sep}`)) {
      report.outside += 1;
      continue;
    }
    report.checked += 1;
    const absolute = probe?.absolute === true;
    try {
      await lstat(path.join(cwd, file.path));
      continue;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 工具参数里写的是绝对路径：ENOENT 就是「那个路径现在没有东西」。
      // 相对路径则可能是写在了子目录里，只能算「没找到」。
      if (absolute && (code === 'ENOENT' || code === 'ENOTDIR')) {
        report.missing += 1;
        report.states.set(file.path, 'missing');
      } else {
        report.unverified += 1;
        report.states.set(file.path, 'unverified');
      }
    }
  }

  // 一条都没核对过、也没有可说明的旁证时不给结论：正文里多一句「0 个没能核对」只会让人以为查过了。
  // `outside` 单独计数也算有内容——「有几条在会话目录之外、根本没查」本身就是要披露的事实。
  return report.checked === 0 && report.removed === 0 && report.outside === 0
    ? null
    : report;
}

/** `--json` 用的可序列化摘要（`states` 是 Map，不直接进 JSON）。 */
export function summarizeManifestDisk(report: ManifestDiskReport): Omit<ManifestDiskReport, 'states'> {
  return {
    checked: report.checked,
    missing: report.missing,
    unverified: report.unverified,
    outside: report.outside,
    removed: report.removed,
  };
}
