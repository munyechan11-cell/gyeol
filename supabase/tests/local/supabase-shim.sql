-- ============================================================
-- Supabase 가 깔아 주는 전제를 빈 Postgres 에 세운다.
--
-- 왜 필요한가: personas.sql / rls.sql 은 RLS 를 판정 주체로 쓴다. 그러려면
-- `authenticated`·`anon` 역할과 `auth.uid()` 가 있어야 하는데, 그건 Supabase 프로젝트에만
-- 있다. 운영 DB 에서 돌려도 되지만(전부 rollback 이라 흔적은 없다), 매번 운영에 붙는 건
-- 좋은 습관이 아니다. 이 파일 + migrations 를 순서대로 부으면 같은 판정이 로컬에서 난다.
--
-- 충실도 확인 방법(2026-09 실측): 로컬과 운영의 정책·트리거·생성컬럼·테이블 해시가
-- 일치하고, 함수는 주석을 걷어낸 본문 해시가 일치한다. rls.sql 도 양쪽에서 똑같이 통과한다.
-- ============================================================

create role anon          nologin noinherit;
create role authenticated nologin noinherit;
create role service_role   nologin noinherit bypassrls;
grant anon, authenticated, service_role to postgres;

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  instance_id uuid,
  aud text, role text, email text,
  created_at timestamptz default now(), updated_at timestamptz default now()
);

create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;

-- Supabase 는 public 의 테이블·함수 권한을 세 역할에 기본으로 준다.
-- 그래서 **RLS 가 유일한 방어선**이다. 이걸 빠뜨리면 전부 "권한 없음"이 되어
-- 정책이 잘못돼도 통과한 것처럼 보인다.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create publication supabase_realtime;
