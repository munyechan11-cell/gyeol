import { Router } from 'express';

import { getDb } from '../lib/db.js';
import { resolveCallerStore } from '../lib/storeAuth.js';

const router = Router();


// ============================================================
// 푸드테크 POS 전달 — 주문을 외부 POS 로 넘긴다.
//
// 예전에는 인증이 없었고 매장 코드·품목·금액을 본문에서 받았다. 그러면 아무나
// 서버의 API 키로 임의 매장 코드에 가짜 주문을 흘려 넣을 수 있다. 그리고 손님
// 기기가 사장님의 POS 키를 알아야 했다 — 손님이 사장님 행을 읽던 시절의 흔적이다.
//
// 이제 **주문 id 만** 받는다. 주문·매장·POS 설정은 서버가 DB 에서 읽고, 요청자가
// 그 주문의 손님이거나 그 매장 사람인지 확인한다.
// ============================================================
router.post('/api/order/relay-to-pos', async (req, res) => {
  try {
    const caller = await resolveCallerStore(req.headers.authorization);
    if (!caller) return res.status(401).json({ error: 'unauthorized' });
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });

    const orderId = String(req.body?.orderId ?? '');
    if (!orderId) return res.status(400).json({ error: 'orderId required' });

    const orderSnap = await db.collection('orders').doc(orderId).get();
    if (!orderSnap.exists) return res.status(404).json({ error: 'order not found' });
    const order = orderSnap.data() as any;
    const storeId = String(order.storeId ?? '');
    const mine = order.customerId === caller.userId || (caller.storeId && caller.storeId === storeId);
    if (!mine) return res.status(403).json({ error: 'not your order' });

    const ownerSnap = await db.collection('users').doc(storeId).get();
    const owner = (ownerSnap.data() ?? {}) as any;
    const vendor = owner.posVendor;
    const storeCode = owner.posApiKey || owner.foodtechStoreCode || '';
    if (!vendor || vendor === 'none' || !storeCode) {
      return res.json({ success: true, mode: 'skipped', message: 'POS 연동이 설정되지 않은 매장' });
    }

    const FOODTECH_API_KEY = process.env.FOODTECH_API_KEY;
    if (!FOODTECH_API_KEY || FOODTECH_API_KEY === 'YOUR_REAL_KEY_HERE') {
      console.warn(`[Foodtech Relay] API Key not set. Order ${orderId} logged locally only.`);
      return res.json({ success: true, mode: 'test', message: 'POS relay skipped (no API key). 주문은 DB 에만 저장됨.' });
    }

    // 품목의 POS 코드는 메뉴 문서에서 읽는다(클라이언트가 보내던 값을 서버가 직접 찾는다).
    const items: any[] = Array.isArray(order.items) ? order.items : [];
    const posCodes = new Map<string, string | undefined>();
    for (const it of items) {
      if (it?.menuId && !posCodes.has(it.menuId)) {
        const m = await db.collection('menus').doc(String(it.menuId)).get();
        posCodes.set(it.menuId, m.data()?.posProductCode);
      }
    }

    const FOODTECH_API_URL = process.env.FOODTECH_API_URL || 'https://api.foodtech.co.kr/v1/order/relay';
    const relayPayload = {
      store_code: storeCode,
      order_id: orderId,
      order_type: 'WEB_QR',
      table_no: order.tableNumber,
      order_items: items.map((item: any) => ({
        product_code: posCodes.get(item.menuId) || '9999',
        product_name: item.selectedOptions?.length
          ? `${item.name} (${item.selectedOptions.map((o: any) => o.optionName).join(', ')})`
          : item.name,
        quantity: item.quantity,
        price: item.price,
      })),
      amount: { total: order.totalAmount, payment: order.totalAmount },
      payment_type: 'PREPAID',
      ordered_at: new Date().toISOString(),
    };

    const response = await fetch(FOODTECH_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${FOODTECH_API_KEY}`,
        'X-Request-Id': orderId,
      },
      body: JSON.stringify(relayPayload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[Foodtech Relay] HTTP ${response.status}: ${errorBody}`);
      return res.status(502).json({ success: false, error: `POS relay failed (HTTP ${response.status})` });
    }

    const result = await response.json();
    console.log(`[Foodtech Relay] Order ${orderId} successfully relayed to store ${storeCode}`);
    res.json({ success: true, mode: 'live', vendor, posResponse: result });
  } catch (error: any) {
    console.error('[Relay Error]', error.message);
    res.status(500).json({ success: false, error: 'POS 전송에 실패했어요. 잠시 후 다시 시도해 주세요.' }); // 내부 오류 메시지 비노출
  }
});

export default router;
