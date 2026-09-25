import type { OntologyBundle, ValueTypeDefinition } from '../../contracts/src/index.js';
import { validateBundle } from '../../ontology-kernel/src/index.js';
import { requireScope, PlatformError, type EntityRecord, type PlatformStore, type Principal } from '../../platform-contracts/src/index.js';
import { hash, nonempty, record } from './common.js';

export interface ProposalResult { ontology: EntityRecord; proposal: EntityRecord; reviewGaps: string[]; method: 'deterministic-extraction' | 'model-assisted' }
const safeId = (value:string) => value.replace(/[^A-Za-z0-9_]/g,'_').replace(/^[^A-Za-z]+/,'field_') || 'field';

/** RFC-style quoted field parsing. No expressions or uploaded source are executed. */
function parseCsv(text:string): string[][] {
  const rows:string[][]=[]; let row:string[]=[]; let field=''; let quoted=false;
  for(let index=0;index<text.length;index++) {
    const ch=text[index]!;
    if(ch==='"') {
      if(quoted && text[index+1]==='"') {field+='"';index++;}
      else if(quoted) quoted=false;
      else if(field==='') quoted=true;
      else throw new PlatformError(400,'invalid_csv','CSV quote must begin a field');
    } else if(ch===',' && !quoted) {row.push(field);field='';}
    else if((ch==='\n'||ch==='\r')&&!quoted) {if(ch==='\r'&&text[index+1]==='\n')index++;row.push(field);if(row.some(value=>value!==''))rows.push(row);row=[];field='';}
    else field+=ch;
    if(row.length>100 || rows.length>1000) throw new PlatformError(400,'input_limit','CSV is limited to 100 columns and 1000 rows');
  }
  if(quoted)throw new PlatformError(400,'invalid_csv','CSV has an unterminated quoted field');
  row.push(field);if(row.some(value=>value!==''))rows.push(row);
  if(rows.some(item=>item.length!==rows[0]?.length))throw new PlatformError(400,'invalid_csv','CSV rows must have the same number of columns');
  return rows;
}

function inferKind(values:unknown[]):ValueTypeDefinition['kind'] {
  const known=values.filter(value=>value!==null&&value!==undefined&&value!=='');
  if(known.length && known.every(value=>typeof value==='boolean'))return 'boolean';
  if(known.length && known.every(value=>typeof value==='number'&&Number.isFinite(value)))return known.every(Number.isSafeInteger)?'integer':'decimal';
  return 'string';
}

export class ProposalServices {
  constructor(protected readonly store:PlatformStore, protected readonly now:()=>Date){}

  async transformKnowledge(principal:Principal,input:{name:string;text:string;source:unknown}):Promise<EntityRecord> {
    requireScope(principal,'build');
    const name=nonempty(input.name,'Name',200),text=nonempty(input.text,'Source text');
    if(typeof input.source!=='string'&&(!input.source||typeof input.source!=='object'||Array.isArray(input.source)))throw new PlatformError(400,'invalid_source','A source label or reference object is required');
    if(typeof input.source==='string')nonempty(input.source,'Source',1000);
    const evidence=text.split(/\r?\n/).map((line,index)=>({line:index+1,text:line})).filter(item=>item.text.trim());
    const requirements=evidence.filter(item=>/\b(must|shall|required|may only|cannot|must not)\b/i.test(item.text));
    const markdown=[`# ${name.replace(/[\r\n]/g,' ')}`,'',`Source reference: ${typeof input.source==='string'?input.source:JSON.stringify(input.source)}`,'',`Content digest: ${hash(text)}`,'','## Source statements',...evidence.map(item=>`> [L${item.line}] ${item.text}`),'','## Candidate requirements',...(requirements.length?requirements.map(item=>`- [L${item.line}] ${item.text}`):['No explicit requirement keywords were found.'])].join('\n');
    const entity=await this.store.create(principal,'knowledge',{name,state:'draft',data:{markdown,originalText:text,source:input.source,sourceHash:hash(text),observedAt:this.now().toISOString(),evidence,requirements,reviewGaps:['Domain owner must confirm source authority, currency, and extracted requirements.'],method:'deterministic-extraction'}});
    await this.store.audit(principal,'knowledge.transformed',entity.id,{sourceHash:hash(text),lines:evidence.length,requirements:requirements.length});
    return entity;
  }

  async proposeOntology(principal:Principal,input:{text:string;name:string}):Promise<ProposalResult> {
    requireScope(principal,'build');
    const text=nonempty(input.text,'Source text'),name=nonempty(input.name,'Name',200);
    let samples:Record<string,unknown>[]=[];let format:'json'|'csv'|'text'='text';
    const trimmed=text.trim();
    if(trimmed.startsWith('{')||trimmed.startsWith('[')) {
      let parsed:unknown;
      try{parsed=JSON.parse(trimmed);}catch{throw new PlatformError(400,'invalid_json','The supplied JSON is invalid');}
      const rows=Array.isArray(parsed)?parsed:[parsed];
      if(rows.length>1000||rows.some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw new PlatformError(400,'invalid_json','JSON must be an object or an array of at most 1000 objects');
      samples=rows.map(record);format='json';
    } else if(text.split(/\r?\n/)[0]?.includes(',')) {
      const [header,...rows]=parseCsv(text);
      if(!header?.length || new Set(header).size!==header.length || header.some(value=>!value.trim()))throw new PlatformError(400,'invalid_csv','CSV requires unique nonempty headers');
      samples=rows.map(row=>Object.fromEntries(header.map((key,index)=>[key,row[index]])));format='csv';
      if(!samples.length)samples=[Object.fromEntries(header.map(key=>[key,'']))];
    }
    const sourceId='providedSource';
    const bundle:OntologyBundle={schemaVersion:'2.0',id:`proposal_${hash(text).slice(7,19)}`,namespace:'draft.import',version:'0.1.0',name,sources:[{id:sourceId,system:'user-provided',kind:'file',resource:`sha256:${hash(text).slice(7)}`}],values:[{id:'value_identifier',name:'Identifier',kind:'string'}],sharedProperties:[],objects:[],relations:[],interfaces:[],rules:[],actions:[],functions:[],events:[],policies:[]};
    const values=[...bundle.values];const objects=[...bundle.objects];
    const reviewGaps=['Review the proposed names and property types against the source owner.','Confirm stable primary keys; generated IDs below are proposal identifiers, not source identity guarantees.','Define reviewed access policies, relationships, source bindings, and action contracts before release.'];
    if(format==='json'||format==='csv') {
      const keys=[...new Set(samples.flatMap(row=>Object.keys(row)))];
      if(keys.length>100)throw new PlatformError(400,'input_limit','At most 100 fields can be proposed at once');
      const seen=new Set<string>(['recordId']);
      const properties=[{id:'recordId',valueTypeId:'value_identifier',required:true,sourceRefs:[sourceId]}];
      for(const key of keys) {
        const observed=samples.map(row=>row[key]);
        if(observed.some(value=>value!==null&&typeof value==='object')) {reviewGaps.push(`Nested field ${key} requires an explicit relation or value mapping.`);continue;}
        let id=safeId(key);while(seen.has(id))id+='_field';seen.add(id);
        const kind=inferKind(observed),valueTypeId=`value_${kind}`;
        if(!values.some(value=>value.id===valueTypeId))values.push({id:valueTypeId,name:kind[0]!.toUpperCase()+kind.slice(1),kind});
        properties.push({id,valueTypeId,required:samples.every(row=>row[key]!==null&&row[key]!==undefined&&row[key]!==''),sourceRefs:[sourceId]});
      }
      objects.push({id:'ImportedRecord',name:'Imported record',primaryKey:'recordId',sourceRefs:[sourceId],properties});
      if(format==='csv')reviewGaps.push('CSV fields remain strings until an owner confirms numeric, date, currency, and identifier semantics.');
    } else {
      const concepts=[['PurchaseOrder','Purchase order',/\bpurchase orders?\b/i],['PurchaseRequest','Purchase request',/\bpurchase requests?\b/i],['Supplier','Supplier',/\bsuppliers?\b/i],['Customer','Customer',/\bcustomers?\b/i],['Invoice','Invoice',/\binvoices?\b/i],['Department','Department',/\bdepartments?\b/i]] as const;
      for(const [id,label,pattern] of concepts)if(pattern.test(text))objects.push({id,name:label,primaryKey:'id',sourceRefs:[sourceId],properties:[{id:'id',valueTypeId:'value_identifier',required:true,sourceRefs:[sourceId]}]});
      if(!objects.length) {objects.push({id:'SourceRecord',name:'Source record',primaryKey:'id',sourceRefs:[sourceId],properties:[{id:'id',valueTypeId:'value_identifier',required:true,sourceRefs:[sourceId]}]});reviewGaps.push('No supported business noun was found; SourceRecord is an explicit placeholder requiring owner replacement.');}
      reviewGaps.push('Text extraction proposes only named concepts. It does not infer executable rules, write operations, or authorization.');
    }
    const proposed={...bundle,values,objects};
    const evidence=text.split(/\r?\n/).map((line,index)=>({line:index+1,text:line})).filter(item=>item.text.trim());
    const diagnostics=validateBundle(proposed);
    const ontology=await this.store.create(principal,'ontologies',{name,state:'draft',data:{bundle:proposed,sourceHash:hash(text),reviewGaps,evidence,references:[],review:{status:'pending'}}});
    const proposal=await this.store.create(principal,'proposals',{name:`${name} proposal`,state:'needs_review',data:{ontologyId:ontology.id,bundle:proposed,sourceText:text,sourceHash:hash(text),format,method:'deterministic-extraction',evidence,reviewGaps,diagnostics}});
    await this.store.audit(principal,'ontology.proposed',ontology.id,{proposalId:proposal.id,format,sourceHash:hash(text)});
    return {ontology,proposal,reviewGaps,method:'deterministic-extraction'};
  }
}
