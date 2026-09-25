import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpOntologyGenerationPort } from '../apps/api/src/ontology-model.js';

const schema={type:'object',additionalProperties:false,properties:{name:{type:'string'}},required:['name']};
const config={mode:'openai' as const,model:'configured-model',apiKey:'test-key-never-log'};
const transport=(implementation:(input:Parameters<typeof fetch>[0],init?:RequestInit)=>Promise<Response>)=>implementation as typeof fetch;

test('ontology generation sends the current Responses JSON contract and validates output locally',async()=>{
  const model=new HttpOntologyGenerationPort(config,transport(async(input,init)=>{
    assert.equal(String(input),'https://api.openai.com/v1/responses');assert.equal(init?.redirect,'error');
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer test-key-never-log');
    const payload=JSON.parse(String(init?.body));assert.equal(payload.model,'configured-model');assert.equal(payload.store,false);assert.equal(payload.max_output_tokens,16000);assert.deepEqual(payload.text,{format:{type:'json_object'}});assert.equal(payload.input[0].role,'developer');assert.match(payload.input[0].content,/untrusted evidence/);
    return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'{"name":"Procurement"}'}]}]});
  }));
  assert.deepEqual(await model.generate('Propose procurement',schema),{name:'Procurement'});
});

test('compatible ontology provider uses Chat Completions with an explicit output token budget',async()=>{
  const model=new HttpOntologyGenerationPort({...config,mode:'openai-compatible',baseUrl:'https://models.example.test/v1/'},transport(async(input,init)=>{
    assert.equal(String(input),'https://models.example.test/v1/chat/completions');
    const payload=JSON.parse(String(init?.body));assert.deepEqual(payload.response_format,{type:'json_object'});assert.equal(payload.max_completion_tokens,16000);assert.equal(payload.messages[0].role,'system');
    return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'{"name":"Orders"}'}}]});
  }));
  assert.deepEqual(await model.generate('Propose orders',schema),{name:'Orders'});
});

test('model configuration rejects cleartext or credential-bearing endpoints',()=>{
  for(const baseUrl of ['http://localhost:8000/v1','https://name:password@example.test/v1','https://example.test/v1?key=secret','https://example.test/v1#fragment'])assert.throws(()=>new HttpOntologyGenerationPort({...config,baseUrl}),/HTTPS URL/);
  assert.throws(()=>new HttpOntologyGenerationPort({...config,apiKey:''}),/server-configured/);
  assert.throws(()=>new HttpOntologyGenerationPort({...config,mode:'sandbox'}),/configured live provider/);
});

test('provider errors, transport errors, refusals, truncation, and invalid schema output fail without exposing secrets',async()=>{
  for(const response of [
    new Response('test-key-never-log: provider internal prompt',{status:429}),
    Response.json({status:'incomplete',output:[]}),
    Response.json({status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'test-key-never-log'}]}]}),
    Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"name":10}'}]}]}),
    Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'not JSON test-key-never-log'}]}]}),
  ]){
    const model=new HttpOntologyGenerationPort(config,transport(async()=>response));
    await assert.rejects(model.generate('Source',schema),(error:Error)=>!error.message.includes('test-key-never-log')&&/Ontology model/.test(error.message));
  }
  const transportFailure=new HttpOntologyGenerationPort(config,transport(async()=>{throw new Error('test-key-never-log sent to bad host');}));
  await assert.rejects(transportFailure.generate('Source',schema),(error:Error)=>error.message==='Ontology model request could not be completed');
});

test('response streams and stalled providers are bounded before parsing or persistence',async()=>{
  let cancelled=false;
  const oversized=new HttpOntologyGenerationPort(config,transport(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(512));},cancel(){cancelled=true;}}))),{maxResponseBytes:256});
  await assert.rejects(oversized.generate('Source',schema),/size limit/);assert.equal(cancelled,true);
  let signal:AbortSignal|undefined;
  const stalled=new HttpOntologyGenerationPort(config,transport(async(_input,init)=>{signal=init?.signal??undefined;return new Promise<Response>(()=>{});}),{timeoutMs:20});
  await assert.rejects(stalled.generate('Source',schema),/timed out/);assert.equal(signal?.aborted,true);
  const badSchema=new HttpOntologyGenerationPort(config,transport(async()=>{throw new Error('Must not call provider');}));
  await assert.rejects(badSchema.generate('Source',{type:'not-a-json-schema-type'}),/schema is invalid/);
});
