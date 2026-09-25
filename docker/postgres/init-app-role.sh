#!/bin/sh
set -eu

psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=app_user="$POSTGRES_APP_USER" \
  --set=app_password="$POSTGRES_APP_PASSWORD" \
  --set=ops_control_user="$POSTGRES_OPS_CONTROL_USER" \
  --set=ops_control_password="$POSTGRES_OPS_CONTROL_PASSWORD" \
  --set=read_worker_user="$POSTGRES_READ_WORKER_USER" \
  --set=read_worker_password="$POSTGRES_READ_WORKER_PASSWORD" <<-'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'ops_control_user', :'ops_control_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'ops_control_user') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'read_worker_user', :'read_worker_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'read_worker_user') \gexec
SQL
