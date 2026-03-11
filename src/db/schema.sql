-- PostgreSQL Schema for Trading Bot
-- Run this script to create all necessary tables

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- App Users Table
CREATE TABLE IF NOT EXISTS app_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_app_users_email ON app_users(email);

-- Profiles Table
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    display_name VARCHAR(255),
    email VARCHAR(255),
    referrer_id UUID REFERENCES profiles(id),
    referral_code VARCHAR(16) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_referral_code ON profiles(referral_code);

-- API Keys Table
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    key_name VARCHAR(255) NOT NULL,
    exchange VARCHAR(50) NOT NULL CHECK (exchange IN ('binance', 'bybit')),
    product VARCHAR(50) NOT NULL CHECK (product IN ('spot', 'futures')),
    environment VARCHAR(50) NOT NULL CHECK (environment IN ('testnet', 'mainnet')),
    api_key_encrypted TEXT NOT NULL,
    api_secret_encrypted TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, exchange, product, environment)
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);

-- Trading Strategies Table
CREATE TABLE IF NOT EXISTS trading_strategies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    webhook_secret VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    config JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trading_strategies_user_id ON trading_strategies(user_id);

-- Trades Table
CREATE TABLE IF NOT EXISTS trades (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    exchange VARCHAR(50) NOT NULL,
    product VARCHAR(50),
    environment VARCHAR(50) NOT NULL CHECK (environment IN ('testnet', 'mainnet')),
    symbol VARCHAR(50) NOT NULL,
    side VARCHAR(10) NOT NULL,
    order_type VARCHAR(50) NOT NULL,
    price DECIMAL(20, 8) NOT NULL,
    quantity DECIMAL(20, 8) NOT NULL,
    realized_pnl DECIMAL(20, 8),
    status VARCHAR(50) NOT NULL,
    order_id VARCHAR(255),
    triggered_by VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trades_user_id ON trades(user_id);
CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);

-- Webhook Logs Table
CREATE TABLE IF NOT EXISTS webhook_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    strategy_id UUID NOT NULL REFERENCES trading_strategies(id) ON DELETE CASCADE,
    payload JSONB NOT NULL,
    status VARCHAR(50) NOT NULL,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_user_id ON webhook_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_strategy_id ON webhook_logs(strategy_id);

-- User Roles Table
CREATE TABLE IF NOT EXISTS user_roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);

-- Bot Status Table
CREATE TABLE IF NOT EXISTS bot_status (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    is_running BOOLEAN DEFAULT false,
    environment VARCHAR(50) NOT NULL CHECK (environment IN ('testnet', 'mainnet')),
    exchange VARCHAR(50),
    last_trade_at TIMESTAMP WITH TIME ZONE,
    total_trades INTEGER DEFAULT 0,
    successful_trades INTEGER DEFAULT 0,
    failed_trades INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, environment)
);

CREATE INDEX IF NOT EXISTS idx_bot_status_user_id ON bot_status(user_id);

-- Positions Table
CREATE TABLE IF NOT EXISTS positions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    symbol VARCHAR(50) NOT NULL,
    side VARCHAR(10) NOT NULL CHECK (side IN ('long', 'short')),
    size DECIMAL(20, 8) NOT NULL,
    entry_price DECIMAL(20, 8) NOT NULL,
    current_price DECIMAL(20, 8),
    unrealized_pnl DECIMAL(20, 8) DEFAULT 0,
    leverage INTEGER NOT NULL,
    margin DECIMAL(20, 8),
    liquidation_price DECIMAL(20, 8),
    stop_loss DECIMAL(20, 8),
    take_profit DECIMAL(20, 8),
    is_open BOOLEAN DEFAULT true,
    exchange VARCHAR(50) NOT NULL,
    product VARCHAR(50),
    environment VARCHAR(50) NOT NULL CHECK (environment IN ('testnet', 'mainnet')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_positions_user_id ON positions(user_id);
CREATE INDEX IF NOT EXISTS idx_positions_is_open ON positions(is_open);

-- Account Balances Table
CREATE TABLE IF NOT EXISTS account_balances (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    exchange VARCHAR(50) NOT NULL,
    product VARCHAR(50) NOT NULL,
    environment VARCHAR(50) NOT NULL CHECK (environment IN ('testnet', 'mainnet')),
    asset VARCHAR(50) NOT NULL,
    balance DECIMAL(20, 8) DEFAULT 0,
    available_balance DECIMAL(20, 8) DEFAULT 0,
    unrealized_pnl DECIMAL(20, 8) DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, exchange, product, environment, asset)
);

CREATE INDEX IF NOT EXISTS idx_account_balances_user_id ON account_balances(user_id);

-- Gas Fee Balances Table
CREATE TABLE IF NOT EXISTS gas_fee_balances (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    environment VARCHAR(50) NOT NULL CHECK (environment IN ('testnet', 'mainnet')),
    balance DECIMAL(20, 8) DEFAULT 0,
    total_deposited DECIMAL(20, 8) DEFAULT 0,
    total_deducted DECIMAL(20, 8) DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, environment)
);

CREATE INDEX IF NOT EXISTS idx_gas_fee_balances_user_id ON gas_fee_balances(user_id);

-- Gas Fee Transactions Table
CREATE TABLE IF NOT EXISTS gas_fee_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    amount DECIMAL(20, 8) NOT NULL,
    transaction_type VARCHAR(50) NOT NULL CHECK (transaction_type IN ('deposit', 'service_fee', 'refund', 'demo_deposit', 'referral_commission')),
    description TEXT,
    trade_id UUID REFERENCES trades(id),
    balance_before DECIMAL(20, 8) NOT NULL,
    balance_after DECIMAL(20, 8) NOT NULL,
    environment VARCHAR(50) CHECK (environment IN ('testnet', 'mainnet')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gas_fee_transactions_user_id ON gas_fee_transactions(user_id);

-- Referral Commissions Table
CREATE TABLE IF NOT EXISTS referral_commissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    beneficiary_user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    source_user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    trade_id UUID REFERENCES trades(id),
    level INTEGER NOT NULL,
    gross_profit DECIMAL(20, 8) NOT NULL,
    commission_rate DECIMAL(5, 4) NOT NULL,
    commission_amount DECIMAL(20, 8) NOT NULL,
    status VARCHAR(50) NOT NULL CHECK (status IN ('pending', 'paid', 'cancelled')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    paid_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_referral_commissions_beneficiary ON referral_commissions(beneficiary_user_id);
CREATE INDEX IF NOT EXISTS idx_referral_commissions_source ON referral_commissions(source_user_id);

-- Admin Earnings Table
CREATE TABLE IF NOT EXISTS admin_earnings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    trade_id UUID REFERENCES trades(id),
    gross_profit DECIMAL(20, 8) NOT NULL,
    total_service_fee DECIMAL(20, 8) NOT NULL,
    referral_commissions_paid DECIMAL(20, 8) NOT NULL,
    admin_share DECIMAL(20, 8) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_earnings_created_at ON admin_earnings(created_at);

-- Profit Settlements Table
CREATE TABLE IF NOT EXISTS profit_settlements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    trade_id UUID REFERENCES trades(id),
    gross_profit DECIMAL(20, 8) NOT NULL,
    service_fee_rate DECIMAL(5, 4) NOT NULL,
    service_fee_amount DECIMAL(20, 8) NOT NULL,
    net_profit DECIMAL(20, 8) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_profit_settlements_user_id ON profit_settlements(user_id);

-- Pending Deposits Table
CREATE TABLE IF NOT EXISTS pending_deposits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    amount DECIMAL(20, 8) NOT NULL,
    environment VARCHAR(50) NOT NULL CHECK (environment IN ('testnet', 'mainnet')),
    transaction_hash VARCHAR(255),
    wallet_address VARCHAR(255),
    proof_screenshot_url TEXT,
    status VARCHAR(50) NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    admin_notes TEXT,
    approved_by UUID REFERENCES app_users(id),
    approved_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pending_deposits_user_id ON pending_deposits(user_id);
CREATE INDEX IF NOT EXISTS idx_pending_deposits_status ON pending_deposits(status);

-- Deposit Addresses Table
CREATE TABLE IF NOT EXISTS deposit_addresses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    network VARCHAR(50) NOT NULL,
    address VARCHAR(255) NOT NULL,
    label VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    created_by UUID REFERENCES app_users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_deposit_addresses_is_active ON deposit_addresses(is_active);

-- User Settings Table
CREATE TABLE IF NOT EXISTS user_settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    notify_trade_executed BOOLEAN DEFAULT true,
    notify_stop_loss_hit BOOLEAN DEFAULT true,
    notify_take_profit_hit BOOLEAN DEFAULT true,
    notify_bot_errors BOOLEAN DEFAULT true,
    max_daily_trades INTEGER,
    max_position_size_percent DECIMAL(5, 2),
    daily_loss_limit DECIMAL(20, 8),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_settings_user_id ON user_settings(user_id);

-- App Settings Table
CREATE TABLE IF NOT EXISTS app_settings (
    key VARCHAR(255) PRIMARY KEY,
    bool_value BOOLEAN NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Insert default app settings
INSERT INTO app_settings (key, bool_value) 
VALUES ('maintenance_mode', false)
ON CONFLICT (key) DO NOTHING;
