import {createPlatformApp} from './app.js';
import {readConfig} from './config.js';
import {runWorker} from '../../worker/src/index.js';
const app=await createPlatformApp(readConfig());const abort=new AbortController();
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>abort.abort());
try{await runWorker({runtime:app.runtime,queue:app.store,signal:abort.signal});}finally{await app.close();}
