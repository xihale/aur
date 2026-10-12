#!/bin/bash
# One-time setup after clirelay-bin + postgresql packages are installed. No root needed.
set -euo pipefail

PGDATA="$HOME/.local/share/clirelay-pg"
CLIRELAY_PG_PASSWORD="3048fdda47517137d0307da08a21d7ab"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
    echo "==> initdb at $PGDATA"
    PWFILE=$(mktemp)
    echo "clirelay-super-$(openssl rand -hex 8)" > "$PWFILE"
    initdb -D "$PGDATA" -E UTF8 --locale=C \
        --auth-local=trust --auth-host=scram-sha-256 \
        --username=postgres --pwfile="$PWFILE"
    rm -f "$PWFILE"

    cat >> "$PGDATA/postgresql.conf" <<EOF
listen_addresses = '127.0.0.1'
port = 5543
unix_socket_directories = '/tmp'
EOF
fi

echo "==> starting clirelay-postgres user service"
systemctl --user daemon-reload
systemctl --user enable --now clirelay-postgres.service
sleep 2
systemctl --user is-active clirelay-postgres.service

echo "==> creating clirelay role + database"
psql -h /tmp -U postgres -d postgres -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'clirelay') THEN
        CREATE ROLE clirelay LOGIN PASSWORD '${CLIRELAY_PG_PASSWORD}';
    END IF;
END \$\$;
SELECT 'CREATE DATABASE clirelay OWNER clirelay'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'clirelay')\gexec
SQL

echo "==> starting clirelay user service"
systemctl --user enable --now clirelay.service
sleep 3
systemctl --user --no-pager --lines=20 status clirelay.service || true
