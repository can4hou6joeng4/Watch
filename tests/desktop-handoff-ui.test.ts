import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENTS, buildCommand, handoffRoute, parseThemePreference, resolveTheme, THEME_OPTIONS } from '../desktop/src/handoff-ui.js';

test('desktop Claude to Codex only exposes the official import route', () => {
  assert.equal(handoffRoute('claude', 'codex'), 'official-codex');
  assert.equal(handoffRoute('opencode', 'codex'), 'convert');
  assert.equal(handoffRoute('codex', 'codex'), 'resume');
  assert.equal(handoffRoute(null, 'codex'), 'unresolved');
});
test('restored commands preserve cwd, quote shell arguments and keep YOLO opt-in', () => {
  const codex = AGENTS.find((agent) => agent.id === 'codex')!;
  assert.equal(buildCommand(codex, 'target-id', '/tmp/project with spaces', false), "cd '/tmp/project with spaces' && codex resume target-id");
  assert.equal(buildCommand(codex, 'target-id', "C:\\project's folder", false, true), "Set-Location -LiteralPath 'C:\\project''s folder'; codex resume target-id");
  assert.ok(buildCommand(codex, 'id; touch /tmp/unsafe', undefined, false).includes("'id; touch /tmp/unsafe'"));
  assert.ok(!buildCommand(codex, 'target-id', undefined, false).includes('dangerously'));
  assert.ok(buildCommand(codex, 'target-id', undefined, true).includes(codex.yolo!));
  const pi = AGENTS.find((agent) => agent.id === 'pi')!;
  assert.equal(buildCommand(pi, 'target-id', undefined, true), 'pi --session target-id');
});

test('theme preference parses safely and resolves against the system scheme', () => {
  assert.equal(parseThemePreference(null), 'system');
  assert.equal(parseThemePreference('bogus'), 'system');
  assert.equal(parseThemePreference('dark'), 'dark');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.deepEqual(THEME_OPTIONS.map((o) => o.value), ['system', 'light', 'dark']);
});
