import { randomUUID } from 'node:crypto';
import { evaluateGuard } from '../../ontology-kernel/src/index.js';
import { PlatformError, requireScope, type EntityRecord, type PlatformStore, type Principal } from '../../platform-contracts/src/index.js';
import { canRead, nonempty, record, strings, visibleObject } from './common.js';

export interface ObjectQuery { objectTypeId?: string; search?: string; filters?: Array<{property: string; op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains'; value: string | number | boolean | null}>; limit?: number }
export interface ContextItem { id: string; kind: 'object' | 'knowledge'; title: string; text: string; source: unknown; sourceRevision: string; observedAt: string; freshness: 'fresh' }
export interface ContextPack { id: string; tenantId: string; profileId: string; prompt: string; generatedAt: string; items: ContextItem[]; bytes: number; maxBytes: number; truncated: boolean; excluded: { stale: number; unauthorized: number; overBudget: number } }
export interface ReleasedContextInput { prompt: string; profile: EntityRecord; knowledge: EntityRecord[] }

export class ObjectServices {
  constructor(protected readonly store: PlatformStore, protected readonly now: () => Date) {}

  async queryObjects(principal: Principal, query: ObjectQuery = {}): Promise<EntityRecord[]> {
    requireScope(principal, 'read');
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new PlatformError(400, 'invalid_limit', 'Object limit must be between 1 and 1000');
    return (await this.selectObjects(principal,query)).slice(0,limit);
  }

  private async selectObjects(principal:Principal,query:ObjectQuery):Promise<EntityRecord[]> {
    requireScope(principal,'read');
    if (query.filters && (!Array.isArray(query.filters) || query.filters.length > 20)) throw new PlatformError(400, 'invalid_filter', 'At most 20 property filters are allowed');
    const search = query.search?.toLocaleLowerCase();
    return (await this.store.list(principal.tenantId, 'objects')).flatMap(entity => {
      const visible = visibleObject(principal, entity);
      if (!visible || (query.objectTypeId && visible.data.objectTypeId !== query.objectTypeId)) return [];
      const properties = record(visible.data.properties);
      if (search && !`${visible.name} ${JSON.stringify(properties)}`.toLocaleLowerCase().includes(search)) return [];
      if (query.filters?.some(filter => !Object.hasOwn(properties, filter.property) || evaluateGuard({op: filter.op, left: {kind:'fact',path:'value'},right:{kind:'literal',value:filter.value}}, {value:properties[filter.property]}).outcome !== 'true')) return [];
      return [visible];
    }).sort((a,b) => a.id.localeCompare(b.id));
  }

  async traverseObjects(principal: Principal, input: {objectId: string; relationId?: string; direction?: 'outgoing' | 'incoming'}): Promise<EntityRecord[]> {
    requireScope(principal, 'read');
    const start = await this.store.get(principal.tenantId, 'objects', input.objectId);
    if (!start || !canRead(principal,start)) throw new PlatformError(404,'object_not_found','Object was not found');
    const all = await this.selectObjects(principal,{});
    const links = (entity: EntityRecord) => Array.isArray(entity.data.links) ? entity.data.links.map(record).filter(link => !input.relationId || link.relationId === input.relationId) : [];
    if (input.direction === 'incoming') return all.filter(entity => links(entity).some(link => link.targetId === start.id));
    const targets = new Set(links(start).map(link => link.targetId));
    return all.filter(entity => targets.has(entity.id));
  }

  async aggregateObjects(principal: Principal, input: ObjectQuery & {operation: 'count' | 'sum' | 'average' | 'min' | 'max'; property?: string; groupBy?: string}): Promise<Array<{group: string; value: number; count: number}>> {
    const all = await this.selectObjects(principal,input);
    const groups = new Map<string, number[]>();
    for (const entity of all) {
      const properties = record(entity.data.properties);
      // Never expose even a count grouped by a field the principal cannot read.
      if (input.groupBy && !Object.hasOwn(properties,input.groupBy)) continue;
      const group = input.groupBy ? String(properties[input.groupBy]) : 'all';
      const value = input.operation === 'count' ? 1 : properties[input.property ?? ''];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      groups.set(group,[...(groups.get(group) ?? []),value]);
    }
    if (!groups.size && input.operation === 'count' && !input.groupBy) groups.set('all',[]);
    return [...groups].map(([group,values]) => ({group,count:values.length,value:input.operation === 'count' ? values.length : input.operation === 'sum' ? values.reduce((a,b)=>a+b,0) : input.operation === 'average' ? values.reduce((a,b)=>a+b,0)/values.length : input.operation === 'min' ? Math.min(...values) : Math.max(...values)}));
  }

  async inspectContext(principal: Principal, input: {prompt: string; profileId?: string}): Promise<ContextPack> {
    requireScope(principal,'read');
    const prompt = nonempty(input.prompt,'Prompt',20_000);
    const profiles = await this.store.list(principal.tenantId,'contextProfiles');
    const profile = profiles.find(item => (!input.profileId || item.id === input.profileId) && item.state === 'active' && canRead(principal,item));
    if (!profile) throw new PlatformError(404,'profile_not_found','No accessible active context profile was found');
    return this.buildContext(principal,prompt,profile,await this.store.list(principal.tenantId,'knowledge'));
  }

  /** Trusted runtime entry point. HTTP callers cannot supply these release snapshots. */
  async inspectReleasedContext(principal: Principal, input: ReleasedContextInput): Promise<ContextPack> {
    requireScope(principal,'read');
    const prompt=nonempty(input.prompt,'Prompt',20_000);
    const profile=input.profile;
    const current=await this.store.get(principal.tenantId,'contextProfiles',profile.id);
    if(profile.kind!=='contextProfiles'||profile.state!=='active'||!canRead(principal,profile)||!current||current.state!=='active'||!canRead(principal,current))throw new PlatformError(404,'profile_not_found','No accessible released context profile was found');
    const allowed=new Set<string>();
    const seen=new Set<string>();
    for(const snapshot of input.knowledge){
      if(snapshot.kind!=='knowledge'||snapshot.tenantId!==principal.tenantId||seen.has(snapshot.id))throw new PlatformError(422,'invalid_context_snapshot','Released knowledge snapshots have invalid identity');
      seen.add(snapshot.id);
      const live=await this.store.get(principal.tenantId,'knowledge',snapshot.id);
      if(live&&canRead(principal,live)&&['approved','published'].includes(live.state))allowed.add(snapshot.id);
    }
    return this.buildContext(principal,prompt,profile,input.knowledge,allowed);
  }

  private async buildContext(principal:Principal,prompt:string,profile:EntityRecord,knowledge:EntityRecord[],allowedKnowledge?:ReadonlySet<string>):Promise<ContextPack> {
    const maxBytes = profile.data.maxBytes;
    const maxAgeSeconds = profile.data.maxAgeSeconds ?? 86_400;
    if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 256 || maxBytes > 1_000_000 || typeof maxAgeSeconds !== 'number' || maxAgeSeconds < 1 || !Number.isFinite(maxAgeSeconds)) throw new PlatformError(422,'invalid_profile','Context profile has invalid size or freshness limits');
    const excluded = {stale:0,unauthorized:0,overBudget:0};
    const candidates: ContextItem[] = [];
    for (const entity of await this.store.list(principal.tenantId,'objects')) {
      if (!strings(profile.data.objectTypes).includes(String(entity.data.objectTypeId))) continue;
      const visible = visibleObject(principal,entity);
      if (!visible) { excluded.unauthorized++; continue; }
      const observedAt = String(entity.data.observedAt ?? '');
      const age = this.now().getTime()-Date.parse(observedAt);
      if (!Number.isFinite(age) || age < 0 || age > maxAgeSeconds*1000) { excluded.stale++; continue; }
      candidates.push({id:entity.id,kind:'object',title:entity.name,text:JSON.stringify(visible.data.properties),source:entity.data.source ?? 'unknown',sourceRevision:String(entity.data.sourceRevision ?? entity.revision),observedAt,freshness:'fresh'});
    }
    for (const entity of knowledge) {
      if (!strings(profile.data.knowledgeIds).includes(entity.id)) continue;
      if (!canRead(principal,entity) || !['approved','published'].includes(entity.state) || allowedKnowledge&&!allowedKnowledge.has(entity.id)) { excluded.unauthorized++; continue; }
      const observedAt = String(entity.data.observedAt ?? entity.updatedAt);
      const age = this.now().getTime()-Date.parse(observedAt);
      if (!Number.isFinite(age) || age < 0 || age > maxAgeSeconds*1000) { excluded.stale++; continue; }
      candidates.push({id:entity.id,kind:'knowledge',title:entity.name,text:String(entity.data.markdown ?? ''),source:entity.data.source ?? 'unknown',sourceRevision:String(entity.revision),observedAt,freshness:'fresh'});
    }
    const terms = [...new Set(prompt.toLocaleLowerCase().match(/[a-z0-9-]{3,}/g) ?? [])];
    const score = (item:ContextItem) => terms.reduce((total,term)=>total+(`${item.title} ${item.text}`.toLocaleLowerCase().includes(term)?1:0),0);
    candidates.sort((a,b)=>score(b)-score(a)||a.id.localeCompare(b.id));
    const items:ContextItem[]=[];
    for (const item of candidates) {
      if (Buffer.byteLength(JSON.stringify([...items,item])) > maxBytes) { excluded.overBudget++; continue; }
      items.push(item);
    }
    const pack:ContextPack={id:randomUUID(),tenantId:principal.tenantId,profileId:profile.id,prompt,generatedAt:this.now().toISOString(),items,bytes:Buffer.byteLength(JSON.stringify(items)),maxBytes,truncated:excluded.overBudget>0,excluded};
    await this.store.audit(principal,'context.generated',profile.id,{packId:pack.id,itemIds:items.map(item=>item.id),bytes:pack.bytes,excluded});
    return pack;
  }
}
