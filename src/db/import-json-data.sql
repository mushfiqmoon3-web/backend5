-- Migration script to import JSON data to PostgreSQL
-- This script inserts data from db.json into the database tables

-- Enable UUID extension if not exists
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- 1. APP USERS
-- ============================================
INSERT INTO app_users (id, email, password_hash, created_at) VALUES
('5a402450-9bdf-4903-9158-569081444fd0', 'admin@mail.com', '$2a$10$fF5uYxNC8gazeOEe.GK/XueYxGJLgcO8VUg95MblEXc99gCPHQ0uW', '2026-02-05 17:38:39.450+00')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 2. USER ROLES
-- ============================================
INSERT INTO user_roles (id, user_id, role, created_at) VALUES
('2847e24f-1ada-4ef3-8f95-e6221d88b329', '5a402450-9bdf-4903-9158-569081444fd0', 'admin', '2026-02-05 17:38:39.450+00')
ON CONFLICT (user_id, role) DO NOTHING;

-- ============================================
-- 3. PROFILES
-- ============================================
INSERT INTO profiles (id, user_id, display_name, email, referral_code, created_at, updated_at) VALUES
('7c47e1a4-a448-47dd-9544-d5af96fd2837', '5a402450-9bdf-4903-9158-569081444fd0', 'Admin', 'admin@mail.com', '28433d0636bf6698', '2026-02-05 17:38:39.450+00', '2026-02-05 17:38:39.450+00')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 4. GAS FEE BALANCES
-- ============================================
INSERT INTO gas_fee_balances (id, user_id, environment, balance, total_deposited, total_deducted, created_at, updated_at) VALUES
('37518c58-e129-487c-bafe-fac5b70e2945', '5a402450-9bdf-4903-9158-569081444fd0', 'testnet', 200, 200, 0, '2026-02-05 17:38:39.450+00', '2026-02-05 22:01:09.802+00'),
('64ffb2ce-8a24-49a2-9e47-015afb1039e3', '5a402450-9bdf-4903-9158-569081444fd0', 'mainnet', 0, 0, 0, '2026-02-05 17:38:39.450+00', '2026-02-05 17:38:39.450+00')
ON CONFLICT (user_id, environment) DO NOTHING;

-- ============================================
-- 5. GAS FEE TRANSACTIONS
-- ============================================
INSERT INTO gas_fee_transactions (id, user_id, amount, transaction_type, description, balance_before, balance_after, environment, created_at) VALUES
('932f5ca3-cfa7-40c3-a6e2-410a2047d023', '5a402450-9bdf-4903-9158-569081444fd0', 200, 'admin_credit', 'Admin added gas fee (testnet)', 0, 200, 'testnet', '2026-02-05 22:01:10.038+00')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 6. BOT STATUS
-- ============================================
INSERT INTO bot_status (id, user_id, is_running, environment, exchange, last_trade_at, total_trades, successful_trades, failed_trades, created_at, updated_at) VALUES
('17d06c2f-e171-4d54-bc60-18a97f9070c7', '5a402450-9bdf-4903-9158-569081444fd0', false, 'testnet', 'binance', NULL, 0, 0, 0, '2026-02-05 17:38:39.450+00', '2026-02-05 17:38:39.450+00'),
('d12f4e50-4bbc-4907-8126-ff0c8f6d6e0d', '5a402450-9bdf-4903-9158-569081444fd0', false, 'mainnet', 'binance', NULL, 0, 0, 0, '2026-02-16 05:03:55.911+00', '2026-02-16 05:03:55.911+00')
ON CONFLICT (user_id, environment) DO NOTHING;

-- ============================================
-- 7. DEPOSIT ADDRESSES
-- ============================================
INSERT INTO deposit_addresses (id, network, address, label, created_by, is_active, created_at, updated_at) VALUES
('9ef16b69-6bb3-42c3-a9ae-c26ebdadba61', 'BSC', '0x691c7c84f2aa9f6dcb7b1da11f46943f9b4b93f5', '', '5a402450-9bdf-4903-9158-569081444fd0', true, '2026-02-05 17:58:32.158+00', '2026-02-05 17:58:34.395+00')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 8. APP SETTINGS
-- ============================================
INSERT INTO app_settings (key, bool_value, created_at, updated_at) VALUES
('maintenance_mode', false, '2026-02-05 22:08:56.938+00', '2026-02-05 22:09:12.045+00')
ON CONFLICT (key) DO UPDATE SET bool_value = EXCLUDED.bool_value;

-- ============================================
-- 9. ADMIN EARNINGS
-- ============================================
INSERT INTO admin_earnings (id, source_user_id, trade_id, gross_profit, total_service_fee, referral_commissions_paid, admin_share, created_at) VALUES
('3dbc802a-554b-4dbb-a3bc-0bd0e9563afc', 'e70b4418-6af6-4930-8e3a-6e772836c44e', '38f5fa90-b9be-4ab6-9910-a5a10dfb4bbc', 10.31041169, 3.093123507, 0, 3.093123507, '2026-02-05 21:27:01.124+00'),
('ea010afa-0868-4036-9e3b-55e5c864b6d5', 'e70b4418-6af6-4930-8e3a-6e772836c44e', '165c081f-f769-4cd4-9b5d-5bcf31970312', 0.54615468, 0.163846404, 0, 0.163846404, '2026-02-05 21:27:01.126+00'),
('318238fa-2e52-4952-b016-912ebe063b75', 'e70b4418-6af6-4930-8e3a-6e772836c44e', '74d59003-bf93-4310-955d-389068223581', 0.192, 0.0576, 0, 0.0576, '2026-02-05 21:27:01.126+00'),
('93328329-daf7-4e72-81d3-96bbf4e05898', 'e70b4418-6af6-4930-8e3a-6e772836c44e', '70aaeaeb-290b-49ac-91da-2fb295ba40f1', 7.04804004, 2.114412012, 0, 2.114412012, '2026-02-06 03:26:00.889+00'),
('12682142-fdf8-4a55-a035-e03d0f220da0', 'e70b4418-6af6-4930-8e3a-6e772836c44e', '53a110a4-ae10-42a8-b2da-28217433e497', 8.36, 2.508, 0, 2.508, '2026-02-06 15:25:00.895+00')
ON CONFLICT (id) DO NOTHING;

-- Note: trading_strategies table has complex structure with many fields
-- We need to insert the strategy data with all its configuration
-- ============================================
-- 10. TRADING STRATEGIES
-- ============================================
INSERT INTO trading_strategies (
    id, user_id, name, description, strategy_type, exchange, product, environment,
    position_size_type, position_size_value, max_positions, max_daily_loss,
    max_drawdown_percent, max_trades_per_day, max_consecutive_losses,
    tp1_percent, tp1_close_percent, tp2_percent, tp2_close_percent,
    tp3_percent, tp3_close_percent, use_tp1, use_tp2, use_tp3,
    stop_loss_percent, use_trailing_stop, trailing_stop_activation,
    trailing_stop_callback, default_leverage, allowed_pairs, strategy_config,
    is_active, updated_at, signal_mode, auto_signal_enabled,
    auto_signal_indicators, auto_signal_interval, last_signal_at, created_at
) VALUES (
    '9c5ef018-decf-4ef1-b3cb-ac0b795c1b2a',
    '5a402450-9bdf-4903-9158-569081444fd0',
    'Daily Profit (10 Trades/Day)',
    'Balanced daily trading strategy optimized for 10 trades per day with consistent profits. Conservative risk with 1:2 R:R ratio.',
    'daily_profit',
    'binance',
    'spot',
    'mainnet',
    'fixed',
    150,
    10,
    0.5,
    5,
    20,
    1,
    0.8,
    40,
    1.5,
    35,
    2.5,
    25,
    true,
    true,
    true,
    0.6,
    true,
    0.8,
    0.3,
    7,
    ARRAY['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'],
    '{"htf_timeframe": "1h", "ltf_timeframe": "5m", "ema_fast": 9, "ema_slow": 21, "rsi_period": 14, "rsi_overbought": 70, "rsi_oversold": 30, "volume_multiplier": 1.2, "trade_interval_minutes": 144, "min_signal_strength": 0.6}'::jsonb,
    true,
    '2026-02-14 19:37:46.542+00',
    'auto',
    true,
    '{"ema_short": 12, "ema_long": 26, "rsi_period": 14, "rsi_overbought": 70, "rsi_oversold": 30, "macd_fast": 12, "macd_slow": 26, "macd_signal": 9, "volume_multiplier": 1.5}'::jsonb,
    1,
    '2026-02-05 22:38:11.186+00',
    '2026-02-05 19:24:33.169+00'
)
ON CONFLICT (id) DO NOTHING;

-- Update timestamp
UPDATE app_settings SET updated_at = CURRENT_TIMESTAMP WHERE key = 'maintenance_mode';
