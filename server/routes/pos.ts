import { Router } from 'express';

const router = Router();


// --- FOODTECH POS RELAY API ---
router.post('/api/order/relay-to-pos', async (req, res) => {
  const { orderId, foodtechStoreCode, tableNumber, items, totalAmount } = req.body;

  const FOODTECH_API_KEY = process.env.FOODTECH_API_KEY;
  
  if (!FOODTECH_API_KEY || FOODTECH_API_KEY === 'YOUR_REAL_KEY_HERE') {
    console.warn(`[Foodtech Relay] API Key not set. Order ${orderId} logged locally only.`);
    return res.json({ success: true, mode: 'test', message: 'POS relay skipped (no API key). Order saved to Firestore only.' });
  }

  try {
    const FOODTECH_API_URL = process.env.FOODTECH_API_URL || 'https://api.foodtech.co.kr/v1/order/relay';
    
    const relayPayload = {
      store_code: foodtechStoreCode,
      order_id: orderId,
      order_type: 'WEB_QR',
      table_no: tableNumber,
      order_items: items.map((item: any) => ({
        product_code: item.posCode || '9999',
        product_name: item.name,
        quantity: item.quantity,
        price: item.price
      })),
      amount: {
        total: totalAmount,
        payment: totalAmount
      },
      payment_type: 'PREPAID',
      ordered_at: new Date().toISOString()
    };

    const response = await fetch(FOODTECH_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${FOODTECH_API_KEY}`,
        'X-Request-Id': orderId
      },
      body: JSON.stringify(relayPayload)
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[Foodtech Relay] HTTP ${response.status}: ${errorBody}`);
      return res.status(502).json({ success: false, error: `POS relay failed (HTTP ${response.status})` });
    }

    const result = await response.json();
    console.log(`[Foodtech Relay] Order ${orderId} successfully relayed to store ${foodtechStoreCode}`);
    res.json({ success: true, mode: 'live', posResponse: result });

  } catch (error: any) {
    console.error('[Relay Error]', error.message);
    res.status(500).json({ success: false, error: 'POS 전송에 실패했어요. 잠시 후 다시 시도해 주세요.' }); // 내부 오류 메시지 비노출

  }
});

export default router;
