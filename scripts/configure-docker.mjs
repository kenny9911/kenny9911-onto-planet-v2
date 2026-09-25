import {existsSync,writeFileSync,chmodSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
const path='.env';if(existsSync(path))throw new Error('.env already exists; no values were overwritten. Review your existing Docker configuration.');
const secret=()=>randomBytes(32).toString('hex');
writeFileSync(path,`POSTGRES_ADMIN_PASSWORD=${secret()}\nAPP_DB_PASSWORD=${secret()}\nSOURCE_SANDBOX_TOKEN=${secret()}\nSETUP_TOKEN=${secret()}\nAPP_ORIGIN=http://localhost:4100\nMODEL_PROVIDER=sandbox\n`,{mode:0o600});chmodSync(path,0o600);
console.log('Created private Docker configuration in .env. Use its SETUP_TOKEN for first-admin setup, then run docker compose up --build -d.');
