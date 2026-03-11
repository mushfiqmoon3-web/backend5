import { Router } from 'express';
import { PostgresQueries } from '../db/adapter.js';
import crypto from 'node:crypto';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

router.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const strategies = await PostgresQueries.getStrategiesByUserId(req.user?.id as string);
    return res.json(strategies);
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

router.post('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const strategy = {
      id: crypto.randomUUID(),
      user_id: req.user?.id as string,
      is_active: true,
      ...req.body,
    };
    
    await PostgresQueries.insert('trading_strategies', {
      ...strategy,
      config: JSON.stringify(strategy.config || {}),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    
    return res.json(strategy);
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export const strategiesRouter = router;
