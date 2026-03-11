/**
 * Database Adapter
 * Provides a unified interface for both LowDB and PostgreSQL
 * Automatically uses PostgreSQL if configured, otherwise falls back to LowDB
 */

import { pool, isPostgresConfigured } from './postgres.js';
import { db as lowdb, safeWrite, type Data } from './index.js';
import { logger } from '../lib/logger.js';

export type DatabaseAdapter = 'lowdb' | 'postgres';

let currentAdapter: DatabaseAdapter = 'lowdb';

/**
 * Initialize database adapter
 */
export async function initDatabase(): Promise<void> {
  if (isPostgresConfigured()) {
    try {
      const { initPostgres } = await import('./postgres.js');
      await initPostgres();
      currentAdapter = 'postgres';
      logger.info('Using PostgreSQL database');
    } catch (error) {
      logger.warn('PostgreSQL connection failed, falling back to LowDB', {
        error: error instanceof Error ? error.message : String(error),
      });
      currentAdapter = 'lowdb';
      const { initDb } = await import('./index.js');
      await initDb();
    }
  } else {
    logger.info('PostgreSQL not configured, using LowDB');
    currentAdapter = 'lowdb';
    const { initDb } = await import('./index.js');
    await initDb();
  }
}

/**
 * Get current database adapter
 */
export function getAdapter(): DatabaseAdapter {
  return currentAdapter;
}

/**
 * Check if PostgreSQL is configured (re-export from postgres)
 */
export { isPostgresConfigured } from './postgres.js';

/**
 * Get database instance (for backward compatibility)
 */
export function getDb(): typeof lowdb {
  if (currentAdapter === 'postgres') {
    throw new Error('Cannot use LowDB API with PostgreSQL. Use PostgreSQL-specific functions.');
  }
  return lowdb;
}

/**
 * Safe write (only for LowDB)
 */
export async function dbSafeWrite(): Promise<void> {
  if (currentAdapter === 'postgres') {
    // PostgreSQL doesn't need explicit writes
    return;
  }
  await safeWrite();
}

/**
 * PostgreSQL Query Helpers
 */
export class PostgresQueries {
  // App Users
  static async getAppUserByEmail(email: string) {
    const result = await pool.query('SELECT * FROM app_users WHERE email = $1', [email.toLowerCase()]);
    return result.rows[0] || null;
  }

  static async getAppUserById(id: string) {
    const result = await pool.query('SELECT * FROM app_users WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  static async createAppUser(email: string, passwordHash: string) {
    const result = await pool.query(
      'INSERT INTO app_users (email, password_hash) VALUES ($1, $2) RETURNING *',
      [email.toLowerCase(), passwordHash]
    );
    return result.rows[0];
  }

  // Profiles
  static async getProfileByUserId(userId: string) {
    const result = await pool.query('SELECT * FROM profiles WHERE user_id = $1', [userId]);
    return result.rows[0] || null;
  }

  static async getProfileByReferralCode(referralCode: string) {
    const result = await pool.query('SELECT * FROM profiles WHERE referral_code = $1', [referralCode]);
    return result.rows[0] || null;
  }

  static async createProfile(data: {
    userId: string;
    email: string;
    referrerId?: string | null;
    referralCode: string;
  }) {
    const result = await pool.query(
      `INSERT INTO profiles (user_id, email, referrer_id, referral_code) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [data.userId, data.email, data.referrerId || null, data.referralCode]
    );
    return result.rows[0];
  }

  // API Keys
  static async getApiKeysByUserId(userId: string) {
    const result = await pool.query(
      'SELECT * FROM api_keys WHERE user_id = $1 AND is_active = true',
      [userId]
    );
    return result.rows;
  }

  static async getApiKeyByUserAndEnv(
    userId: string,
    exchange: string,
    product: string,
    environment: string
  ) {
    const result = await pool.query(
      `SELECT * FROM api_keys 
       WHERE user_id = $1 AND exchange = $2 AND product = $3 AND environment = $4 AND is_active = true`,
      [userId, exchange, product, environment]
    );
    return result.rows[0] || null;
  }

  static async createApiKey(data: {
    userId: string;
    keyName: string;
    exchange: string;
    product: string;
    environment: string;
    apiKeyEncrypted: string;
    apiSecretEncrypted: string;
  }) {
    const result = await pool.query(
      `INSERT INTO api_keys (user_id, key_name, exchange, product, environment, api_key_encrypted, api_secret_encrypted)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        data.userId,
        data.keyName,
        data.exchange,
        data.product,
        data.environment,
        data.apiKeyEncrypted,
        data.apiSecretEncrypted,
      ]
    );
    return result.rows[0];
  }

  // Trading Strategies
  static async getStrategiesByUserId(userId: string) {
    const result = await pool.query('SELECT * FROM trading_strategies WHERE user_id = $1', [userId]);
    return result.rows;
  }

  static async getStrategyById(strategyId: string) {
    const result = await pool.query('SELECT * FROM trading_strategies WHERE id = $1', [strategyId]);
    return result.rows[0] || null;
  }

  static async createStrategy(data: {
    userId: string;
    name: string;
    webhookSecret?: string | null;
    config?: Record<string, unknown>;
  }) {
    const result = await pool.query(
      `INSERT INTO trading_strategies (user_id, name, webhook_secret, config)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [data.userId, data.name, data.webhookSecret || null, JSON.stringify(data.config || {})]
    );
    return result.rows[0];
  }

  static async updateStrategy(strategyId: string, updates: Partial<{
    name: string;
    webhookSecret: string | null;
    isActive: boolean;
    config: Record<string, unknown>;
  }>) {
    const setClause: string[] = [];
    const values: unknown[] = [];
    let paramCount = 1;

    if (updates.name !== undefined) {
      setClause.push(`name = $${paramCount++}`);
      values.push(updates.name);
    }
    if (updates.webhookSecret !== undefined) {
      setClause.push(`webhook_secret = $${paramCount++}`);
      values.push(updates.webhookSecret);
    }
    if (updates.isActive !== undefined) {
      setClause.push(`is_active = $${paramCount++}`);
      values.push(updates.isActive);
    }
    if (updates.config !== undefined) {
      setClause.push(`config = $${paramCount++}`);
      values.push(JSON.stringify(updates.config));
    }

    setClause.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(strategyId);

    const result = await pool.query(
      `UPDATE trading_strategies SET ${setClause.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  // Generic query helper
  static async query<T = unknown>(text: string, params?: unknown[]): Promise<T[]> {
    const result = await pool.query(text, params);
    return result.rows as T[];
  }

  // Generic insert helper
  static async insert<T = unknown>(table: string, data: Record<string, unknown>): Promise<T> {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const columns = keys.join(', ');

    const result = await pool.query(
      `INSERT INTO ${table} (${columns}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    return result.rows[0] as T;
  }

  // Generic update helper
  static async update<T = unknown>(
    table: string,
    id: string,
    updates: Record<string, unknown>
  ): Promise<T | null> {
    const keys = Object.keys(updates);
    const values = Object.values(updates);
    const setClause = keys.map((key, i) => `${key} = $${i + 1}`).join(', ');
    values.push(id);

    const result = await pool.query(
      `UPDATE ${table} SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING *`,
      values
    );
    return result.rows[0] as T || null;
  }

  // Generic delete helper
  static async delete(table: string, id: string): Promise<boolean> {
    const result = await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    return (result.rowCount || 0) > 0;
  }
}

