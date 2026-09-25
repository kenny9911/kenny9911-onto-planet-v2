import {spawn} from 'node:child_process';
import {localEnvironment} from './environment.mjs';
const args=process.argv.slice(2),test=args[0]==='--test';if(test)args.shift();if(!args.length)throw new Error('Supply a command');const child=spawn(args[0],args.slice(1),{stdio:'inherit',env:localEnvironment(test)});for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));child.on('exit',code=>process.exit(code??1));
