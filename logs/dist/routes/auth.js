import { Router } from 'express';
import '../config/env.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db, safeWrite } from '../db/index.js';
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
const jwtExpiresIn = (process.env.JWT_EXPIRES_IN || '7d');
const createAccessToken = (authUserId, email) => {
    const payload = {
        sub: authUserId,
        email,
        role: 'authenticated',
        aud: 'authenticated',
    };
    const options = {
        expiresIn: jwtExpiresIn,
    };
    return jwt.sign(payload, jwtSecret, options);
};
const handleRegister = async (req, res) => {
    try {
        const { email, password, referralCode } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }
        const existing = db.data?.app_users.find((u) => u.email === email.toLowerCase());
        if (existing) {
            return res.status(409).json({ error: 'Email already registered' });
        }
        const passwordHash = await bcrypt.hash(password, 10);
        const userId = crypto.randomUUID();
        const now = new Date().toISOString();
        // Ensure all arrays exist
        db.data ||= {
            app_users: [],
            api_keys: [],
            trading_strategies: [],
            webhook_logs: [],
            user_roles: [],
            trades: [],
            bot_status: [],
            profiles: [],
            positions: [],
            account_balances: [],
            gas_fee_balances: [],
            gas_fee_transactions: [],
            referral_commissions: [],
            admin_earnings: [],
            profit_settlements: [],
            pending_deposits: [],
            deposit_addresses: [],
            user_settings: [],
            app_settings: [],
        };
        // Create app_user
        db.data.app_users.push({
            id: userId,
            email: email.toLowerCase(),
            password_hash: passwordHash,
            created_at: now,
        });
        // Create profile
        let referrerProfileId = null;
        if (referralCode) {
            // Find referrer by referral code
            const referrer = db.data.profiles.find((p) => p.referral_code?.toLowerCase() === referralCode.toLowerCase());
            if (referrer) {
                referrerProfileId = referrer.id;
            }
        }
        db.data.profiles.push({
            id: crypto.randomUUID(),
            user_id: userId,
            display_name: null,
            email: email.toLowerCase(),
            referrer_id: referrerProfileId,
            referral_code: crypto.randomBytes(8).toString('hex'),
            created_at: now,
            updated_at: now,
        });
        // Create bot_status for both environments
        db.data.bot_status.push({
            id: crypto.randomUUID(),
            user_id: userId,
            is_running: false,
            environment: 'testnet',
            exchange: 'binance',
            last_trade_at: null,
            total_trades: 0,
            successful_trades: 0,
            failed_trades: 0,
            created_at: now,
            updated_at: now,
        });
        db.data.bot_status.push({
            id: crypto.randomUUID(),
            user_id: userId,
            is_running: false,
            environment: 'mainnet',
            exchange: 'binance',
            last_trade_at: null,
            total_trades: 0,
            successful_trades: 0,
            failed_trades: 0,
            created_at: now,
            updated_at: now,
        });
        // Create gas_fee_balances for both environments
        db.data.gas_fee_balances.push({
            id: crypto.randomUUID(),
            user_id: userId,
            environment: 'testnet',
            balance: 0,
            total_deposited: 0,
            total_deducted: 0,
            created_at: now,
            updated_at: now,
        });
        db.data.gas_fee_balances.push({
            id: crypto.randomUUID(),
            user_id: userId,
            environment: 'mainnet',
            balance: 0,
            total_deposited: 0,
            total_deducted: 0,
            created_at: now,
            updated_at: now,
        });
        await safeWrite();
        const token = createAccessToken(userId, email.toLowerCase());
        return res.status(201).json({
            token,
            user: { id: userId, email: email.toLowerCase() },
        });
    }
    catch (error) {
        logger.error('Register error', { error: error instanceof Error ? error.message : String(error) });
        throw new CustomError('Internal error', 500, 'INTERNAL_ERROR');
    }
};
// Apply rate limiting to auth routes
router.use(authRateLimiter);
router.post('/register', validate(authSchemas.register), asyncHandler(handleRegister));
router.post('/signup', validate(authSchemas.register), asyncHandler(handleRegister));
router.post('/login', validate(authSchemas.login), asyncHandler(async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }
        const appUser = db.data?.app_users.find((u) => u.email === email.toLowerCase());
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
    }
    catch (error) {
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
        const payload = jwt.verify(token, jwtSecret);
        return res.json({ user: { id: payload.sub, email: payload.email ?? null } });
    }
    catch (error) {
        return res.status(401).json({ error: 'Invalid token' });
    }
});
export const authRouter = router;
