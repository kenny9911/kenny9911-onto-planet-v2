import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  Activity, ArrowRight, BadgeCheck, Blocks, BookOpen, Bot, Cable, Check,
  ClipboardCheck, Clock3, Database, FileText, FlaskConical, GitBranchPlus,
  History, LayoutDashboard, LogOut, Menu, Network, Play,
  Plus, RefreshCw, Save, ScanSearch, Search, Settings2, ShieldCheck, Sparkles, Square,
  Trash2, UserRound, Users, Workflow, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { OntologyBundle } from '../../../packages/contracts/src/index.js';
import { api, ApiError, type BootstrapResponse, type EntityRecord, type ResourceKind, type SessionInfo } from './api';
import { asArray, asBundle, asRecord, BusyLabel, dateLabel, EmptyState, ErrorBanner, JsonInspector, KeyValue, MiniLink, OntologyGraph, PageTitle, pretty, shortHash, StatusBadge, textValue } from './components';

type View = 'overview' | 'ontologies' | 'objects' | 'knowledge' | 'connectors' | 'context' | 'agents' | 'skills' | 'plugins' | 'applications' | 'tasks' | 'runs' | 'approvals' | 'releases' | 'evaluations' | 'audit' | 'settings';
type Group = { label: string; items: Array<{ id: View; label: string; icon: LucideIcon }> };

const navigation: Group[] = [
  { label: 'Workspace', items: [{ id: 'overview', label: 'Overview', icon: LayoutDashboard }] },
  { label: 'Build', items: [
    { id: 'ontologies', label: 'Ontology', icon: Network }, { id: 'objects', label: 'Objects', icon: Database },
    { id: 'knowledge', label: 'Knowledge', icon: BookOpen }, { id: 'connectors', label: 'Connectors', icon: Cable },
    { id: 'context', label: 'Context inspector', icon: ScanSearch }, { id: 'agents', label: 'Agents', icon: Bot },
    { id: 'skills', label: 'Skills', icon: Sparkles }, { id: 'plugins', label: 'Plugins', icon: Blocks },
    { id: 'applications', label: 'Applications', icon: Workflow },
  ] },
  { label: 'Use', items: [{ id: 'tasks', label: 'Task runner', icon: Play }, { id: 'runs', label: 'Runs and traces', icon: Activity }] },
  { label: 'Govern', items: [
    { id: 'approvals', label: 'Approvals', icon: ClipboardCheck }, { id: 'releases', label: 'Releases', icon: GitBranchPlus },
    { id: 'evaluations', label: 'Evaluations', icon: FlaskConical }, { id: 'audit', label: 'Audit trail', icon: History },
    { id: 'settings', label: 'Settings', icon: Settings2 },
  ] },
];
const allViews = new Set(navigation.flatMap((group) => group.items.map((item) => item.id)));
const viewFromHash = (): View => {
  const value = window.location.hash.slice(1) as View;
  return allViews.has(value) ? value : 'overview';
};

function initialBundle(name: string): OntologyBundle {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'new-ontology';
  return { schemaVersion: '2.0', id, namespace: `workspace.${id}`, version: '0.1.0', name,
    sources: [], values: [], sharedProperties: [], objects: [], relations: [], interfaces: [], rules: [],
    actions: [], functions: [], events: [], policies: [] };
}

function resourceSummary(record: EntityRecord): string {
  const data = asRecord(record.data);
  const bundle = asBundle(data);
  if (bundle) return `${bundle.objects.length} object types · ${bundle.relations.length} relations · ${bundle.actions.length} actions`;
  if (record.kind === 'objects') return `${textValue(data.objectTypeId, 'Object')} · ${textValue(asRecord(data.source).system ?? data.source, 'Source not set')}`;
  if (record.kind === 'knowledge') return textValue(data.source, 'Reviewed knowledge');
  if (record.kind === 'runs') return textValue(data.status ?? data.state, record.state);
  return textValue(data.description, `${record.kind} record`);
}

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [setupStatus, setSetupStatus] = useState<{ required: boolean; oidcEnabled?: boolean; setupTokenRequired?: boolean } | null>(null);
  const [boot, setBoot] = useState<BootstrapResponse | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pollEpoch, setPollEpoch] = useState(0);
  const [view, setView] = useState<View>(viewFromHash);
  const [mobileNav, setMobileNav] = useState(false);

  const navigate = useCallback((next: View) => { setView(next); window.location.hash = next; setMobileNav(false); setError(null); }, []);
  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.bootstrap();
      setBoot(next);
      setSession(next.session);
      setPollEpoch((epoch) => epoch + 1);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const current = await api.session();
        if (!live) return;
        setSession(current);
        const next = await api.bootstrap();
        if (live) { setBoot(next); setSession(next.session); }
      } catch (caught) {
        if (!live) return;
        if (caught instanceof ApiError && caught.status === 401) {
          setSession(null);
          try { setSetupStatus(await api.setupStatus()); }
          catch (setupError) { if (live) setError(errorText(setupError)); }
        } else setError(errorText(caught));
      } finally { if (live) setAuthLoading(false); }
    })();
    return () => { live = false; };
  }, []);

  const pollingNeeded = !!session && !!boot && ['tasks', 'runs', 'approvals'].includes(view) && (
    boot.resources.runs.some((run) => ['queued', 'running', 'queued_resume', 'approval_required', 'unknown'].includes(run.state)) ||
    boot.approvals.some((approval) => ['awaiting_approval', 'unknown', 'executing', 'reconciling'].includes(approval.state))
  );
  useEffect(() => {
    if (!pollingNeeded) return;
    let live = true;
    let inFlight = false;
    let failed = false;
    const timer = window.setInterval(() => {
      if (!live || inFlight || failed || document.hidden) return;
      inFlight = true;
      void api.bootstrap().then((next) => {
        if (!live) return;
        setBoot(next);
        setSession(next.session);
      }).catch((caught) => {
        if (!live) return;
        failed = true;
        if (caught instanceof ApiError && caught.status === 401) { setSession(null); setBoot(null); }
        else setError(`Live updates paused: ${errorText(caught)}. Use Refresh workspace to retry.`);
      }).finally(() => { inFlight = false; });
    }, 2500);
    return () => { live = false; window.clearInterval(timer); };
  }, [pollingNeeded, session?.user.actorId, view, pollEpoch]);

  const perform = useCallback(async <T,>(label: string, operation: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await operation();
      setNotice(label);
      try { await refresh(); }
      catch (caught) { setError(`${label}. Workspace refresh failed: ${errorText(caught)}. Refresh the page to see the latest state.`); }
      return result;
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) { setSession(null); setBoot(null); }
      setError(errorText(caught));
      return undefined;
    } finally { setBusy(false); }
  }, [refresh]);

  const handleAuth = async (input: { email: string; password: string; name?: string; workspace?: string; setupToken?: string }) => {
    setBusy(true); setError(null);
    try {
      const current = setupStatus?.required ? await api.setup({ name: input.name ?? '', workspace: input.workspace ?? '', email: input.email, password: input.password, ...(input.setupToken ? { setupToken: input.setupToken } : {}) })
        : await api.login({ email: input.email, password: input.password });
      setSession(current);
      await refresh();
      setSetupStatus({ required: false, oidcEnabled: setupStatus?.oidcEnabled });
      navigate('overview');
    } catch (caught) { setError(errorText(caught)); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    if (!session) return;
    setBusy(true); setError(null);
    try { await api.logout(session.csrfToken); setSession(null); setBoot(null); setSetupStatus({ required: false, oidcEnabled: setupStatus?.oidcEnabled }); }
    catch (caught) { setError(errorText(caught)); }
    finally { setBusy(false); }
  };

  if (authLoading) return <div className="splash"><span className="brand-symbol">◉</span><BusyLabel>Opening workspace</BusyLabel></div>;
  if (!session) return <AuthScreen setupRequired={setupStatus?.required === true} setupTokenRequired={setupStatus?.setupTokenRequired === true} oidcEnabled={setupStatus?.oidcEnabled === true} busy={busy} error={error} onSubmit={handleAuth} />;
  if (!boot) return <div className="splash error-splash"><span className="brand-symbol">◉</span><h1>Workspace could not load</h1>{error && <ErrorBanner message={error} />}<button className="button primary" onClick={() => void refresh().catch((caught) => setError(errorText(caught)))} disabled={loading}>Retry workspace</button><button className="button ghost" onClick={() => void logout()}>Sign out</button></div>;

  const can = (scope: string) => session.user.scopes.includes(scope);
  const resources = boot.resources;
  const csrf = session.csrfToken;
  const create = (kind: ResourceKind, input: { name: string; data: Record<string, unknown>; state?: string }) => perform(`${input.name} created`, () => api.createResource(kind, input, csrf));
  const update = (kind: ResourceKind, id: string, input: { revision: number; name?: string; data?: Record<string, unknown>; state?: string }) =>
    perform('Changes saved', () => api.updateResource(kind, id, input, csrf));
  const remove = (kind: ResourceKind, record: EntityRecord) => perform(`${record.name} deleted`, () => api.deleteResource(kind, record.id, record.revision, csrf));
  const special = <T,>(label: string, path: string, body: unknown) => perform(label, () => api.post<T>(path, body, csrf));

  const content = (() => {
    switch (view) {
      case 'overview': return <Overview boot={boot} canAudit={can('admin')} navigate={navigate} />;
      case 'ontologies': return <OntologyScreen records={resources.ontologies} activeBundle={boot.activeBundle} canBuild={can('build')} canRelease={can('release')} busy={busy} create={create} update={update} remove={remove} special={special} navigate={navigate} />;
      case 'objects': return <ObjectScreen records={resources.objects} canBuild={can('build')} busy={busy} create={create} update={update} remove={remove} special={special} />;
      case 'knowledge': return <KnowledgeScreen records={resources.knowledge} canBuild={can('build')} busy={busy} create={create} update={update} remove={remove} special={special} />;
      case 'connectors': return <ConnectorScreen records={resources.connectors} canBuild={can('admin')} canTest={can('admin')} canSync={can('build')} busy={busy} create={create} update={update} remove={remove} special={special} />;
      case 'context': return <ContextScreen profiles={resources.contextProfiles} canBuild={can('build')} busy={busy} create={create} update={update} remove={remove} special={special} />;
      case 'agents': return <GenericScreen kind="agents" title="Agents" subtitle="Versioned agents that use governed context and actions." records={resources.agents} canBuild={can('build')} busy={busy} create={create} update={update} remove={remove} />;
      case 'skills': return <GenericScreen kind="skills" title="Skills" subtitle="Reusable procedures; tool authority is granted separately." records={resources.skills} canBuild={can('build')} busy={busy} create={create} update={update} remove={remove} />;
      case 'plugins': return <GenericScreen kind="plugins" title="Plugins" subtitle="Reviewed extension packages and their requested capabilities." records={resources.plugins} canBuild={can('admin')} busy={busy} create={create} update={update} remove={remove} />;
      case 'applications': return <GenericScreen kind="applications" title="Applications" subtitle="Business tasks composed from ontology, context, agents, and skills." records={resources.applications} canBuild={can('build')} busy={busy} create={create} update={update} remove={remove} />;
      case 'tasks': return <TaskScreen agents={resources.agents} runs={resources.runs} canOperate={can('operate')} busy={busy} special={special} navigate={navigate} />;
      case 'runs': return <RunsScreen runs={resources.runs} audit={boot.audit} canOperate={can('operate')} busy={busy} special={special} />;
      case 'approvals': return <ApprovalScreen approvals={boot.approvals} actorId={session.user.actorId} canApprove={can('approve')} canOperate={can('operate')} busy={busy} special={special} />;
      case 'releases': return <ReleasesScreen records={resources.releases} ontologies={resources.ontologies} canRelease={can('release')} busy={busy} special={special} />;
      case 'evaluations': return <EvaluationScreen records={resources.evaluations} canBuild={can('build')} busy={busy} special={special} />;
      case 'audit': return <AuditScreen records={boot.audit} canAdmin={can('admin')} />;
      case 'settings': return <SettingsScreen session={session} health={boot.health} canAdmin={can('admin')} busy={busy} perform={perform} />;
    }
  })();

  return <div className="app-shell">
    {mobileNav && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
      <div className="brand"><span className="brand-symbol">◉</span><div><strong>ONTO PLANET</strong><small>Studio / V2</small></div><button className="nav-mobile-close" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={18} /></button></div>
      <div className="workspace-switch"><span className="workspace-icon">{session.tenant.name.slice(0, 1).toUpperCase()}</span><span><strong>{session.tenant.name}</strong><small>{boot.health.environment} environment</small></span></div>
      <nav aria-label="Main navigation" className="nav-groups">{navigation.map((group) => <div className="nav-group" key={group.label}><p>{group.label}</p>{group.items.filter((item) => item.id !== 'audit' || can('admin')).map((item) => <button key={item.id} type="button" className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)} aria-current={view === item.id ? 'page' : undefined}><item.icon size={17} strokeWidth={1.8} /><span>{item.label}</span>{item.id === 'approvals' && boot.approvals.length > 0 && <span className="nav-count">{boot.approvals.length}</span>}</button>)}</div>)}</nav>
      <div className="sidebar-footer"><div className="sidebar-health"><span className={`health-light ${boot.health.database === 'ok' || boot.health.database === 'connected' ? 'healthy' : ''}`} />{textValue(boot.health.database, 'Database status unknown')}<small>v{boot.health.version}</small></div></div>
    </aside>
    <div className="main-frame">
      <header className="topbar"><button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={20} /></button><div className="breadcrumb"><span>{navigation.find((group) => group.items.some((item) => item.id === view))?.label}</span><span className="breadcrumb-divider">/</span><strong>{navigation.flatMap((group) => group.items).find((item) => item.id === view)?.label}</strong></div><div className="top-actions"><button className="icon-button" onClick={() => { void refresh().catch((caught) => setError(errorText(caught))); }} aria-label="Refresh workspace" title="Refresh workspace"><RefreshCw size={17} className={loading ? 'spin' : ''} /></button><span className="top-divider" /><span className="account-avatar">{session.user.name.slice(0, 1).toUpperCase()}</span><span className="account-name">{session.user.name}<small>{session.user.role}</small></span><button className="icon-button" onClick={() => void logout()} aria-label="Sign out" title="Sign out"><LogOut size={17} /></button></div></header>
      <main className="content" id="main-content">{error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}{notice && <div className="notice" role="status"><Check size={16} />{notice}<button className="icon-button" onClick={() => setNotice(null)} aria-label="Dismiss notification">×</button></div>}{content}</main>
    </div>
  </div>;
}

function errorText(caught: unknown): string { return caught instanceof Error ? caught.message : 'The request could not be completed.'; }

function AuthScreen({ setupRequired, setupTokenRequired, oidcEnabled, busy, error, onSubmit }: { setupRequired: boolean; setupTokenRequired: boolean; oidcEnabled: boolean; busy: boolean; error: string | null; onSubmit: (input: { email: string; password: string; name?: string; workspace?: string; setupToken?: string }) => Promise<void> }) {
  const [name, setName] = useState(''); const [workspace, setWorkspace] = useState('');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); void onSubmit({ name, workspace, email, password, setupToken }); };
  return <div className="auth-layout"><div className="auth-art"><div className="auth-brand"><span className="brand-symbol">◉</span> ONTO PLANET</div><div className="auth-art-center"><div className="auth-orbit orbit-a" /><div className="auth-orbit orbit-b" /><div className="auth-core">Ontology<br />in motion</div><span className="auth-satellite s1" /><span className="auth-satellite s2" /><span className="auth-satellite s3" /></div><p>One governed model for knowledge, systems, and agents.</p></div><div className="auth-panel"><div className="auth-form-wrap"><span className="auth-mark">OP / STUDIO</span><h1>{setupRequired ? 'Create your workspace' : 'Welcome back'}</h1><p>{setupRequired ? 'Set up the first administrator and a local workspace.' : 'Sign in to continue your work.'}</p>{error && <ErrorBanner message={error} />}<form onSubmit={submit}>{setupRequired && <><label>Full name<input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} required /></label><label>Workspace name<input value={workspace} onChange={(event) => setWorkspace(event.target.value)} required /></label>{setupTokenRequired && <label>Setup token<input type="password" value={setupToken} onChange={(event) => setSetupToken(event.target.value)} required /></label>}</>}<label>Email address<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label>Password<input type="password" autoComplete={setupRequired ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={setupRequired ? 12 : undefined} /></label><button className="button primary auth-submit" type="submit" disabled={busy}>{busy ? <BusyLabel>Working</BusyLabel> : setupRequired ? 'Create workspace' : 'Sign in'}<ArrowRight size={17} /></button></form>{oidcEnabled && !setupRequired && <a className="button secondary oidc-link" href="/api/auth/oidc/start">Sign in with company identity<ArrowRight size={16} /></a>}<small className="auth-footnote">Access is managed by your workspace administrator.</small></div></div></div>;
}

function Overview({ boot, canAudit, navigate }: { boot: BootstrapResponse; canAudit: boolean; navigate: (view: View) => void }) {
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const bundle = boot.activeBundle ?? asBundle(boot.resources.ontologies[0]?.data);
  const modelStatus = boot.activeBundle ? 'Active' : bundle ? 'Draft preview' : 'Not configured';
  const selected = bundle?.objects.find((object) => object.id === selectedId) ?? bundle?.objects[0];
  const recent = [...boot.resources.ontologies, ...boot.resources.knowledge, ...boot.resources.agents, ...boot.resources.releases]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 5);
  return <>
    <PageTitle title="Operational ontology" subtitle="A live view of the definitions, context, and actions that power this workspace." actions={<button className="button secondary" type="button" onClick={() => navigate('ontologies')}><Network size={16} />Open ontology</button>} />
    <div className="overview-signal"><span className="signal-line" /><div><span>{boot.activeBundle ? 'Active model' : 'Model preview'}</span><strong>{bundle?.name ?? 'No ontology configured'}</strong></div><span className="signal-divider" /><div><span>Object types</span><strong>{bundle?.objects.length ?? 0}</strong></div><span className="signal-divider" /><div><span>Relations</span><strong>{bundle?.relations.length ?? 0}</strong></div><span className="signal-divider" /><div><span>Actions</span><strong>{bundle?.actions.length ?? 0}</strong></div><div className="signal-status"><StatusBadge value={modelStatus} /></div></div>
    <div className="overview-hero"><section className="panel graph-panel"><div className="panel-heading"><div><h2>Business model</h2><p>Select a type to inspect its fields and connections.</p></div><span className="subtle-tag">Ontology V2</span></div><OntologyGraph bundle={bundle} selectedId={selected?.id} onSelect={setSelectedId} /></section><aside className="panel graph-inspector"><div className="panel-heading"><div><h2>Inspector</h2><p>Selected object type</p></div><ScanSearch size={17} /></div>{selected ? <><div className="inspector-identity"><span className="inspector-icon"><Database size={22} /></span><h3>{selected.name}</h3><code>{selected.id}</code></div><p className="inspector-description">{selected.description ?? 'No description recorded for this object type.'}</p><div className="inspector-fields"><h4>Properties <span>{selected.properties.length}</span></h4>{selected.properties.slice(0, 6).map((property) => <div key={property.id}><span>{property.id}</span><small>{property.required ? 'Required' : 'Optional'}</small></div>)}{selected.properties.length === 0 && <p className="muted">No properties defined.</p>}</div><MiniLink onClick={() => navigate('ontologies')}>View definition</MiniLink></> : <EmptyState title="Select an object" description="Choose a node in the model to inspect its definition." />}</aside></div>
    <div className="overview-lower"><section className="panel activity-panel"><div className="panel-heading"><div><h2>Recent changes</h2><p>Updated definitions and operational assets</p></div>{canAudit && <MiniLink onClick={() => navigate('audit')}>Audit trail</MiniLink>}</div>{recent.length ? <div className="activity-list">{recent.map((record) => <div className="activity-row" key={record.id}><span className="activity-icon">{record.kind === 'ontologies' ? <Network size={16} /> : record.kind === 'knowledge' ? <BookOpen size={16} /> : record.kind === 'agents' ? <Bot size={16} /> : <GitBranchPlus size={16} />}</span><div><strong>{record.name}</strong><small>{record.kind} · rev {record.revision}</small></div><StatusBadge value={record.state} /><time>{dateLabel(record.updatedAt)}</time></div>)}</div> : <EmptyState title="No changes yet" description="Create an ontology or transform source knowledge to begin." />}</section><section className="panel next-panel"><div className="panel-heading"><div><h2>Next steps</h2><p>Move a business task toward a verified release.</p></div></div><button onClick={() => navigate('knowledge')}><BookOpen size={18} /><span><strong>Review source knowledge</strong><small>Transform evidence into cited Markdown</small></span><ArrowRight size={16} /></button><button onClick={() => navigate('context')}><ScanSearch size={18} /><span><strong>Inspect task context</strong><small>See what an agent is permitted to know</small></span><ArrowRight size={16} /></button><button onClick={() => navigate('tasks')}><Play size={18} /><span><strong>Run a governed task</strong><small>Trace context, action, and source receipt</small></span><ArrowRight size={16} /></button></section></div>
  </>;
}

type MutationProps = {
  canBuild: boolean; busy: boolean;
  create: (kind: ResourceKind, input: { name: string; data: Record<string, unknown>; state?: string }) => Promise<EntityRecord | undefined>;
  update: (kind: ResourceKind, id: string, input: { revision: number; name?: string; data?: Record<string, unknown>; state?: string }) => Promise<EntityRecord | undefined>;
  remove: (kind: ResourceKind, record: EntityRecord) => Promise<void | undefined>;
};
type Special = <T>(label: string, path: string, body: unknown) => Promise<T | undefined>;

function RecordWorkbench({ kind, records, canBuild, busy, create, update, remove, initialData, selectedAction, onSelect, canEditRecord, focusId }:
  MutationProps & { kind: ResourceKind; records: EntityRecord[]; initialData?: (name: string) => Record<string, unknown>; selectedAction?: (record: EntityRecord) => ReactNode; onSelect?: (record: EntityRecord | undefined) => void; canEditRecord?: (record: EntityRecord) => boolean; focusId?: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [draft, setDraft] = useState('{}');
  const [search, setSearch] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const selected = records.find((record) => record.id === selectedId) ?? records[0];
  const editable = canBuild && (creating || !selected || !canEditRecord || canEditRecord(selected));
  const filtered = records.filter((record) => `${record.name} ${record.id} ${resourceSummary(record)}`.toLowerCase().includes(search.toLowerCase()));

  useEffect(() => {
    if (!creating && selected) { setName(selected.name); setDraft(pretty(selected.data)); setLocalError(null); onSelect?.(selected); }
    if (!creating && !selected) onSelect?.(undefined);
  }, [selected?.id, selected?.revision, creating]);
  useEffect(() => { if (focusId) { setCreating(false); setSelectedId(focusId); } }, [focusId]);

  const startCreate = () => { setCreating(true); setSelectedId(null); setName(''); setDraft(pretty(initialData?.('New item') ?? {})); setLocalError(null); };
  const choose = (record: EntityRecord) => { setCreating(false); setSelectedId(record.id); setName(record.name); setDraft(pretty(record.data)); setLocalError(null); onSelect?.(record); };
  const parseDraft = (): Record<string, unknown> | undefined => {
    try { const value: unknown = JSON.parse(draft); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Data must be a JSON object.'); return value as Record<string, unknown>; }
    catch (caught) { setLocalError(errorText(caught)); return undefined; }
  };
  const save = async () => {
    if (!name.trim()) { setLocalError('Give this record a name.'); return; }
    const data = parseDraft(); if (!data) return;
    if (creating && kind === 'ontologies') {
      const bundle = asRecord(data.bundle);
      if (bundle.name === 'New item') {
        const named = initialBundle(name.trim());
        data.bundle = { ...bundle, id: named.id, namespace: named.namespace, name: named.name };
      }
    }
    if (creating) { const result = await create(kind, { name: name.trim(), data }); if (result) { setCreating(false); setSelectedId(result.id); } }
    else if (selected) await update(kind, selected.id, { revision: selected.revision, name: name.trim(), data });
  };
  const deleteSelected = async () => { if (selected && window.confirm(`Delete ${selected.name}? This change is audited.`)) { await remove(kind, selected); setSelectedId(null); } };

  return <div className="record-workbench"><section className="panel record-list"><div className="record-list-top"><strong>{records.length} records</strong>{canBuild && <button type="button" className="icon-button add-record" onClick={startCreate} aria-label={`Create ${kind}`} title={`Create ${kind}`}><Plus size={18} /></button>}</div><label className="search-field"><Search size={16} /><input aria-label={`Search ${kind}`} placeholder="Search records" value={search} onChange={(event) => setSearch(event.target.value)} /></label><div className="record-items">{filtered.map((record) => <button type="button" key={record.id} className={`record-item ${!creating && selected?.id === record.id ? 'selected' : ''}`} onClick={() => choose(record)}><span className="record-item-mark" /><span><strong>{record.name}</strong><small>{resourceSummary(record)}</small></span><StatusBadge value={record.state} /></button>)}{filtered.length === 0 && <div className="list-empty">{records.length ? 'No records match your search.' : 'No records yet.'}</div>}</div></section><section className="panel record-editor">{creating || selected ? <><div className="editor-header"><div><h2>{creating ? `New ${kind.slice(0, -1)}` : selected?.name}</h2><p>{creating ? 'Add a versioned workspace record.' : `${selected?.id} · revision ${selected?.revision}`}</p></div>{!creating && selected && <StatusBadge value={selected.state} />}</div>{!creating && selected && selectedAction?.(selected)}<div className="editor-form"><label>Name<input value={name} onChange={(event) => setName(event.target.value)} disabled={!editable || busy} /></label><label>Data <span className="field-help">JSON definition</span><textarea className="code-editor" spellCheck={false} value={draft} onChange={(event) => setDraft(event.target.value)} disabled={!editable || busy} aria-label="Record data JSON" /></label>{localError && <ErrorBanner message={localError} onDismiss={() => setLocalError(null)} />}{canBuild && !editable && <p className="read-only-note">This record is owned by an external source. Change it through a governed action.</p>}{editable && <div className="editor-footer"><button type="button" className="button primary" onClick={() => void save()} disabled={busy}><Save size={16} />{creating ? 'Create record' : 'Save changes'}</button>{creating ? <button type="button" className="button ghost" onClick={() => setCreating(false)}>Cancel</button> : <button type="button" className="button danger-quiet" onClick={() => void deleteSelected()} disabled={busy}><Trash2 size={16} />Delete</button>}</div>}</div></> : <EmptyState title="No record selected" description={canBuild ? 'Create a record to start building this part of the platform.' : 'This workspace has no records to view.'} action={canBuild && <button className="button secondary" onClick={startCreate}><Plus size={16} />Create record</button>} />}</section></div>;
}

function GenericScreen({ kind, title, subtitle, records, ...props }: MutationProps & { kind: ResourceKind; title: string; subtitle: string; records: EntityRecord[] }) {
  return <><PageTitle title={title} subtitle={subtitle} /><RecordWorkbench kind={kind} records={records} {...props} /></>;
}

function OntologyScreen({ records, activeBundle, canBuild, canRelease, busy, create, update, remove, special, navigate }:
  MutationProps & { records: EntityRecord[]; activeBundle: OntologyBundle | null; canRelease: boolean; special: Special; navigate: (view: View) => void }) {
  const [selected, setSelected] = useState<EntityRecord | undefined>(records[0]);
  const [selectedNode, setSelectedNode] = useState<string | undefined>();
  const [validation, setValidation] = useState<Record<string, unknown> | null>(null);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [proposalName, setProposalName] = useState('Procurement proposal');
  const [proposalText, setProposalText] = useState('');
  const [proposal, setProposal] = useState<Record<string, unknown> | null>(null);
  const [focusId, setFocusId] = useState<string>();
  const [reviewReason, setReviewReason] = useState('Reviewed business meaning and source evidence');
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [policyActionId, setPolicyActionId] = useState('');
  const [policyArgs, setPolicyArgs] = useState('{}');
  const [policyObjectId, setPolicyObjectId] = useState('');
  const [policyResult, setPolicyResult] = useState<unknown>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const bundle = asBundle(selected?.data) ?? activeBundle;
  const selectedType = bundle?.objects.find((object) => object.id === selectedNode);
  const selectedData = asRecord(selected?.data);
  const review = asRecord(selectedData.review);
  const gaps = asArray(selectedData.reviewGaps).filter((value): value is string => typeof value === 'string');
  const reviewApproved = selected?.state === 'approved' || review.status === 'approved';
  const validate = async () => {
    if (!bundle) return;
    const result = await special<Record<string, unknown>>('Ontology validation completed', '/api/ontology/validate', { bundle });
    if (result) setValidation(result);
  };
  const publish = async () => {
    if (!selected) return;
    const result = await special<EntityRecord>('Release created for review', '/api/releases', { ontologyId: selected.id, revision: selected.revision });
    if (result) navigate('releases');
  };
  const submitReview = async (event: FormEvent) => {
    event.preventDefault(); if (!selected) return;
    const result = await special<unknown>('Ontology approved for release', `/api/ontology/${encodeURIComponent(selected.id)}/review`, { revision: selected.revision, reason: reviewReason, acknowledgedGaps: acknowledged });
    if (result) setAcknowledged([]);
  };
  const simulatePolicy = async (event: FormEvent) => {
    event.preventDefault(); setPolicyError(null);
    let args: unknown;
    try { args = JSON.parse(policyArgs); if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Action arguments must be a JSON object.'); }
    catch (caught) { setPolicyError(errorText(caught)); return; }
    const result = await special<unknown>('Policy simulation completed', '/api/policy/simulate', { actionId: policyActionId, args, ...(policyObjectId ? { objectId: policyObjectId } : {}) });
    if (result) setPolicyResult(result);
  };
  const propose = async (event: FormEvent) => {
    event.preventDefault();
    const result = await special<Record<string, unknown>>('Ontology proposal created', '/api/ontology/propose', { text: proposalText, name: proposalName });
    if (result) { setProposal(result); setProposalOpen(false); setProposalText(''); setFocusId(textValue(asRecord(result.ontology).id, '')); }
  };
  return <><PageTitle title="Ontology" subtitle="Model business types, relationships, rules, and actions as one reviewed contract." actions={<>{canBuild && <button className="button secondary" type="button" onClick={() => setProposalOpen((open) => !open)}><Sparkles size={16} />Propose from text</button>}{canRelease && selected && <button className="button primary" type="button" disabled={busy || !reviewApproved} title={reviewApproved ? 'Create release' : 'Owner review is required first'} onClick={() => void publish()}><GitBranchPlus size={16} />Create release</button>}</>} />
    {proposalOpen && <form className="panel input-panel" onSubmit={propose}><div className="panel-heading"><div><h2>Propose a model change</h2><p>Paste approved business text. The proposal remains a draft for review.</p></div><button className="icon-button" type="button" onClick={() => setProposalOpen(false)} aria-label="Close proposal form"><X size={17} /></button></div><div className="form-grid"><label>Proposal name<input value={proposalName} onChange={(event) => setProposalName(event.target.value)} required /></label><label className="span-2">Source text<textarea value={proposalText} onChange={(event) => setProposalText(event.target.value)} required rows={5} placeholder="Paste the policy or process description with its source context." /></label></div><button className="button primary" type="submit" disabled={busy || !proposalText.trim()}><Sparkles size={16} />Create draft proposal</button></form>}
    {proposal && <div className="result-strip"><BadgeCheck size={18} /><div><strong>{textValue(asRecord(proposal.proposal).name, 'Draft proposal created')}</strong><span>{asArray(proposal.reviewGaps).length} review gaps · {textValue(proposal.method, 'proposal')}</span>{asArray(proposal.reviewGaps).length > 0 && <ul>{asArray(proposal.reviewGaps).map((gap, index) => <li key={index}>{textValue(gap)}</li>)}</ul>}</div><button className="mini-link" onClick={() => { setFocusId(textValue(asRecord(proposal.ontology).id, '')); document.querySelector('.record-workbench')?.scrollIntoView({ behavior: 'smooth' }); }}>Open draft<ArrowRight size={15} /></button></div>}
    <section className="panel ontology-canvas"><div className="panel-heading"><div><h2>{bundle?.name ?? 'Model canvas'}</h2><p>{bundle ? `${bundle.objects.length} object types · ${bundle.relations.length} relations · ${bundle.actions.length} actions` : 'Select an ontology to inspect its model.'}</p></div><div className="inline-actions">{selected && <span className="subtle-tag">Revision {selected.revision}</span>}{canBuild && <button className="button small secondary" disabled={!bundle || busy} onClick={() => void validate()}><ShieldCheck size={15} />Validate</button>}</div></div><OntologyGraph bundle={bundle} selectedId={selectedNode} onSelect={setSelectedNode} />{selectedType && <div className="canvas-inspector"><div><strong>{selectedType.name}</strong><code>{selectedType.id}</code></div><p>{selectedType.description ?? 'No description recorded for this object type.'}</p><span>{selectedType.properties.length} properties · {selectedType.sourceRefs?.length ?? 0} source references</span></div>}</section>
    {validation && <section className="panel validation-panel"><div className="panel-heading"><div><h2>Validation result</h2><p>Checked against the current ontology contract.</p></div><StatusBadge value={validation.valid === true ? 'Passed' : 'Failed'} /></div>{asArray(validation.diagnostics).length ? <div className="diagnostic-list">{asArray(validation.diagnostics).map((item, index) => { const diagnostic = asRecord(item); return <div key={index}><StatusBadge value={diagnostic.severity} /><code>{textValue(diagnostic.path)}</code><span>{textValue(diagnostic.message)}</span></div>; })}</div> : <p className="muted panel-message">No diagnostics reported.</p>}<JsonInspector value={validation.summary ?? validation} title="Validation details" /></section>}
    {selected && <section className="panel review-panel"><div className="panel-heading"><div><h2>Owner review</h2><p>Generated gaps need explicit acknowledgment before this revision can be released.</p></div><StatusBadge value={review.status ?? selected.state} /></div>{gaps.length > 0 && <div className="review-gaps"><strong>Open review gaps</strong>{gaps.map((gap) => <label key={gap}><input type="checkbox" checked={acknowledged.includes(gap)} disabled={!canRelease || reviewApproved} onChange={(event) => setAcknowledged((current) => event.target.checked ? [...current, gap] : current.filter((item) => item !== gap))} /><span>{gap}</span></label>)}</div>}{reviewApproved ? <p className="review-approved"><BadgeCheck size={17} />Approved by {textValue(review.actorId, 'owner')} {review.at ? `on ${dateLabel(review.at)}` : ''}</p> : canRelease ? <form onSubmit={submitReview} className="review-form"><label>Review decision note<textarea value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} required rows={2} /></label><button className="button secondary" type="submit" disabled={busy || gaps.some((gap) => !acknowledged.includes(gap))}><ShieldCheck size={16} />Approve this revision</button></form> : <p className="muted panel-message">A workspace release owner must review this revision.</p>}</section>}
    {bundle && bundle.actions.length > 0 && <section className="panel policy-panel"><div className="panel-heading"><div><h2>Policy simulation</h2><p>Evaluate an action with sample arguments before running it.</p></div><ShieldCheck size={18} /></div><form onSubmit={simulatePolicy} className="form-grid"><label>Action<select value={policyActionId} onChange={(event) => setPolicyActionId(event.target.value)} required><option value="">Choose an action</option>{bundle.actions.map((action) => <option key={action.id} value={action.id}>{action.name}</option>)}</select></label><label>Object ID, if needed<input value={policyObjectId} onChange={(event) => setPolicyObjectId(event.target.value)} placeholder="PR-42" /></label><label className="span-2">Arguments JSON<textarea className="code-editor small-code" value={policyArgs} onChange={(event) => setPolicyArgs(event.target.value)} spellCheck={false} /></label>{policyError && <div className="span-2"><ErrorBanner message={policyError} /></div>}<button className="button secondary" disabled={busy || !policyActionId}><ShieldCheck size={16} />Simulate policy</button></form>{policyResult !== null && <JsonInspector value={policyResult} title="Policy decision" />}</section>}
    <div className="section-separator"><h2>Definition records</h2><p>Edit JSON and save a new revision before creating a release.</p></div><RecordWorkbench kind="ontologies" records={records} canBuild={canBuild} busy={busy} create={create} update={update} remove={remove} initialData={(name) => ({ bundle: initialBundle(name) as unknown as Record<string, unknown> })} focusId={focusId} onSelect={setSelected} />
  </>;
}

function ObjectScreen({ records, special, ...props }: MutationProps & { records: EntityRecord[]; special: Special }) {
  const [query, setQuery] = useState('');
  const [objectTypeId, setObjectTypeId] = useState('');
  const [queryResults, setQueryResults] = useState<EntityRecord[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [relationResults, setRelationResults] = useState<EntityRecord[] | null>(null);
  const [relationError, setRelationError] = useState<string | null>(null);
  const displayed = queryResults ?? records;
  const selected = displayed.find((record) => record.id === selectedId) ?? displayed[0];
  const objectTypes = [...new Set(records.map((record) => textValue(asRecord(record.data).objectTypeId, '')).filter(Boolean))].sort();
  const searchObjects = async (event: FormEvent) => {
    event.preventDefault();
    const result = await special<EntityRecord[] | { items: EntityRecord[] }>('Object query completed', '/api/objects/query', { ...(query ? { search: query } : {}), ...(objectTypeId ? { objectTypeId } : {}), limit: 100 });
    if (result) { setQueryResults(Array.isArray(result) ? result : asArray(asRecord(result).items) as EntityRecord[]); setSelectedId(null); setRelationResults(null); }
  };
  const loadRelations = async () => {
    if (!selected) return;
    setRelationError(null);
    try { const result = await api.get<EntityRecord[]>(`/api/objects/${encodeURIComponent(selected.id)}/relations`); setRelationResults(result); }
    catch (caught) { setRelationError(errorText(caught)); }
  };
  return <><PageTitle title="Objects" subtitle="Search source-backed instances and inspect their current revision and provenance." /><section className="panel table-panel"><div className="panel-heading"><div><h2>Object registry</h2><p>{queryResults ? `${displayed.length} query results` : `${records.length} instances in this workspace`}</p></div></div><form className="object-query-bar" onSubmit={searchObjects}><label className="search-field compact"><Search size={16} /><input aria-label="Search objects" placeholder="Search objects" value={query} onChange={(event) => setQuery(event.target.value)} /></label><select aria-label="Filter object type" value={objectTypeId} onChange={(event) => setObjectTypeId(event.target.value)}><option value="">All object types</option>{objectTypes.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select><button className="button secondary" disabled={props.busy} type="submit"><Search size={15} />Query objects</button>{queryResults && <button type="button" className="button ghost" onClick={() => { setQueryResults(null); setQuery(''); setObjectTypeId(''); }}>Clear</button>}</form>{displayed.length ? <div className="table-scroll"><table><thead><tr><th>Name</th><th>Object type</th><th>Source</th><th>Source revision</th><th>Observed</th></tr></thead><tbody>{displayed.map((record) => { const data = asRecord(record.data); return <tr key={record.id} className={selected?.id === record.id ? 'selected-row' : ''}><td><button className="table-link" onClick={() => { setSelectedId(record.id); setRelationResults(null); }}>{record.name}</button></td><td>{textValue(data.objectTypeId)}</td><td>{textValue(asRecord(data.source).system ?? data.source)}</td><td><code>{shortHash(data.sourceRevision)}</code></td><td>{dateLabel(data.observedAt)}</td></tr>; })}</tbody></table></div> : <EmptyState title="No objects found" description={records.length ? 'Try another search term or object type.' : 'Connect a source or create a native object to populate the registry.'} />}</section>{selected && <div className="object-detail-grid"><section className="panel detail-panel"><div className="panel-heading"><div><h2>{selected.name}</h2><p>{selected.id}</p></div><StatusBadge value={selected.state} /></div><KeyValue label="Object type">{textValue(asRecord(selected.data).objectTypeId)}</KeyValue><KeyValue label="Source">{textValue(asRecord(asRecord(selected.data).source).system ?? asRecord(selected.data).source)}</KeyValue><KeyValue label="Revision"><code>{shortHash(asRecord(selected.data).sourceRevision)}</code></KeyValue><KeyValue label="Observed">{dateLabel(asRecord(selected.data).observedAt)}</KeyValue><div className="relation-control"><button className="button small secondary" onClick={() => void loadRelations()}><Network size={15} />View relations</button></div>{relationError && <div className="relation-error"><ErrorBanner message={relationError} /></div>}{relationResults && <div className="relation-list"><strong>{relationResults.length} related objects</strong>{relationResults.map((record) => <div key={record.id}>{record.name}<small>{textValue(asRecord(record.data).objectTypeId)}</small></div>)}{relationResults.length === 0 && <p>No relations are available for this object.</p>}</div>}</section><JsonInspector value={asRecord(selected.data).properties ?? selected.data} title="Properties" /></div>}<div className="section-separator"><h2>Object records</h2><p>Manage workspace-owned object records and their source references.</p></div><RecordWorkbench kind="objects" records={records} {...props} canEditRecord={(record) => asRecord(asRecord(record.data).source).system === 'onto'} initialData={() => ({ objectTypeId: '', properties: {}, source: { system: 'onto' }, sourceRevision: '1', observedAt: new Date().toISOString() })} /></>;
}

function KnowledgeScreen({ records, special, ...props }: MutationProps & { records: EntityRecord[]; special: Special }) {
  const [name, setName] = useState(''); const [source, setSource] = useState(''); const [rawText, setRawText] = useState('');
  const [transformed, setTransformed] = useState<EntityRecord | null>(null);
  const transform = async (event: FormEvent) => { event.preventDefault(); const result = await special<EntityRecord>('Knowledge draft created', '/api/knowledge/transform', { name, text: rawText, source }); if (result) { setTransformed(result); setRawText(''); setName(''); } };
  return <><PageTitle title="Knowledge" subtitle="Turn source material into reviewed, source-linked Markdown." /><section className="panel input-panel"><div className="panel-heading"><div><h2>Transform source text</h2><p>The output is a draft. Review evidence before using it in a release.</p></div><FileText size={18} /></div>{props.canBuild ? <form onSubmit={transform}><div className="form-grid"><label>Document name<input value={name} onChange={(event) => setName(event.target.value)} required placeholder="Purchase approval policy" /></label><label>Source reference<input value={source} onChange={(event) => setSource(event.target.value)} required placeholder="Policy repository / revision" /></label><label className="span-2">Source text<textarea rows={6} value={rawText} onChange={(event) => setRawText(event.target.value)} required placeholder="Paste a policy, process note, or documented business rule." /></label></div><button className="button primary" disabled={props.busy || !rawText.trim()}><Sparkles size={16} />Create Markdown draft</button></form> : <p className="muted">Builder permission is required to transform knowledge.</p>}</section>{transformed && <section className="panel knowledge-preview"><div className="panel-heading"><div><h2>{transformed.name}</h2><p>Created as a reviewable knowledge record</p></div><StatusBadge value={transformed.state} /></div><pre>{textValue(asRecord(transformed.data).markdown, 'No Markdown returned')}</pre><small>{asArray(asRecord(transformed.data).evidence).length} source spans · {asArray(asRecord(transformed.data).reviewGaps).length} review gaps</small></section>}<div className="section-separator"><h2>Knowledge records</h2><p>Edit reviewed Markdown and source metadata by revision.</p></div><RecordWorkbench kind="knowledge" records={records} {...props} /></>;
}

function ConnectorScreen({ records, special, canTest, canSync, ...props }: MutationProps & { records: EntityRecord[]; special: Special; canTest: boolean; canSync: boolean }) {
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [resultKind, setResultKind] = useState<'test' | 'sync' | null>(null);
  const [selected, setSelected] = useState<EntityRecord | undefined>(records[0]);
  const operate = async (kind: 'test' | 'sync') => {
    if (!selected) return;
    const response = await special<Record<string, unknown>>(
      kind === 'sync' ? 'Source objects refreshed' : 'Connector test completed',
      `/api/connectors/${encodeURIComponent(selected.id)}/${kind}`, {},
    );
    if (response) { setResult(response); setResultKind(kind); }
  };
  return <>
    <PageTitle title="Connectors" subtitle="Keep ERP, CRM, MRP, and custom systems authoritative through reviewed bindings." actions={selected && (canSync || canTest) && <>
      {canSync && <button className="button secondary" disabled={props.busy} onClick={() => void operate('sync')}><RefreshCw size={16} />Refresh source objects</button>}
      {canTest && <button className="button secondary" disabled={props.busy} onClick={() => void operate('test')}><Cable size={16} />Test connection</button>}
    </>} />
    <div className="connector-guidance"><Database size={16} /><span>Source objects are materialized snapshots. Refresh reads the external system; governed actions handle writes and receipt verification.</span></div>
    {result && <section className="panel result-panel"><div className="panel-heading"><div><h2>{resultKind === 'sync' ? 'Source refresh' : 'Connection test'}</h2><p>{resultKind === 'sync' ? `${textValue(result.refreshed, '0')} objects observed at ${dateLabel(result.observedAt)}` : 'Read-only capability and reachability evidence'}</p></div><StatusBadge value={result.health ?? result.status ?? result.state ?? 'Completed'} /></div><JsonInspector value={result} title={resultKind === 'sync' ? 'Freshness evidence' : 'Test evidence'} /></section>}
    <RecordWorkbench kind="connectors" records={records} {...props} onSelect={setSelected} />
  </>;
}

function ContextScreen({ profiles, special, ...props }: MutationProps & { profiles: EntityRecord[]; special: Special }) {
  const [prompt, setPrompt] = useState('Why is purchase request PR-42 pending?');
  const [profileId, setProfileId] = useState('');
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const inspect = async (event: FormEvent) => { event.preventDefault(); const response = await special<Record<string, unknown>>('Context inspected', '/api/context/inspect', { prompt, ...(profileId ? { profileId } : {}) }); if (response) setResult(response); };
  return <><PageTitle title="Context inspector" subtitle="See the cited facts an agent can receive for a specific task." /><section className="panel input-panel"><div className="panel-heading"><div><h2>Inspect a task context</h2><p>Retrieval is authorized for your current identity and profile.</p></div><ScanSearch size={18} /></div><form onSubmit={inspect}><div className="form-grid"><label className="span-2">Task or question<textarea rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} required /></label><label>Context profile<select value={profileId} onChange={(event) => setProfileId(event.target.value)}><option value="">Default profile</option>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select></label></div><button className="button primary" disabled={props.busy || !prompt.trim()}><ScanSearch size={16} />Inspect context</button></form></section>{result && <section className="panel context-result"><div className="panel-heading"><div><h2>Context pack</h2><p>{dateLabel(result.generatedAt)} · {textValue(result.bytes, '0')} bytes</p></div><StatusBadge value={result.truncated === true ? 'Truncated' : 'Complete'} /></div><div className="context-items">{asArray(result.items).map((item, index) => { const value = asRecord(item); return <article key={textValue(value.id, String(index))}><span className="context-kind">{textValue(value.kind)}</span><h3>{textValue(value.title, 'Context item')}</h3><p>{textValue(value.text, '')}</p><footer><span>{textValue(value.source)}</span><span>{shortHash(value.sourceRevision)}</span><span>{dateLabel(value.observedAt)}</span><StatusBadge value={value.freshness} /></footer></article>; })}{asArray(result.items).length === 0 && <EmptyState title="No context items" description="The profile found no authorized matching facts. Review sources and profile configuration." />}</div><div className="context-excluded">Excluded: {Object.entries(asRecord(result.excluded)).map(([key, value]) => `${key} ${textValue(value, '0')}`).join(' · ') || 'none'}</div><JsonInspector value={result} title="Pack details" /></section>}<div className="section-separator"><h2>Context profiles</h2><p>Versioned selection and freshness rules.</p></div><RecordWorkbench kind="contextProfiles" records={profiles} {...props} /></>;
}

function TaskScreen({ agents, runs, canOperate, busy, special, navigate }: { agents: EntityRecord[]; runs: EntityRecord[]; canOperate: boolean; busy: boolean; special: Special; navigate: (view: View) => void }) {
  const sandboxAgent = agents.some((agent) => agent.id === 'procurement-agent');
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [prompt, setPrompt] = useState(sandboxAgent ? 'Inspect PO-2026-001' : '');
  const [created, setCreated] = useState<EntityRecord | null>(null);
  const liveRun = created ? runs.find((run) => run.id === created.id) ?? created : null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const response = await special<EntityRecord>('Task run started', '/api/runs', { agentId, prompt });
    if (response) setCreated(response);
  };
  return <>
    <PageTitle title="Task runner" subtitle="Start a bounded agent task with pinned ontology and governed tools." actions={<button className="button secondary" type="button" onClick={() => navigate('runs')}><Activity size={16} />View all runs</button>} />
    <div className="task-layout"><section className="panel input-panel task-composer"><div className="panel-heading"><div><h2>Start a business task</h2><p>The agent can propose actions; the gateway decides whether they run.</p></div><Bot size={19} /></div>
      {canOperate ? <form onSubmit={submit}><label>Agent<select value={agentId} onChange={(event) => setAgentId(event.target.value)} required>{agents.length ? agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>) : <option value="">No agents available</option>}</select></label>
        <label>Task instructions<textarea rows={8} value={prompt} onChange={(event) => setPrompt(event.target.value)} required placeholder="Describe the business outcome and relevant object." /></label>
        {sandboxAgent && <div className="task-examples"><span>Sandbox examples</span><button type="button" onClick={() => setPrompt('Inspect PO-2026-001')}>Inspect PO-2026-001</button><button type="button" onClick={() => setPrompt('Approve PO-2026-001')}>Approve PO-2026-001</button></div>}
        <div className="task-guidance"><ShieldCheck size={16} /><span>Business writes require policy checks, preview, and source verification.</span></div><button className="button primary" disabled={busy || !agentId || !prompt.trim()}><Play size={16} />Start run</button>
      </form> : <EmptyState title="Operator access required" description="Ask an administrator for operate permission to start a task." />}</section>
      <section className="panel task-aside"><div className="panel-heading"><div><h2>Recent runs</h2><p>Open a run to inspect the latest audited steps.</p></div></div>{runs.length ? <div className="compact-list">{runs.slice(0, 6).map((run) => <button key={run.id} type="button" onClick={() => navigate('runs')}><span className="compact-icon"><Activity size={17} /></span><span><strong>{run.name}</strong><small>{dateLabel(run.createdAt)}</small></span><StatusBadge value={run.state} /></button>)}</div> : <EmptyState title="No runs yet" description="Start a task to see its trace and outcome here." />}</section>
    </div>
    {liveRun && <section className="panel result-panel"><div className="panel-heading"><div><h2>Run status</h2><p>{liveRun.id} · updates while this page is open</p></div><StatusBadge value={liveRun.state} /></div><div className="run-status-actions"><button className="button small secondary" onClick={() => navigate('runs')}>Open trace<ArrowRight size={15} /></button></div>{asRecord(liveRun.data).result !== undefined && <JsonInspector value={asRecord(liveRun.data).result} title="Current outcome" />}</section>}
  </>;
}

function RunsScreen({ runs, audit, canOperate, busy, special }: { runs: EntityRecord[]; audit: BootstrapResponse['audit']; canOperate: boolean; busy: boolean; special: Special }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [operationResult, setOperationResult] = useState<unknown>(null);
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
  const data = asRecord(selected?.data);
  const result = asRecord(data.result);
  const checkpoint = asRecord(result.checkpoint);
  const history = asArray(checkpoint.history);
  const events = audit.filter((event) => event.subjectId === selected?.id && (event.kind.startsWith('runtime.') || event.kind.startsWith('run.')));
  const mayResume = selected?.state === 'approval_required' || selected?.state === 'unknown';
  const isTerminal = selected ? ['completed', 'cancelled', 'cancelled_pending_reconciliation', 'timed_out', 'exhausted', 'failed'].includes(selected.state) : true;
  const operate = async (operation: 'resume' | 'cancel') => {
    if (!selected) return;
    const response = await special<unknown>(`Run ${operation} requested`, `/api/runs/${encodeURIComponent(selected.id)}/${operation}`, {});
    if (response) setOperationResult(response);
  };
  return <>
    <PageTitle title="Runs and traces" subtitle="Inspect model decisions, tool effects, approvals, and receipts in one record." />
    <div className="record-workbench runs-layout">
      <section className="panel record-list">
        <div className="record-list-top"><strong>{runs.length} runs</strong><Activity size={17} /></div>
        <div className="record-items">{runs.map((run) => <button type="button" key={run.id} className={`record-item ${selected?.id === run.id ? 'selected' : ''}`} onClick={() => { setSelectedId(run.id); setOperationResult(null); }}><span className="record-item-mark" /><span><strong>{run.name}</strong><small>{dateLabel(run.createdAt)}</small></span><StatusBadge value={run.state} /></button>)}{runs.length === 0 && <div className="list-empty">No runs have started.</div>}</div>
      </section>
      <section className="panel run-detail">{selected ? <>
        <div className="panel-heading"><div><h2>{selected.name}</h2><p>{selected.id} · started {dateLabel(selected.createdAt)}</p></div><StatusBadge value={selected.state} /></div>
        <div className="run-meta"><KeyValue label="Agent">{textValue(data.agentId)}</KeyValue><KeyValue label="Release"><code>{shortHash(data.releaseId)}</code></KeyValue><KeyValue label="Actor">{textValue(data.actorId)}</KeyValue></div>
        {canOperate && <div className="inline-actions run-actions"><button className="button secondary" disabled={busy || !mayResume} onClick={() => void operate('resume')}><Play size={15} />Resume</button><button className="button danger-quiet" disabled={busy || isTerminal} onClick={() => void operate('cancel')}><Square size={15} />Cancel run</button></div>}
        {(result.text || result.reason || data.error) && <div className="run-outcome"><strong>Outcome</strong><p>{textValue(result.text ?? result.reason ?? data.error)}</p></div>}
        {events.length > 0 ? <div className="trace-list"><h3>Execution events</h3>{events.map((event, index) => <article key={event.id}><span className="trace-index">{index + 1}</span><div><div><strong>{event.kind.replace(/^runtime\./, '').replaceAll('_', ' ')}</strong><time>{dateLabel(event.at)}</time></div><pre>{pretty(event.details)}</pre></div></article>)}</div> : <div className="trace-empty"><Clock3 size={17} />No audited run events are visible for this account yet.</div>}
        {history.length > 0 && <div className="trace-list checkpoint-history"><h3>Checkpoint history</h3>{history.map((item, index) => { const entry = asRecord(item); return <article key={index}><span className="trace-index">{index + 1}</span><div><div><strong>{textValue(entry.role, 'Step').replaceAll('_', ' ')}</strong></div><p>{textValue(entry.text ?? entry.toolName, '')}</p>{entry.args !== undefined && <pre>{pretty(entry.args)}</pre>}</div></article>; })}</div>}
        {operationResult !== null && <JsonInspector value={operationResult} title="Latest operation response" />}
        <JsonInspector value={selected.data} title="Run record" />
      </> : <EmptyState title="No run selected" description="Start a task to inspect its execution trace." />}</section>
    </div>
  </>;
}

function ApprovalScreen({ approvals, actorId, canApprove, canOperate, busy, special }: { approvals: BootstrapResponse['approvals']; actorId: string; canApprove: boolean; canOperate: boolean; busy: boolean; special: Special }) {
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const [decisionResult, setDecisionResult] = useState<unknown>(null);
  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    const response = await special<unknown>(`Approval ${decision}`, `/api/approvals/${encodeURIComponent(id)}`, { decision, reason: reasonById[id] ?? '' });
    if (response) setDecisionResult(response);
  };
  const reconcile = async (id: string) => {
    const response = await special<unknown>('Source outcome reconciled', `/api/intents/${encodeURIComponent(id)}/reconcile`, {});
    if (response) setDecisionResult(response);
  };
  return <>
    <PageTitle title="Approvals" subtitle="Review exact action intents before source systems are changed." />
    <div className="approval-list">{approvals.length ? approvals.map((item) => <section className="panel approval-card" key={item.id}>
      <div className="approval-card-top"><div><span className="approval-kind"><ClipboardCheck size={15} />Action approval</span><h2>{item.name}</h2><p>{item.summary}</p></div><StatusBadge value={item.state} /></div>
      <div className="approval-meta"><KeyValue label="Requested by">{item.actorId}</KeyValue><KeyValue label="Intent hash"><code>{shortHash(item.intentHash)}</code></KeyValue><KeyValue label="Created">{dateLabel(item.createdAt)}</KeyValue></div>
      <div className="approval-effects"><strong>Expected effects</strong>{item.effects.length ? <ul>{item.effects.map((effect, index) => <li key={`${effect}-${index}`}>{effect}</li>)}</ul> : <p>No effect description is available. Inspect the action before approving.</p>}</div>
      {item.state === 'awaiting_approval' && canApprove && item.actorId !== actorId ? <div className="approval-controls"><label>Reason or review note<input value={reasonById[item.id] ?? ''} onChange={(event) => setReasonById((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="Add a review note" /></label><div><button className="button primary" type="button" disabled={busy} onClick={() => void decide(item.id, 'approved')}><Check size={16} />Approve exact intent</button><button className="button danger-quiet" type="button" disabled={busy} onClick={() => void decide(item.id, 'rejected')}><X size={16} />Reject</button></div></div>
        : item.state === 'unknown' && canOperate ? <div className="approval-controls"><p>Source outcome is uncertain. Reconcile the recorded intent before another action.</p><button className="button secondary" type="button" disabled={busy} onClick={() => void reconcile(item.id)}><RefreshCw size={16} />Reconcile source outcome</button></div>
        : <p className="approval-warning">{item.actorId === actorId && item.state === 'awaiting_approval' ? 'You initiated this action. A different authorized operator must review it.' : item.state === 'awaiting_approval' ? 'Approve permission is required to decide this action.' : 'The action is being processed. Refresh for its latest source outcome.'}</p>}
    </section>) : <EmptyState icon={<ClipboardCheck size={24} />} title="No approvals waiting" description="Action intents requiring review will appear here with their exact effect and hash." />}</div>
    {decisionResult !== null && <JsonInspector value={decisionResult} title="Latest decision or reconciliation" />}
  </>;
}

function ReleasesScreen({ records, ontologies, canRelease, busy, special }: { records: EntityRecord[]; ontologies: EntityRecord[]; canRelease: boolean; busy: boolean; special: Special }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ontologyId, setOntologyId] = useState(ontologies[0]?.id ?? '');
  const [result, setResult] = useState<unknown>(null);
  const selected = records.find((record) => record.id === selectedId) ?? records[0];
  const createRelease = async () => { const ontology = ontologies.find((item) => item.id === ontologyId); if (!ontology) return; const response = await special<EntityRecord>('Release created for review', '/api/releases', { ontologyId: ontology.id, revision: ontology.revision }); if (response) { setResult(response); setSelectedId(response.id); } };
  const activate = async () => { if (!selected) return; const response = await special<unknown>('Release activation requested', `/api/releases/${encodeURIComponent(selected.id)}/activate`, {}); if (response) setResult(response); };
  const gates = asArray(asRecord(selected?.data).gates);
  return <><PageTitle title="Releases" subtitle="Publish a reviewed ontology revision, inspect gates, and activate only when they pass." />{canRelease && <section className="panel release-creator"><div><h2>Create release</h2><p>Choose a saved ontology revision for the quality gate.</p></div><div className="inline-actions"><select aria-label="Ontology to release" value={ontologyId} onChange={(event) => setOntologyId(event.target.value)}>{ontologies.length ? ontologies.map((item) => <option key={item.id} value={item.id}>{item.name} · revision {item.revision}</option>) : <option value="">No ontologies available</option>}</select><button className="button secondary" disabled={!ontologyId || busy} onClick={() => void createRelease()}><Plus size={16} />Create release</button></div></section>}<div className="record-workbench release-layout"><section className="panel record-list"><div className="record-list-top"><strong>{records.length} releases</strong><GitBranchPlus size={17} /></div><div className="record-items">{records.map((record) => <button type="button" key={record.id} className={`record-item ${selected?.id === record.id ? 'selected' : ''}`} onClick={() => setSelectedId(record.id)}><span className="record-item-mark" /><span><strong>{record.name}</strong><small>{dateLabel(record.createdAt)}</small></span><StatusBadge value={record.state} /></button>)}{records.length === 0 && <div className="list-empty">No releases have been created.</div>}</div></section><section className="panel release-detail">{selected ? <><div className="panel-heading"><div><h2>{selected.name}</h2><p>{selected.id} · revision {selected.revision}</p></div><StatusBadge value={selected.state} /></div><div className="release-hash"><span>Manifest hash</span><code>{shortHash(asRecord(selected.data).manifestHash)}</code></div><h3>Quality gates</h3>{gates.length ? <div className="gate-list">{gates.map((item, index) => { const gate = asRecord(item); return <div key={textValue(gate.id, String(index))}><StatusBadge value={gate.status} /><span><strong>{textValue(gate.name)}</strong><small>{asArray(gate.details).map((detail) => textValue(detail)).join('; ')}</small></span></div>; })}</div> : <EmptyState title="No gate results" description="Release activation requires recorded quality evidence." />}{canRelease && <button className="button primary release-activate" disabled={busy || selected.state !== 'ready' || !gates.length || gates.some((item) => asRecord(item).status !== 'pass')} onClick={() => void activate()}><BadgeCheck size={16} />Activate release</button>}<JsonInspector value={selected.data} title="Release manifest and review" /></> : <EmptyState title="No release selected" description="Create a release from an ontology revision to inspect its quality gates." />}</section></div>{result && <JsonInspector value={result} title="Latest release response" />}</>;
}

function EvaluationScreen({ records, canBuild, busy, special }: { records: EntityRecord[]; canBuild: boolean; busy: boolean; special: Special }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const selected = records.find((record) => record.id === selectedId) ?? records[0];
  const run = async () => { const response = await special<EntityRecord>('Evaluation completed', '/api/evaluations/run', {}); if (response) { setResult(response); setSelectedId(response.id); } };
  const data = asRecord(selected?.data); const summary = asRecord(data.summary); const cases = asArray(data.results);
  return <><PageTitle title="Evaluations" subtitle="Measure task behavior and guard against regressions before release." actions={canBuild && <button className="button primary" disabled={busy} onClick={() => void run()}><FlaskConical size={16} />Run evaluation</button>} /><div className="record-workbench"><section className="panel record-list"><div className="record-list-top"><strong>{records.length} evaluation runs</strong><FlaskConical size={17} /></div><div className="record-items">{records.map((record) => <button type="button" key={record.id} className={`record-item ${selected?.id === record.id ? 'selected' : ''}`} onClick={() => setSelectedId(record.id)}><span className="record-item-mark" /><span><strong>{record.name}</strong><small>{dateLabel(record.createdAt)}</small></span><StatusBadge value={record.state} /></button>)}{records.length === 0 && <div className="list-empty">No evaluations have run.</div>}</div></section><section className="panel evaluation-detail">{selected ? <><div className="panel-heading"><div><h2>{selected.name}</h2><p>{dateLabel(data.executedAt ?? selected.createdAt)}</p></div><StatusBadge value={selected.state} /></div><div className="eval-counts"><div><strong>{textValue(summary.passed, '0')}</strong><span>Passed</span></div><div><strong>{textValue(summary.failed, '0')}</strong><span>Failed</span></div><div><strong>{cases.length}</strong><span>Total checks</span></div></div>{cases.length ? <div className="gate-list eval-cases">{cases.map((item, index) => { const check = asRecord(item); return <div key={textValue(check.id, String(index))}><StatusBadge value={check.status} /><span><strong>{textValue(check.name)}</strong><small>Expected {textValue(check.expected)} · actual {textValue(check.actual)}</small></span></div>; })}</div> : <EmptyState title="No case results" description="This record does not include detailed evaluation cases." />}<JsonInspector value={data} title="Evaluation evidence" /></> : <EmptyState title="No evaluation selected" description="Run the deterministic suite to generate evidence." />}</section></div>{result && <JsonInspector value={result} title="Latest evaluation response" />}</>;
}

function AuditScreen({ records, canAdmin }: { records: BootstrapResponse['audit']; canAdmin: boolean }) {
  const [query, setQuery] = useState('');
  const filtered = records.filter((record) => `${record.kind} ${record.actorId} ${record.subjectId} ${pretty(record.details)}`.toLowerCase().includes(query.toLowerCase()));
  if (!canAdmin) return <><PageTitle title="Audit trail" subtitle="Governed workspace history and runtime decisions." /><section className="panel"><EmptyState title="Administrator access required" description="Ask a workspace administrator to review tenant audit events." /></section></>;
  return <><PageTitle title="Audit trail" subtitle="Tenant-scoped history of reviewed changes and runtime decisions." /><section className="panel table-panel"><div className="panel-heading"><div><h2>Recent events</h2><p>{records.length} audit entries loaded</p></div><label className="search-field compact"><Search size={16} /><input aria-label="Search audit events" placeholder="Search events" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>{filtered.length ? <div className="table-scroll"><table><thead><tr><th>When</th><th>Event</th><th>Actor</th><th>Subject</th><th>Details</th></tr></thead><tbody>{filtered.map((record) => <tr key={record.id}><td>{dateLabel(record.at)}</td><td><StatusBadge value={record.kind} /></td><td>{record.actorId}</td><td><code>{shortHash(record.subjectId)}</code></td><td><details><summary>Inspect</summary><pre className="table-json">{pretty(record.details)}</pre></details></td></tr>)}</tbody></table></div> : <EmptyState title="No matching audit events" description={records.length ? 'Try another search term.' : 'Audited changes and decisions will appear here.'} />}</section></>;
}

function tokenStatus(token: Record<string, unknown>): 'Active' | 'Expired' | 'Revoked' {
  if (token.revokedAt) return 'Revoked';
  const expiresAt = typeof token.expiresAt === 'string' ? Date.parse(token.expiresAt) : NaN;
  return Number.isFinite(expiresAt) && expiresAt <= Date.now() ? 'Expired' : 'Active';
}

function SettingsScreen({ session, health, canAdmin, busy, perform }: { session: SessionInfo; health: BootstrapResponse['health']; canAdmin: boolean; busy: boolean; perform: <T>(label: string, operation: () => Promise<T>) => Promise<T | undefined> }) {
  const [users, setUsers] = useState<Array<Record<string, unknown>>>([]);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, string>>({});
  const [tokens, setTokens] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [userPassword, setUserPassword] = useState('');
  const [userRole, setUserRole] = useState('operator');
  const [tokenName, setTokenName] = useState('');
  const [tokenScopes, setTokenScopes] = useState('read');
  const [newToken, setNewToken] = useState<Record<string, unknown> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [nextUsers, nextTokens] = await Promise.all([
        canAdmin ? api.users() : Promise.resolve([]),
        api.tokens(),
      ]);
      const userRecords = Array.isArray(nextUsers) ? nextUsers : [];
      setUsers(userRecords);
      setRoleDrafts(Object.fromEntries(userRecords.map((user) => [textValue(user.id), textValue(user.role, 'viewer')])));
      setTokens(Array.isArray(nextTokens) ? nextTokens : []);
    } catch (caught) { setLoadError(errorText(caught)); }
    finally { setLoading(false); }
  }, [canAdmin]);
  useEffect(() => { void load(); }, [load]);

  const addUser = async (event: FormEvent) => {
    event.preventDefault();
    const result = await perform('User created', () => api.createUser({ name: userName, email: userEmail, password: userPassword, role: userRole }, session.csrfToken));
    if (result) { setUserName(''); setUserEmail(''); setUserPassword(''); await load(); }
  };
  const updateRole = async (user: Record<string, unknown>) => {
    const id = textValue(user.id, '');
    const role = roleDrafts[id];
    if (!id || !role || role === user.role || id === session.user.actorId) return;
    const result = await perform('User role updated', () => api.updateUser(id, { role }, session.csrfToken));
    if (result) await load();
  };
  const toggleUser = async (user: Record<string, unknown>) => {
    const id = textValue(user.id, '');
    if (!id || id === session.user.actorId) return;
    const active = user.active === false;
    const result = await perform(active ? 'User enabled' : 'User disabled', () => api.updateUser(id, { active }, session.csrfToken));
    if (result) await load();
  };
  const addToken = async (event: FormEvent) => {
    event.preventDefault();
    const scopes = tokenScopes.split(',').map((value) => value.trim()).filter(Boolean);
    const result = await perform('API token created', () => api.createToken({ name: tokenName, scopes }, session.csrfToken));
    if (result) { setNewToken(result); setTokenName(''); await load(); }
  };
  const revokeToken = async (token: Record<string, unknown>) => {
    const id = textValue(token.id, '');
    if (!id || tokenStatus(token) !== 'Active') return;
    const result = await perform('API token revoked', () => api.revokeToken(id, session.csrfToken));
    if (result) {
      if (newToken?.id === id) setNewToken(null);
      await load();
    }
  };

  return <>
    <PageTitle title="Settings" subtitle="Workspace identity, runtime status, users, and API access." />
    <div className="settings-grid">
      <section className="panel settings-panel">
        <div className="panel-heading"><div><h2>Workspace</h2><p>Authenticated session and service status</p></div><Settings2 size={18} /></div>
        <KeyValue label="Workspace">{session.tenant.name}</KeyValue>
        <KeyValue label="Signed in as">{session.user.name} <span className="muted">({session.user.role})</span></KeyValue>
        <KeyValue label="Authentication">{session.authMode}</KeyValue>
        <KeyValue label="Environment">{health.environment}</KeyValue>
        <KeyValue label="Database"><StatusBadge value={health.database} /></KeyValue>
        <KeyValue label="Worker"><StatusBadge value={health.worker} /></KeyValue>
        <KeyValue label="Model"><StatusBadge value={health.model} /></KeyValue>
        <KeyValue label="Version">{health.version}</KeyValue>
      </section>
      <section className="panel settings-panel">
        <div className="panel-heading"><div><h2>Permissions</h2><p>Your effective workspace scopes</p></div><ShieldCheck size={18} /></div>
        <div className="scope-list">{session.user.scopes.map((scope) => <span key={scope}>{scope}</span>)}</div>
        <p className="muted">Server policy checks every action even when a control is visible here.</p>
      </section>
    </div>
    <div className="section-separator"><h2>Access management</h2><p>{canAdmin ? 'Manage workspace users and your own API tokens.' : 'Create and revoke API tokens scoped to your own permissions.'}</p></div>
    {loadError && <ErrorBanner message={loadError} onDismiss={() => setLoadError(null)} />}
    <div className={`settings-grid ${canAdmin ? '' : 'access-single'}`}>
      {canAdmin && <section className="panel settings-panel">
        <div className="panel-heading"><div><h2>Users</h2><p>{loading ? 'Loading users…' : `${users.length} workspace users`}</p></div><Users size={18} /></div>
        <div className="access-list">
          {users.map((user, index) => {
            const id = textValue(user.id, String(index));
            const name = textValue(user.name, 'Unknown user');
            const isSelf = id === session.user.actorId;
            const active = user.active !== false;
            const role = textValue(user.role, 'viewer');
            return <div className="user-entry" key={id}>
              <div className="access-entry-main"><span className="account-avatar small">{name.slice(0, 1)}</span><span className="access-entry-summary"><strong>{name}{isSelf ? ' (you)' : ''}</strong><small>{textValue(user.email)}</small></span><StatusBadge value={active ? 'Active' : 'Disabled'} /></div>
              <div className="user-controls">
                <label htmlFor={`user-role-${id}`}>Role for {name}</label>
                <select id={`user-role-${id}`} value={roleDrafts[id] ?? role} disabled={isSelf || busy} onChange={(event) => setRoleDrafts((current) => ({ ...current, [id]: event.target.value }))}>
                  <option value="viewer">Viewer</option><option value="builder">Builder</option><option value="operator">Operator</option><option value="admin">Administrator</option>
                </select>
                <button className="button secondary small" type="button" disabled={isSelf || busy || (roleDrafts[id] ?? role) === role} onClick={() => void updateRole(user)}>Save role</button>
                <button className="button secondary small" type="button" disabled={isSelf || busy} onClick={() => void toggleUser(user)}>{active ? 'Disable user' : 'Enable user'}</button>
              </div>
              {isSelf && <small className="access-hint">Another administrator must change your administrator access.</small>}
            </div>;
          })}
          {!loading && users.length === 0 && <div className="list-empty">No workspace users were returned.</div>}
        </div>
        <form className="settings-form" onSubmit={addUser}>
          <h3>Add user</h3>
          <label>Name<input value={userName} onChange={(event) => setUserName(event.target.value)} required /></label>
          <label>Email<input type="email" value={userEmail} onChange={(event) => setUserEmail(event.target.value)} required /></label>
          <label>Password<input type="password" value={userPassword} onChange={(event) => setUserPassword(event.target.value)} required minLength={12} /></label>
          <div className="settings-select-field"><label htmlFor="new-user-role">Role</label><select id="new-user-role" value={userRole} onChange={(event) => setUserRole(event.target.value)}><option value="operator">Operator</option><option value="builder">Builder</option><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></div>
          <button className="button secondary" disabled={busy}><Plus size={16} />Add user</button>
        </form>
      </section>}
      <section className="panel settings-panel">
        <div className="panel-heading"><div><h2>Your API tokens</h2><p>{loading ? 'Loading tokens…' : `${tokens.filter((token) => tokenStatus(token) === 'Active').length} active · ${tokens.length} total`}</p></div><UserRound size={18} /></div>
        <div className="access-list">
          {tokens.map((token, index) => {
            const id = textValue(token.id, String(index));
            const status = tokenStatus(token);
            return <div className="token-entry" key={id}>
              <div className="access-entry-main"><span className="compact-icon"><ShieldCheck size={16} /></span><span className="access-entry-summary"><strong>{textValue(token.name)}</strong><small>{asArray(token.scopes).map((value) => textValue(value)).join(', ')}</small></span><StatusBadge value={status} /></div>
              <div className="token-controls"><small>{status === 'Revoked' ? `Revoked ${dateLabel(token.revokedAt)}` : `Expires ${dateLabel(token.expiresAt)}`}</small><button className="button secondary small" type="button" disabled={status !== 'Active' || busy} onClick={() => void revokeToken(token)}>Revoke token</button></div>
            </div>;
          })}
          {!loading && tokens.length === 0 && <div className="list-empty">You have no API tokens yet.</div>}
        </div>
        <form className="settings-form" onSubmit={addToken}>
          <h3>Create scoped token</h3>
          <label>Name<input value={tokenName} onChange={(event) => setTokenName(event.target.value)} required placeholder="Integration client" /></label>
          <label>Scopes, comma separated<input value={tokenScopes} onChange={(event) => setTokenScopes(event.target.value)} required placeholder={session.user.scopes.join(', ')} /></label>
          <p className="access-hint">Choose scopes from your permissions above. Tokens expire after 30 days.</p>
          <button className="button secondary" disabled={busy}><Plus size={16} />Create token</button>
        </form>
        {newToken && <div className="token-result"><strong>Copy this token now</strong><p>The secret is shown once. Store it in a secret manager.</p><code>{textValue(newToken.token ?? newToken.secret ?? newToken.value, 'Token value was not returned')}</code></div>}
      </section>
    </div>
  </>;
}
