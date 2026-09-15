import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Check, ChevronDown, ClipboardPaste, Copy, FileText, Folder, History, Info, LoaderCircle, Monitor, Moon, RefreshCw, Search, Settings2, ShieldCheck, Sun, SunMoon, Terminal, Workflow, X } from 'lucide-react';
import { assertSameCodexImportPlan, beginCodexOpen, completeCodexOpen, failCodexOpen, importedCodexThreadId, parseCodexImportResult, viewForCodexImportResult, type CodexImportResult, type CodexImportView } from './codex-import.js';
import { AGENTS, buildCommand, handoffRoute, parseThemePreference, resolveTheme, THEME_OPTIONS, type ThemePreference } from './handoff-ui.js';
import './App.css';

type TerminalId = 'terminal' | 'kaku' | 'iterm2' | 'ghostty';
type LaunchMode = TerminalId | 'copy';
type Page = 'handoff' | 'history' | 'compatibility' | 'settings';
type Recent = { provider: string; sessionId: string; cwd: string; updatedAt: number; preview?: string };
type Provider = { id: string; available: boolean };
type Record = { id: string; fromProvider?: string; toProvider: string; toRef?: { sessionId?: string }; createdAt: number };
type Summary = { turnCount: number; userTurnCount: number; assistantTurnCount: number; lastUserPrompt?: string; lastAssistantReply?: string; hasThinking: boolean; hasTools: boolean; hasAttachments: boolean; toolNames: string[] };
type Source = { cwd: string; provider: string | null; sessionId?: string; usage?: { inputTokens: number; outputTokens: number } | null; summary?: Summary | null };
type Detect = { status: 'idle' | 'loading' } | { status: 'ok'; source: Source } | { status: 'error'; error: string };
type Transfer = { provider: string; sessionId: string; cwd?: string; notes: string[]; delivery?: 'copied' | 'launched'; error?: string };
const native = () => '__TAURI_INTERNALS__' in window && Boolean(window.__TAURI_INTERNALS__);
const windows = /windows/i.test(navigator.userAgent);
const labels = Object.fromEntries(AGENTS.map((agent) => [agent.id, agent.label]));
const terminalLabels: { [key in LaunchMode]: string } = { terminal: '系统终端', kaku: 'Kaku', iterm2: 'iTerm2', ghostty: 'Ghostty', copy: '仅复制命令' };
const DEMO_ID = '11111111-1111-4111-8111-111111111111';
const DEMO_TARGET = '22222222-2222-4222-8222-222222222222';
const demoSource: Source = { cwd: '/Users/developer/Projects/Watch', provider: 'claude', sessionId: DEMO_ID, usage: { inputTokens: 14200, outputTokens: 3680 }, summary: { turnCount: 8, userTurnCount: 4, assistantTurnCount: 4, hasThinking: true, hasTools: true, hasAttachments: false, toolNames: ['Bash', 'FileEdit', 'Glob', 'Grep'], lastUserPrompt: '保留现有导入保护流程，整理桌面端的接力操作与会话上下文。', lastAssistantReply: '已核对来源目录与项目归属。下一步完善预览与导入结果展示。' } };
function basename(path?: string) { return path?.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) || path || '未选择项目'; }
function tokens(value?: number) { return value == null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value); }
function relativeTime(value: number) { const minutes = Math.max(0, Math.floor((Date.now() - value) / 60000)); return minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前` : `${Math.floor(minutes / 1440)} 天前`; }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function initialMode(): LaunchMode { try { const value = localStorage.getItem('watch-launch-mode'); return value && value in terminalLabels ? value as LaunchMode : 'terminal'; } catch { return 'terminal'; } }
function demoPlan(): CodexImportResult { return { ok: true, planId: 'a'.repeat(64), status: 'prepared', canConfirm: true, desktop: 'demo-only', warnings: ['工具调用与结果在目标侧可能降级为文本；不代表结构化工具历史完整保留。'], plan: { source: { provider: 'claude', sessionId: DEMO_ID, cwd: demoSource.cwd, filePath: '/demo/source.jsonl' }, cliVersion: 'codex-cli 0.153.4', codexHome: '/demo/codex', desktopProject: { name: 'Watch', legacyProjectId: 'demo', nativeProjectId: 'demo', rootPaths: [demoSource.cwd] } }, outcome: null }; }

export default function App() {
  const [sessionId, setSessionId] = useState(() => new URLSearchParams(location.search).get('session') ?? '');
  const [demo, setDemo] = useState(() => !native() && new URLSearchParams(location.search).get('demo') === '1');
  const [page, setPage] = useState<Page>('handoff');
  const [detect, setDetect] = useState<Detect>({ status: 'idle' });
  const [recents, setRecents] = useState<Recent[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [history, setHistory] = useState<Record[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [recentError, setRecentError] = useState('');
  const [available, setAvailable] = useState<TerminalId[]>(['terminal']);
  const [mode, setMode] = useState<LaunchMode>(initialMode);
  const [target, setTarget] = useState('codex');
  const [yolo, setYolo] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(() => { try { return parseThemePreference(localStorage.getItem('watch-theme')); } catch { return 'system'; } });
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = resolveTheme(theme, media.matches); };
    apply(); media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  function chooseTheme(value: ThemePreference) { setTheme(value); try { localStorage.setItem('watch-theme', value); } catch { /* 无持久化时仅本次生效 */ } }
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [codexImport, setCodexImport] = useState<CodexImportView>({ status: 'idle' });
  const [transfers, setTransfers] = useState<{ [provider: string]: Transfer }>({});
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const historyRequest = useRef(0);
  const toastTimer = useRef<number | undefined>(undefined);
  const id = sessionId.trim();
  const source = detect.status === 'ok' ? detect.source : null;
  const owner = source?.provider ?? null;
  const agent = AGENTS.find((entry) => entry.id === target)!;
  const route = handoffRoute(owner, target);
  const ready = source !== null && route !== 'unresolved';
  const result = 'result' in codexImport ? codexImport.result : undefined;
  const activeTransfer = transfers[target] ?? null;
  function setTransfer(value: Transfer) { setTransfers((saved) => ({ ...saved, [value.provider]: value })); }
  const command = activeTransfer ? buildCommand(agent, activeTransfer.sessionId, activeTransfer.cwd, yolo, windows) : route === 'resume' ? buildCommand(agent, id, source?.cwd, yolo, windows) : '';
  function toast(text: string, type: 'ok' | 'error' = 'ok') { window.clearTimeout(toastTimer.current); setNotice({ type, text }); toastTimer.current = window.setTimeout(() => setNotice(null), 6000); }
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);
  async function loadRecents() {
    if (!native()) return;
    try { const data = await invoke<{ ok?: boolean; sessions?: Recent[]; error?: string }>('list_recent_sessions'); if (!data.ok || !Array.isArray(data.sessions)) throw new Error(data.error || '无法读取近期会话'); setRecents(data.sessions); setRecentError(''); }
    catch (error) { setRecentError(message(error)); }
  }
  useEffect(() => {
    if (!native()) return;
    let cancelled = false;
    void loadRecents();
    void invoke<{ providers?: Provider[] }>('list_available_providers').then((data) => { if (!cancelled && Array.isArray(data.providers)) setProviders(data.providers); }).catch(() => {});
    void invoke<string[]>('list_terminals').then((list) => {
      if (cancelled) return;
      const ids = list.filter((entry): entry is TerminalId => entry !== 'copy' && entry in terminalLabels);
      const usable = ids.length ? ids : ['terminal' as TerminalId]; setAvailable(usable);
      setMode((saved) => {
        if (saved === 'copy') return saved;
        let persisted = false;
        try { persisted = localStorage.getItem('watch-launch-mode') !== null; } catch { /* Use discovery defaults. */ }
        return persisted && usable.includes(saved) ? saved : (['kaku', 'iterm2', 'ghostty'] as TerminalId[]).find((entry) => usable.includes(entry)) ?? 'terminal';
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const version = ++request.current;
    setCodexImport({ status: 'idle' }); setTransfers({}); setNotice(null); setExpanded(false);
    if (demo && id === DEMO_ID) { setDetect({ status: 'ok', source: demoSource }); return; }
    if (!id) { setDetect({ status: 'idle' }); return; }
    if (!native()) { setDetect({ status: 'error', error: '浏览器预览无法读取本地会话。演示使用合成记录，不写入 Agent 存储。' }); return; }
    setDetect({ status: 'loading' });
    const timer = window.setTimeout(async () => {
      try { const data = await invoke<Source & { ok?: boolean; error?: string }>('resolve_cwd', { sessionId: id }); if (version !== request.current) return; if (!data.ok || !data.cwd) throw new Error(data.error || '未找到该会话，请检查来源 ID'); setDetect({ status: 'ok', source: data }); }
      catch (error) { if (version === request.current) setDetect({ status: 'error', error: message(error) }); }
    }, 350);
    return () => { window.clearTimeout(timer); request.current += 1; };
  }, [id, demo]);
  useEffect(() => { if (owner === 'claude') setTarget('codex'); else if (owner === 'codex') setTarget('claude'); }, [owner]);
  useEffect(() => {
    const version = ++historyRequest.current; setHistory([]); setHistoryError('');
    if (!source || demo || !native()) return;
    void invoke<{ history?: Record[] }>('get_handoff_history', { cwd: source.cwd }).then((data) => { if (version === historyRequest.current && Array.isArray(data.history)) setHistory(data.history); }).catch((error) => { if (version === historyRequest.current) setHistoryError(message(error)); });
  }, [source?.cwd, demo]);
  function chooseMode(value: LaunchMode) { setMode(value); try { localStorage.setItem('watch-launch-mode', value); } catch { toast('此环境无法保存偏好设置', 'error'); } }
  async function copy(text: string) { if (native()) { try { await writeText(text); return; } catch { /* Clipboard fallback. */ } } await navigator.clipboard.writeText(text); }
  async function copyFeedback(text: string) { try { await copy(text); toast('已复制'); } catch (error) { toast(`复制失败：${message(error)}`, 'error'); } }
  async function paste() {
    try {
      let text: string;
      if (native()) { try { text = await readText(); } catch { text = await navigator.clipboard.readText(); } }
      else text = await navigator.clipboard.readText();
      const value = text.trim(); if (!value) throw new Error('剪贴板为空');
      setDemo(false); setSessionId(value); setPage('handoff');
    } catch (error) { toast(`无法粘贴：${message(error)}`, 'error'); }
  }
  function startDemo() { if (busy) return; setDemo(true); setSessionId(DEMO_ID); setPage('handoff'); }
  async function prepare() {
    if (!ready || busy || route !== 'official-codex' || !source) return;
    const version = ++request.current; setBusy('prepare'); setCodexImport({ status: 'preparing', sourceId: id, cwd: source.cwd });
    try { const next = parseCodexImportResult(demo ? demoPlan() : await invoke('prepare_codex_import', { sourceId: id, cwd: source.cwd })); if (version !== request.current) return; if (next.plan.source.sessionId !== id || next.plan.source.cwd !== source.cwd) throw new Error('预览与当前来源不一致'); setCodexImport(viewForCodexImportResult(next)); }
    catch (error) { if (version === request.current) setCodexImport({ status: 'error', message: message(error) }); }
    finally { if (version === request.current) setBusy(null); }
  }
  async function updateImport(current: CodexImportResult, confirm = false) {
    if (busy || confirm && codexImport.status !== 'prepared') return;
    const version = ++request.current; setBusy(confirm ? 'confirm' : 'check'); setCodexImport({ status: confirm ? 'confirming' : 'checking', result: current });
    try {
      const demoResult = { ...current, status: 'imported', canConfirm: false, outcome: { target: { provider: 'codex', sessionId: DEMO_TARGET, cwd: demoSource.cwd, filePath: '/demo/target.jsonl' } } };
      const next = parseCodexImportResult(demo ? demoResult : await invoke(confirm ? 'confirm_codex_import' : 'codex_import_status', { planId: current.planId }));
      if (version !== request.current) return; assertSameCodexImportPlan(current, next); setCodexImport(viewForCodexImportResult(next)); if (confirm) void loadRecents();
    } catch (error) { if (version === request.current) setCodexImport({ status: 'error', message: message(error), result: current }); }
    finally { if (version === request.current) setBusy(null); }
  }
  async function openCodex(current: CodexImportResult) {
    const threadId = importedCodexThreadId(current); if (!threadId || busy) return;
    const version = ++request.current; setBusy('open'); setCodexImport(beginCodexOpen(current));
    try { if (!demo) await invoke('open_codex_thread', { threadId }); if (version === request.current) { setCodexImport(completeCodexOpen(current)); if (demo) toast('演示：未打开外部客户端'); } }
    catch (error) { if (version === request.current) setCodexImport(failCodexOpen(current, error)); }
    finally { if (version === request.current) setBusy(null); }
  }
  async function deliver(current: Transfer) {
    const cmd = buildCommand(AGENTS.find((entry) => entry.id === current.provider)!, current.sessionId, current.cwd, yolo, windows);
    if (demo) { setTransfer({ ...current, delivery: 'copied', error: undefined }); toast('演示：未写入会话或启动终端'); return; }
    if (mode !== 'copy' && native()) {
      try { await invoke('launch_terminal', { cwd: current.cwd ?? '', command: cmd, terminal: mode }); setTransfer({ ...current, delivery: 'launched', error: undefined }); toast('已请求启动终端；继续状态需在目标客户端确认'); return; }
      catch (error) { try { await copy(cmd); setTransfer({ ...current, delivery: 'copied', error: message(error) }); toast(`启动失败，命令已复制：${message(error)}`, 'error'); } catch (copyError) { setTransfer({ ...current, error: `${message(error)}；复制失败：${message(copyError)}` }); } return; }
    }
    await copy(cmd); setTransfer({ ...current, delivery: 'copied', error: undefined }); toast('恢复命令已复制');
  }
  async function handoff() {
    if (!ready || busy || route === 'official-codex') return;
    setBusy('handoff'); let completed = activeTransfer;
    try {
      if (!completed) {
        if (route === 'resume') completed = { provider: target, sessionId: id, cwd: source?.cwd, notes: [] };
        else { const data = demo ? { ok: true, sessionId: DEMO_TARGET, cwd: demoSource.cwd, notes: ['演示转换：不代表该方向通过原生验收。'] } : await invoke<{ ok?: boolean; sessionId?: string; cwd?: string; notes?: string[]; error?: string }>('open_in', { sourceId: id, providerId: target }); if (!data.ok || !data.sessionId) throw new Error(data.error || '转换失败'); completed = { provider: target, sessionId: data.sessionId, cwd: data.cwd, notes: data.notes ?? [] }; }
        setTransfer(completed);
      }
      await deliver(completed); void loadRecents();
    } catch (error) { if (completed) setTransfer({ ...completed, error: message(error) }); toast(message(error), 'error'); }
    finally { setBusy(null); }
  }
  const titles = { handoff: '会话接力', history: '接力记录', compatibility: '支持路径', settings: '设置' };
  const modeSelect = (label: string) => <select aria-label={label} value={mode} disabled={busy !== null} onChange={(event) => chooseMode(event.target.value as LaunchMode)}>{available.map((entry) => <option key={entry} value={entry}>{terminalLabels[entry]}</option>)}<option value="copy">仅复制命令</option></select>;
  return <div className="watch-app">
    <aside className="app-sidebar">
      <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setPage('handoff'); }}><span className="brand-mark"><img className="mark-light" src="/watch-mark-light.svg" alt="" width="26" height="13" /><img className="mark-dark" src="/watch-mark.svg" alt="" width="26" height="13" /></span><span>Watch<small>值更 / Session Relay</small></span></a>
      <span className="nav-caption">工作空间</span>
      <nav aria-label="主导航">{([{ key: 'handoff', label: '会话接力', icon: Workflow }, { key: 'history', label: '接力记录', icon: History }, { key: 'compatibility', label: '支持路径', icon: ShieldCheck }, { key: 'settings', label: '设置', icon: Settings2 }] as const).map((item) => <button key={item.key} className={`nav-item ${page === item.key ? 'active' : ''}`} onClick={() => setPage(item.key)} title={item.label} aria-label={item.label} aria-current={page === item.key ? 'page' : undefined}><item.icon size={17} /><span>{item.label}</span>{item.key === 'handoff' && <ArrowUpRight size={14} className="nav-trailing" />}</button>)}</nav>
      <div className="sidebar-recents"><div className="sidebar-heading"><span className="nav-caption">近期会话</span><button className="icon-button" title="刷新近期会话" aria-label="刷新近期会话" onClick={loadRecents}><RefreshCw size={14} /></button></div>{recents.length ? recents.slice(0, 8).map((entry) => <button key={`${entry.provider}-${entry.sessionId}`} className={`recent-item ${entry.sessionId === id ? 'selected' : ''}`} disabled={busy !== null} onClick={() => { setDemo(false); setSessionId(entry.sessionId); setPage('handoff'); }} title={entry.preview || entry.cwd}><img src={`/${entry.provider}.svg`} alt="" /><span>{basename(entry.cwd)}<small>{labels[entry.provider] || entry.provider} · {relativeTime(entry.updatedAt)}</small></span></button>) : <p className="sidebar-empty">{recentError || (native() ? '暂无近期会话' : '浏览器预览 · 本地记录不可访问')}</p>}</div>
      <div className="sidebar-bottom"><span className="local-status"><span className="status-dot" />{demo ? '合成演示' : native() ? '本地运行' : '浏览器预览'}</span><span className="theme-switch" role="radiogroup" aria-label="外观">{THEME_OPTIONS.map((option) => <button key={option.value} type="button" role="radio" aria-checked={theme === option.value} aria-label={option.label} title={option.label} className={theme === option.value ? 'active' : ''} onClick={() => chooseTheme(option.value)}>{option.value === 'system' ? <SunMoon size={13} /> : option.value === 'light' ? <Sun size={13} /> : <Moon size={13} />}</button>)}</span><span className="version">v0.1.1</span></div>
    </aside>
    <div className="app-content">
      <header className="topbar"><span className="breadcrumb">工作空间 <span>/</span> <strong>{titles[page]}</strong></span><div className="topbar-actions">{source && <button className="text-button" title={source.cwd} onClick={() => copyFeedback(source.cwd)}><Folder size={14} />{basename(source.cwd)}</button>}<span className="privacy-label"><ShieldCheck size={14} />本地会话</span></div></header>
      <main className="page-content"><div className="page-heading"><div><span className="eyebrow">SESSION CONTINUITY</span><h1>{titles[page]}</h1></div><span className="environment-label">{demo ? 'DEMO / 无真实写入' : native() ? 'LOCAL / 本机环境' : 'PREVIEW / 浏览器'}</span></div>
      {page === 'handoff' && <>
        <div className="workflow-strip" aria-label="接力状态">{['来源会话', '上下文', '目标 Agent', '交付结果'].map((label, index) => <div key={label} className={`workflow-item ${index < 2 && source ? 'complete' : index === 0 || index === 2 && source ? 'current' : ''}`}><span className="step-index">{index < 2 && source ? <Check size={13} /> : `0${index + 1}`}</span>{label}{index < 3 && <ArrowRight size={14} className="step-arrow" />}</div>)}</div>
        <div className="handoff-layout"><section className="source-section" aria-labelledby="source-title"><div className="section-heading"><h2 id="source-title">来源会话</h2><span>{source ? labels[owner || ''] || owner : '尚未选择'}</span></div>
          <div className="session-search"><Search size={18} /><input ref={input} aria-label="来源会话 ID" placeholder="输入或粘贴会话 ID" value={sessionId} disabled={busy !== null} spellCheck={false} onChange={(event) => { setDemo(false); setSessionId(event.target.value); }} />{id ? <button className="icon-button" title="清空会话" aria-label="清空会话" disabled={busy !== null} onClick={() => { setSessionId(''); setDemo(false); input.current?.focus(); }}><X size={17} /></button> : <button className="text-button" disabled={busy !== null} onClick={paste}><ClipboardPaste size={15} />粘贴</button>}</div>
          {detect.status === 'idle' && <div className="source-empty"><span className="empty-symbol"><FileText size={24} /></span><div><h3>尚无来源会话</h3><p>{native() ? '近期会话为空时，可使用来源工具的会话 ID。' : '本地会话仅在 Watch 桌面端读取。'}</p></div><button className="secondary-button" onClick={startDemo}>载入演示<ArrowRight size={15} /></button></div>}
          {detect.status === 'loading' && <div className="state-message" role="status"><LoaderCircle className="spin" size={18} />正在查找来源会话与工作目录…</div>}
          {detect.status === 'error' && <div className="state-message error" role="alert"><Info size={18} /><span>{detect.error}</span><button className="text-button" onClick={startDemo}>载入演示</button></div>}
          {source && <div className="source-details"><div className="source-identity"><span className="provider-label"><img src={`/${owner || 'claude'}.svg`} alt="" />{labels[owner || ''] || owner || '未知来源'}</span><code>{source.sessionId || id}</code><button className="icon-button" title="复制来源 ID" aria-label="复制来源 ID" onClick={() => copyFeedback(source.sessionId || id)}><Copy size={14} /></button></div><button className="cwd-row" title="复制完整工作目录" onClick={() => copyFeedback(source.cwd)}><Folder size={16} /><code>{source.cwd}</code><Copy size={13} /></button>
            <div className="session-metrics"><div><span>消息</span><strong>{source.summary?.turnCount ?? '—'}<small>条</small></strong></div><div><span><ArrowDownLeft size={13} />输入 Tokens</span><strong>{tokens(source.usage?.inputTokens)}</strong></div><div><span><ArrowUpRight size={13} />输出 Tokens</span><strong>{tokens(source.usage?.outputTokens)}</strong></div><div><span>来源内容</span><div className="content-flags">{source.summary?.hasThinking && <span>思考记录</span>}{source.summary?.hasTools && <span>工具调用</span>}{source.summary?.hasAttachments && <span>附件</span>}{!source.summary && <span>未提供摘要</span>}</div></div></div>
            {source.summary && <div className="context-section"><div className="section-heading"><h3>上下文摘录</h3><button className="text-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '展开'}<ChevronDown size={14} className={expanded ? 'rotate' : ''} /></button></div>{source.summary.lastUserPrompt && <div className="excerpt-row"><span className="role-label">用户</span><p className={expanded ? '' : 'clamped'}>{source.summary.lastUserPrompt}</p></div>}{source.summary.lastAssistantReply && <div className="excerpt-row"><span className="role-label assistant">助手</span><p className={expanded ? '' : 'clamped'}>{source.summary.lastAssistantReply}</p></div>}{!!source.summary.toolNames.length && <div className="tool-list"><span>工具</span>{source.summary.toolNames.map((tool) => <code key={tool}>{tool}</code>)}</div>}</div>}
          </div>}
        </section>
        <section className="target-section" aria-labelledby="target-title"><div className="section-heading"><h2 id="target-title">接力目标</h2><span>05 AGENTS</span></div><div className="agent-selector" role="radiogroup" aria-label="接力目标 Agent">{AGENTS.map((entry, index) => { const installed = providers.find((provider) => provider.id === entry.id); return <button role="radio" aria-checked={target === entry.id} tabIndex={target === entry.id ? 0 : -1} key={entry.id} className={`agent-option ${target === entry.id ? 'selected' : ''}`} disabled={busy !== null} onClick={() => setTarget(entry.id)} onKeyDown={(event) => {
          const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
          if (!direction && event.key !== 'Home' && event.key !== 'End') return;
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? AGENTS.length - 1 : (index + direction + AGENTS.length) % AGENTS.length;
          setTarget(AGENTS[next].id);
          (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next])?.focus();
        }}><img src={`/${entry.id}.svg`} alt="" /><span>{entry.label}<small>{owner === entry.id ? '来源 Agent' : installed ? installed.available ? 'CLI 已检测到' : 'CLI 未检测到' : '环境未检测'}</small></span>{target === entry.id && <Check size={15} />}</button>; })}</div>
          <div className="handoff-tool"><div className="handoff-tool-heading"><span className="route-label"><span className="status-dot" />{route === 'official-codex' ? '官方桌面导入' : route === 'resume' ? '原会话恢复' : '本地格式转换'}</span><span className="client-label">{route === 'official-codex' ? <Monitor size={14} /> : <Terminal size={14} />}{route === 'official-codex' ? 'Codex Desktop' : terminalLabels[mode]}</span></div>
          {route === 'official-codex' ? <div className="official-import"><p className="route-description">先匹配已存在的桌面项目，再确认导入。工具记录可能转为文本；打开客户端不代表模型继续已验证。</p>
            {codexImport.status === 'idle' && <button className="primary-button" disabled={!ready || busy !== null} onClick={prepare}>预览导入计划<ArrowRight size={16} /></button>}
            {codexImport.status === 'preparing' && <div className="state-message" role="status"><LoaderCircle className="spin" size={17} />正在核验项目与来源…</div>}
            {result && <><dl className="plan-details"><div><dt>桌面项目</dt><dd>{result.plan.desktopProject?.name}</dd></div><div><dt>工作目录</dt><dd><code>{result.plan.source.cwd}</code></dd></div><div><dt>计划 ID</dt><dd><code>{result.planId}</code></dd></div><div><dt>CLI 版本</dt><dd>{result.plan.cliVersion}</dd></div>{result.outcome?.target && <div><dt>目标会话</dt><dd><code>{result.outcome.target.sessionId}</code></dd></div>}</dl>{result.warnings.map((warning, index) => <p className="warning-message" key={index}><Info size={15} />{warning}</p>)}</>}
            {codexImport.status === 'prepared' && <div className="button-row"><button className="primary-button" disabled={busy !== null} onClick={() => updateImport(codexImport.result, true)}>{demo ? '模拟确认导入' : '确认导入'}<ArrowRight size={16} /></button><button className="secondary-button" onClick={() => setCodexImport({ status: 'idle' })}>取消预览</button></div>}
            {(codexImport.status === 'confirming' || codexImport.status === 'checking') && <div className="state-message" role="status"><LoaderCircle className="spin" size={17} />{codexImport.status === 'confirming' ? '正在导入并验证目标…' : '正在查询现有计划…'}</div>}
            {codexImport.status === 'uncertain' && <><div className="warning-message" role="alert"><Info size={16} />提交结果不确定。保留计划与锁，只查询状态，不重复导入。</div><button className="secondary-button" disabled={busy !== null} onClick={() => updateImport(codexImport.result)}><RefreshCw size={15} />查询状态</button></>}
            {codexImport.status === 'error' && <><div className="state-message error" role="alert"><Info size={16} />{codexImport.message}</div><button className="secondary-button" disabled={busy !== null} onClick={() => codexImport.result ? updateImport(codexImport.result) : prepare()}><RefreshCw size={15} />{codexImport.result ? '查询现有计划' : '重新预览'}</button></>}
            {codexImport.status === 'imported' && <><div className="success-message" role="status"><Check size={17} />{demo ? '演示导入完成 · 无真实写入' : '会话已导入'}{codexImport.opened && <span>· 已请求打开目标</span>}</div>{codexImport.openError && <p className="warning-message" role="alert">打开失败：{codexImport.openError}。目标已保留，不重复导入。</p>}<div className="button-row"><button className="primary-button" disabled={busy !== null} onClick={() => openCodex(codexImport.result)}>{codexImport.opening ? <LoaderCircle className="spin" size={16} /> : <Monitor size={16} />}{codexImport.openError ? '重试打开' : '打开目标会话'}</button><button className="secondary-button" onClick={() => copyFeedback(buildCommand(agent, importedCodexThreadId(codexImport.result)!, codexImport.result.plan.source.cwd, false, windows))}><Copy size={15} />复制恢复命令</button></div></>}
          </div> : <div className="standard-handoff"><p className="route-description">{route === 'resume' ? '使用原会话 ID 和来源工作目录恢复。' : '转入目标后生成恢复命令。不同格式可能降级或丢失部分记录；具体说明以转换结果为准。'}</p>{!ready && <p className="muted">等待来源识别完成</p>}{command && <div className="command-output"><span>$</span><code>{command}</code><button className="icon-button" title="复制恢复命令" aria-label="复制恢复命令" onClick={() => copyFeedback(command)}><Copy size={16} /></button></div>}{activeTransfer && <div className="transfer-result"><span className="success-message"><Check size={16} />{route === 'resume' ? '恢复命令已生成' : '目标会话已生成'}</span><code>{activeTransfer.sessionId}</code>{activeTransfer.notes.map((note, index) => <p className="warning-message" key={index}>{note}</p>)}{activeTransfer.error && <p className="warning-message" role="alert">{activeTransfer.error}。重试仅交付恢复命令，不重复转换。</p>}</div>}<div className="delivery-options"><label><Terminal size={15} />{modeSelect('交付方式')}</label><label className="toggle-label"><input type="checkbox" checked={yolo} disabled={busy !== null || !agent.yolo} onChange={(event) => setYolo(event.target.checked)} /><span>YOLO</span></label></div>{yolo && agent.yolo && <p className="warning-message"><Info size={15} />免确认参数会放宽目标 Agent 的权限或沙箱保护。</p>}<button className="primary-button" disabled={!ready || busy !== null} onClick={handoff}>{busy ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}{activeTransfer ? mode === 'copy' ? '再次复制命令' : '仅重新打开' : route === 'resume' ? mode === 'copy' ? '复制恢复命令' : '在终端中继续' : mode === 'copy' ? '转入并复制命令' : '转入并启动终端'}</button></div>}
          </div>
        </section></div><div className="page-footnote"><ShieldCheck size={14} /><span>Watch 不搬迁凭据、权限或模型内部状态。</span><button className="text-button" onClick={() => setPage('compatibility')}>查看路径限制<ArrowUpRight size={13} /></button></div>
      </>}
      {page === 'history' && <section><div className="section-heading"><h2>{basename(source?.cwd)}</h2><span>链式接力记录</span></div>{historyError && <p className="state-message error">{historyError}</p>}{!history.length ? <div className="large-empty"><History size={30} /><h2>暂无接力记录</h2><p>{source ? '此列表来自工作目录的链式接力历史，不是所有导入操作的执行日志。' : '选择来源会话后查看对应工作目录的记录。'}</p><button className="secondary-button" onClick={() => setPage('handoff')}>返回会话接力<ArrowRight size={15} /></button></div> : history.map((entry, index) => <div className="record-row" key={entry.id || index}><History size={17} /><span>{labels[entry.fromProvider || ''] || entry.fromProvider || '来源'}</span><ArrowRight size={14} /><strong>{labels[entry.toProvider] || entry.toProvider}</strong><time>{relativeTime(entry.createdAt)}</time>{entry.toRef?.sessionId && <button className="text-button" disabled={busy !== null} onClick={() => { setSessionId(entry.toRef!.sessionId!); setDemo(false); setPage('handoff'); }}>查看目标<ArrowUpRight size={14} /></button>}</div>)}</section>}
      {page === 'compatibility' && <section><div className="section-heading"><h2>支持路径</h2><span>仓库证据 / 2026-09-10</span></div><div className="compat-row"><Monitor size={19} /><div><h3>Claude Code → Codex Desktop</h3><p>官方导入、项目先建、预览 / 确认 / 独立打开。macOS arm64 合成样本限定通过；工具记录可能转为文本，模型继续不在通过范围内。</p></div><span className="badge green">限定验收</span></div><div className="compat-row"><Terminal size={19} /><div><h3>Claude / Codex / OpenCode / Kimi / Pi</h3><p>保留已有 CLI 适配器与恢复入口，不代表所有方向、版本及平台均通过原生验收。OpenCode 使用基础 CLI 路径。</p></div><span className="badge amber">逐方向验收</span></div><div className="compat-row"><ShieldCheck size={19} /><div><h3>官方增强与其他客户端</h3><p>OpenCode 官方 Web/TUI 增强、Claude Desktop Code 与 Antigravity 不作为新的默认接力入口。</p></div><span className="badge">未接入</span></div><p className="warning-message"><Info size={16} />安装检测只说明 CLI 命令可找到，不代表版本或会话兼容性通过。</p></section>}
      {page === 'settings' && <section><div className="setting-row"><div><h2>默认交付方式</h2><p>保存到本地；终端启动失败时尝试复制恢复命令。</p></div>{modeSelect('默认交付方式')}</div><div className="setting-row"><div><h2>YOLO 免确认参数</h2><p>仅本次运行生效，可能放宽目标 Agent 权限；官方桌面导入不会传入此参数。</p></div><label className="toggle-label"><input aria-label="YOLO 免确认参数" type="checkbox" checked={yolo} disabled={busy !== null} onChange={(event) => setYolo(event.target.checked)} /><span>{yolo ? '已开启' : '已关闭'}</span></label></div><div className="setting-row"><div><h2>合成演示</h2><p>仅展示交互状态，不转换真实会话、不启动外部客户端。</p></div><button className="secondary-button" disabled={busy !== null} onClick={startDemo}>载入演示<ArrowRight size={15} /></button></div></section>}
      </main><footer className="app-footer"><span>Watch · 值更</span><span>Relieve the watch. The voyage never stalls.</span></footer>
    </div>
    {notice && <div className={`toast ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.type === 'ok' ? <Check size={17} /> : <Info size={17} />}<span>{notice.text}</span><button className="icon-button" title="关闭通知" aria-label="关闭通知" onClick={() => setNotice(null)}><X size={15} /></button></div>}
  </div>;
}
