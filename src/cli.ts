#!/usr/bin/env node
/**
 * CLI 入口只做 Node 版本门槛。
 * 低于 22.13 时 `node:sqlite` 不可用，直接加载主实现会在模块加载期抛
 * ERR_UNKNOWN_BUILTIN_MODULE，桌面端只能把 tsx 的原始 stderr 原样展示给用户。
 */
import { optionArgs } from './core/cli-commands.js';
import { exitOnBrokenPipe } from './core/broken-pipe.js';
import { nodeVersionProblem } from './core/node-version.js';

// 管道下游提前关闭（`watch prompt | head`）不是命令失败：安静退出，不打印 EPIPE 堆栈。
// 必须在任何输出之前安装，版本门槛那两行也可能撞上已关闭的下游。
exitOnBrokenPipe([process.stdout, process.stderr]);

const problem = nodeVersionProblem(process.versions.node);
if (problem) {
  // 与主实现相同的 --json 契约：单行 { ok:false, error }，诊断走 stderr
  if (optionArgs(process.argv.slice(2)).includes('--json')) console.log(JSON.stringify({ ok: false, error: problem }));
  else console.error(`[watch] ${problem}`);
  process.exit(1);
}

await import('./cli-main.js');
