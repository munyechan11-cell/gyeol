import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * 서버용 데이터 접근 — Supabase service_role.
 *
 * ⚠️ **이 클라이언트는 RLS 를 우회한다.** 서버가 매장 경계를 넘어 일해야 하는 경우가
 *    있어서(웹훅 수신, cron, 결제 확인) 필요하지만, 요청자가 보낸 storeId 를 그대로
 *    믿고 쓰면 안 된다. 각 라우트가 자기 인증을 먼저 해야 한다.
 *
 * 아래 `firestoreCompat` 은 **이행용 어댑터**다. 서버 코드 28곳이 Firestore 문법
 * (`fs.collection('x').doc(id).get()`)으로 쓰여 있는데, 그걸 전부 Supabase 문법으로
 * 고치면 결제·POS·영수증 경로를 한 번에 건드리게 된다. 모양을 유지한 채 밑을 바꿔
 * 변경 범위를 좁혔다.
 *
 * 영구 구조가 아니다 — 라우트 그룹 단위로 네이티브 쿼리로 옮기고 이 파일을 지우는 게 목표다.
 */

const URL_ = process.env.SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

let client: SupabaseClient | null = null;

/** service_role 클라이언트. 환경변수가 없으면 null (라우트가 503 으로 응답). */
export function getSupabaseAdmin(): SupabaseClient | null {
  if (client) return client;
  if (!URL_ || !SERVICE_KEY) {
    console.warn('[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 미설정 — DB 접근 불가');
    return null;
  }
  client = createClient(URL_, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

// ============================================================
// Firestore 모양 어댑터
// ============================================================

/** 컬렉션 이름 → 테이블 이름. 클라이언트의 resolveTable 과 같은 표다. */
const TABLES: Record<string, string> = {
  Communications: 'communications',
  tierOverrides: 'tier_overrides',
  marketingDrafts: 'marketing_drafts',
  appState: 'app_state',
};
const table = (name: string) => TABLES[name] ?? name;

/** 기본키 컬럼이 id 가 아닌 테이블. */
const PK: Record<string, string> = {
  store_secrets: 'storeId',
  pairing_codes: 'code',
  merchant_map: 'merchantId',
};
const pkOf = (t: string) => PK[t] ?? 'id';

/** 행 → Firestore 문서 모양. 앱·서버 모두 `{ id, ...필드 }` 를 기대한다. */
function toDoc(row: Record<string, any> | null, t: string): Record<string, any> | null {
  if (!row) return null;
  const data = (row.data ?? {}) as Record<string, any>;
  return { ...data, [pkOf(t)]: row[pkOf(t)] };
}

/**
 * 서버 전용 테이블 — 조회용 승격 컬럼 없이 data jsonb 안을 직접 본다.
 *
 * 나머지 테이블처럼 save_doc 을 쓰지 않는 이유: save_doc 의 화이트리스트는
 * 앱이 문서처럼 다루는 테이블만 담는다. 여기 것들은 클라이언트가 아예 닿으면
 * 안 되는 자료(정산 키·페어링 코드)라 그 목록에 들어가지 않는다.
 */
const RAW_TABLES = new Set(['store_secrets', 'pairing_codes', 'merchant_map', 'tossplace_diag']);

/**
 * 조회 대상 필드 → PostgREST 가 이해하는 표현.
 *
 * 세 갈래다:
 *   · 점이 있으면 중첩 필드 — `storeConfig.aiReservation.phoneNumber` 처럼.
 *     승격 컬럼으로 뽑아 두지 않은 깊은 값이라 jsonb 경로로 내려간다.
 *     ⚠️ 인덱스가 없어 전체 훑기가 된다. 지금은 매장 수가 적어 괜찮지만,
 *        자주 쓰는 경로가 생기면 생성 컬럼으로 승격시켜야 한다.
 *   · 서버 전용 테이블은 승격 컬럼 자체가 없으므로 jsonb 안을 본다.
 *   · 나머지는 진짜 컬럼(생성 컬럼)이다.
 */
function columnFor(t: string, field: string): string {
  if (field.includes('.')) {
    const parts = field.split('.');
    const last = parts.pop()!;
    return `data->${parts.join('->')}->>${last}`;
  }
  return RAW_TABLES.has(t) ? `data->>${field}` : field;
}

export interface CompatSnapshot {
  exists: boolean;
  id: string;
  data(): Record<string, any> | undefined;
}
export interface CompatQuerySnapshot {
  empty: boolean;
  size: number;
  docs: Array<{ id: string; data(): Record<string, any> }>;
}

class CompatQuery {
  constructor(
    private sb: SupabaseClient,
    private name: string,
    private filters: Array<[string, any]> = [],
    private lim?: number
  ) {}

  where(field: string, op: string, value: any): CompatQuery {
    if (op !== '==') throw new Error(`지원하지 않는 연산자: ${op}`);
    return new CompatQuery(this.sb, this.name, [...this.filters, [field, value]], this.lim);
  }

  limit(n: number): CompatQuery {
    return new CompatQuery(this.sb, this.name, this.filters, n);
  }

  async get(): Promise<CompatQuerySnapshot> {
    const t = table(this.name);
    let q = this.sb.from(t).select('*');
    for (const [f, v] of this.filters) {
      q = q.eq(columnFor(t, f), v);
    }
    if (this.lim) q = q.limit(this.lim);
    const { data, error } = await q;
    if (error) throw error;
    const rows = data ?? [];
    return {
      empty: rows.length === 0,
      size: rows.length,
      docs: rows.map((r: any) => ({
        id: String(r[pkOf(t)]),
        data: () => toDoc(r, t)!,
      })),
    };
  }
}

class CompatDoc {
  constructor(private sb: SupabaseClient, private name: string, public id: string) {}

  /** 일괄 쓰기(CompatBatch)가 쓰는 주소. */
  get table(): string {
    return table(this.name);
  }

  async get(): Promise<CompatSnapshot> {
    const t = table(this.name);
    const { data, error } = await this.sb.from(t).select('*').eq(pkOf(t), this.id).maybeSingle();
    if (error) throw error;
    return { exists: !!data, id: this.id, data: () => toDoc(data as any, t) ?? undefined };
  }

  /** merge 여부와 무관하게 부분 병합한다 — save_doc 이 Firestore merge 와 같은 규칙을 쓴다. */
  async set(value: Record<string, any>, _opts?: { merge?: boolean }): Promise<void> {
    await this.write(value);
  }

  async update(value: Record<string, any>): Promise<void> {
    await this.write(value);
  }

  private async write(value: Record<string, any>): Promise<void> {
    const t = table(this.name);
    if (RAW_TABLES.has(t)) {
      // 서버 전용 테이블 — 기본키 + data 만 있으므로 직접 upsert.
      const { data: cur } = await this.sb.from(t).select('data').eq(pkOf(t), this.id).maybeSingle();
      const merged = { ...(((cur as any)?.data as object) ?? {}), ...value };
      const { error } = await this.sb
        .from(t)
        .upsert({ [pkOf(t)]: this.id, data: merged }, { onConflict: pkOf(t) });
      if (error) throw error;
      return;
    }
    const { error } = await this.sb.rpc('save_doc', {
      p_table: t,
      p_id: this.id,
      p_patch: value,
    });
    if (error) throw error;
  }

  async delete(): Promise<void> {
    const t = table(this.name);
    const { error } = await this.sb.from(t).delete().eq(pkOf(t), this.id);
    if (error) throw error;
  }
}

class CompatCollection extends CompatQuery {
  constructor(private sb2: SupabaseClient, private name2: string) {
    super(sb2, name2);
  }
  doc(id?: string): CompatDoc {
    return new CompatDoc(this.sb2, this.name2, id ?? crypto.randomUUID());
  }
  async add(value: Record<string, any>): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    await this.doc(id).set(value);
    return { id };
  }
}

/**
 * 여러 문서를 한 번에 쓰는 통로.
 *
 * ⚠️ **부분 병합이 아니라 통째로 덮어쓴다.** 낱개 저장(save_doc)은 Firestore 의
 *    merge 규칙을 그대로 따르지만, 여기는 upsert 라 기존 data 가 사라진다.
 *    지금 쓰는 곳(쿠폰 대량 발급)은 전부 새 문서를 만드는 경우라 문제가 없다.
 *    기존 문서를 조금씩 고치는 용도로는 쓰면 안 된다 — 그건 save_doc 쪽이다.
 *
 * 테이블별로 모아 한 번에 보낸다. 450건을 450번 왕복하던 것이 테이블당 1회가 된다.
 */
class CompatBatch {
  private sets = new Map<string, Array<Record<string, any>>>();
  private deletes = new Map<string, string[]>();

  constructor(private sb: SupabaseClient) {}

  set(ref: { table: string; id: string }, value: Record<string, any>): void {
    const rows = this.sets.get(ref.table) ?? [];
    rows.push({ [pkOf(ref.table)]: ref.id, data: value });
    this.sets.set(ref.table, rows);
  }

  delete(ref: { table: string; id: string }): void {
    const ids = this.deletes.get(ref.table) ?? [];
    ids.push(ref.id);
    this.deletes.set(ref.table, ids);
  }

  async commit(): Promise<void> {
    for (const [t, rows] of this.sets) {
      const { error } = await this.sb.from(t).upsert(rows, { onConflict: pkOf(t) });
      if (error) throw error;
    }
    for (const [t, ids] of this.deletes) {
      const { error } = await this.sb.from(t).delete().in(pkOf(t), ids);
      if (error) throw error;
    }
    this.sets.clear();
    this.deletes.clear();
  }
}

/**
 * Firestore 모양의 DB 핸들. `getFirebaseAdmin().firestore()` 자리에 그대로 들어간다.
 */
export interface CompatDb {
  collection(name: string): CompatCollection;
  batch(): CompatBatch;
}

export function getDb(): CompatDb | null {
  const sb = getSupabaseAdmin();
  if (!sb) return null;
  return {
    collection: (name: string) => new CompatCollection(sb, name),
    batch: () => new CompatBatch(sb),
  };
}

/**
 * Firestore 의 FieldValue 자리.
 * save_doc 이 `__op` 를 보고 DB 안에서 처리한다(원자 증감·필드 삭제).
 */
export const FieldValue = {
  serverTimestamp: () => new Date().toISOString(),
  delete: () => ({ __op: 'delete' }),
  increment: (by: number) => ({ __op: 'increment', by }),
  arrayUnion: (...values: unknown[]) => ({ __op: 'arrayUnion', values }),
  arrayRemove: (...values: unknown[]) => ({ __op: 'arrayRemove', values }),
};
