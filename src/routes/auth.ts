import { Router } from 'express';
import type { Request, Response } from 'express';
import '../config/env.js';
import bcrypt from 'bcryptjs';
import jwt, { type SignOptions } from 'jsonwebtoken';
import type { StringValue } from 'ms';
import { pool } from '../db/postgres.js';
import crypto from 'node:crypto';
import { validate, authSchemas } from '../middleware/validation.js';
import { authRateLimiter } from '../middleware/security.js';
import { asyncHandler, CustomError } from '../middleware/errorHandler.js';
import { logger } from '../lib/logger.js';

const router = Router();

// Use JWT_SECRET from env, or generate a dev secret if not provided
const jwtSecret = process.env.JWT_SECRET || (process.env.NODE_ENV !== 'production' 
  ? 'dev-secret-key-change-in-production-' + Date.now() 
  : null);

if (!jwtSecret) {
  throw new Error('Missing JWT_SECRET. Please set JWT_SECRET in your .env file for production.');
}

const jwtExpiresIn: StringValue | number = (process.env.JWT_EXPIRES_IN || '7d') as StringValue;

const createAccessToken = (authUserId: string, email: string): string => {
  const payload = {
    sub: authUserId,
    email,
    role: 'authenticated',
    aud: 'authenticated',
  };
  const options: jwt.SignOptions = {
    expiresIn: jwtExpiresIn,
  };
  return jwt.sign(payload, jwtSecret as string, options);
};

const handleRegister = async (req: Request, res: Response) => {
  const client = await pool.connect();
  
  try {
   const { email, password, referralCode } = req.body as {
      email?: string;
      password?: string;
      referralCode?: string;
    };

   if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Check if user exists
   const existingResult = await client.query(
      'SELECT id FROM app_users WHERE email = $1',
      [email.toLowerCase()]
    );
   if (existingResult.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

   const passwordHash = await bcrypt.hash(password, 10);
   const userId = crypto.randomUUID();
   const now = new Date().toISOString();

    // Find referrer by referral code
    let referrerProfileId: string | null = null;
   if (referralCode) {
     const referrerResult = await client.query(
        'SELECT id FROM profiles WHERE referral_code = $1',
        [referralCode.toLowerCase()]
      );
     if (referrerResult.rows.length > 0) {
        referrerProfileId = referrerResult.rows[0].id;
      }
    }

   const newReferralCode = crypto.randomBytes(8).toString('hex');
   const profileId = crypto.randomUUID();
   const botStatusTestnetId = crypto.randomUUID();
   const botStatusMainnetId = crypto.randomUUID();
   const gasFeeTestnetId = crypto.randomUUID();
   const gasFeeMainnetId = crypto.randomUUID();

    // Start transaction
   await client.query('BEGIN');

    // Create app_user
   await client.query(
      'INSERT INTO app_users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)',
      [userId, email.toLowerCase(), passwordHash, now]
    );

    // Create profile
   await client.query(
      `INSERT INTO profiles(id, user_id, display_name, email, referrer_id, referral_code, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [profileId, userId, null, email.toLowerCase(), referrerProfileId, newReferralCode, now, now]
    );

    // Create bot_status for both environments
   await client.query(
      `INSERT INTO bot_status (id, user_id, is_running, environment, exchange, last_trade_at, total_trades, successful_trades, failed_trades, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [botStatusTestnetId, userId, false, 'testnet', 'binance', null, 0, 0, 0, now, now]
    );
   await client.query(
      `INSERT INTO bot_status (id, user_id, is_running, environment, exchange, last_trade_at, total_trades, successful_trades, failed_trades, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [botStatusMainnetId, userId, false, 'mainnet', 'binance', null, 0, 0, 0, now, now]
    );

    // Create gas_fee_balances for both environments
   await client.query(
      `INSERT INTO gas_fee_balances (id, user_id, environment, balance, total_deposited, total_deducted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [gasFeeTestnetId, userId, 'testnet', 0, 0, 0, now, now]
    );
   await client.query(
      `INSERT INTO gas_fee_balances(id, user_id, environment, balance, total_deposited, total_deducted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [gasFeeMainnetId, userId, 'mainnet', 0, 0, 0, now, now]
    );

   await client.query('COMMIT');

   const token = createAccessToken(userId, email.toLowerCase());
    return res.status(201).json({
      token,
      user: { id: userId, email: email.toLowerCase() },
    });
  } catch (error) {
   await client.query('ROLLBACK');
   logger.error('Register error', { error: error instanceof Error ? error.message : String(error) });
    throw new CustomError('Internal error', 500, 'INTERNAL_ERROR');
  } finally {
    client.release();
  }
};

// Apply rate limiting to auth routes
router.use(authRateLimiter);

router.post('/register', validate(authSchemas.register), asyncHandler(handleRegister));
router.post('/signup', validate(authSchemas.register), asyncHandler(handleRegister));

router.post('/login', validate(authSchemas.login), asyncHandler(async (req, res) => {
  try {
   const { email, password } = req.body as { email?: string; password?: string };
   if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

   const result = await pool.query(
      'SELECT * FROM app_users WHERE email = $1',
      [email.toLowerCase()]
    );
   const appUser = result.rows[0];
    
   if (!appUser) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
   const ok = await bcrypt.compare(password, appUser.password_hash);
   if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
   const token = createAccessToken(appUser.id, appUser.email);
    return res.json({
      token,
      user: { id: appUser.id, email: appUser.email },
    });
  } catch (error) {
   logger.error('Login error', { error: error instanceof Error ? error.message : String(error) });
    throw new CustomError('Internal error', 500, 'INTERNAL_ERROR');
  }
}));

router.get('/me', (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.slice('Bearer '.length);
    const payload = jwt.verify(token, jwtSecret) as { sub: string; email?: string };
    return res.json({ user: { id: payload.sub, email: payload.email ?? null } });
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

export const authRouter = router;
export default router; // Default export for NodeNext compatibility

