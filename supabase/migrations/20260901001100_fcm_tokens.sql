-- ============================================================
-- FCM 디바이스 토큰 등록/해제.
--
-- 푸시 자체는 Firebase 에 남지만, **토큰 목록은 Supabase 에 있다** — 서버가
-- users.data.fcmTokens 를 읽어 발송한다. 클라이언트가 계속 Firestore 에 쓰면
-- 서버는 빈 목록을 보고 아무에게도 못 보낸다.
--
-- 왜 함수로 만드는가 — 이건 단순 배열 추가가 아니다. entry 는
--   { token, platform, registeredAt }
-- 인데 registeredAt 이 매번 달라서 값 전체 비교로는 같은 토큰을 못 알아본다.
-- 예전에 이것 때문에 같은 기기가 등록할 때마다 entry 가 쌓여 문서가 비대해지고
-- 죽은 토큰으로 FCM 을 두들기는 버그가 있었다(코드 주석에 그 흔적이 남아 있다).
-- "같은 token 은 하나만" 을 지키려면 읽고-거르고-쓰는 걸 한 번에 해야 한다.
--
-- 그리고 대상이 **항상 자기 자신**이다. userId 를 인자로 받지 않는다 —
-- 받으면 남의 계정에 자기 기기를 등록해 그 사람의 알림을 가로챌 수 있다.
-- ============================================================

create or replace function public.set_fcm_token(p_token text, p_platform text default 'web')
returns void
language plpgsql security invoker set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다' using errcode = '42501';
  end if;
  if coalesce(p_token, '') = '' then
    raise exception '토큰이 비어 있습니다' using errcode = '22023';
  end if;

  update public.users
     set data = jsonb_set(
           data,
           '{fcmTokens}',
           -- 같은 토큰의 옛 entry 를 모두 걷어내고 새 것 하나만 남긴다.
           coalesce((
             select jsonb_agg(e)
               from jsonb_array_elements(coalesce(data -> 'fcmTokens', '[]'::jsonb)) e
              where e ->> 'token' is distinct from p_token
           ), '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
             'token', p_token,
             'platform', coalesce(p_platform, 'web'),
             'registeredAt', now()
           )),
           true
         )
   where id = auth.uid();
end;
$$;
comment on function public.set_fcm_token is '내 계정에 이 기기의 FCM 토큰을 등록. 같은 토큰은 항상 1건만 남는다.';

create or replace function public.remove_fcm_token(p_token text)
returns void
language plpgsql security invoker set search_path = public as $$
begin
  if auth.uid() is null then
    return;
  end if;

  update public.users
     set data = jsonb_set(
           data,
           '{fcmTokens}',
           coalesce((
             select jsonb_agg(e)
               from jsonb_array_elements(coalesce(data -> 'fcmTokens', '[]'::jsonb)) e
              where e ->> 'token' is distinct from p_token
           ), '[]'::jsonb),
           true
         )
   where id = auth.uid();
end;
$$;
comment on function public.remove_fcm_token is '내 계정에서 이 기기의 FCM 토큰을 제거.';

revoke all on function public.set_fcm_token(text, text) from public, anon;
revoke all on function public.remove_fcm_token(text) from public, anon;
grant execute on function public.set_fcm_token(text, text) to authenticated;
grant execute on function public.remove_fcm_token(text) to authenticated;
