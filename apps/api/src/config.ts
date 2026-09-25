export interface AppConfig {
 databaseUrl:string; port:number; host:string; appOrigin:string; production:boolean; embedWorker:boolean;
 setupToken?:string; oidc?:{issuer:string;clientId:string;clientSecret?:string;redirectUri:string};
 operatorOrigins:string[]; operatorPrivateOrigins?:string[]; allowLocalSandbox:boolean; model:{mode:'sandbox'|'openai'|'openai-compatible';baseUrl?:string;apiKey?:string;model?:string};
}
export function readConfig(env:NodeJS.ProcessEnv=process.env):AppConfig {
 if(!env.DATABASE_URL)throw new Error('DATABASE_URL is required. Run pnpm setup:local or configure your PostgreSQL connection.');
 const production=env.NODE_ENV==='production',appOrigin=env.APP_ORIGIN??'http://localhost:4100';
 if(production&&!env.APP_ORIGIN)throw new Error('APP_ORIGIN is required in production');
 if(production&&!env.SETUP_TOKEN)throw new Error('SETUP_TOKEN is required in production to protect first-administrator setup');
 const mode=env.MODEL_PROVIDER??'sandbox';if(!['sandbox','openai','openai-compatible'].includes(mode))throw new Error('MODEL_PROVIDER must be sandbox, openai, or openai-compatible');
 const oidc=env.OIDC_ISSUER?{issuer:env.OIDC_ISSUER,clientId:env.OIDC_CLIENT_ID??'',...(env.OIDC_CLIENT_SECRET?{clientSecret:env.OIDC_CLIENT_SECRET}:{}),redirectUri:new URL('/api/auth/oidc/callback',appOrigin).toString()}:undefined;
 if(oidc&&!oidc.clientId)throw new Error('OIDC_CLIENT_ID is required with OIDC_ISSUER');
 return {databaseUrl:env.DATABASE_URL,port:Number(env.PORT??4100),host:env.HOST??'127.0.0.1',appOrigin,production,embedWorker:env.EMBED_WORKER!=='false',setupToken:env.SETUP_TOKEN,oidc,operatorOrigins:(env.OPERATOR_ALLOWED_ORIGINS??'http://127.0.0.1:4200').split(',').map(s=>s.trim()).filter(Boolean),operatorPrivateOrigins:(env.OPERATOR_ALLOWED_PRIVATE_ORIGINS??'').split(',').map(s=>s.trim()).filter(Boolean),allowLocalSandbox:env.ALLOW_LOCAL_SANDBOX==='true'||!production,model:{mode:mode as AppConfig['model']['mode'],...(env.MODEL_BASE_URL?{baseUrl:env.MODEL_BASE_URL}:{}),...(env.MODEL_API_KEY?{apiKey:env.MODEL_API_KEY}:{}),...(env.MODEL_ID?{model:env.MODEL_ID}:{})}};
}
