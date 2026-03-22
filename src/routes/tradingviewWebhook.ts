import { Router } from 'express';
import crypto from 'node:crypto';
import { pool } from '../db/postgres.js';
import { safeWrite, type TradingStrategy, type ApiKey, type Trade, type Position, type WebhookLog } from '../db/index.js';
import { createHmac } from 'node:crypto';

const router = Router();

interface TradingViewAlert {
  action: 'buy' | 'sell' | 'close';
  symbol: string;
  price?: number;
  strategy_id?: string;
  secret?: string;
  source?: string;
  leverage?: number;
  quantity?: number;
  sl?: number;
  tp1?: number;
  tp2?: number;
  tp3?: number;
}

interface StrategyConfig extends TradingStrategy {
  exchange: string;
  product: string;
  environment: string;
  position_size_type: string;
  position_size_value: number;
  max_positions: number;
  max_trades_per_day?: number;
  max_daily_loss?: number;
  max_consecutive_losses?: number;
  tp1_percent: number;
  tp1_close_percent: number;
  tp2_percent: number;
  tp2_close_percent: number;
  tp3_percent: number;
  tp3_close_percent: number;
  use_tp1: boolean;
  use_tp2: boolean;
  use_tp3: boolean;
  stop_loss_percent: number;
  use_trailing_stop?: boolean;
  trailing_stop_activation?: number;
  trailing_stop_callback?: number;
  default_leverage: number;
  webhook_secret: string;
  is_active: boolean;
  strategy_config?: Record<string, unknown>;
}

const decryptValue = (encrypted: string): string => {
  try {
    const decoded = Buffer.from(encrypted, 'base64').toString('utf-8');
    return decoded || encrypted;
  } catch {
    return encrypted;
  }
};

const createBinanceSignature = (queryString: string, secret: string): string => {
  const hmac = createHmac('sha256', secret);
  hmac.update(queryString);
  return hmac.digest('hex');
};

const clampNumber = (value: number, min: number, max: number) => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
};

const getConfigNumber = (config: Record<string, unknown>, key: string, fallback: number) => {
  const value = config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const isWithinTradingSession = (config: Record<string, unknown>, now = new Date()) => {
  const start = typeof config.session_start === 'string' ? config.session_start : null;
  const end = typeof config.session_end === 'string' ? config.session_end : null;
  if (!start || !end) return true;

  const [startH, startM] = start.split(':').map((s) => Number(s));
  const [endH, endM] = end.split(':').map((s) => Number(s));
  if (![startH, startM, endH, endM].every((n) => Number.isFinite(n))) return true;

  const minutesNow = now.getUTCHours() * 60 + now.getUTCMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return minutesNow >= startMinutes && minutesNow <= endMinutes;
  }
  return minutesNow >= startMinutes || minutesNow <= endMinutes;
};

const getBookTicker = async (
  exchange: string,
  product: string,
  symbol: string,
  isTestnet: boolean
): Promise<{ bid: number; ask: number } | null> => {
  try {
    if (exchange === 'binance') {
      const isFutures = product === 'futures';
      const baseUrl = isFutures
        ? isTestnet
          ? 'https://testnet.binancefuture.com'
          : 'https://fapi.binance.com'
        : isTestnet
          ? 'https://testnet.binance.vision'
          : 'https://api.binance.com';
      const endpoint = isFutures ? '/fapi/v1/ticker/bookTicker' : '/api/v3/ticker/bookTicker';
      const url = `${baseUrl}${endpoint}?symbol=${symbol}`;
      const response = await fetch(url);
      const data = await response.json() as { bidPrice?: string; askPrice?: string };
      const bid = parseFloat(data.bidPrice || '0');
      const ask = parseFloat(data.askPrice || '0');
      if (bid > 0 && ask > 0) return { bid, ask };
      return null;
    }

    if (exchange === 'bybit') {
      const baseUrl = isTestnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
      const url = `${baseUrl}/v5/market/orderbook?category=linear&symbol=${symbol}&limit=1`;
      const response = await fetch(url);
      const data = await response.json() as { result?: { b?: Array<[string, string]>; a?: Array<[string, string]> } };
      const bid = parseFloat(data.result?.b?.[0]?.[0] || '0');
      const ask = parseFloat(data.result?.a?.[0]?.[0] || '0');
      if (bid > 0 && ask > 0) return { bid, ask };
      return null;
    }
  } catch {
    return null;
  }

  return null;
};

const callBinanceApi = async (
  endpoint: string,
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  product: string,
  method = 'GET',
  params: Record<string, string> = {}
): Promise<{ success: boolean; data?: unknown; error?: string }> => {
  const baseUrl =
    product === 'futures'
      ? isTestnet
        ? 'https://testnet.binancefuture.com'
        : 'https://fapi.binance.com'
      : isTestnet
        ? 'https://testnet.binance.vision'
        : 'https://api.binance.com';

  const timestamp = Date.now().toString();
  const queryParams = new URLSearchParams({ ...params, timestamp });
  const signature = createBinanceSignature(queryParams.toString(), apiSecret);
  queryParams.append('signature', signature);

  const url = `${baseUrl}${endpoint}?${queryParams.toString()}`;
  
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/json',
      },
    });
    const data = await response.json();
    
    if (!response.ok) {
      return { success: false, error: (data as { msg?: string }).msg || 'Binance API error' };
    }
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Network error' };
  }
};

const createBybitSignature = (
  timestamp: string,
  apiKey: string,
  recvWindow: string,
  payload: string,
  secret: string
): string => {
  const signStr = timestamp + apiKey + recvWindow + payload;
  const hmac = createHmac('sha256', secret);
  hmac.update(signStr);
  return hmac.digest('hex');
};

const callBybitApi = async (
  endpoint: string,
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  method = 'GET',
  params: Record<string, unknown> = {}
): Promise<{ success: boolean; data?: unknown; error?: string }> => {
  const baseUrl = isTestnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';

  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  
  let url = `${baseUrl}${endpoint}`;
  let body = '';
  
  if (method === 'GET') {
    const queryString = new URLSearchParams(params as Record<string, string>).toString();
    if (queryString) url += '?' + queryString;
    const signature = createBybitSignature(timestamp, apiKey, recvWindow, queryString, apiSecret);
    
    try {
      const response = await fetch(url, {
        method,
        headers: {
          'X-BAPI-API-KEY': apiKey,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': recvWindow,
          'X-BAPI-SIGN': signature,
        },
      });
      const data = await response.json() as { retCode?: number; retMsg?: string };
      if (data.retCode !== 0) {
        return { success: false, error: data.retMsg || 'Bybit API error' };
      }
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  } else {
    body = JSON.stringify(params);
    const signature = createBybitSignature(timestamp, apiKey, recvWindow, body, apiSecret);
    
    try {
      const response = await fetch(url, {
        method,
        headers: {
          'X-BAPI-API-KEY': apiKey,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': recvWindow,
          'X-BAPI-SIGN': signature,
          'Content-Type': 'application/json',
        },
        body,
      });
      const data = await response.json() as { retCode?: number; retMsg?: string };
      if (data.retCode !== 0) {
        return { success: false, error: data.retMsg || 'Bybit API error' };
      }
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  }
};

async function getAccountBalance(
  exchange: string,
  product: string,
  environment: string,
  apiKey: string,
  apiSecret: string
): Promise<{ available: number; total: number }> {
  const isTestnet = environment === 'testnet';

  if (exchange === 'binance') {
    const endpoint = product === 'futures' ? '/fapi/v2/balance' : '/api/v3/account';
    const result = await callBinanceApi(endpoint, apiKey, apiSecret, isTestnet, product);
    
    if (result.success && result.data) {
      if (product === 'futures') {
        const balances = result.data as Array<{ asset: string; availableBalance: string; balance: string }>;
        const usdtBalance = balances.find((b) => b.asset === 'USDT');
        if (usdtBalance) {
          return {
            available: parseFloat(usdtBalance.availableBalance) || 0,
            total: parseFloat(usdtBalance.balance) || 0,
          };
        }
      }
    }
    return { available: 0, total: 0 };
  } else if (exchange === 'bybit') {
    const result = await callBybitApi(
      '/v5/account/wallet-balance',
      apiKey,
      apiSecret,
      isTestnet,
      'GET',
      { accountType: 'UNIFIED' }
    );
    
    if (result.success && result.data) {
      type BybitBalanceResponse = {
        result?: {
          list?: Array<{
            coin?: Array<{
              coin: string;
              equity: string;
              availableToWithdraw?: string;
            }>;
          }>;
        };
      };
      const balanceResponse = result.data as BybitBalanceResponse;
      const coins = balanceResponse.result?.list?.[0]?.coin;
      if (coins) {
        const usdtBalance = coins.find((c) => c.coin === 'USDT');
        if (usdtBalance) {
          const total = parseFloat(usdtBalance.equity) || 0;
          const available = parseFloat(usdtBalance.availableToWithdraw || usdtBalance.equity) || 0;
          return { available, total };
        }
      }
    }
    return { available: 0, total: 0 };
  }
  
  return { available: 0, total: 0 };
}

async function calculatePositionSize(
  strategy: StrategyConfig,
  currentPrice: number,
  apiKey: string,
  apiSecret: string
): Promise<number> {
  const isTestnet = strategy.environment === 'testnet';
  
  const strategyConfig = strategy.strategy_config || {};
  const riskPercent = getConfigNumber(strategyConfig, 'risk_percent', 0);

  if (strategy.position_size_type === 'fixed') {
    return strategy.position_size_value / currentPrice;
  }
  
  // Percentage of balance
  const { total: balance } = await getAccountBalance(
    strategy.exchange,
    strategy.product,
    strategy.environment,
    apiKey,
    apiSecret
  );

  if (riskPercent > 0 && strategy.stop_loss_percent > 0) {
    const riskAmount = balance * (riskPercent / 100);
    const stopDistance = currentPrice * (strategy.stop_loss_percent / 100);
    return stopDistance > 0 ? riskAmount / stopDistance : 0;
  }

  const positionValue = balance * (strategy.position_size_value / 100);
  return positionValue / currentPrice;
}

async function executeTrade(
  strategy: StrategyConfig,
  alert: TradingViewAlert,
  apiKey: string,
  apiSecret: string
): Promise<{ success: boolean; orderId?: string; error?: string }> {
  const isTestnet = strategy.environment === 'testnet';
  const leverage = alert.leverage || strategy.default_leverage;
  const price = alert.price || 0;
  const positionSide = (strategy.strategy_config?.position_side as string | undefined) || 'BOTH';
  const positionIdx = typeof strategy.strategy_config?.position_idx === 'number'
    ? strategy.strategy_config.position_idx
    : 0;
  
  // Calculate position size
  const quantity = alert.quantity || await calculatePositionSize(strategy, price, apiKey, apiSecret);
  
  // Round quantity to appropriate precision
  const roundedQty = Math.floor(quantity * 1000) / 1000;
  
  if (roundedQty <= 0) {
    return { success: false, error: 'Invalid position size calculated' };
  }
  
  if (strategy.exchange === 'binance' && strategy.product === 'futures') {
    // Set leverage first
    await callBinanceApi(
      '/fapi/v1/leverage',
      apiKey,
      apiSecret,
      isTestnet,
      strategy.product,
      'POST',
      {
        symbol: alert.symbol,
        leverage: leverage.toString(),
      }
    );
    
    // Place market order
    const side = alert.action === 'buy' ? 'BUY' : 'SELL';
    const orderResult = await callBinanceApi(
      '/fapi/v1/order',
      apiKey,
      apiSecret,
      isTestnet,
      strategy.product,
      'POST',
      {
        symbol: alert.symbol,
        side,
        type: 'MARKET',
        ...(positionSide !== 'BOTH' && { positionSide }),
        quantity: roundedQty.toString(),
      }
    );
    
    if (!orderResult.success) {
      return { success: false, error: orderResult.error };
    }
    
    const orderData = orderResult.data as { orderId: number };
    
    // Place TP/SL orders if enabled
    if (price > 0) {
      const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
      
      // Stop Loss
      const slPrice = side === 'BUY' 
        ? price * (1 - strategy.stop_loss_percent / 100)
        : price * (1 + strategy.stop_loss_percent / 100);
      
      const slResult = await callBinanceApi('/fapi/v1/order', apiKey, apiSecret, isTestnet, strategy.product, 'POST', {
        symbol: alert.symbol,
        side: closeSide,
        type: 'STOP_MARKET',
        stopPrice: slPrice.toFixed(2),
        closePosition: 'true',
        ...(positionSide !== 'BOTH' && { positionSide }),
      });
      if (!slResult.success) {
        return { success: false, error: slResult.error || 'Stop loss failed' };
      }
      
      // Take Profit levels
      const tpLevels = [
        { enabled: strategy.use_tp1, percent: strategy.tp1_percent, closePercent: strategy.tp1_close_percent },
        { enabled: strategy.use_tp2, percent: strategy.tp2_percent, closePercent: strategy.tp2_close_percent },
        { enabled: strategy.use_tp3, percent: strategy.tp3_percent, closePercent: strategy.tp3_close_percent },
      ];

      for (const tp of tpLevels) {
        if (!tp.enabled) continue;
        const tpPrice = side === 'BUY'
          ? price * (1 + tp.percent / 100)
          : price * (1 - tp.percent / 100);
        const tpQty = Math.floor(roundedQty * (tp.closePercent / 100) * 1000) / 1000;
        
        if (tpQty > 0) {
          const tpResult = await callBinanceApi('/fapi/v1/order', apiKey, apiSecret, isTestnet, strategy.product, 'POST', {
            symbol: alert.symbol,
            side: closeSide,
            type: 'TAKE_PROFIT_MARKET',
            stopPrice: tpPrice.toFixed(2),
            ...(positionSide !== 'BOTH' && { positionSide }),
            quantity: tpQty.toString(),
          });
          if (!tpResult.success) {
            return { success: false, error: tpResult.error || 'Take profit failed' };
          }
        }
      }

      if (strategy.use_trailing_stop && (strategy.trailing_stop_callback || 0) > 0) {
        const callbackRate = clampNumber(strategy.trailing_stop_callback || 0.2, 0.1, 5);
        const activationPrice = (strategy.trailing_stop_activation || 0) > 0
          ? side === 'BUY'
            ? price * (1 + (strategy.trailing_stop_activation || 0) / 100)
            : price * (1 - (strategy.trailing_stop_activation || 0) / 100)
          : 0;
        const params: Record<string, string> = {
          symbol: alert.symbol,
          side: closeSide,
          type: 'TRAILING_STOP_MARKET',
          callbackRate: callbackRate.toString(),
        };
        if (activationPrice > 0) {
          params.activationPrice = activationPrice.toFixed(2);
        }
        if (positionSide !== 'BOTH') {
          params.positionSide = positionSide;
        }
        const trailingResult = await callBinanceApi('/fapi/v1/order', apiKey, apiSecret, isTestnet, strategy.product, 'POST', params);
        if (!trailingResult.success) {
          return { success: false, error: trailingResult.error || 'Trailing stop failed' };
        }
      }
    }
    
    return { success: true, orderId: orderData.orderId.toString() };
  } else if (strategy.exchange === 'bybit') {
    // Set leverage
    await callBybitApi('/v5/position/set-leverage', apiKey, apiSecret, isTestnet, 'POST', {
      category: 'linear',
      symbol: alert.symbol,
      buyLeverage: leverage.toString(),
      sellLeverage: leverage.toString(),
    });
    
    // Place market order
    const side = alert.action === 'buy' ? 'Buy' : 'Sell';
    const orderResult = await callBybitApi(
      '/v5/order/create',
      apiKey,
      apiSecret,
      isTestnet,
      'POST',
      {
        category: 'linear',
        symbol: alert.symbol,
        side,
        orderType: 'Market',
        qty: roundedQty.toString(),
      }
    );
    
    if (!orderResult.success) {
      return { success: false, error: orderResult.error };
    }
    
    const orderData = orderResult.data as { result?: { orderId?: string } };
    
    // Place TP/SL using trading stop
    if (price > 0) {
      const slPrice = side === 'Buy'
        ? price * (1 - strategy.stop_loss_percent / 100)
        : price * (1 + strategy.stop_loss_percent / 100);
      
      const tp1Price = strategy.use_tp1 
        ? (side === 'Buy' ? price * (1 + strategy.tp1_percent / 100) : price * (1 - strategy.tp1_percent / 100))
        : 0;
      
    await callBybitApi('/v5/position/trading-stop', apiKey, apiSecret, isTestnet, 'POST', {
        category: 'linear',
        symbol: alert.symbol,
      positionIdx,
        stopLoss: slPrice.toFixed(2),
        ...(tp1Price > 0 && { takeProfit: tp1Price.toFixed(2) }),
        slTriggerBy: 'LastPrice',
        tpTriggerBy: 'LastPrice',
      });

      // Additional TP levels via conditional reduce-only orders
      const closeSide = side === 'Buy' ? 'Sell' : 'Buy';
      const extraTpLevels = [
        { enabled: strategy.use_tp2, percent: strategy.tp2_percent, closePercent: strategy.tp2_close_percent },
        { enabled: strategy.use_tp3, percent: strategy.tp3_percent, closePercent: strategy.tp3_close_percent },
      ];

      for (const tp of extraTpLevels) {
        if (!tp.enabled) continue;
        const tpPrice = side === 'Buy'
          ? price * (1 + tp.percent / 100)
          : price * (1 - tp.percent / 100);
        const tpQty = Math.floor(roundedQty * (tp.closePercent / 100) * 1000) / 1000;

        if (tpQty > 0) {
          const tpResult = await callBybitApi('/v5/order/create', apiKey, apiSecret, isTestnet, 'POST', {
            category: 'linear',
            symbol: alert.symbol,
            side: closeSide,
            orderType: 'Market',
            qty: tpQty.toString(),
            reduceOnly: true,
            closeOnTrigger: true,
            triggerPrice: tpPrice.toFixed(2),
            triggerBy: 'LastPrice',
          });
          if (!tpResult.success) {
            return { success: false, error: tpResult.error || 'Take profit failed' };
          }
        }
      }

      if (strategy.use_trailing_stop && (strategy.trailing_stop_callback || 0) > 0) {
        const trailingDistance = price * ((strategy.trailing_stop_callback || 0) / 100);
        const activePrice = (strategy.trailing_stop_activation || 0) > 0
          ? side === 'Buy'
            ? price * (1 + (strategy.trailing_stop_activation || 0) / 100)
            : price * (1 - (strategy.trailing_stop_activation || 0) / 100)
          : 0;
        const params: Record<string, unknown> = {
          category: 'linear',
          symbol: alert.symbol,
          positionIdx,
          trailingStop: trailingDistance.toFixed(2),
        };
        if (activePrice > 0) {
          params.activePrice = activePrice.toFixed(2);
        }
        const trailingResult = await callBybitApi('/v5/position/trading-stop', apiKey, apiSecret, isTestnet, 'POST', params);
        if (!trailingResult.success) {
          return { success: false, error: trailingResult.error || 'Trailing stop failed' };
        }
      }
    }
    
    return { success: true, orderId: orderData.result?.orderId };
  }
  
  return { success: false, error: 'Unsupported exchange or product' };
}

router.post('/', async (req, res) => {
  try {
    const alert = req.body as TradingViewAlert;
    
    if (!alert.symbol || !alert.action) {
      return res.status(400).json({ error: 'Missing symbol or action' });
    }

    // Find strategy by strategy_id or webhook_secret using PostgreSQL
    let strategy: StrategyConfig | undefined;
    
    if (alert.strategy_id) {
      const strategyResult = await pool.query(
        'SELECT * FROM trading_strategies WHERE id = $1',
        [alert.strategy_id]
      );
      strategy = strategyResult.rows[0] as StrategyConfig | undefined;
    } else if (alert.secret) {
      const strategyResult = await pool.query(
        'SELECT * FROM trading_strategies WHERE webhook_secret = $1',
        [alert.secret]
      );
      strategy = strategyResult.rows[0] as StrategyConfig | undefined;
    }

    if (!strategy || !strategy.is_active) {
      return res.status(404).json({ error: 'Strategy not found or inactive' });
    }

    // Verify webhook secret if provided
    if (alert.secret && strategy.webhook_secret !== alert.secret) {
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }

    // Get API keys from PostgreSQL
    const apiKeysResult = await pool.query(
      `SELECT * FROM api_keys 
       WHERE user_id = $1 AND exchange = $2 AND product = $3 AND environment = $4 AND is_active = true`,
      [strategy.user_id, strategy.exchange, strategy.product, strategy.environment]
    );
    const apiKeys = apiKeysResult.rows[0] as ApiKey | undefined;

    if (!apiKeys) {
      return res.status(400).json({ error: 'API keys not configured' });
    }

    const apiKey = decryptValue(apiKeys.api_key_encrypted);
    const apiSecret = decryptValue(apiKeys.api_secret_encrypted);
    const positionSide = (strategy.strategy_config?.position_side as string | undefined) || 'BOTH';
    const positionIdx = typeof strategy.strategy_config?.position_idx === 'number'
      ? strategy.strategy_config.position_idx
      : 0;

    const strategyConfig = strategy.strategy_config || {};
    const now = new Date();

    if (alert.action !== 'close' && !isWithinTradingSession(strategyConfig, now)) {
      await pool.query(
        `INSERT INTO webhook_logs (id, user_id, strategy_id, webhook_secret, request_body, signal_data, decision, status, error_message, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          crypto.randomUUID(),
          strategy.user_id,
          strategy.id,
          strategy.webhook_secret || '',
          JSON.stringify(alert),
          null,
          null,
          'rejected',
          'Outside trading session',
          new Date().toISOString()
        ]
      );
      return res.status(200).json({ success: false, error: 'Outside trading session' });
    }

    if (alert.action !== 'close') {
      const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      
      // Get daily trades from PostgreSQL
      const tradesResult = await pool.query(
        `SELECT * FROM trades 
         WHERE user_id = $1 AND triggered_by = 'tradingview_webhook' AND created_at >= $2`,
        [strategy.user_id, dayStart.toISOString()]
      );
      const dailyTrades = tradesResult.rows;
      
      if (strategy.max_trades_per_day && dailyTrades.length >= strategy.max_trades_per_day) {
        await pool.query(
          `INSERT INTO webhook_logs (id, user_id, strategy_id, webhook_secret, request_body, signal_data, decision, status, error_message, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            crypto.randomUUID(),
            strategy.user_id,
            strategy.id,
            strategy.webhook_secret || '',
            JSON.stringify(alert),
            null,
            null,
            'rejected',
            'Max trades per day reached',
            new Date().toISOString()
          ]
        );
        return res.status(200).json({ success: false, error: 'Max trades per day reached' });
      }

      // Calculate daily PnL from PostgreSQL
      const pnlResult = await pool.query(
        `SELECT COALESCE(SUM(realized_pnl), 0) as total_pnl 
         FROM trades 
         WHERE user_id = $1 AND created_at >= $2`,
        [strategy.user_id, dayStart.toISOString()]
      );
      const dailyPnl = parseFloat(pnlResult.rows[0].total_pnl) || 0;
      
      if (strategy.max_daily_loss && dailyPnl <= -strategy.max_daily_loss) {
        await pool.query(
          `INSERT INTO webhook_logs (id, user_id, strategy_id, webhook_secret, request_body, signal_data, decision, status, error_message, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            crypto.randomUUID(),
            strategy.user_id,
            strategy.id,
            strategy.webhook_secret || '',
            JSON.stringify(alert),
            null,
            null,
            'rejected',
            'Max daily loss reached',
            new Date().toISOString()
          ]
        );
        return res.status(200).json({ success: false, error: 'Max daily loss reached' });
      }

      if (strategy.max_consecutive_losses && strategy.max_consecutive_losses > 0) {
        const recentResult = await pool.query(
          `SELECT * FROM trades 
           WHERE user_id = $1 AND realized_pnl IS NOT NULL 
           ORDER BY created_at DESC`,
          [strategy.user_id]
        );
        const recent = recentResult.rows;
        let consecutiveLosses = 0;
        for (const trade of recent) {
          if ((trade.realized_pnl || 0) < 0) {
            consecutiveLosses += 1;
          } else if ((trade.realized_pnl || 0) > 0) {
            break;
          }
        }
        if (consecutiveLosses >= strategy.max_consecutive_losses) {
          await pool.query(
            `INSERT INTO webhook_logs (id, user_id, strategy_id, webhook_secret, request_body, signal_data, decision, status, error_message, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              crypto.randomUUID(),
              strategy.user_id,
              strategy.id,
              strategy.webhook_secret || '',
              JSON.stringify(alert),
              null,
              null,
              'rejected',
              'Max consecutive losses reached',
              new Date().toISOString()
            ]
          );
          return res.status(200).json({ success: false, error: 'Max consecutive losses reached' });
        }
      }

      const maxSpreadPercent = getConfigNumber(strategyConfig, 'max_spread_percent', 0);
      const maxSlippagePercent = getConfigNumber(strategyConfig, 'max_slippage_percent', 0);
      if (maxSpreadPercent > 0 || maxSlippagePercent > 0) {
        const book = await getBookTicker(strategy.exchange, strategy.product, alert.symbol, strategy.environment === 'testnet');
        if (book) {
          const mid = (book.bid + book.ask) / 2;
          const spreadPct = ((book.ask - book.bid) / mid) * 100;
          const slippagePct = alert.price ? Math.abs(alert.price - mid) / mid * 100 : 0;
          if (maxSpreadPercent > 0 && spreadPct > maxSpreadPercent) {
            await pool.query(
              `INSERT INTO webhook_logs (id, user_id, strategy_id, webhook_secret, request_body, signal_data, decision, status, error_message, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [
                crypto.randomUUID(),
                strategy.user_id,
                strategy.id,
                strategy.webhook_secret || '',
                JSON.stringify(alert),
                null,
                null,
                'rejected',
                'Spread too high',
                new Date().toISOString()
              ]
            );
            return res.status(200).json({ success: false, error: 'Spread too high' });
          }
          if (maxSlippagePercent > 0 && slippagePct > maxSlippagePercent) {
            await pool.query(
              `INSERT INTO webhook_logs (id, user_id, strategy_id, webhook_secret, request_body, signal_data, decision, status, error_message, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [
                crypto.randomUUID(),
                strategy.user_id,
                strategy.id,
                strategy.webhook_secret || '',
                JSON.stringify(alert),
                null,
                null,
                'rejected',
                'Slippage too high',
                new Date().toISOString()
              ]
            );
            return res.status(200).json({ success: false, error: 'Slippage too high' });
          }
        }
      }
    }

    // Handle close action
    if (alert.action === 'close') {
      // Find open position in PostgreSQL
      const positionResult = await pool.query(
        `SELECT * FROM positions 
         WHERE user_id = $1 AND symbol = $2 AND is_open = true`,
        [strategy.user_id, alert.symbol]
      );
      const position = positionResult.rows[0];

      if (!position) {
        return res.json({ success: true, message: 'No position to close' });
      }

      // Close position via exchange API (simplified - would need full implementation)
      // For now, just mark as closed in database
      await pool.query(
        `UPDATE positions SET is_open = false, updated_at = $1 WHERE id = $2`,
        [new Date().toISOString(), position.id]
      );

      return res.json({ success: true, message: 'Position closed' });
    }

    // Check max positions from PostgreSQL
    const positionCountResult = await pool.query(
      `SELECT COUNT(*) as count FROM positions WHERE user_id = $1 AND is_open = true`,
      [strategy.user_id]
    );
    const positionCount = parseInt(positionCountResult.rows[0].count) || 0;

    if (positionCount >= strategy.max_positions) {
      return res.status(400).json({ error: 'Max positions reached' });
    }

    // Execute trade
    const execResult = await executeTrade(strategy, alert, apiKey, apiSecret);

    if (execResult.success && execResult.orderId) {
      // Record trade in PostgreSQL
      const tradeId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO trades (id, user_id, exchange, product, environment, symbol, side, order_type, price, quantity, status, order_id, triggered_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          tradeId,
          strategy.user_id,
          strategy.exchange,
          strategy.product,
          strategy.environment,
          alert.symbol,
          alert.action,
          'market',
          alert.price || 0,
          alert.quantity || 0,
          'filled',
          execResult.orderId,
          'tradingview_webhook',
          new Date().toISOString()
        ]
      );

      // Record position in PostgreSQL
      const positionId = crypto.randomUUID();
      const slPrice = alert.action === 'buy'
        ? (alert.price || 0) * (1 - strategy.stop_loss_percent / 100)
        : (alert.price || 0) * (1 + strategy.stop_loss_percent / 100);
      const tpPrice = strategy.use_tp1
        ? alert.action === 'buy'
          ? (alert.price || 0) * (1 + strategy.tp1_percent / 100)
          : (alert.price || 0) * (1 - strategy.tp1_percent / 100)
        : null;

      await pool.query(
        `INSERT INTO positions (id, user_id, exchange, product, environment, symbol, side, size, entry_price, leverage, is_open, unrealized_pnl, stop_loss, take_profit, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          positionId,
          strategy.user_id,
          strategy.exchange,
          strategy.product,
          strategy.environment,
          alert.symbol,
          alert.action === 'buy' ? 'long' : 'short',
          alert.quantity || 0,
          alert.price || 0,
          alert.leverage || strategy.default_leverage,
          true,
          0,
          slPrice,
          tpPrice,
          new Date().toISOString(),
          new Date().toISOString()
        ]
      );

      // Log webhook in PostgreSQL
      const webhookLogId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO webhook_logs (id, user_id, strategy_id, webhook_secret, request_body, signal_data, decision, status, error_message, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          webhookLogId,
          strategy.user_id,
          strategy.id,
          strategy.webhook_secret || '',
          JSON.stringify(alert),
          null,
          null,
          'executed',
          null,
          new Date().toISOString()
        ]
      );

      return res.json({
        success: true,
        orderId: execResult.orderId,
        tradeId,
        message: 'Trade executed successfully',
      });
    } else {
      // Log failed webhook in PostgreSQL
      const webhookLogId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO webhook_logs (id, user_id, strategy_id, webhook_secret, request_body, signal_data, decision, status, error_message, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          webhookLogId,
          strategy.user_id,
          strategy.id,
          strategy.webhook_secret || '',
          JSON.stringify(alert),
          null,
          null,
          'failed',
          execResult.error || 'Unknown error',
          new Date().toISOString()
        ]
      );

      return res.status(500).json({
        success: false,
        error: execResult.error || 'Trade execution failed',
      });
    }
  } catch (error) {
    console.error('TradingView webhook error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export const tradingviewWebhookRouter = router;
