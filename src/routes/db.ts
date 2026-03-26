import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { pool } from '../db/postgres.js';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';

const router = Router();

type DbFilter = { op: 'eq' | 'in'; column: string; value: unknown };

// Build WHERE clause from filters
const buildWhereClause = (filters: DbFilter[] | undefined, paramOffset: number = 1): { where: string; params: unknown[] } => {
  if (!filters || filters.length === 0) {
    return { where: '', params: [] };
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = paramOffset;

  filters.forEach((filter) => {
    if (filter.op === 'eq') {
      conditions.push(`${filter.column} = $${paramIndex++}`);
      params.push(filter.value);
    } else if (filter.op === 'in' && Array.isArray(filter.value)) {
      const placeholders = filter.value.map((_, i) => `$${paramIndex + i}`).join(',');
      conditions.push(`${filter.column} IN (${placeholders})`);
      params.push(...filter.value);
      paramIndex += filter.value.length;
    }
  });

  return { where: `WHERE ${conditions.join(' AND ')}`, params };
};

// Public tables that don't require auth
const PUBLIC_TABLES = ['app_settings'];

const isPublicQuery = (table: string, action: string): boolean => {
  return PUBLIC_TABLES.includes(table) && action === 'select';
};

// Middleware to check if query is public
const checkPublicQuery = (req: Request, res: Response, next: NextFunction) => {
  const { table, action } = req.body as { table?: string; action?: string };
  if (table && action && isPublicQuery(table, action)) {
    // Public query, skip auth
    return next();
  }
  // Require auth
  return requireAuth(req as AuthenticatedRequest, res, next);
};

router.post('/', checkPublicQuery, async (req: Request | AuthenticatedRequest, res: Response) => {
  await handleDbRequest(req, res);
});

async function handleDbRequest(req: Request, res: Response) {
  const client = await pool.connect(); // Get a client from the pool
  try {
    const { table, action, filters, order, limit, data, count, head, returning, onConflict } = req.body as {
      table: string;
      action: 'select' | 'insert' | 'update' | 'delete' | 'upsert';
      filters?: DbFilter[];
      order?: { column: string; ascending: boolean };
      limit?: number;
      data?: Record<string, unknown> | Record<string, unknown>[];
      count?: boolean;
      head?: boolean;
      returning?: boolean;
      onConflict?: string;
    };

    if (!table || !action) {
      return res.status(400).json({ error: 'Missing table or action' });
    }

    if (action === 'select') {
      const { where, params } = buildWhereClause(filters, 1);
      
      let query = `SELECT * FROM ${table} ${where}`;
      const queryParams = [...params];
      
      if (order?.column) {
        query += ` ORDER BY ${order.column} ${order.ascending ? 'ASC' : 'DESC'}`;
      }
      
      if (typeof limit === 'number') {
        query += ` LIMIT ${limit}`;
      }

      const result = await client.query(query, queryParams);
      const totalCount = count ? result.rows.length : undefined;
      const returnData = head ? [] : result.rows;
      
      return res.json({ data: returnData, count: count ? totalCount : undefined });
    }

    if (action === 'insert') {
      const payload = Array.isArray(data) ? data : [data || {}];
      
      const inserted: Record<string, unknown>[] = [];
      
      for (const row of payload) {
        // Remove updated_at to avoid conflicts with triggers
        const { updated_at, ...rowWithoutUpdatedAt } = row;
        const keys = Object.keys(rowWithoutUpdatedAt);
        const values = Object.values(rowWithoutUpdatedAt);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
        
        const insertQuery = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`;
        const result = await client.query(insertQuery, values);
        inserted.push(result.rows[0]);
      }
      
      return res.json({ data: returning ? inserted : null });
    }

    if (action === 'upsert') {
      const payload = Array.isArray(data) ? data : [data || {}];
      const conflictFields = onConflict ? onConflict.split(',').map((s) => s.trim()).filter(Boolean) : [];
      const upserted: Record<string, unknown>[] = [];

      for (const row of payload) {
        // Remove updated_at to avoid conflicts with triggers
        const { updated_at, ...rowWithoutUpdatedAt } = row;
        const keys = Object.keys(rowWithoutUpdatedAt);
        const values = Object.values(rowWithoutUpdatedAt);
        const updateKeys = keys.filter(k => !conflictFields.includes(k));
        
        const setClause = updateKeys.map((key, i) => `${key} = EXCLUDED.${key}`).join(', ');
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
        
        const conflictColumns = conflictFields.length > 0 ? conflictFields.join(', ') : 'id';
        
        const upsertQuery = `
          INSERT INTO ${table} (${keys.join(', ')}) 
          VALUES (${placeholders})
          ON CONFLICT (${conflictColumns}) 
          DO UPDATE SET ${setClause}, updated_at = CURRENT_TIMESTAMP
          RETURNING *
        `;
        
        const result = await client.query(upsertQuery, values);
        upserted.push(result.rows[0]);
      }
      
      return res.json({ data: returning ? upserted : null });
    }

    if (action === 'update') {
      const { where, params } = buildWhereClause(filters, Object.keys(data || {}).length + 1);
      
      const keys = Object.keys(data || {});
      const values = Object.values(data || {});
      const setClause = keys.map((key, i) => `${key} = $${i + 1}`).join(', ');
      
      const updateQuery = `UPDATE ${table} SET ${setClause}, updated_at = CURRENT_TIMESTAMP ${where} RETURNING *`;
      const queryParams = [...values, ...params];
      
      const result = await client.query(updateQuery, queryParams);
      
      return res.json({ data: returning ? result.rows : null });
    }

    if (action === 'delete') {
      const { where, params } = buildWhereClause(filters, 1);
      
      const deleteQuery = `DELETE FROM ${table} ${where} RETURNING *`;
      const result = await client.query(deleteQuery, params);
      
      return res.json({ data: returning ? result.rows : null });
    }

    return res.status(400).json({ error: 'Unsupported action' });
  } catch (error) {
    console.error('Database router error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  } finally {
    client.release(); // ALWAYS release the client back to the pool
  }
}

export const dbRouter = router;
