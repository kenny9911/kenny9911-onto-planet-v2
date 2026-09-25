import type { OntologyBundle } from '../../contracts/src/index.js';
import { authorizeAction, createReleaseManifest, hashBundle, validateBundle, verifyReleaseManifest, type AuthorizationResult } from '../../ontology-kernel/src/index.js';
import { parsePluginManifest, parseSkillManifest, verifyPluginManifestSignature } from '../../extension-registry/src/index.js';
import { validateActionBinding } from '../../action-gateway/src/index.js';
import type { ActionBinding } from '../../contracts/src/index.js';
import { PlatformError, requireScope, resourceKinds, type EntityRecord, type PlatformStore, type Principal, type ResourceKind } from '../../platform-contracts/src/index.js';
import { canRead, visibleObject, hash, record, semanticDiff, strings, type ResourceReference } from './common.js';
import { ObjectServices } from './objects.js';
import { ProposalServices } from './proposals.js';
import { AiOntologyProposer, type OntologyGenerationPort } from './ai-proposer.js';

export * from './objects.js';
export { semanticDiff, canRead, visibleObject } from './common.js';
export type { ProposalResult } from './proposals.js';
export { createSeedData, seedPlatform } from './seed.js';
export { AiOntologyProposer, ontologyProposalSchema } from './ai-proposer.js';
export type { OntologyGenerationPort, SourceEvidence } from './ai-proposer.js';
export interface ServiceOptions { now?:()=>Date; trustedPluginKeys?:Readonly<Record<string,string>>; ontologyModel?:OntologyGenerationPort }
export interface EvaluationResult { id:string; name:string; status:'pass'|'fail'; expected:unknown; actual:unknown }
export interface ReleaseGate { id:string; name:string; status:'pass'|'fail'; details:string[] }
export interface AssetSnapshot extends ResourceReference { hash:string; name:string; state:string; data:Record<string,unknown> }
export interface PlatformReleaseManifest {
  schemaVersion:'ontoplanet.release/v1'; tenantId:string; environment:'sandbox'|'production'; createdAt:string;
  ontology:{id:string;revision:number;hash:string;resourceHash:string;bundle:OntologyBundle;release:ReturnType<typeof createReleaseManifest>;mcpCapabilities:Array<{id:string;kind:'function'|'action';scopes:string[]}>};
  resources:AssetSnapshot[]; evaluation:{id:string;revision:number;hash:string;results:EvaluationResult[]};
}

const assetHash=(entity:EntityRecord)=>hash({kind:entity.kind,id:entity.id,revision:entity.revision,data:entity.data});
const requiredRecord=async(store:PlatformStore,principal:Principal,kind:ResourceKind,id:string)=>{
  const entity=await store.get(principal.tenantId,kind,id);
  if(!entity||!canRead(principal,entity))throw new PlatformError(404,'not_found',`${kind} resource was not found`);
  return entity;
};

/** Tenant-scoped domain operations. All authorization comes from the server-authenticated principal. */
export class PlatformServices extends ObjectServices {
  private readonly proposals:ProposalServices;
  private readonly trustedPluginKeys:Readonly<Record<string,string>>;
  private readonly aiProposer?:AiOntologyProposer;
  constructor(store:PlatformStore,options:ServiceOptions={}) {
    super(store,options.now??(()=>new Date()));
    this.proposals=new ProposalServices(store,this.now);
    this.trustedPluginKeys=options.trustedPluginKeys??{};
    if(options.ontologyModel)this.aiProposer=new AiOntologyProposer(store,options.ontologyModel);
  }
  transformKnowledge(principal:Principal,input:{name:string;text:string;source:unknown}) { return this.proposals.transformKnowledge(principal,input); }
  proposeOntology(principal:Principal,input:{text:string;name:string}) { return this.aiProposer?this.aiProposer.propose(principal,input):this.proposals.proposeOntology(principal,input); }

  validateOntology(bundle:unknown) {
    const diagnostics=validateBundle(bundle);
    const candidate=record(bundle);
    return {valid:diagnostics.length===0,diagnostics,summary:{objects:Array.isArray(candidate.objects)?candidate.objects.length:0,relations:Array.isArray(candidate.relations)?candidate.relations.length:0,actions:Array.isArray(candidate.actions)?candidate.actions.length:0,rules:Array.isArray(candidate.rules)?candidate.rules.length:0}};
  }

  async activeOntology(principal:Principal):Promise<{record:EntityRecord;bundle:OntologyBundle;release?:EntityRecord}> {
    requireScope(principal,'read');
    const releases=(await this.store.list(principal.tenantId,'releases')).filter(item=>item.state==='active');
    if(releases.length>1)throw new PlatformError(409,'ambiguous_release','More than one release is active; activation must be atomic');
    const active=releases[0];
    if(active) {
      const manifest=this.readManifest(active);
      const entity=await requiredRecord(this.store,principal,'ontologies',manifest.ontology.id);
      return {record:entity,bundle:structuredClone(manifest.ontology.bundle),release:active};
    }
    const draft=(await this.store.list(principal.tenantId,'ontologies')).find(item=>canRead(principal,item));
    if(!draft)throw new PlatformError(404,'ontology_not_found','No ontology has been created');
    return {record:draft,bundle:draft.data.bundle as OntologyBundle};
  }

  async saveOntologyDraft(principal:Principal,input:{id:string;revision:number;bundle:unknown;name?:string}):Promise<EntityRecord> {
    requireScope(principal,'build');
    const current=await requiredRecord(this.store,principal,'ontologies',input.id);
    const validation=this.validateOntology(input.bundle);
    if(!validation.valid)throw new PlatformError(422,'invalid_ontology',validation.diagnostics.map(item=>`${item.path}: ${item.message}`).join('; '));
    const changes=semanticDiff(current.data.bundle,input.bundle);
    const next=await this.store.update(principal,'ontologies',input.id,input.revision,{...(input.name?{name:input.name}:{}),state:'draft',data:{...current.data,bundle:input.bundle,review:{status:'pending'},lastDiff:changes}});
    await this.store.audit(principal,'ontology.draft_updated',next.id,{fromRevision:current.revision,toRevision:next.revision,changes:changes.map(item=>({path:item.path,kind:item.kind}))});
    return next;
  }

  async diffOntology(principal:Principal,input:{ontologyId:string;bundle:unknown}) {
    requireScope(principal,'build');
    const current=await requiredRecord(this.store,principal,'ontologies',input.ontologyId);
    return {ontologyId:current.id,baseRevision:current.revision,changes:semanticDiff(current.data.bundle,input.bundle)};
  }

  async simulatePolicy(principal:Principal,input:{actionId:string;args:unknown;objectId?:string;ontologyId?:string}):Promise<AuthorizationResult&{actionId:string;ontologyHash:string;sourceRevision?:string;simulation:true}> {
    requireScope(principal,'read');
    const bundle=input.ontologyId?(await requiredRecord(this.store,principal,'ontologies',input.ontologyId)).data.bundle as OntologyBundle:(await this.activeOntology(principal)).bundle;
    const action=bundle.actions.find(item=>item.id===input.actionId);
    const args=record(input.args);
    const objectId=input.objectId??(action?.objectIdParameterId?String(args[action.objectIdParameterId]??''):undefined);
    const candidate=objectId?await this.store.get(principal.tenantId,'objects',objectId):undefined;
    const object=candidate?visibleObject(principal,candidate):undefined;
    let result:AuthorizationResult;
    const deny=(reason:string):AuthorizationResult=>({allowed:false,decision:'deny',reason,matchedPolicyIds:[],unknownFacts:[]});
    if(action?.targetObjectTypeId&&(!object||object.data.objectTypeId!==action.targetObjectTypeId))result=deny('The action requires an accessible object of its declared target type');
    else if(action?.objectIdParameterId&&args[action.objectIdParameterId]!==objectId)result=deny('Action input and object identity do not match');
    else result=authorizeAction(bundle,input.actionId,{tenantId:principal.tenantId,actorId:principal.actorId,actor:{id:principal.actorId,role:principal.role},scopes:principal.scopes,args,object:record(object?.data.properties),order:record(object?.data.properties),request:record(object?.data.properties),sourceRevision:object?.data.sourceRevision});
    await this.store.audit(principal,'policy.simulated',input.actionId,{allowed:result.allowed,objectId:objectId??null});
    return {...result,actionId:input.actionId,ontologyHash:hashBundle(bundle),...(object?{sourceRevision:String(object.data.sourceRevision)}:{}),simulation:true};
  }

  private async ontologyForEvaluation(principal:Principal,input:{ontologyId?:string;revision?:number}) {
    const entity=input.ontologyId?await requiredRecord(this.store,principal,'ontologies',input.ontologyId):(await this.activeOntology(principal)).record;
    if(input.revision!==undefined&&entity.revision!==input.revision)throw new PlatformError(409,'revision_conflict','Ontology changed; review its current revision');
    return entity;
  }

  async runEvaluations(principal:Principal,input:{ontologyId?:string;revision?:number}={}):Promise<EntityRecord> {
    requireScope(principal,'build');
    const entity=await this.ontologyForEvaluation(principal,input),bundle=entity.data.bundle as OntologyBundle;
    const results:EvaluationResult[]=[];
    const check=(id:string,name:string,expected:unknown,actual:unknown)=>results.push({id,name,status:hash(expected)===hash(actual)?'pass':'fail',expected,actual});
    const diagnostics=validateBundle(bundle);
    check('schema','Ontology schema and references are valid',0,diagnostics.length);
    if(!diagnostics.length) {
      const manifest=createReleaseManifest(bundle,this.now().toISOString());
      check('release-integrity','Released ontology verifies against its manifest',true,verifyReleaseManifest(bundle,manifest));
      check('release-tamper','A changed ontology cannot reuse its prior release',false,verifyReleaseManifest({...bundle,name:`${bundle.name} changed`},manifest));
      check('unknown-action','An unknown action fails closed',false,authorizeAction(bundle,'UndefinedAction',{}).allowed);
      const cases=Array.isArray(entity.data.evaluationCases)?entity.data.evaluationCases:[];
      for(const [index,entry] of cases.entries()) {
        const fixture=record(entry);
        if(typeof fixture.actionId!=='string'||typeof fixture.expectedAllowed!=='boolean'||!fixture.facts||typeof fixture.facts!=='object'||Array.isArray(fixture.facts)) {
          check(`case-${index}`,'Evaluation case has a supported executable schema',true,false);continue;
        }
        check(String(fixture.id??`case-${index}`),String(fixture.name??fixture.actionId),fixture.expectedAllowed,authorizeAction(bundle,fixture.actionId,record(fixture.facts)).allowed);
      }
      for(const action of bundle.actions) {
        check(`coverage-${action.id}`,`${action.name} has explicit allow and deny fixtures`,true,[true,false].every(expected=>cases.some(entry=>record(entry).actionId===action.id&&record(entry).expectedAllowed===expected)));
        check(`missing-facts-${action.id}`,`${action.name} denies missing authorization facts`,false,authorizeAction(bundle,action.id,{}).allowed);
      }
    }
    const summary={passed:results.filter(item=>item.status==='pass').length,failed:results.filter(item=>item.status==='fail').length};
    const evaluation=await this.store.create(principal,'evaluations',{name:`${entity.name} checks · revision ${entity.revision}`,state:summary.failed?'failed':'passed',data:{ontologyId:entity.id,ontologyRevision:entity.revision,ontologyHash:hashBundle(bundle),ontologyResourceHash:assetHash(entity),executedAt:this.now().toISOString(),method:'deterministic',results,summary}});
    await this.store.audit(principal,'evaluation.executed',evaluation.id,{...summary,ontologyId:entity.id,ontologyRevision:entity.revision});
    return evaluation;
  }

  private async collectResources(principal:Principal,ontology:EntityRecord):Promise<{snapshots:AssetSnapshot[];errors:string[]}> {
    const errors:string[]=[],snapshots:AssetSnapshot[]=[];
    const pending:unknown[]=Array.isArray(ontology.data.references)?[...ontology.data.references]:[];
    const seen=new Map<string,number>();
    while(pending.length) {
      const ref=record(pending.shift());
      if(!resourceKinds.includes(ref.kind as ResourceKind)||['ontologies','objects','runs','releases','evaluations','proposals'].includes(String(ref.kind))||typeof ref.id!=='string'||!Number.isInteger(ref.revision)) {errors.push('A release resource reference has an invalid kind, ID, or revision');continue;}
      const key=`${ref.kind}:${ref.id}`;
      if(seen.has(key)) {if(seen.get(key)!==ref.revision)errors.push(`Conflicting revisions for ${key}`);continue;}
      seen.set(key,Number(ref.revision));
      const entity=await this.store.get(principal.tenantId,ref.kind as ResourceKind,ref.id);
      if(!entity||!canRead(principal,entity)||entity.revision!==ref.revision) {errors.push(`${key} is inaccessible or no longer at revision ${ref.revision}`);continue;}
      snapshots.push({kind:entity.kind,id:entity.id,revision:entity.revision,hash:assetHash(entity),name:entity.name,state:entity.state,data:structuredClone(entity.data)});
      if(Array.isArray(entity.data.references))pending.push(...entity.data.references);
    }
    return {snapshots:snapshots.sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),errors};
  }

  async createRelease(principal:Principal,input:{ontologyId:string;revision:number}):Promise<EntityRecord> {
    requireScope(principal,'build');
    const ontology=await this.ontologyForEvaluation(principal,input),bundle=ontology.data.bundle as OntologyBundle;
    const diagnostics=validateBundle(bundle);
    if(diagnostics.length)throw new PlatformError(422,'invalid_ontology','The ontology must pass schema validation before a release can be assembled');
    const resources=await this.collectResources(principal,ontology);
    const evaluation=await this.runEvaluations(principal,input);
    const ontologyHash=hashBundle(bundle),bindingErrors:string[]=[],extensionErrors:string[]=[],dependencyErrors:string[]=[];
    const mcpCapabilities:Array<{id:string;kind:'function'|'action';scopes:string[]}>=[];
    const publishedIds=new Set<string>();
    for(const entry of Array.isArray(ontology.data.mcpCapabilities)?ontology.data.mcpCapabilities:[]) {
      const capability=record(entry);
      const id=typeof capability.id==='string'?capability.id:'';
      const scopes=strings(capability.scopes);
      if(!id||publishedIds.has(id)||!Array.isArray(capability.scopes)||scopes.length!==capability.scopes.length||scopes.length===0||new Set(scopes).size!==scopes.length||scopes.some(scope=>!scope.trim())||
        (capability.kind==='function'?!bundle.functions.some(item=>item.id===id&&item.sideEffect==='pure'):capability.kind==='action'?!bundle.actions.some(item=>item.id===id):true)) {
        dependencyErrors.push('MCP publication must uniquely reference a pure function or governed action with explicit scopes');continue;
      }
      publishedIds.add(id);mcpCapabilities.push({id,kind:capability.kind as 'function'|'action',scopes});
    }
    const environment=ontology.data.environment==='production'?'production':'sandbox';
    for(const action of bundle.actions) {
      const matches=resources.snapshots.filter(item=>item.kind==='connectors'&&record(item.data.binding).actionId===action.id);
      if(matches.length!==1) {bindingErrors.push(`${action.id} needs exactly one referenced connector binding`);continue;}
      const connector=matches[0]!,binding=connector.data.binding as unknown as ActionBinding;
      try {
        bindingErrors.push(...validateActionBinding(binding).map(error=>`${connector.id}: ${error}`));
        if(binding.tenantId!==principal.tenantId||binding.ontologyRelease!==ontologyHash||binding.environment!==environment)bindingErrors.push(`${connector.id} binding does not match tenant, release, and environment`);
        if(action.risk!=='low'&&(!binding.guarantees.conditionalWrite||!binding.guarantees.readback||!binding.guarantees.reconciliation))bindingErrors.push(`${connector.id} lacks material write guarantees`);
        if(environment==='production'&&(record(connector.data.conformance).status!=='passed'||record(connector.data.conformance).bindingHash!==hash(binding)))bindingErrors.push(`${connector.id} has no passing conformance evidence for this binding`);
      } catch {bindingErrors.push(`${connector.id} has an invalid binding`);}
    }
    for(const asset of resources.snapshots) {
      if(!['approved','active','published','configured','catalog'].includes(asset.state))dependencyErrors.push(`${asset.kind}:${asset.id} is not reviewed or configured`);
      if(strings(asset.data.reviewGaps).length)dependencyErrors.push(`${asset.kind}:${asset.id} has unresolved review gaps`);
      try {
        if(asset.kind==='skills')parseSkillManifest(asset.data.manifest);
        if(asset.kind==='plugins') {
          const plugin=parsePluginManifest(asset.data.manifest);
          if(asset.state!=='catalog'&&!verifyPluginManifestSignature(asset.data.manifest,this.trustedPluginKeys))extensionErrors.push(`${asset.id} signature is not verified by a configured trusted publisher key`);
          if(asset.state==='catalog'&&asset.data.enabled===true)extensionErrors.push(`${asset.id} catalog metadata cannot enable execution`);
          for(const skill of plugin.spec.skillRefs)if(!resources.snapshots.some(item=>item.kind==='skills'&&record(record(item.data.manifest).metadata).id===skill.id&&record(record(item.data.manifest).metadata).version===skill.version))dependencyErrors.push(`${asset.id} references unpinned skill ${skill.id}@${skill.version}`);
        }
        if(asset.kind==='contextProfiles') {
          for(const id of strings(asset.data.knowledgeIds))if(!resources.snapshots.some(item=>item.kind==='knowledge'&&item.id===id))dependencyErrors.push(`${asset.id} references unpinned knowledge ${id}`);
          for(const id of strings(asset.data.objectTypes))if(!bundle.objects.some(item=>item.id===id))dependencyErrors.push(`${asset.id} references undefined object type ${id}`);
        }
        if(asset.kind==='agents') {
          if(asset.data.ontologyRelease!==ontologyHash)dependencyErrors.push(`${asset.id} does not pin this ontology`);
          if(asset.data.contextProfileId&&!resources.snapshots.some(item=>item.kind==='contextProfiles'&&item.id===asset.data.contextProfileId))dependencyErrors.push(`${asset.id} references an unpinned context profile`);
          for(const tool of Array.isArray(asset.data.tools)?asset.data.tools.map(record):[])if(tool.kind==='action'&&!resources.snapshots.some(item=>item.kind==='connectors'&&item.id===tool.connectorId))dependencyErrors.push(`${asset.id} references an unpinned action connector`);
          for(const skill of Array.isArray(asset.data.skills)?asset.data.skills.map(record):[])if(!resources.snapshots.some(item=>item.kind==='skills'&&(item.id===skill.id||record(record(item.data.manifest).metadata).id===skill.id)&&record(record(item.data.manifest).metadata).version===skill.version))dependencyErrors.push(`${asset.id} references an unpinned skill version`);
        }
      } catch {extensionErrors.push(`${asset.kind}:${asset.id} has an invalid extension manifest`);}
    }
    const review=record(ontology.data.review);
    const gates:ReleaseGate[]=[
      {id:'ontology',name:'Ontology schema and references',status:'pass',details:[]},
      {id:'owner-review',name:'Domain owner review',status:review.status==='approved'&&strings(ontology.data.reviewGaps).length===0?'pass':'fail',details:review.status==='approved'&&strings(ontology.data.reviewGaps).length===0?[]:['Owner review or unresolved proposal gaps remain']},
      {id:'resources',name:'Pinned resource closure',status:resources.errors.length+dependencyErrors.length?'fail':'pass',details:[...resources.errors,...dependencyErrors]},
      {id:'bindings',name:environment==='sandbox'?'Sandbox connector contracts':'Production connector conformance',status:bindingErrors.length?'fail':'pass',details:bindingErrors},
      {id:'extensions',name:'Skill and plugin manifests',status:extensionErrors.length?'fail':'pass',details:extensionErrors},
      {id:'evaluations',name:'Executable deterministic cases',status:evaluation.state==='passed'?'pass':'fail',details:evaluation.state==='passed'?[]:['One or more executable cases failed']},
    ];
    const manifest:PlatformReleaseManifest={schemaVersion:'ontoplanet.release/v1',tenantId:principal.tenantId,environment,createdAt:this.now().toISOString(),ontology:{id:ontology.id,revision:ontology.revision,hash:ontologyHash,resourceHash:assetHash(ontology),bundle:structuredClone(bundle),release:createReleaseManifest(bundle,this.now().toISOString()),mcpCapabilities},resources:resources.snapshots,evaluation:{id:evaluation.id,revision:evaluation.revision,hash:assetHash(evaluation),results:evaluation.data.results as EvaluationResult[]}};
    const release=await this.store.create(principal,'releases',{name:`${ontology.name} · ${bundle.version}`,state:gates.every(gate=>gate.status==='pass')?'ready':'blocked',data:{ontologyId:ontology.id,ontologyHash,manifest,manifestHash:hash(manifest),gates,review:{status:'awaiting_activation',createdBy:principal.actorId},sampleOnly:environment==='sandbox'}});
    await this.store.audit(principal,'release.created',release.id,{manifestHash:hash(manifest),state:release.state});
    return release;
  }

  private readManifest(release:EntityRecord):PlatformReleaseManifest {
    const manifest=release.data.manifest as unknown as PlatformReleaseManifest;
    try {
      if(!manifest||manifest.schemaVersion!=='ontoplanet.release/v1'||manifest.tenantId!==release.tenantId||hash(manifest)!==release.data.manifestHash||!verifyReleaseManifest(manifest.ontology.bundle,manifest.ontology.release)||manifest.ontology.hash!==hashBundle(manifest.ontology.bundle))throw new Error('mismatch');
      for(const asset of manifest.resources)if(hash({kind:asset.kind,id:asset.id,revision:asset.revision,data:asset.data})!==asset.hash)throw new Error('asset mismatch');
      return manifest;
    } catch {throw new PlatformError(409,'release_integrity','Release manifest or resource digest is invalid');}
  }

  async activateRelease(principal:Principal,id:string):Promise<EntityRecord> {
    requireScope(principal,'release');
    const release=await requiredRecord(this.store,principal,'releases',id);
    if(release.state!=='ready')throw new PlatformError(409,'release_not_ready','Only a ready release can be activated');
    const manifest=this.readManifest(release);
    if(!Array.isArray(release.data.gates)||!release.data.gates.length||release.data.gates.some(gate=>record(gate).status!=='pass'))throw new PlatformError(409,'release_gate_failed','All release gates must pass');
    const ontology=await requiredRecord(this.store,principal,'ontologies',manifest.ontology.id);
    if(ontology.revision!==manifest.ontology.revision||assetHash(ontology)!==manifest.ontology.resourceHash)throw new PlatformError(409,'release_stale','Ontology changed after review; assemble a new release');
    for(const asset of manifest.resources) {
      const current=await this.store.get(principal.tenantId,asset.kind,asset.id);
      if(!current||!canRead(principal,current))throw new PlatformError(404,'not_found','A release dependency was not found');
      if(!current||current.revision!==asset.revision||assetHash(current)!==asset.hash)throw new PlatformError(409,'release_stale',`${asset.kind}:${asset.id} changed after review`);
    }
    const evaluation=await this.store.get(principal.tenantId,'evaluations',manifest.evaluation.id);
    if(!evaluation||assetHash(evaluation)!==manifest.evaluation.hash||evaluation.state!=='passed'||hash(evaluation.data.results)!==hash(manifest.evaluation.results))throw new PlatformError(409,'evaluation_invalid','Release evaluation evidence is absent or changed');
    if(!this.store.activateRelease)throw new PlatformError(503,'atomic_activation_unavailable','Storage does not support atomic release activation');
    const activated=await this.store.activateRelease(principal,id,release.revision,String(release.data.manifestHash));
    await this.store.audit(principal,'release.activated',id,{manifestHash:release.data.manifestHash,actorId:principal.actorId,environment:manifest.environment});
    return activated;
  }
}
