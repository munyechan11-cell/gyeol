import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDb, getSupabaseAdmin } from './db.js';

/**
 * 어댑터 실동작 검증 — 실제 Supabase 에 붙어서 확인한다.
 *
 * 이 어댑터는 서버 코드 28곳이 그대로 얹히는 자리라, 모양만 맞고 동작이 다르면
 * 결제·POS·영수증 경로가 조용히 어긋난다. 모형 객체로는 그걸 못 잡는다.
 *
 * 자격 증명(SUPABASE_SERVICE_ROLE_KEY)이 없으면 통째로 건너뛴다 —
 * CI 나 남의 체크아웃에서 실패로 보이면 안 된다.
 */
const HAS_CREDS = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
const d = HAS_CREDS ? describe : describe.skip;

const OWNER_ID = '00000000-0000-4000-8000-00000000a001';
const AUTH_EMAIL = `adapter-test-${Date.now()}@example.test`;

d('firestore 모양 어댑터', () => {
  const db = getDb()!;
  const sb = getSupabaseAdmin()!;

  beforeAll(async () => {
    // users 는 auth.users 를 참조하므로 먼저 auth 사용자를 만든다.
    await sb.auth.admin.createUser({
      id: OWNER_ID, email: AUTH_EMAIL, email_confirm: true,
    } as never);
    await db.collection('users').doc(OWNER_ID).set({
      id: OWNER_ID, role: 'owner', name: '어댑터테스트', phone: '01000000001',
    });
    // role 은 실제 컬럼이라 save_doc(data 병합)로는 안 채워진다 — 직접 넣는다.
    await sb.from('users').update({ role: 'owner' }).eq('id', OWNER_ID);
  });

  afterAll(async () => {
    await sb.auth.admin.deleteUser(OWNER_ID).catch(() => {});
  });

  it('doc.set → doc.get 왕복', async () => {
    const id = crypto.randomUUID();
    await db.collection('menus').doc(id).set({ id, storeId: OWNER_ID, name: '김치찌개', price: 9000 });
    const snap = await db.collection('menus').doc(id).get();
    expect(snap.exists).toBe(true);
    expect(snap.data()).toMatchObject({ name: '김치찌개', price: 9000 });
  });

  it('set 은 부분 병합이다 — 안 보낸 필드가 지워지면 안 된다', async () => {
    const id = crypto.randomUUID();
    await db.collection('menus').doc(id).set({ id, storeId: OWNER_ID, name: '된장', price: 8000 });
    await db.collection('menus').doc(id).set({ price: 8500 });
    expect(await db.collection('menus').doc(id).get().then((s) => s.data())).toMatchObject({
      name: '된장', price: 8500,
    });
  });

  it('없는 문서는 exists=false', async () => {
    const snap = await db.collection('menus').doc(crypto.randomUUID()).get();
    expect(snap.exists).toBe(false);
    expect(snap.data()).toBeUndefined();
  });

  it('where + limit 조회', async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids) {
      await db.collection('orders').doc(id).set({ id, storeId: OWNER_ID, status: 'pending' });
    }
    const snap = await db.collection('orders').where('storeId', '==', OWNER_ID).get();
    expect(snap.size).toBeGreaterThanOrEqual(2);
    expect(snap.docs.every((x) => x.data().storeId === OWNER_ID)).toBe(true);

    const one = await db.collection('orders').where('storeId', '==', OWNER_ID).limit(1).get();
    expect(one.size).toBe(1);
  });

  it('조건에 맞는 문서가 없으면 empty', async () => {
    const snap = await db.collection('orders')
      .where('storeId', '==', '00000000-0000-4000-8000-0000000000ff').get();
    expect(snap.empty).toBe(true);
  });

  it('delete 하면 사라진다', async () => {
    const id = crypto.randomUUID();
    await db.collection('menus').doc(id).set({ id, storeId: OWNER_ID, name: '삭제대상' });
    await db.collection('menus').doc(id).delete();
    expect(await db.collection('menus').doc(id).get().then((s) => s.exists)).toBe(false);
  });

  it('add 는 id 를 만들어 준다', async () => {
    const ref = await db.collection('print_jobs').add({ storeId: OWNER_ID, status: 'queued' });
    expect(ref.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await db.collection('print_jobs').doc(ref.id).get().then((s) => s.exists)).toBe(true);
  });

  it('서버 전용 테이블(store_secrets)도 병합 저장된다', async () => {
    await db.collection('store_secrets').doc(OWNER_ID).set({ tossSecretKey: 'sk_test' });
    await db.collection('store_secrets').doc(OWNER_ID).set({ memo: '메모' });
    const snap = await db.collection('store_secrets').doc(OWNER_ID).get();
    expect(snap.data()).toMatchObject({ tossSecretKey: 'sk_test', memo: '메모' });
  });

  it('app_state 는 문자열 id 를 쓴다', async () => {
    await db.collection('appState').doc('settings').set({ masterPassword: 'IMC' });
    expect(await db.collection('appState').doc('settings').get().then((s) => s.data()))
      .toMatchObject({ masterPassword: 'IMC' });
  });
});
