#!/usr/bin/env node
/**
 * CLI 入口只做 Node 版本门槛。
 * 低于 22.13 时 `node:sqlite` 不可用，直接加载主实现会在模块加载期抛
 * ERR_UNKNOWN_BUILTIN_MODULE，桌面端只能把 tsx 的原始 stderr 原样展示给用户。
 */
import { nodeVersionProblem } from './core/node-version.js';

const problem = nodeVersionProblem(process.versions.node);
if (problem) {
  // 与主实现相同的 --json 契约：单行 { ok:false, error }，诊断走 stderr
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: problem }));
  else console.error(`[watch] ${problem}`);
  process.exit(1);
}

await import('./cli-main.js');
