import { Router } from 'express';
import { PostgresQueries } from '../db/adapter.js';

const router = Router();

const getBaseUrl = (): string => {
  return process.env.BACKEND_BASE_URL || `http://127.0.0.1:${process.env.PORT || 8080}`;
};

router.post('/tradingview/:secret', async (req, res) => {
  const { secret } = req.params;

  try {
   // Find strategy by webhook_secret
    const strategies = await PostgresQueries.query<{id: string; webhook_secret: string}>('SELECT * FROM trading_strategies WHERE webhook_secret = $1 AND is_active = true', [secret]);
   const strategy = strategies[0];
    
   if (!strategy) {
      return res.status(404).json({ error: 'Strategy not found' });
    }

   const response = await fetch(`${getBaseUrl()}/api/tradingview-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...req.body,
        strategy_id: strategy.id,
        secret,
      }),
    });

   const text = await response.text();
    return res.status(response.status).send(text);
  } catch (error) {
   return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export const webhookRouter = router;
