/**
 * Complete Migration Script: LowDB to PostgreSQL (Supabase)
 * 
 * This script migrates ALL data from LowDB (db.json) to Supabase PostgreSQL
 * 
 * Usage:
 *   npm run migrate:postgres
 * 
 * Make sure DATABASE_URL is configured in .env before running
 */

import '../src/config/env.js';
import { initDb, db } from '../src/db/index.js';
import { initPostgres, pool, isPostgresConfigured } from '../src/db/postgres.js';
import { logger } from '../src/lib/logger.js';

async function migrateTable(
  tableName: string,
  insertQuery: string,
  getData: () => unknown[]
): Promise<number> {
  const data = getData();
  if (data.length === 0) {
   logger.info(`⏭️  No data to migrate for ${tableName}`);
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
          error: error instanceof Error ? error.message: String(error),
          row: row,
        });
      }
    }

   await client.query('COMMIT');
   logger.info(`✅ Migrated ${migrated}/${data.length} rows from ${tableName}`);
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
   logger.error('❌ PostgreSQL not configured. Please set DATABASE_URL in.env');
    process.exit(1);
  }

  logger.info('🚀 Starting migration from LowDB to Supabase PostgreSQL...');

  // Initialize both databases
  await initDb();
  await initPostgres();

  // Read data from LowDB
  await db.read();
  const data = db.data;

  if (!data) {
   logger.error('❌ No data found in LowDB');
    process.exit(1);
  }

  let totalMigrated = 0;

  logger.info('📊 Data found in db.json:');
  logger.info(`   - app_users: ${data.app_users?.length || 0}`);
  logger.info(`   - trading_strategies: ${data.trading_strategies?.length || 0}`);
  logger.info(`   - api_keys: ${data.api_keys?.length || 0}`);
  logger.info(`   - trades: ${data.trades?.length || 0}`);
  logger.info(`   - positions: ${data.positions?.length || 0}`);
  logger.info(`   - gas_fee_balances: ${data.gas_fee_balances?.length || 0}`);
  logger.info(`   - bot_status: ${data.bot_status?.length || 0}`);
  logger.info(`   - profiles: ${data.profiles?.length || 0}`);

  // 1. Migrate app_users
  if (data.app_users?.length > 0) {
   const count = await migrateTable(
      'app_users',
      'INSERT INTO app_users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
      () => data.app_users || []
    );
    totalMigrated += count;
  }

  // 2. Migrate profiles
  if (data.profiles?.length > 0) {
   const count = await migrateTable(
      'profiles',
      `INSERT INTO profiles (id, user_id, display_name, email, referrer_id, referral_code, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
      () => (data.profiles || []).map((p: any) => ({
       id: p.id,
        user_id: p.user_id,
        display_name: p.display_name || null,
       email: p.email,
        referral_code: p.referral_code,
        created_at: p.created_at,
        updated_at: p.updated_at || p.created_at,
      }))
    );
    totalMigrated += count;
  }

  // 3. Migrate api_keys
  if (data.api_keys?.length > 0) {
   const count = await migrateTable(
      'api_keys',
      `INSERT INTO api_keys (id, user_id, key_name, exchange, product, environment, api_key_encrypted, api_secret_encrypted, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING`,
      () => (data.api_keys || []).map((k: any) => ({
       id: k.id,
        user_id: k.user_id,
        key_name: k.key_name || 'Default Key',
        exchange: k.exchange || 'binance',
        product: k.product || 'futures',
        environment: k.environment || 'testnet',
       api_key_encrypted: k.api_key_encrypted,
       api_secret_encrypted: k.api_secret_encrypted,
       is_active: k.is_active ?? true,
        created_at: k.created_at,
        updated_at: k.updated_at || k.created_at,
      }))
    );
    totalMigrated += count;
  }

  // 4. Migrate trading_strategies (COMPLETE with all fields)
  if (data.trading_strategies?.length > 0) {
   const count = await migrateTable(
      'trading_strategies',
      `INSERT INTO trading_strategies (
       id, user_id, name, description, strategy_type, webhook_secret, is_active, config,
        signal_mode, auto_signal_enabled, auto_signal_interval, auto_signal_indicators, last_signal_at,
        exchange, product, environment, position_size_type, position_size_value, max_positions,
        max_daily_loss, max_drawdown_percent, max_trades_per_day, max_consecutive_losses,
        tp1_percent, tp1_close_percent, tp2_percent, tp2_close_percent, tp3_percent, tp3_close_percent,
        use_tp1, use_tp2, use_tp3, stop_loss_percent, use_trailing_stop, trailing_stop_activation,
       trailing_stop_callback, default_leverage, allowed_pairs, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, $18,
        $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37,
        $38::text[], $39, $40
      ) ON CONFLICT (id) DO NOTHING`,
      () => (data.trading_strategies || []).map((s: any) => ({
       id: s.id,
        user_id: s.user_id,
       name: s.name,
        description: s.description || null,
        strategy_type: s.strategy_type || 'custom',
        webhook_secret: s.webhook_secret || null,
       is_active: s.is_active ?? true,
       config: typeof s.strategy_config === 'object' ? JSON.stringify(s.strategy_config) : '{}',
        signal_mode: s.signal_mode || 'auto',
        auto_signal_enabled: s.auto_signal_enabled ?? false,
        auto_signal_interval: s.auto_signal_interval || 1,
        auto_signal_indicators: typeof s.auto_signal_indicators === 'object' ? JSON.stringify(s.auto_signal_indicators) : '{}',
        last_signal_at: s.last_signal_at || null,
        exchange: s.exchange || 'binance',
        product: s.product || 'futures',
        environment: s.environment || 'testnet',
        position_size_type: s.position_size_type || 'fixed',
        position_size_value: s.position_size_value || 100,
        max_positions: s.max_positions || 5,
        max_daily_loss: s.max_daily_loss || 0,
        max_drawdown_percent: s.max_drawdown_percent || 0,
        max_trades_per_day: s.max_trades_per_day || 0,
        max_consecutive_losses: s.max_consecutive_losses || 0,
        tp1_percent: s.tp1_percent || 1.0,
        tp1_close_percent: s.tp1_close_percent || 33.33,
        tp2_percent: s.tp2_percent || 2.0,
        tp2_close_percent: s.tp2_close_percent || 33.33,
        tp3_percent: s.tp3_percent || 3.0,
        tp3_close_percent: s.tp3_close_percent || 33.34,
        use_tp1: s.use_tp1 ?? true,
        use_tp2: s.use_tp2 ?? true,
        use_tp3: s.use_tp3 ?? true,
        stop_loss_percent: s.stop_loss_percent || 1.0,
        use_trailing_stop: s.use_trailing_stop ?? false,
       trailing_stop_activation: s.trailing_stop_activation || 1.0,
       trailing_stop_callback: s.trailing_stop_callback || 0.5,
        default_leverage: s.default_leverage || 10,
        allowed_pairs: s.allowed_pairs || [],
        created_at: s.created_at,
        updated_at: s.updated_at || s.created_at,
      }))
    );
    totalMigrated += count;
  }

  // 5. Migrate trades
  if (data.trades?.length > 0) {
   const count = await migrateTable(
      'trades',
      `INSERT INTO trades(id, user_id, strategy_id, exchange, environment, symbol, side, size, entry_price, exit_price, leverage, realized_pnl, closed_at, triggered_by, order_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) ON CONFLICT (id) DO NOTHING`,
      () => (data.trades || []).map((t: any) => ({
       id: t.id,
        user_id: t.user_id,
        strategy_id: t.strategy_id || null,
        exchange: t.exchange || 'binance',
        environment: t.environment || 'testnet',
        symbol: t.symbol,
        side: t.side || 'long',
        size: t.size,
        entry_price: t.entry_price,
        exit_price: t.exit_price || null,
        leverage: t.leverage || 1,
        realized_pnl: t.realized_pnl || null,
        closed_at: t.closed_at || null,
       triggered_by: t.triggered_by || 'manual',
        order_id: t.order_id || null,
        created_at: t.created_at,
      }))
    );
    totalMigrated += count;
  }

  // 6. Migrate positions
  if (data.positions?.length > 0) {
   const count = await migrateTable(
      'positions',
      `INSERT INTO positions (id, user_id, exchange, environment, symbol, side, size, entry_price, leverage, is_open, stop_loss, take_profit, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT (id) DO NOTHING`,
      () => (data.positions || []).map((p: any) => ({
       id: p.id,
        user_id: p.user_id,
        exchange: p.exchange || 'binance',
        environment: p.environment || 'testnet',
        symbol: p.symbol,
        side: p.side || 'long',
        size: p.size,
        entry_price: p.entry_price,
        leverage: p.leverage || 1,
       is_open: p.is_open ?? true,
        stop_loss: p.stop_loss || null,
        take_profit: p.take_profit || null,
        created_at: p.created_at,
        updated_at: p.updated_at || p.created_at,
      }))
    );
    totalMigrated += count;
  }

  // 7. Migrate gas_fee_balances
  if (data.gas_fee_balances?.length > 0) {
   const count = await migrateTable(
      'gas_fee_balances',
      `INSERT INTO gas_fee_balances(id, user_id, environment, balance, total_deposited, total_deducted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
      () => (data.gas_fee_balances || []).map((g: any) => ({
       id: g.id,
        user_id: g.user_id,
        environment: g.environment,
        balance: g.balance,
        total_deposited: g.total_deposited,
        total_deducted: g.total_deducted,
        created_at: g.created_at,
        updated_at: g.updated_at || g.created_at,
      }))
    );
    totalMigrated += count;
  }

  // 8. Migrate gas_fee_transactions
  if (data.gas_fee_transactions?.length > 0) {
   const count = await migrateTable(
      'gas_fee_transactions',
      `INSERT INTO gas_fee_transactions (id, user_id, amount, transaction_type, description, balance_before, balance_after, environment, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
      () => (data.gas_fee_transactions || []).map((t: any) => ({
       id: t.id,
        user_id: t.user_id,
        amount: t.amount,
       transaction_type: t.transaction_type,
        description: t.description,
        balance_before: t.balance_before,
        balance_after: t.balance_after,
        environment: t.environment,
        created_at: t.created_at,
      }))
    );
    totalMigrated += count;
  }

  // 9. Migrate bot_status
  if (data.bot_status?.length > 0) {
   const count = await migrateTable(
      'bot_status',
      `INSERT INTO bot_status (id, user_id, exchange, environment, is_running, last_trade_at, total_trades, successful_trades, failed_trades, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING`,
      () => (data.bot_status || []).map((b: any) => ({
       id: b.id,
        user_id: b.user_id,
        exchange: b.exchange || 'binance',
        environment: b.environment,
       is_running: b.is_running ?? false,
        last_trade_at: b.last_trade_at || null,
        total_trades: b.total_trades || 0,
        successful_trades: b.successful_trades || 0,
        failed_trades: b.failed_trades || 0,
        created_at: b.created_at,
        updated_at: b.updated_at || b.created_at,
      }))
    );
    totalMigrated += count;
  }

  // 10. Migrate deposit_proofs
  if (data.deposit_proofs?.length > 0) {
   const count = await migrateTable(
      'deposit_proofs',
      `INSERT INTO deposit_proofs (id, user_id, amount, proof_image_path, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
      () => (data.deposit_proofs || []).map((d: any) => ({
       id: d.id,
        user_id: d.user_id,
        amount: d.amount,
        proof_image_path: d.proof_image_path,
        status: d.status || 'pending',
        created_at: d.created_at,
        updated_at: d.updated_at || d.created_at,
      }))
    );
    totalMigrated += count;
  }

  // 11. Migrate deposit_addresses
  if (data.deposit_addresses?.length > 0) {
   const count = await migrateTable(
      'deposit_addresses',
      `INSERT INTO deposit_addresses(id, created_by, network, address, label, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
      () => (data.deposit_addresses || []).map((d: any) => ({
       id: d.id,
        created_by: d.created_by,
        network: d.network,
        address: d.address,
        label: d.label || null,
       is_active: d.is_active ?? true,
        created_at: d.created_at,
        updated_at: d.updated_at || d.created_at,
      }))
    );
    totalMigrated += count;
  }

  // 12. Migrate admin_earnings
  if (data.admin_earnings?.length > 0) {
   const count = await migrateTable(
      'admin_earnings',
      `INSERT INTO admin_earnings (id, source_user_id, trade_id, gross_profit, total_service_fee, referral_commissions_paid, admin_share, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
      () => (data.admin_earnings || []).map((a: any) => ({
       id: a.id,
        source_user_id: a.source_user_id,
       trade_id: a.trade_id,
        gross_profit: a.gross_profit,
        total_service_fee: a.total_service_fee,
        referral_commissions_paid: a.referral_commissions_paid,
        admin_share: a.admin_share,
        created_at: a.created_at,
      }))
    );
    totalMigrated += count;
  }

  // 13. Migrate app_settings
  if (data.app_settings?.length > 0) {
   const count = await migrateTable(
      'app_settings',
      `INSERT INTO app_settings (id, key, bool_value, string_value, number_value, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
      () => (data.app_settings || []).map((s: any) => ({
       id: s.id,
        key: s.key,
        bool_value: s.bool_value ?? null,
        string_value: s.string_value || null,
        number_value: s.number_value || null,
        created_at: s.created_at,
        updated_at: s.updated_at || s.created_at,
      }))
    );
    totalMigrated += count;
  }

  // 14. Migrate user_roles
  if (data.user_roles?.length > 0) {
   const count = await migrateTable(
      'user_roles',
      `INSERT INTO user_roles (id, user_id, role, created_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      () => (data.user_roles || []).map((r: any) => ({
       id: r.id,
        user_id: r.user_id,
        role: r.role,
        created_at: r.created_at,
      }))
    );
    totalMigrated += count;
  }

  // 15. Migrate webhook_logs
  if (data.webhook_logs?.length > 0) {
   const count = await migrateTable(
      'webhook_logs',
      `INSERT INTO webhook_logs (id, user_id, strategy_id, payload, status, error_message, executed_at, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
      () => (data.webhook_logs || []).map((w: any) => ({
       id: w.id,
        user_id: w.user_id,
        strategy_id: w.strategy_id || null,
        payload: typeof w.payload === 'object' ? JSON.stringify(w.payload) : '{}',
        status: w.status || 'received',
        error_message: w.error_message || null,
        executed_at: w.executed_at || null,
        created_at: w.created_at,
      }))
    );
    totalMigrated += count;
  }

  logger.info('');
  logger.info('🎉 ========================================');
  logger.info(`🎉 Migration completed successfully!`);
  logger.info(`🎉 Total records migrated: ${totalMigrated}`);
  logger.info('🎉 ========================================');
  logger.info('');
  logger.info('📋 Next steps:');
  logger.info('1. Verify data in Supabase Dashboard');
  logger.info('2. Test the application');
  logger.info('3. Keep db.json as backup');
  logger.info('');
}

runMigration()
  .then(() => {
   logger.info('✅ Migration script finished successfully');
    process.exit(0);
  })
  .catch((error) => {
   logger.error('❌ Migration failed', { error: error.message, stack: error.stack });
    process.exit(1);
  });
