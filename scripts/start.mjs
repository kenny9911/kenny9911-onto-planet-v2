import {spawn} from 'node:child_process';
import {localEnvironment} from './environment.mjs';
const env=localEnvironment();if(!env.DATABASE_URL)throw new Error('Run pnpm setup:local or configure DATABASE_URL.');
const children=[];
if(env.MODEL_PROVIDER==='sandbox'||!env.MODEL_PROVIDER){if(!env.SOURCE_SANDBOX_TOKEN)throw new Error('SOURCE_SANDBOX_TOKEN is required for the local source sandbox.');children.push(spawn(process.execPath,['dist/apps/source-sandbox/src/main.js'],{env,stdio:'inherit'}));}
children.push(spawn(process.execPath,['dist/apps/api/src/main.js'],{env,stdio:'inherit'}));
let stopping=false;const stop=()=>{if(stopping)return;stopping=true;children.forEach(p=>p.kill('SIGTERM'));};for(const s of ['SIGINT','SIGTERM'])process.on(s,stop);children.forEach(child=>child.on('exit',code=>{if(!stopping){stop();process.exitCode=code??1;}}));
