// DCA Routes - Fetch and manage DCA entries
import { Router, Request, Response } from 'express';
import { pool } from '../db/postgres.js';

export const dcaRouter = Router();

/**
 * GET /dca/entries
 * Fetch DCA entries for a strategy or user
 */
dcaRouter.get('/entries', async (req: Request, res: Response) => {
  try {
    const { strategy_id, user_id, executed } = req.query;

    let query = 'SELECT * FROM dca_entries WHERE 1=1';
    const params: any[] = [];
    let paramCount = 0;

    if (strategy_id) {
      paramCount++;
      query += ` AND strategy_id = $${paramCount}`;
      params.push(strategy_id);
    }

    if (user_id) {
      paramCount++;
      query += ` AND user_id = $${paramCount}`;
      params.push(user_id);
    }

    if (executed !== undefined) {
      paramCount++;
      query += ` AND executed = $${paramCount}`;
      params.push(executed === 'true');
    }

    query += ' ORDER BY level ASC, created_at DESC';

    const result = await pool.query(query, params);

    res.json({
      success: true,
      entries: result.rows,
      count: result.rows.length,
    });
  } catch (error) {
    console.error('Error fetching DCA entries:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch DCA entries',
    });
  }
});

/**
 * GET /dca/stats
 * Get DCA statistics for a user
 */
dcaRouter.get('/stats', async (req: Request, res: Response) => {
  try {
    const { user_id, strategy_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: 'user_id is required',
      });
    }

    let query = `
      SELECT 
        COUNT(*) as total_entries,
        COUNT(*) FILTER (WHERE executed = true) as executed_entries,
        COUNT(*) FILTER (WHERE executed = false) as pending_entries,
        SUM(position_size) FILTER (WHERE executed = true) as total_deployed,
        AVG(average_price) FILTER (WHERE executed = true) as avg_entry_price
      FROM dca_entries 
      WHERE user_id = $1
    `;
    const params: any[] = [user_id];

    if (strategy_id) {
      query += ' AND strategy_id = $2';
      params.push(strategy_id);
    }

    const result = await pool.query(query, params);
    const stats = result.rows[0];

    res.json({
      success: true,
      stats: {
        totalEntries: parseInt(stats.total_entries),
        executedEntries: parseInt(stats.executed_entries),
        pendingEntries: parseInt(stats.pending_entries),
        totalDeployed: parseFloat(stats.total_deployed || 0),
        avgEntryPrice: parseFloat(stats.avg_entry_price || 0),
      },
    });
  } catch (error) {
    console.error('Error fetching DCA stats:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch DCA stats',
    });
  }
});

export default dcaRouter;
