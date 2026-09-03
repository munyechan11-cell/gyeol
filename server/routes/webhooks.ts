import { Router } from 'express';

const router = Router();


// --- ORDER STATUS WEBHOOK (from Foodtech or internal) ---
router.post('/api/webhook/order-status', async (req, res) => {
  const { orderId, status, timestamp } = req.body;
  console.log(`[Webhook] Order ${orderId} status changed to: ${status} at ${timestamp || new Date().toISOString()}`);
  
  // Note: In this architecture, Firestore updates are handled client-side via the store.
  // This webhook endpoint is for external POS systems (e.g., Foodtech) to notify status changes.
  // If Firebase Admin SDK is configured, server-side updates can be added here.
  
  res.json({ received: true, orderId, status });
});

export default router;
