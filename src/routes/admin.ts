import { Router, Request } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { pool } from '../db/postgres.js';
import { asyncHandler, CustomError } from '../middleware/errorHandler.js';
import crypto from 'node:crypto';

// Extend Express Request type to include adminUserId
declare global {
  namespace Express {
    interface Request {
      adminUserId?: string;
    }
  }
}

const router = Router();

// Middleware to check if user is admin
const requireAdmin = async (req: any, res: any, next: any) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.slice('Bearer '.length);
    const jwt = await import('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
    
    const payload = jwt.default.verify(token, JWT_SECRET) as { sub: string };
    const userId = payload.sub;

    // Check if user has admin role
    const adminCheck = await pool.query(
      'SELECT id FROM user_roles WHERE user_id = $1 AND role = $2',
      [userId, 'admin']
    );

    if (adminCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    req.adminUserId = userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// GET /api/admin/users - Get all users with stats
router.get('/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id,
        u.email,
        u.password_hash,
        u.created_at as user_created_at,
        p.display_name,
        p.referral_code,
        p.referrer_id,
        p.created_at as profile_created_at,
        p.updated_at as profile_updated_at,
        COALESCE(ur.user_id IS NOT NULL, false) as is_admin,
        COALESCE(br.user_id IS NOT NULL, false) as is_banned,
        COALESCE(stats.total_trades, 0) as total_trades,
        COALESCE(stats.total_pnl, 0) as total_pnl,
        COALESCE(stats.total_positions, 0) as total_positions,
        COALESCE(stats.total_strategies, 0) as total_strategies
      FROM app_users u
      LEFT JOIN profiles p ON u.id = p.user_id
      LEFT JOIN user_roles ur ON u.id = ur.user_id AND ur.role = 'admin'
      LEFT JOIN banned_users br ON u.id = br.user_id AND br.is_active = true
      LEFT JOIN LATERAL (
        SELECT 
          COUNT(DISTINCT t.id) as total_trades,
          COALESCE(SUM(t.realized_pnl), 0) as total_pnl,
          COUNT(DISTINCT ps.id) as total_positions,
          COUNT(DISTINCT ts.id) as total_strategies
        FROM trades t
        LEFT JOIN positions ps ON t.user_id = ps.user_id AND ps.is_open = true AND t.user_id = u.id
        LEFT JOIN trading_strategies ts ON t.user_id = ts.user_id AND t.user_id = u.id
        WHERE t.user_id = u.id
      ) stats ON true
      ORDER BY u.created_at DESC
    `);

    res.json({
      success: true,
      users: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    throw new CustomError('Failed to fetch users', 500, 'FETCH_ERROR');
  }
}));

// DELETE /api/admin/users/:id - Delete user and ALL related data
router.delete('/users/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  try {
    const userId = req.params.id;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Delete webhook logs
      await client.query('DELETE FROM webhook_logs WHERE user_id = $1', [userId]);

      // 2. Delete trades
      await client.query('DELETE FROM trades WHERE user_id = $1', [userId]);

      // 3. Delete positions (open and closed)
      await client.query('DELETE FROM positions WHERE user_id = $1', [userId]);

      // 4. Delete profit settlements
      await client.query('DELETE FROM profit_settlements WHERE user_id = $1', [userId]);

      // 5. Delete referral commissions (both as beneficiary and source)
      await client.query('DELETE FROM referral_commissions WHERE beneficiary_user_id = $1 OR source_user_id = $1', [userId]);

      // 6. Update referred users to remove referrer reference
      await client.query('UPDATE profiles SET referrer_id = NULL WHERE referrer_id IN (SELECT id FROM profiles WHERE user_id = $1)', [userId]);

      // 7. Delete gas fee transactions
      await client.query('DELETE FROM gas_fee_transactions WHERE user_id = $1', [userId]);

      // 8. Delete gas fee balances
      await client.query('DELETE FROM gas_fee_balances WHERE user_id = $1', [userId]);

      // 9. Delete admin earnings
      await client.query('DELETE FROM admin_earnings WHERE source_user_id = $1', [userId]);

      // 10. Delete bot status
      await client.query('DELETE FROM bot_status WHERE user_id = $1', [userId]);

      // 11. Delete API keys
      await client.query('DELETE FROM api_keys WHERE user_id = $1', [userId]);

      // 12. Delete trading strategies
      await client.query('DELETE FROM trading_strategies WHERE user_id = $1', [userId]);

      // 13. Delete user roles
      await client.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);

      // 14. Delete banned user record if exists
      await client.query('DELETE FROM banned_users WHERE user_id = $1', [userId]);

      // 15. Delete profile
      await client.query('DELETE FROM profiles WHERE user_id = $1', [userId]);

      // 16. Finally, delete the user
      await client.query('DELETE FROM app_users WHERE id = $1', [userId]);

      await client.query('COMMIT');

      res.json({
        success: true,
        message: 'User and all related data deleted successfully',
        deletedUserId: userId
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error deleting user:', error);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error in delete user:', error);
    throw new CustomError('Failed to delete user', 500, 'DELETE_ERROR');
  }
}));

// POST /api/admin/users/:id/ban - Ban a user
router.post('/users/:id/ban', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  try {
    const userId = req.params.id;
    const { reason, duration_days } = req.body as { reason?: string; duration_days?: number };

    // Check if user is already banned
    const existingBan = await pool.query(
      'SELECT * FROM banned_users WHERE user_id = $1 AND is_active = true',
      [userId]
    );

    if (existingBan.rows.length > 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'User is already banned' 
      });
    }

    // Calculate ban expiry if duration provided
    const expiresAt = duration_days 
      ? new Date(Date.now() + duration_days * 24 * 60 * 60 * 1000).toISOString()
      : null;

    // Insert ban record
    await pool.query(
      `INSERT INTO banned_users (id, user_id, reason, banned_by, expires_at, is_active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
      [
        crypto.randomUUID(),
        userId,
        reason || 'Banned by admin',
        req.adminUserId || null,
        expiresAt,
        true
      ]
    );

    res.json({
      success: true,
      message: 'User banned successfully',
      banDetails: {
        userId,
        reason: reason || 'Banned by admin',
        expiresAt,
        permanent: !expiresAt
      }
    });
  } catch (error) {
    console.error('Error banning user:', error);
    throw new CustomError('Failed to ban user', 500, 'BAN_ERROR');
  }
}));

// POST /api/admin/users/:id/unban - Unban a user
router.post('/users/:id/unban', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  try {
    const userId = req.params.id;

    // Deactivate ban
    await pool.query(
      'UPDATE banned_users SET is_active = false, unbanned_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND is_active = true',
      [userId]
    );

    res.json({
      success: true,
      message: 'User unbanned successfully'
    });
  } catch (error) {
    console.error('Error unbanning user:', error);
    throw new CustomError('Failed to unban user', 500, 'UNBAN_ERROR');
  }
}));

// GET /api/admin/users/banned - Get all banned users
router.get('/users/banned', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        bu.id as ban_id,
        bu.user_id,
        bu.reason,
        bu.banned_by,
        bu.expires_at,
        bu.is_active,
        bu.created_at as banned_at,
        bu.unbanned_at,
        u.email,
        p.display_name,
        admin_p.email as banned_by_email
      FROM banned_users bu
      LEFT JOIN app_users u ON bu.user_id = u.id
      LEFT JOIN profiles p ON bu.user_id = p.user_id
      LEFT JOIN app_users admin_p ON bu.banned_by = admin_p.id
      WHERE bu.is_active = true
      ORDER BY bu.created_at DESC
    `);

    res.json({
      success: true,
      bannedUsers: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching banned users:', error);
    throw new CustomError('Failed to fetch banned users', 500, 'FETCH_ERROR');
  }
}));

export { router as adminRouter };
