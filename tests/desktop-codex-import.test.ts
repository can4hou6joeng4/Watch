import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSameCodexImportPlan,
  beginCodexOpen,
  completeCodexOpen,
  failCodexOpen,
  importedCodexThreadId,
  parseCodexImportResult,
  viewForCodexImportResult,
} from '../desktop/src/codex-import.js';

function response(status: 'prepared' | 'imported' | 'uncertain') {
  return {
    ok: status !== 'uncertain',
    planId: 'a'.repeat(64),
    status,
    canConfirm: status === 'prepared',
    desktop: status === 'prepared' ? 'project-first-preflight' : 'project-membership-and-visibility-preflight-verified',
    warnings: ['Tool records may become text.'],
    targetLockPath: '/tmp/codex/.watch-official-import.lock',
    plan: {
      source: { provider: 'claude', sessionId: '11111111-1111-4111-8111-111111111111', cwd: '/tmp/project', filePath: '/tmp/source.jsonl' },
      cliVersion: 'codex-cli 0.153.4',
      codexHome: '/tmp/codex',
      target: { path: '/tmp/codex' },
      desktopProject: {
        name: 'Project', legacyProjectId: 'legacy', nativeProjectId: 'native', rootPaths: ['/tmp/project'],
      },
    },
    outcome: status === 'prepared' ? null : {
      target: status === 'imported'
        ? { provider: 'codex', sessionId: '22222222-2222-4222-8222-222222222222', cwd: '/tmp/project', filePath: '/tmp/target.jsonl' }
        : undefined,
    },
  };
}

test('Codex desktop import response maps prepared, imported and uncertain states', () => {
  const prepared = parseCodexImportResult(response('prepared'));
  assert.equal(viewForCodexImportResult(prepared).status, 'prepared');
  assert.equal(prepared.plan.desktopProject?.name, 'Project');

  const imported = parseCodexImportResult(response('imported'));
  assert.equal(viewForCodexImportResult(imported).status, 'imported');
  assert.equal(importedCodexThreadId(imported), '22222222-2222-4222-8222-222222222222');
  assert.doesNotThrow(() => assertSameCodexImportPlan(prepared, imported));

  const uncertain = parseCodexImportResult(response('uncertain'));
  assert.equal(viewForCodexImportResult(uncertain).status, 'uncertain');
  assert.equal(importedCodexThreadId(uncertain), null);
});

test('Codex desktop open failure retains the imported thread for open-only retry', () => {
  const imported = parseCodexImportResult(response('imported'));
  assert.deepEqual(beginCodexOpen(imported), { status: 'imported', result: imported, opening: true });
  assert.deepEqual(completeCodexOpen(imported), {
    status: 'imported', result: imported, opening: false, opened: true,
  });
  assert.deepEqual(failCodexOpen(imported, new Error('desktop missing')), {
    status: 'imported', result: imported, opening: false, openError: 'desktop missing',
  });
  assert.throws(() => beginCodexOpen(parseCodexImportResult(response('prepared'))), /尚未生成/);
});

test('Codex desktop import response fails closed for unsafe or incomplete results', () => {
  assert.throws(() => parseCodexImportResult({ ok: false, error: 'project missing' }), /project missing/);
  assert.throws(() => parseCodexImportResult({ ...response('prepared'), planId: '../bad' }), /计划 ID/);
  assert.throws(() => parseCodexImportResult({
    ...response('prepared'),
    plan: { ...response('prepared').plan, desktopProject: undefined },
  }), /未绑定 Desktop 项目/);
  assert.throws(() => parseCodexImportResult({ ...response('imported'), outcome: null }), /没有目标线程/);
  assert.throws(() => parseCodexImportResult({ ...response('prepared'), warnings: 'hidden' }), /warnings/);
  assert.throws(() => parseCodexImportResult({ ...response('imported'), ok: false }), /状态不一致/);
  const notConfirmable = parseCodexImportResult({ ...response('prepared'), canConfirm: false });
  assert.throws(() => viewForCodexImportResult(notConfirmable), /不可确认/);

  const prepared = parseCodexImportResult(response('prepared'));
  const changed = parseCodexImportResult({ ...response('prepared'), planId: 'c'.repeat(64) });
  assert.throws(() => assertSameCodexImportPlan(prepared, changed), /已确认的计划不一致/);
});
