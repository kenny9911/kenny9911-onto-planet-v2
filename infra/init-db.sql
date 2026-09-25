\getenv app_password APP_DB_PASSWORD
SELECT format('CREATE ROLE onto_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'app_password') \gexec
ALTER DATABASE onto_planet OWNER TO onto_app;
GRANT ALL ON SCHEMA public TO onto_app;
