import {readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {localEnvironment} from './environment.mjs';
const unit=process.argv.includes('--unit'),env=localEnvironment(true);
if(!unit&&!env.DATABASE_URL)throw new Error('Integration validation requires TEST_DATABASE_URL or pnpm setup:local. Use pnpm test:unit for the unit-only gate.');
if(unit)delete env.DATABASE_URL;
const files=['dist/packages','dist/tests'].flatMap(root=>readdirSync(root,{recursive:true}).filter(path=>typeof path==='string'&&path.endsWith('.test.js')).map(path=>resolve(root,path)));
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit',env});process.exit(result.status??1);
