import { Router } from 'express';
import { pool } from '../db/postgres.js';

const router = Router();

// GET /api/signals - Fetch recent trading signals
router.get('/', async (req, res) => {
  try {
    const { 
      hours = '24', 
      limit = '100',
      symbol,
      executed 
    } = req.query;
    
    const hoursNum = parseInt(hours as string);
    const limitNum = parseInt(limit as string);
    
    // Build query
    let query = `
      SELECT 
        id,
        user_id,
        strategy_id,
        signal_source,
        symbol,
        action,
        price,
        confidence,
        rsi_value,
        indicators,
        gemini_validated,
        gemini_decision,
        gemini_confidence,
        gemini_reason,
        executed,
        execution_error,
        order_id,
        trade_id,
        exchange,
        product,
        environment,
        triggered_by,
        created_at,
        updated_at
      FROM signals
      WHERE created_at >= NOW() - INTERVAL '${hoursNum} hours'
    `;
    
    // Add filters
    const params: any[] = [];
    let paramIndex = 1;
    
    if (symbol) {
      query += ` AND symbol = $${paramIndex}`;
      params.push(symbol);
      paramIndex++;
    }
    
    if (executed !== undefined) {
      const executedBool = executed === 'true';
      query += ` AND executed = $${paramIndex}`;
      params.push(executedBool);
      paramIndex++;
    }
    
    query += ` ORDER BY created_at DESC LIMIT ${limitNum}`;
    
    const result = await pool.query(query, params);
    
    // Parse JSON fields
    const signals = result.rows.map(row => ({
      ...row,
      indicators: typeof row.indicators === 'string' 
        ? JSON.parse(row.indicators) 
        : row.indicators,
      gemini_decision: typeof row.gemini_decision === 'string'
        ? JSON.parse(row.gemini_decision)
        : row.gemini_decision
    }));
    
    res.json({
      success: true,
      count: signals.length,
      signals,
      meta: {
        hours: hoursNum,
        limit: limitNum,
        filters: { symbol, executed }
      }
    });
  } catch (error) {
    console.error('Error fetching signals:', error);
    res.status(500).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

// GET /api/signals/summary - Get signal statistics
router.get('/summary', async (req, res) => {
  try {
    const { hours = '24' } = req.query;
    const hoursNum = parseInt(hours as string);
    
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_signals,
        SUM(CASE WHEN executed = true THEN 1 ELSE 0 END) as executed_count,
        SUM(CASE WHEN executed = false THEN 1 ELSE 0 END) as filtered_count,
        ROUND(AVG(confidence) * 100, 2) as avg_confidence,
        MAX(CASE WHEN executed = true THEN created_at END) as last_execution_time,
        MAX(CASE WHEN executed = true THEN symbol END) as last_executed_symbol
      FROM signals
      WHERE 
        signal_source = 'auto'
        AND created_at >= NOW() - INTERVAL '${hoursNum} hours'
    `);
    
    res.json({
      success: true,
      summary: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching signal summary:', error);
    res.status(500).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

export { router as signalsRouter };
