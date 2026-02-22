import pg from 'pg';
import { logger } from '../lib/logger.js';

const { Pool } = pg;

// Create connection pool
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'trading_bot',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection
pool.on('connect', () => {
  logger.info('PostgreSQL client connected');
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle PostgreSQL client', { error: err.message });
});

// Initialize database connection
export async function initPostgres(): Promise<void> {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    logger.info('PostgreSQL connection established', { timestamp: result.rows[0].now });
    client.release();
  } catch (error) {
    logger.error('Failed to connect to PostgreSQL', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

// Close all connections
export async function closePostgres(): Promise<void> {
  await pool.end();
  logger.info('PostgreSQL connection pool closed');
}

// Helper function for transactions
export async function withTransaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Check if PostgreSQL is configured
export function isPostgresConfigured(): boolean {
  return !!(
    process.env.DATABASE_URL ||
    (process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD)
  );
}
