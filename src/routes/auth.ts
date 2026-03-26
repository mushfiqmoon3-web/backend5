import type { Request, Response, NextFunction } from 'express';
import '../config/env.js';
import jwt from 'jsonwebtoken';
import { pool } from '../db/postgres.js';

export interface AuthenticatedRequest extends Request {
  user?: { id: string; email?: string | null };
}

const getJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('Missing JWT_SECRET');
  }
  return secret;
};

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ code: 401, message: 'Unauthorized' });
  }

  const token = authHeader.slice('Bearer '.length);

  try {
    const payload = jwt.verify(token, getJwtSecret()) as { sub: string; email?: string };
    
    // Check if user is banned
    const banCheck = await pool.query(
      'SELECT id, reason, expires_at FROM banned_users WHERE user_id = $1 AND is_active = true',
      [payload.sub]
    );

    if (banCheck.rows.length > 0) {
      const ban = banCheck.rows[0];
      
      // Check if ban has expired
      if (ban.expires_at && new Date(ban.expires_at) < new Date()) {
        // Ban expired, deactivate it
        await pool.query(
          'UPDATE banned_users SET is_active = false WHERE id = $1',
          [ban.id]
        );
      } else {
        // User is banned
        return res.status(403).json({ 
          code: 403, 
          message: 'Account banned',
          reason: ban.reason,
          expiresAt: ban.expires_at
        });
      }
    }

    req.user = { id: payload.sub, email: payload.email ?? null };
    return next();
  } catch (error) {
    return res.status(401).json({ code: 401, message: 'Invalid JWT' });
  }
}

