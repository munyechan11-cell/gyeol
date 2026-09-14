#!/usr/bin/env bash
# 페르소나 테스트를 일회용 로컬 Postgres 에서 돌린다 — 운영 DB 에 붙지 않는다.
#
#   bash scripts/personas-local.sh              # personas.sql
#   bash scripts/personas-local.sh rls          # rls.sql (정책 테스트)
#
# 필요한 것: postgresql-16 서버 바이너리(initdb·pg_ctl)와 psql, 그리고 postgres 계정.
# 끝나면 클러스터를 지운다.
set -euo pipefail

SUITE="${1:-personas}"
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
[ -n "$PGBIN" ] || { echo "postgres 서버 바이너리를 못 찾았다 (apt-get install postgresql-16)"; exit 1; }
PORT="${PGPORT_LOCAL:-55432}"
DATA="$(mktemp -d /var/lib/postgresql/personas-XXXXXX)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
chown postgres:postgres "$DATA"
trap 'su postgres -c "$PGBIN/pg_ctl -D $DATA stop -m immediate" >/dev/null 2>&1 || true; rm -rf "$DATA"' EXIT

su postgres -c "$PGBIN/initdb -D $DATA -A trust -U postgres" >/dev/null
su postgres -c "$PGBIN/pg_ctl -D $DATA -o '-p $PORT -k /tmp' -l $DATA/pg.log start" >/dev/null
for _ in $(seq 1 20); do psql -h /tmp -p "$PORT" -U postgres -tAc 'select 1' >/dev/null 2>&1 && break; sleep 0.5; done

psql -h /tmp -p "$PORT" -U postgres -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/local/supabase-shim.sql" 2>&1 | grep -vE 'wal_level|HINT' || true
for f in "$ROOT"/supabase/migrations/*.sql; do
  psql -h /tmp -p "$PORT" -U postgres -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "── $SUITE ──"
psql -h /tmp -p "$PORT" -U postgres -q -P pager=off -f "$ROOT/supabase/tests/$SUITE.sql"

if [ "$SUITE" = "personas" ]; then
  echo
  echo "❌ 로 표시된 줄이 '그 페르소나가 그 기능을 못 쓴다'는 뜻이다."
fi
