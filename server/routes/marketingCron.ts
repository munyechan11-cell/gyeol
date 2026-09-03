import { Router } from 'express';

import { getDb, type CompatDb } from '../lib/db.js';
import { sendPushToOwner } from '../lib/push.js';

const router = Router();


// --- MARKETING AUTOMATION (생일/이탈 쿠폰 자동 발급) ---
// 각 매장의 marketingTriggers 에 따라 발급. 중복 방지: 같은 type available 보유 시 skip → 매일 돌아도 1장만.
async function runMarketingAutomation(db: CompatDb): Promise<{ birthdayIssued: number; winbackIssued: number; capped: number }> {
    // KST(UTC+9) 기준 오늘 — 생일/경과일 판정
    const kstMs = Date.now() + 9 * 3600 * 1000;
    const kst = new Date(kstMs);
    const todayMMDD = `${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;

    const usersSnap = await db.collection('users').get();
    const userById = new Map<string, any>();
    const owners: any[] = [];
    usersSnap.docs.forEach((d) => {
      const u = { id: d.id, ...(d.data() as any) };
      userById.set(d.id, u);
      if (u.role === 'owner') owners.push(u);
    });

    let birthdayIssued = 0;
    let winbackIssued = 0;
    let capped = 0;

    for (const owner of owners) {
      const triggers = owner.storeConfig?.marketingTriggers ?? {};
      if (!triggers.birthdayCoupon && !triggers.inactiveDays) continue;
      const storeId = owner.id;
      try {
        // 매장 손님별 마지막 방문일
        const visitsSnap = await db.collection('visits').where('storeId', '==', storeId).get();
        const lastVisit = new Map<string, string>();
        visitsSnap.docs.forEach((v) => {
          const d = v.data() as any;
          const prev = lastVisit.get(d.customerId);
          if (!prev || d.date > prev) lastVisit.set(d.customerId, d.date);
        });
        if (lastVisit.size === 0) continue;

        // 기존 available 쿠폰 — 중복 발급 방지
        const cpSnap = await db
          .collection('coupons')
          .where('storeId', '==', storeId)
          .where('status', '==', 'available')
          .get();
        const held = new Set<string>();
        cpSnap.docs.forEach((c) => {
          const d = c.data() as any;
          held.add(`${d.customerId}|${d.type}`);
        });

        const winbackCutoff = triggers.inactiveDays
          ? new Date(kstMs - triggers.inactiveDays * 86400000).toISOString().slice(0, 10)
          : null;

        let batch = db.batch();
        let n = 0;
        const pushTargets: Array<{ cid: string; type: string }> = [];
        const issue = (cid: string, type: string, descKey: string) => {
          const ref = db.collection('coupons').doc();
          batch.set(ref, {
            id: ref.id,
            customerId: cid,
            storeId,
            type,
            description: '',
            descKey,
            status: 'available',
            issuedAt: new Date().toISOString(),
          });
          n++;
          pushTargets.push({ cid, type });
        };

        for (const [cid, last] of lastVisit) {
          if (n >= 450) { await batch.commit(); batch = db.batch(); n = 0; capped++; } // 450 단위 chunk 커밋 — 대형 매장도 누락 없이 전량 처리
          const u = userById.get(cid);
          if (!u) continue;
          if (
            triggers.birthdayCoupon &&
            u.birthday &&
            String(u.birthday).slice(5) === todayMMDD &&
            !held.has(`${cid}|birthday`)
          ) {
            issue(cid, 'birthday', 'coupon.birthday');
            birthdayIssued++;
          }
          if (winbackCutoff && last < winbackCutoff && !held.has(`${cid}|winback`)) {
            issue(cid, 'winback', 'coupon.winback');
            winbackIssued++;
          }
        }
        if (n > 0) await batch.commit();

        // 발급받은 손님에게 쿠폰 도착 푸시(도달 보강). 토큰 미등록 손님은 자동 스킵(sent:0).
        const storeName = owner.restaurantName || '단골 매장';
        for (const tgt of pushTargets) {
          const title = tgt.type === 'birthday'
            ? '🎂 생일 축하 쿠폰이 도착했어요'
            : '🎁 다시 만나요, 쿠폰이 도착했어요';
          await sendPushToOwner({
            storeId: tgt.cid, // 손님 users 문서로 발송(필드명만 storeId)
            kind: 'coupon-issued',
            title,
            body: `${storeName}에서 보낸 혜택을 쿠폰함에서 확인해보세요`,
            focusUrl: '/customer',
          });
        }
      } catch (e: any) {
        console.error(`[marketing-cron] store ${storeId} failed`, e?.message);
      }
    }

    console.log(`[marketing-cron] birthday=${birthdayIssued} winback=${winbackIssued} capped=${capped}`);
    return { birthdayIssued, winbackIssued, capped };
}

// 외부 cron(cron-job.org 등)이 매일 호출. 무료 cron 타임아웃·cold start 와 무관하도록
// 기본은 즉시 응답 후 백그라운드에서 발급 진행. ?sync=1 이면 동기 실행해 결과 반환(수동 테스트용).
// GET·POST 모두 허용 — cron 서비스가 method 설정을 못 바꿔도 동작(보안은 x-cron-secret 헤더).
router.all('/api/cron/marketing', async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });

  if (req.query.sync === '1') {
    try {
      res.json({ ok: true, ...(await runMarketingAutomation(db)) });
    } catch (e: any) {
      console.error('[marketing-cron] failed', e?.message);
      res.status(500).json({ error: e?.message });
    }
    return;
  }
  // 즉시 응답 → 외부 cron 이 기다리지 않아도 됨. 발급은 백그라운드에서 진행.
  res.json({ ok: true, accepted: true });
  runMarketingAutomation(db).catch((e) => console.error('[marketing-cron] failed', e?.message));
});

export default router;
