import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {createPlatformApp} from './app.js';
import {readConfig} from './config.js';
import {runWorker} from '../../worker/src/index.js';

const config=readConfig();const app=await createPlatformApp(config);const abort=new AbortController();
const worker=config.embedWorker?runWorker({runtime:app.runtime,queue:app.store,signal:abort.signal}).catch(error=>{console.error('Worker stopped:',error instanceof Error?error.message:'unknown error');abort.abort();}):Promise.resolve();
const server=createServer(async(req:IncomingMessage,res:ServerResponse)=>{
 try{
  const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>1_048_576){res.writeHead(413,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'body_too_large',message:'Request body exceeds 1 MB'}}));return;}chunks.push(chunk);}
  const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);
  const request=new Request(`http://${req.headers.host??`localhost:${config.port}`}${req.url??'/'}`,{method:req.method,headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
  const response=await app.fetch(request);res.statusCode=response.status;response.headers.forEach((value,key)=>{if(key!=='set-cookie')res.setHeader(key,value);});const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('set-cookie',cookies);res.end(Buffer.from(await response.arrayBuffer()));
 }catch(error){console.error('HTTP request failed:',error instanceof Error?error.message:'unknown error');if(!res.headersSent)res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'server_error',message:'Request failed'}}));}
});
server.requestTimeout=30000;server.headersTimeout=15000;
server.listen(config.port,config.host,()=>console.log(`Onto Planet is running at ${config.appOrigin}`));
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{
 if(stopping)return;
 stopping=true;abort.abort();
 server.close(()=>{void worker.finally(()=>app.close()).catch(error=>{console.error('Shutdown failed:',error instanceof Error?error.message:'unknown error');process.exitCode=1;});});
});
