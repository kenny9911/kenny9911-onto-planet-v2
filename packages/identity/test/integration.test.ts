import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { IdentityService, hashSecret } from '../src/index.js';
import { PostgresStore, pg } from '../../persistence/src/index.js';

if(process.env.CI&&!process.env.DATABASE_URL)throw new Error('CI must provide DATABASE_URL for identity integration tests');
const cookie=(values:string[])=>values.map(value=>value.split(';')[0]).join('; ');

test('database identity narrows token authority, revokes sessions, and rejects a lost OIDC subject binding race',{skip:!process.env.DATABASE_URL,timeout:90_000},async t=>{
  const schema=`onto_test_${randomUUID().replaceAll('-','')}`;
  const adminPool=new pg.Pool({connectionString:process.env.DATABASE_URL});await adminPool.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:4});
  const store=new PostgresStore(pool);await store.migrate();
  const identity=new IdentityService(store,{secureCookies:true});
  const setup=await identity.setup({name:'Admin',email:'identity-admin@example.test',password:'identity-admin-password-42',workspace:'Identity tests'});
  const admin=setup.session.user;
  try{
    await t.test('session cookies are secure and mutation CSRF is bound to the stored session secret',async()=>{
      assert.ok(setup.cookies.every(value=>value.includes('; Secure')&&value.includes('SameSite=Lax')));
      assert.ok(setup.cookies[0]!.includes('HttpOnly'));
      const authenticated=await identity.authenticate(new Request('https://onto.example.test/api/session',{headers:{cookie:cookie(setup.cookies)}}));
      assert.equal(authenticated?.principal.actorId,admin.actorId);
      assert.throws(()=>identity.assertCsrf(new Request('https://onto.example.test/api/test',{method:'POST',headers:{'x-csrf-token':'wrong'}}),authenticated!),/Refresh the page/);
      identity.assertCsrf(new Request('https://onto.example.test/api/test',{method:'POST',headers:{'x-csrf-token':setup.session.csrfToken}}),authenticated!);
      assert.equal(await identity.authenticate(new Request('https://onto.example.test/api/session',{headers:{cookie:cookie([setup.cookies[0]!])}})),undefined);
      const row=(await pool.query('SELECT token_hash,csrf_hash FROM sessions WHERE user_id=$1',[admin.actorId])).rows[0];
      assert.equal(row.csrf_hash,hashSecret(setup.session.csrfToken));assert.ok(!setup.cookies[0]!.includes(row.token_hash));
    });
    await t.test('token scopes cannot escalate and follow current role, account status, and revocation',async()=>{
      const builder=(await identity.createUser(admin,{name:'Builder',email:'identity-builder@example.test',password:'identity-builder-password',role:'builder'}))!;
      await assert.rejects(identity.createToken(builder,{name:'Escalated',scopes:['admin']}),/subset/);
      const issued=await identity.createToken(builder,{name:'Build client',scopes:['read','build']});
      const bearer=()=>new Request('https://onto.example.test/api/session',{headers:{authorization:`Bearer ${issued.token}`}});
      assert.deepEqual((await identity.authenticate(bearer()))?.principal.scopes,['read','build']);
      const loggedIn=await identity.login('identity-builder@example.test','identity-builder-password');
      await identity.updateUser(admin,builder.actorId,{role:'viewer'});
      assert.deepEqual((await identity.authenticate(bearer()))?.principal.scopes,['read']);
      assert.equal(await identity.authenticate(new Request('https://onto.example.test/api/session',{headers:{cookie:cookie(loggedIn.cookies)}})),undefined);
      await identity.updateUser(admin,builder.actorId,{active:false});assert.equal(await identity.authenticate(bearer()),undefined);
      await identity.updateUser(admin,builder.actorId,{active:true});assert.ok(await identity.authenticate(bearer()));
      await identity.revokeToken(builder,issued.id);assert.equal(await identity.authenticate(bearer()),undefined);
      await assert.rejects(identity.updateUser(admin,admin.actorId,{active:false}),/another administrator/);
    });
    await t.test('valid OIDC callback cannot issue a session if another subject wins the account binding',async()=>{
      const user=(await identity.createUser(admin,{name:'OIDC user',email:'oidc-user@example.test',password:'temporary-oidc-password',role:'viewer'}))!;
      const issuer='https://identity.example.test';
      const {privateKey,publicKey}=await generateKeyPair('RS256');
      const jwk={...await exportJWK(publicKey),kid:'identity-test-key',alg:'RS256',use:'sig'};
      let idToken='';let changed=false;
      const originalFetch=globalThis.fetch;
      const originalQuery=pool.query.bind(pool);
      const proxyPool=new Proxy(pool,{get(target,key,receiver){
        if(key==='query')return async(...args:unknown[])=>{
          if(!changed&&typeof args[0]==='string'&&args[0].startsWith('UPDATE users SET oidc_subject=')){
            changed=true;
            await originalQuery('UPDATE users SET oidc_subject=$1 WHERE id=$2',[`${issuer}|winning-subject`,user.actorId]);
          }
          return (originalQuery as (...queryArgs:unknown[])=>Promise<unknown>)(...args);
        };
        const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
      }});
      const oidc=new IdentityService(new PostgresStore(proxyPool),{secureCookies:true,oidc:{issuer,clientId:'onto-client',redirectUri:'https://onto.example.test/api/auth/oidc/callback'}});
      globalThis.fetch=(async(input:Parameters<typeof fetch>[0])=>{
        const url=input instanceof Request?input.url:String(input);
        if(url===`${issuer}/.well-known/openid-configuration`)return Response.json({issuer,authorization_endpoint:`${issuer}/authorize`,token_endpoint:`${issuer}/token`,jwks_uri:`${issuer}/jwks`});
        if(url===`${issuer}/token`)return Response.json({id_token:idToken});
        if(url===`${issuer}/jwks`)return Response.json({keys:[jwk]});
        throw new Error(`Unexpected identity test request: ${url}`);
      }) as typeof fetch;
      try{
        const start=await oidc.oidcStart(),authorization=new URL(start.url);
        const state=authorization.searchParams.get('state')!,nonce=authorization.searchParams.get('nonce')!;
        idToken=await new SignJWT({email:'oidc-user@example.test',email_verified:true,nonce}).setProtectedHeader({alg:'RS256',kid:'identity-test-key'}).setIssuer(issuer).setAudience('onto-client').setSubject('losing-subject').setIssuedAt().setExpirationTime('5m').sign(privateKey);
        await assert.rejects(oidc.oidcCallback(new Request(`https://onto.example.test/api/auth/oidc/callback?state=${state}&code=test-code`,{headers:{cookie:cookie([start.cookie])}})),/Identity binding changed/);
        assert.equal(changed,true);
        assert.equal((await pool.query('SELECT count(*)::integer AS count FROM sessions WHERE user_id=$1',[user.actorId])).rows[0].count,0);
        assert.equal((await pool.query('SELECT oidc_subject FROM users WHERE id=$1',[user.actorId])).rows[0].oidc_subject,`${issuer}|winning-subject`);
      }finally{globalThis.fetch=originalFetch;}
    });
  }finally{await pool.end();await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);await adminPool.end();}
});
