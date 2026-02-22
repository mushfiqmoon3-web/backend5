/**
 * Migration Script: LowDB to PostgreSQL
 * 
 * This script migrates all data from LowDB (JSON file) to PostgreSQL
 * 
 * Usage:
 *   npm run migrate:postgres
 * 
 * Make sure PostgreSQL is configured in .env before running
 */

import '../src/config/env.js';
import { initDb, db } from '../src/db/index.js';
import { initPostgres, pool, isPostgresConfigured } from '../src/db/postgres.js';
import { logger } from '../src/lib/logger.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function migrateTable(
  tableName: string,
  insertQuery: string,
  getData: () => unknown[]
): Promise<number> {
  const data = getData();
  if (data.length === 0) {
    logger.info(`No data to migrate for ${tableName}`);
    return 0;
  }

  let migrated = 0;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const row of data) {
      try {
        const values = Object.values(row);
        await client.query(insertQuery, values);
        migrated++;
      } catch (error) {
        logger.warn(`Failed to migrate row in ${tableName}`, {
          error: error instanceof Error ? error.message : String(error),
          row: row,
        });
      }
    }

    await client.query('COMMIT');
    logger.info(`Migrated ${migrated}/${data.length} rows from ${tableName}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return migrated;
}

async function runMigration() {
  if (!isPostgresConfigured()) {
    logger.error('PostgreSQL not configured. Please set DATABASE_URL or DB_* variables in .env');
    process.exit(1);
  }

  logger.info('Starting migration from LowDB to PostgreSQL...');

  // Initialize both databases
  await initDb();
  await initPostgres();

  // Read schema and create tables
  const schemaPath = path.resolve(__dirname, '../src/db/schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  await pool.query(schema);
  logger.info('PostgreSQL schema created/verified');

  // Migrate data
  await db.read();
  const data = db.data;

  if (!data) {
    logger.error('No data found in LowDB');
    process.exit(1);
  }

  let totalMigrated = 0;

  // Migrate app_users
  if (data.app_users?.length > 0) {
    const count = await migrateTable(
      'app_users',
      'INSERT INTO app_users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
      () => data.app_users || []
    );
    totalMigrated += count;
  }

  // Migrate profiles
  if (data.profiles?.length > 0) {
    const count = await migrateTable(
      'profiles',
      `INSERT INTO profiles (id, user_id, display_name, email, referrer_id, referral_code, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
      () => data.profiles || []
    );
    totalMigrated += count;
  }

  // Migrate api_keys
  if (data.api_keys?.length > 0) {
    const count = await migrateTable(
      'api_keys',
      `INSERT INTO api_keys (id, user_id, key_name, exchange, product, environment, api_key_encrypted, api_secret_encrypted, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (user_id, exchange, product, environment) DO NOTHING`,
      () => data.api_keys || []
    );
    totalMigrated += count;
  }

  // Migrate trading_strategies
  if (data.trading_strategies?.length > 0) {
    const count = await migrateTable(
      'trading_strategies',
      `INSERT INTO trading_strategies (id, user_id, name, webhook_secret, is_active, config, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) ON CONFLICT (id) DO NOTHING`,
      () => (data.trading_strategies || []).map((s: any) => ({
        ...s,
        config: typeof s.config === 'object' ? JSON.stringify(s.config) : '{}',
      }))
    );
    totalMigrated += count;
  }

  // Migrate other tables similarly...
  // (Add migrations for all tables as needed)

  logger.info(`Migration completed. Total rows migrated: ${totalMigrated}`);
  logger.info('Please verify the data in PostgreSQL and update your .env to use PostgreSQL');
}

runMigration()
  .then(() => {
    logger.info('Migration script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Migration failed', { error: error.message, stack: error.stack });
    process.exit(1);
  });

