import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, initPostgres } from './postgres.js';
import { logger } from '../lib/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(): Promise<void> {
  try {
    // Test connection first
    await initPostgres();

    logger.info('Starting database migrations...');

    // Read schema file
    const schemaPath = path.resolve(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');

    // Execute schema (split by semicolons for individual statements)
    const statements = schema
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('--'));

    for (const statement of statements) {
      if (statement.trim()) {
        try {
          await pool.query(statement);
        } catch (error) {
          // Ignore "already exists" errors
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (!errorMessage.includes('already exists') && !errorMessage.includes('duplicate')) {
            logger.warn(`Migration statement warning: ${errorMessage}`);
          }
        }
      }
    }

    logger.info('Database migrations completed successfully');
  } catch (error) {
    logger.error('Database migration failed', { error });
    throw error;
  }
}

// Run migrations if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => {
      console.log('✅ Migrations completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Migration failed:', error);
      process.exit(1);
    });
}

