import pg from 'pg';
if(!process.env.CI||!process.env.POSTGRES_ADMIN_URL)throw new Error('This bootstrap is for the isolated CI database only.');
const client=new pg.Client({connectionString:process.env.POSTGRES_ADMIN_URL});await client.connect();
await client.query("CREATE ROLE onto_ci LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD 'onto_ci_test_password'");
await client.query('CREATE DATABASE onto_planet_test OWNER onto_ci');await client.end();
