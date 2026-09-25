import {existsSync,mkdirSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import pg from 'pg';

// An isolated development cluster. Existing PostgreSQL services and databases are never changed.
const root=resolve(import.meta.dirname,'..'),local=join(root,'.local');mkdirSync(local,{recursive:true,mode:0o700});chmodSync(local,0o700);
const configPath=join(local,'database.json');
const config=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{port:55432,adminPassword:randomBytes(32).toString('hex'),appPassword:randomBytes(32).toString('hex'),sourceToken:randomBytes(32).toString('hex')};
writeFileSync(configPath,JSON.stringify(config),{mode:0o600});chmodSync(configPath,0o600);
const candidates=[process.env.POSTGRES_BIN,'/opt/homebrew/opt/postgresql@17/bin','/opt/homebrew/opt/postgresql@18/bin','/usr/lib/postgresql/18/bin','/usr/lib/postgresql/17/bin'].filter(Boolean);
const bin=candidates.find(p=>existsSync(join(p,'initdb')));
if(!bin)throw new Error('PostgreSQL binaries were not found. Use Docker Compose or set POSTGRES_BIN to an installed PostgreSQL bin directory.');
const data=join(local,'postgres'),socket=join(local,'pgsocket');mkdirSync(socket,{recursive:true,mode:0o700});
function command(name,args){const r=spawnSync(join(bin,name),args,{encoding:'utf8'});if(r.status!==0)throw new Error(`${name} failed: ${r.stderr||r.stdout}`);return r;}
if(!existsSync(join(data,'PG_VERSION'))){const pwfile=join(local,'postgres-password');writeFileSync(pwfile,config.adminPassword,{mode:0o600});command('initdb',['-D',data,'--username=onto_bootstrap','--auth=scram-sha-256',`--pwfile=${pwfile}`]);}
if(process.argv.includes('--stop')){command('pg_ctl',['-D',data,'stop','-m','fast']);console.log('Stopped the isolated Onto Planet database.');process.exit(0);}
if(spawnSync(join(bin,'pg_ctl'),['-D',data,'status'],{stdio:'ignore'}).status!==0)command('pg_ctl',['-D',data,'-l',join(local,'postgres.log'),'-o',`-p ${config.port} -h 127.0.0.1 -k ${socket}`,'start','-w']);
const client=new pg.Client({host:'127.0.0.1',port:config.port,user:'onto_bootstrap',password:config.adminPassword,database:'postgres'});await client.connect();
if(!(await client.query("SELECT 1 FROM pg_roles WHERE rolname='onto_app'")).rowCount)await client.query(`CREATE ROLE onto_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${config.appPassword}'`);
for(const db of ['onto_planet','onto_planet_test'])if(!(await client.query('SELECT 1 FROM pg_database WHERE datname=$1',[db])).rowCount)await client.query(`CREATE DATABASE ${db} OWNER onto_app`);
await client.end();
console.log(`Onto Planet PostgreSQL is available at 127.0.0.1:${config.port}. Private connection settings are in .local/database.json.`);
