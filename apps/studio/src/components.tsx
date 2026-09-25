import { useMemo } from 'react';
import { AlertCircle, ArrowUpRight, Boxes, FileJson2, Inbox, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import type { OntologyBundle, ObjectTypeDefinition } from '../../../packages/contracts/src/index.js';

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
export function textValue(value: unknown, fallback = '—'): string {
  return typeof value === 'string' && value.trim() ? value : typeof value === 'number' ? String(value) : fallback;
}
export function pretty(value: unknown): string { return JSON.stringify(value, null, 2) ?? '{}'; }
export function dateLabel(value: unknown): string {
  if (typeof value !== 'string') return '—';
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(time) : value;
}
export function shortHash(value: unknown): string {
  const string = textValue(value, '—');
  return string.length > 20 ? `${string.slice(0, 14)}…${string.slice(-6)}` : string;
}

export function asBundle(value: unknown): OntologyBundle | null {
  const data = asRecord(value);
  const candidate = 'bundle' in data ? asRecord(data.bundle) : data;
  return Array.isArray(candidate.objects) && Array.isArray(candidate.relations) && Array.isArray(candidate.actions)
    ? candidate as unknown as OntologyBundle : null;
}

export function StatusBadge({ value }: { value: unknown }) {
  const label = textValue(value, 'Unknown');
  const normalized = label.toLowerCase();
  const tone = /^(pass|ok|online|fresh|complete|connected)$|active|passed|ready|verified|completed|success|approved|reviewed|healthy/.test(normalized) ? 'good'
    : /fail|error|denied|rejected|revoked|unknown/.test(normalized) ? 'bad'
    : /pending|await|draft|running|queued|review|warning/.test(normalized) ? 'warn' : 'neutral';
  return <span className={`status status-${tone}`}><span className="status-dot" />{label.replaceAll('_', ' ')}</span>;
}

export function PageTitle({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return <header className="page-title"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon">{icon ?? <Inbox size={24} />}</span><h3>{title}</h3><p>{description}</p>{action}</div>;
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return <div className="error-banner" role="alert"><AlertCircle size={17} /><span>{message}</span>{onDismiss && <button className="icon-button" type="button" onClick={onDismiss} aria-label="Dismiss error">×</button>}</div>;
}

export function BusyLabel({ children }: { children: ReactNode }) { return <span className="busy-label"><LoaderCircle size={15} className="spin" />{children}</span>; }

export function JsonInspector({ value, title = 'Details' }: { value: unknown; title?: string }) {
  return <section className="json-inspector"><div className="inspector-heading"><FileJson2 size={16} /><span>{title}</span></div><pre>{pretty(value)}</pre></section>;
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return <div className="key-value"><span>{label}</span><strong>{children}</strong></div>;
}

type GraphNode = { object: ObjectTypeDefinition; x: number; y: number };

export function OntologyGraph({ bundle, selectedId, onSelect }: { bundle: OntologyBundle | null; selectedId?: string; onSelect: (id: string) => void }) {
  const nodes = useMemo<GraphNode[]>(() => {
    if (!bundle) return [];
    const objects = bundle.objects.slice(0, 10);
    return objects.map((object, index) => {
      const angle = -Math.PI / 2 + index * (Math.PI * 2 / objects.length);
      const radiusX = objects.length === 1 ? 0 : objects.length < 4 ? 215 : 300;
      const radiusY = objects.length === 1 ? 0 : objects.length < 4 ? 125 : 165;
      return { object, x: 460 + Math.cos(angle) * radiusX, y: 211 + Math.sin(angle) * radiusY };
    });
  }, [bundle]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.object.id, node])), [nodes]);

  if (!bundle || nodes.length === 0) return <EmptyState icon={<Boxes size={24} />} title="No object types yet" description="Create or activate an ontology to see how business objects relate." />;

  return <div className="graph-wrap">
    <svg viewBox="0 0 920 430" className="ontology-graph" role="group" aria-label="Ontology object and relation graph">
      <defs>
        <pattern id="graph-grid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.8" fill="#d7e1e7" /></pattern>
        <marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="none" stroke="#8ea8b9" strokeWidth="1.4" /></marker>
      </defs>
      <rect x="0" y="0" width="920" height="430" fill="url(#graph-grid)" />
      {bundle.relations.map((relation) => {
        const from = byId.get(relation.from.objectTypeId);
        const to = byId.get(relation.to.objectTypeId);
        if (!from || !to) return null;
        const dx = to.x - from.x; const dy = to.y - from.y;
        const length = Math.hypot(dx, dy) || 1;
        const startX = from.x + dx / length * 78; const startY = from.y + dy / length * 38;
        const endX = to.x - dx / length * 79; const endY = to.y - dy / length * 40;
        return <g key={relation.id}><line x1={startX} y1={startY} x2={endX} y2={endY} stroke="#91aabb" strokeWidth="1.5" markerEnd="url(#graph-arrow)" />
          <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 7} textAnchor="middle" className="graph-edge-label">{relation.name}</text></g>;
      })}
      {nodes.map(({ object, x, y }) => <g key={object.id} className={`graph-node ${selectedId === object.id ? 'selected' : ''}`} role="button" tabIndex={0}
        aria-label={`Inspect ${object.name}`} onClick={() => onSelect(object.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(object.id); } }}>
        <rect x={x - 75} y={y - 34} rx="10" width="150" height="68" />
        <circle cx={x - 53} cy={y - 10} r="7" />
        <text x={x - 39} y={y - 6} className="graph-node-title">{object.name.length > 18 ? `${object.name.slice(0, 17)}…` : object.name}</text>
        <text x={x - 54} y={y + 17} className="graph-node-meta">{object.properties.length} properties</text>
      </g>)}
      {bundle.objects.length > nodes.length && <text x="895" y="410" textAnchor="end" className="graph-edge-label">+{bundle.objects.length - nodes.length} more types</text>}
    </svg>
    <p className="graph-mobile-hint">Swipe the graph to see every object type.</p>
    <div className="graph-index" role="group" aria-label="Object types">{bundle.objects.map((object) => <button key={object.id} type="button" className={selectedId === object.id ? 'selected' : ''} onClick={() => onSelect(object.id)}>{object.name}</button>)}</div>
  </div>;
}

export function MiniLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button className="mini-link" type="button" onClick={onClick}>{children}<ArrowUpRight size={14} /></button>;
}
