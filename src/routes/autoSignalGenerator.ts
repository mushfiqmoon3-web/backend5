import { Router } from 'express';
import crypto from 'node:crypto';
import { pool } from '../db/postgres.js';
import { fetchKlines } from '../lib/marketData.js';
import { analyzeSignal, type StrategyIndicators } from '../lib/signalAnalysis.js';
import { createHmac } from 'node:crypto';
import { DEFAULT_TRADING_PAIRS } from '../lib/tradingPairs.js';

const router = Router();
const MIN_SIGNAL_CONFIDENCE = 0.8;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const MIN_NOTIONAL_BUFFER = 1.02;

const isPrecisionError = (message?: string) => {
  if (!message) return false;
  return /precision|step|lot|qty|quantity|filter failure/i.test(message);
};

const formatQty = (value: number, decimals: number) => {
  const factor = 10 ** decimals;
  const floored = Math.floor(value * factor) / factor;
  if (!Number.isFinite(floored) || floored <= 0) return null;
  return floored.toFixed(decimals).replace(/\.?0+$/, '');
};

const formatPriceByTickSize = (value: number, tickSize: number) => {
  if (!Number.isFinite(value) || value <= 0) return null;
  const tick = tickSize > 0 ? tickSize : 0.01;
  const decimals = (() => {
    const tickStr = tick.toString();
    if (!tickStr.includes('.')) return 0;
    return tickStr.split('.')[1].replace(/0+$/, '').length;
  })();
  const floored = Math.floor(value / tick) * tick;
  if (!Number.isFinite(floored) || floored <= 0) return null;
  return floored.toFixed(decimals).replace(/\.?0+$/, '');
};

const clampNumber = (value: number, min: number, max: number) => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
};

const getConfigNumber = (config: Record<string, unknown>, key: string, fallback: number) => {
  const value = config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const getConfigBoolean = (config: Record<string, unknown>, key: string, fallback: boolean) => {
  const value = config[key];
  return typeof value === 'boolean' ? value : fallback;
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
  // Overnight session (e.g. 22:00-06:00)
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

interface SymbolInfo {
  minNotional: number;
  minQty: number;
  stepSize: number;
  tickSize: number;
  qtyPrecision: number;
  baseAsset: string;
  quoteAsset: string;
}

const getBinanceSymbolInfo = async (
  symbol: string,
  product: string,
  isTestnet: boolean
): Promise<SymbolInfo | null> => {
  try {
    const isFutures = product === 'futures';
    const baseUrl = isFutures
      ? isTestnet
        ? 'https://testnet.binancefuture.com'
        : 'https://fapi.binance.com'
      : isTestnet
        ? 'https://testnet.binance.vision'
        : 'https://api.binance.com';
    const endpoint = isFutures ? '/fapi/v1/exchangeInfo' : '/api/v3/exchangeInfo';
    const url = `${baseUrl}${endpoint}`;
    const response = await fetch(url);
    const data = await response.json() as {
      symbols?: Array<{
        symbol: string;
        baseAsset?: string;
        quoteAsset?: string;
        filters?: Array<{
          filterType: string;
          minNotional?: string;
          minQty?: string;
          stepSize?: string;
          tickSize?: string;
        }>;
      }>;
    };

    const symbolData = data.symbols?.find((s) => s.symbol === symbol);
    if (!symbolData?.filters) return null;

    let minNotional = 5; // Default minimum notional (5 USDT)
    let minQty = 0.001;
    let stepSize = 0.001;
    let tickSize = 0.01;
    let qtyPrecision = 3;
    const baseAsset = symbolData.baseAsset || '';
    const quoteAsset = symbolData.quoteAsset || 'USDT';

    for (const filter of symbolData.filters) {
      if (filter.filterType === 'MIN_NOTIONAL') {
        minNotional = parseFloat(filter.minNotional || '5');
      } else if (filter.filterType === 'LOT_SIZE') {
        minQty = parseFloat(filter.minQty || '0.001');
        stepSize = parseFloat(filter.stepSize || '0.001');
        // Calculate precision from stepSize
        const stepStr = filter.stepSize || '0.001';
        if (stepStr.includes('.')) {
          qtyPrecision = stepStr.split('.')[1].replace(/0+$/, '').length;
        }
      } else if (filter.filterType === 'PRICE_FILTER') {
        tickSize = parseFloat(filter.tickSize || '0.01');
      }
    }

    return { minNotional, minQty, stepSize, tickSize, qtyPrecision, baseAsset, quoteAsset };
  } catch (error) {
    console.error(`Error fetching symbol info for ${symbol}:`, error);
    return null;
  }
};

const getBinanceSpotAssetBalance = async (
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  asset: string
): Promise<{ available: number; total: number }> => {
  const result = await callBinanceApi('/api/v3/account', apiKey, apiSecret, isTestnet, 'spot');
  if (result.success && result.data) {
    const balances = (result.data as { balances?: Array<{ asset: string; free: string; locked: string }> }).balances || [];
    const assetBalance = balances.find((b) => b.asset === asset);
    if (assetBalance) {
      const available = parseFloat(assetBalance.free) || 0;
      const locked = parseFloat(assetBalance.locked) || 0;
      return { available, total: available + locked };
    }
  }
  return { available: 0, total: 0 };
};

const cancelBinanceSpotSellOrders = async (
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  symbol: string
): Promise<{ cancelled: number; errors: string[] }> => {
  const errors: string[] = [];
  let cancelled = 0;

  const openOrdersResult = await callBinanceApi('/api/v3/openOrders', apiKey, apiSecret, isTestnet, 'spot', 'GET', {
    symbol,
  });

  if (!openOrdersResult.success || !openOrdersResult.data) {
    return { cancelled: 0, errors: [openOrdersResult.error || 'Failed to fetch open spot orders'] };
  }

  const openOrders = openOrdersResult.data as Array<{
    orderId: number;
    orderListId?: number;
    side?: string;
  }>;

  const sellOrders = openOrders.filter((o) => (o.side || '').toUpperCase() === 'SELL');
  if (sellOrders.length === 0) {
    return { cancelled, errors };
  }

  const ocoListIds = new Set<number>();
  const standaloneOrderIds: number[] = [];
  for (const order of sellOrders) {
    if (order.orderListId && order.orderListId > 0) {
      ocoListIds.add(order.orderListId);
    } else {
      standaloneOrderIds.push(order.orderId);
    }
  }

  for (const orderListId of ocoListIds) {
    const cancelOcoResult = await callBinanceApi('/api/v3/orderList', apiKey, apiSecret, isTestnet, 'spot', 'DELETE', {
      symbol,
      orderListId: String(orderListId),
    });
    if (cancelOcoResult.success) {
      cancelled += 1;
    } else {
      errors.push(cancelOcoResult.error || `Failed to cancel OCO list ${orderListId}`);
    }
  }

  for (const orderId of standaloneOrderIds) {
    const cancelOrderResult = await callBinanceApi('/api/v3/order', apiKey, apiSecret, isTestnet, 'spot', 'DELETE', {
      symbol,
      orderId: String(orderId),
    });
    if (cancelOrderResult.success) {
      cancelled += 1;
    } else {
      errors.push(cancelOrderResult.error || `Failed to cancel order ${orderId}`);
    }
  }

  return { cancelled, errors };
};

const getAccountBalance = async (
  exchange: string,
  product: string,
  environment: string,
  apiKey: string,
  apiSecret: string
): Promise<{ available: number; total: number }> => {
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
  }

  if (exchange === 'bybit') {
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
        result?: { list?: Array<{ coin?: Array<{ coin: string; equity: string; availableToWithdraw?: string }> }> };
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
};

// Extended interface with additional properties used in auto-signal generation
interface StrategyConfig {
  id: string;
  user_id: string;
  name: string;
  is_active: boolean;
  auto_signal: boolean;
  exchange: string;
  product: string;
  environment: string;
  trading_pair: string;
  position_size?: number;
  max_trades_per_day?: number;
  max_daily_loss?: number;
  last_signal_at?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: any; // Allow additional dynamic properties
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

type GeminiDecision = {
  ok: boolean;
  execute: boolean;
  confidence: number;
  reason?: string;
  raw?: string;
};

const extractJsonFromText = (text: string): string | null => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
};

const getGeminiFilterDecision = async (
  signal: { action: string; symbol: string; price: number; confidence: number; indicators: unknown; rsi_value?: number },
  indicators: StrategyIndicators
): Promise<GeminiDecision> => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // No API key - skip Gemini validation, let engine decide
    console.log(`[Gemini] API key not configured - skipping validation for ${signal.symbol}`);
    return { ok: false, execute: false, confidence: 0, reason: 'gemini_not_configured' };
  }

  const prompt = [
    'You are a trading signal filter.',
    'Return JSON only in the format: {"execute":true|false,"confidence":0-1,"reason":"..."}',
    'Use 0-1 confidence where 0.8-1.0 means high confidence.',
    `Action: ${signal.action}`,
    `Symbol: ${signal.symbol}`,
    `Price: ${signal.price}`,
    `Engine confidence: ${signal.confidence}`,
    `RSI: ${signal.rsi_value ?? 'n/a'}`,
    `Indicators: ${JSON.stringify(signal.indicators)}`,
    `Config: ${JSON.stringify(indicators)}`,
    'If the signal looks weak or conflicting, set execute=false.',
  ].join('\n');

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 200 },
        }),
      }
    );

    if (!response.ok) {
      return { ok: false, execute: false, confidence: 0, reason: `gemini_http_${response.status}` };
    }

    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text =
      data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('')?.trim() || '';
    const jsonText = extractJsonFromText(text);

    if (!jsonText) {
      return { ok: false, execute: false, confidence: 0, reason: 'gemini_invalid_json', raw: text };
    }

    const parsed = JSON.parse(jsonText) as { execute?: boolean; confidence?: number; reason?: string };
    const execute = Boolean(parsed.execute);
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;

    return {
      ok: true,
      execute,
      confidence,
      reason: parsed.reason || 'gemini_filter',
      raw: jsonText,
    };
  } catch (error) {
    return { ok: false, execute: false, confidence: 0, reason: (error as Error).message };
  }
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
    
    const data = await response.json() as { msg?: string; code?: number; message?: string };
    
    if (!response.ok) {
      // Extract error message from Binance API response
      const errorMsg = data.msg || data.message || `Binance API error (code: ${data.code || response.status})`;
      return { success: false, error: errorMsg };
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

interface AutoSignalResult {
  strategy: string;
  pair: string;
  signal: { action: string; symbol: string; price: number; confidence: number } | null;
  executed: boolean;
  tradeId?: string;
  reason?: string;
}

router.post('/', async (_req, res) => {
  try {
    // Get all active auto-signal strategies from PostgreSQL
    const strategiesResult = await pool.query(
      `SELECT * FROM trading_strategies WHERE is_active = true AND signal_mode = 'auto'`
    );
    const allStrategies = strategiesResult.rows;
    console.log(`📊 Total strategies in database: ${allStrategies.length}`);
    
    const strategies = allStrategies
      .filter((s) => {
        const strategy = s as StrategyConfig;
        const isActive = s.is_active;
        const signalMode = strategy.signal_mode;
        const autoSignalEnabled = strategy.auto_signal_enabled;
        const exchange = strategy.exchange;
        const product = strategy.product;
        const environment = strategy.environment;
        
        // Check: is_active must be true
        if (!isActive) {
          console.log(`❌ Strategy ${s.name || s.id} filtered: is_active=false`);
          return false;
        }
        
        // Check: signal_mode should be 'auto' or undefined (defaults to auto)
        if (signalMode && signalMode !== 'auto') {
          console.log(`❌ Strategy ${s.name || s.id} filtered: signal_mode=${signalMode} (must be 'auto' or undefined)`);
          return false;
        }
        
        // Check: auto_signal_enabled should be true or undefined (defaults to enabled)
        if (autoSignalEnabled === false) {
          console.log(`❌ Strategy ${s.name || s.id} filtered: auto_signal_enabled=false`);
          return false;
        }
        
        console.log(`✅ Strategy ${s.name || s.id} passed filter: exchange=${exchange}, product=${product}, environment=${environment}`);
        return true;
      })
      .map((s) => {
        const strategy = s as StrategyConfig;
        // Ensure auto_signal_indicators exists with defaults
        if (!strategy.auto_signal_indicators) {
          strategy.auto_signal_indicators = {
            ema_short: 12,
            ema_long: 26,
            rsi_period: 14,
            rsi_overbought: 70,
            rsi_oversold: 30,
            macd_fast: 12,
            macd_slow: 26,
            macd_signal: 9,
            volume_multiplier: 1.5,
          };
        }
        // Ensure other required fields have defaults
        if (!strategy.allowed_pairs || !Array.isArray(strategy.allowed_pairs) || strategy.allowed_pairs.length === 0) {
          strategy.allowed_pairs = [...DEFAULT_TRADING_PAIRS];
        }
        if (!strategy.max_positions) {
          strategy.max_positions = 5;
        }
        if (!strategy.default_leverage) {
          strategy.default_leverage = 1;
        }
        if (!strategy.stop_loss_percent) {
          strategy.stop_loss_percent = 2;
        }
        if (!strategy.tp1_percent) {
          strategy.tp1_percent = 3;
        }
        if (strategy.use_tp1 === undefined) {
          strategy.use_tp1 = true;
        }
        if (!strategy.tp1_close_percent) {
          strategy.tp1_close_percent = 50;
        }
        if (!strategy.auto_signal_interval) {
          strategy.auto_signal_interval = 1;
        }
        return strategy;
      }) as StrategyConfig[];

    if (strategies.length === 0) {
      console.log(`⚠️  No active auto-signal strategies found after filtering`);
      console.log(`   Total strategies in DB: ${allStrategies.length}`);
      return res.json({
        processed: 0,
        results: [],
        summary: {
          executed: 0,
          totalSignals: 0,
          timestamp: new Date().toISOString(),
        },
        message: 'No active auto-signal strategies found',
        debug: {
          totalStrategies: allStrategies.length,
          filteredOut: allStrategies.length - strategies.length,
        },
      });
    }
    
    console.log(`✅ Found ${strategies.length} active auto-signal strategies to process`);

    const results: AutoSignalResult[] = [];

    for (const config of strategies) {
      const strategyConfig = (config.strategy_config as Record<string, unknown>) || {};
      const minConfidence = clampNumber(
        getConfigNumber(strategyConfig, 'min_confidence', MIN_SIGNAL_CONFIDENCE),
        0,
        1
      );
      const maxSpreadPercent = getConfigNumber(strategyConfig, 'max_spread_percent', 0);
      const maxSlippagePercent = getConfigNumber(strategyConfig, 'max_slippage_percent', 0);
      const requireVolumeConfirmed = getConfigBoolean(strategyConfig, 'require_volume_confirmed', false);
      const riskPercent = getConfigNumber(strategyConfig, 'risk_percent', 0);
      const cooldownMinutes = getConfigNumber(strategyConfig, 'cooldown_minutes', 0);
      const profitOnlySellEnabled = getConfigBoolean(strategyConfig, 'profit_only_sell_enabled', config.product === 'spot');
      const minProfitPercent = Math.max(0, getConfigNumber(strategyConfig, 'min_profit_percent', 0.3));
      const feeBufferPercent = Math.max(0, getConfigNumber(strategyConfig, 'fee_buffer_percent', 0.2));
      const now = new Date();

      if (!isWithinTradingSession(strategyConfig, now)) {
        console.log(`Outside trading session for strategy ${config.id}`);
        continue;
      }

      const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      
      // Get daily trades from PostgreSQL
      const dailyTradesResult = await pool.query(
        `SELECT * FROM trades 
         WHERE user_id = $1 AND triggered_by = 'auto_strategy' AND created_at >= $2`,
        [config.user_id, dayStart.toISOString()]
      );
      const dailyTrades = dailyTradesResult.rows;
      
      const maxTradesPerDay = typeof config.max_trades_per_day === 'number' ? config.max_trades_per_day : 0;
      if (maxTradesPerDay > 0 && dailyTrades.length >= maxTradesPerDay) {
        console.log(`Max trades per day reached for strategy ${config.id}`);
        continue;
      }

      // Get daily PnL from PostgreSQL
      const dailyPnlResult = await pool.query(
        `SELECT COALESCE(SUM(realized_pnl), 0) as total_pnl 
         FROM trades 
         WHERE user_id = $1 AND created_at >= $2`,
        [config.user_id, dayStart.toISOString()]
      );
      const dailyPnl = parseFloat(dailyPnlResult.rows[0].total_pnl);
      const maxDailyLoss = typeof config.max_daily_loss === 'number' ? config.max_daily_loss : 0;
      if (maxDailyLoss > 0 && dailyPnl <= -maxDailyLoss) {
        console.log(`Max daily loss reached for strategy ${config.id}`);
        continue;
      }

      const maxConsecutiveLosses = typeof config.max_consecutive_losses === 'number' ? config.max_consecutive_losses : 0;
      if (maxConsecutiveLosses > 0) {
        // Get recent trades from PostgreSQL
        const recentResult = await pool.query(
          `SELECT * FROM trades WHERE user_id = $1 AND realized_pnl IS NOT NULL ORDER BY created_at DESC`,
          [config.user_id]
        );
        const recent = recentResult.rows;
        let consecutiveLosses = 0;
        let lastLossAt: Date | null = null;
        for (const trade of recent) {
          if ((trade.realized_pnl || 0) < 0) {
            consecutiveLosses += 1;
            if (!lastLossAt) lastLossAt = new Date(trade.created_at);
          } else if ((trade.realized_pnl || 0) > 0) {
            break;
          }
        }

        if (consecutiveLosses >= maxConsecutiveLosses) {
          if (cooldownMinutes > 0 && lastLossAt) {
            const minutesSinceLoss = (Date.now() - lastLossAt.getTime()) / 60000;
            if (minutesSinceLoss < cooldownMinutes) {
              console.log(`Cooldown active for strategy ${config.id} after loss streak`);
              continue;
            }
          } else {
            console.log(`Max consecutive losses reached for strategy ${config.id}`);
            continue;
          }
        }
      }
      const pairs = config.allowed_pairs && config.allowed_pairs.length > 0 
        ? config.allowed_pairs 
        : [...DEFAULT_TRADING_PAIRS];
      const isTestnet = config.environment === 'testnet';
      
      console.log(`📈 Processing strategy: ${config.name}`);
      console.log(`   Exchange: ${config.exchange}, Product: ${config.product}, Environment: ${config.environment} (isTestnet: ${isTestnet})`);
      console.log(`   Pairs: ${pairs.join(', ')}`);
      console.log(`   Auto signal enabled: ${config.auto_signal_enabled}, Signal mode: ${config.signal_mode || 'auto'}`);

      // Check if enough time has passed since last signal
      const intervalMinutes = config.auto_signal_interval || 1;
      if (config.last_signal_at) {
        const lastSignalTime = new Date(config.last_signal_at).getTime();
        const now = Date.now();
        const minutesSinceLastSignal = (now - lastSignalTime) / (1000 * 60);

        if (minutesSinceLastSignal < intervalMinutes) {
          const remainingSeconds = Math.ceil((intervalMinutes - minutesSinceLastSignal) * 60);
          console.log(
            `⏳ Strategy ${config.name}: Waiting ${remainingSeconds}s before next signal (interval: ${intervalMinutes}min)`
          );
          continue;
        }
      }

      // Get user's API keys from PostgreSQL
      const allApiKeysResult = await pool.query('SELECT * FROM api_keys');
      const allApiKeys = allApiKeysResult.rows;
      console.log(`🔑 Checking API keys for strategy ${config.name} (${config.id})`);
      console.log(`   User ID: ${config.user_id}, Exchange: ${config.exchange}, Product: ${config.product}, Environment: ${config.environment}`);
      console.log(`   Total API keys in DB: ${allApiKeys.length}`);
      
      const apiKeys = allApiKeys.find(
        (k) =>
          k.user_id === config.user_id &&
          k.exchange === config.exchange &&
          k.product === config.product &&
          k.environment === config.environment &&
          k.is_active
      );

      if (!apiKeys) {
        console.log(`❌ No API keys found for strategy ${config.id}`);
        console.log(`   Looking for: user_id=${config.user_id}, exchange=${config.exchange}, product=${config.product}, environment=${config.environment}, is_active=true`);
        const userApiKeys = allApiKeys.filter(k => k.user_id === config.user_id);
        console.log(`   User has ${userApiKeys.length} API keys total:`);
        userApiKeys.forEach(k => {
          console.log(`     - ${k.exchange}/${k.product}/${k.environment} (active: ${k.is_active})`);
        });
        continue;
      }
      
      console.log(`✅ API keys found for strategy ${config.id}`);

      const apiKey = decryptValue(apiKeys.api_key_encrypted);
      const apiSecret = decryptValue(apiKeys.api_secret_encrypted);

      // Check if bot is running from PostgreSQL
      const allBotStatusesResult = await pool.query('SELECT * FROM bot_status');
      const allBotStatuses = allBotStatusesResult.rows;
      console.log(`🤖 Checking bot status for strategy ${config.name}`);
      console.log(`   Total bot statuses in DB: ${allBotStatuses.length}`);
      
      const botStatus = allBotStatuses.find(
        (b) =>
          b.user_id === config.user_id &&
          b.environment === config.environment &&
          (b.exchange === config.exchange || !b.exchange)
      );

      if (!botStatus) {
        console.log(`❌ No bot status found for strategy ${config.id}`);
        console.log(`   Looking for: user_id=${config.user_id}, environment=${config.environment}, exchange=${config.exchange || 'any'}`);
        const userBotStatuses = allBotStatuses.filter(b => b.user_id === config.user_id);
        console.log(`   User has ${userBotStatuses.length} bot statuses:`);
        userBotStatuses.forEach(b => {
          console.log(`     - ${b.environment}/${b.exchange || 'any'} (running: ${b.is_running})`);
        });
        continue;
      }
      
      if (!botStatus.is_running) {
        console.log(`❌ Bot is not running for strategy ${config.id}`);
        console.log(`   Bot status: is_running=${botStatus.is_running}, environment=${botStatus.environment}, exchange=${botStatus.exchange || 'any'}`);
        continue;
      }
      
      console.log(`✅ Bot is running for strategy ${config.id}`);

      // Check gas fee balance from PostgreSQL
      const allGasBalancesResult = await pool.query('SELECT * FROM gas_fee_balances');
      const allGasBalances = allGasBalancesResult.rows;
      console.log(`💰 Checking gas fee balance for strategy ${config.name}`);
      
      const gasBalance = allGasBalances.find(
        (b: any) => b.user_id === config.user_id && b.environment === config.environment
      );

      if (!gasBalance) {
        console.log(`❌ No gas fee balance found for strategy ${config.id}`);
        console.log(`   Looking for: user_id=${config.user_id}, environment=${config.environment}`);
        const userBalances = allGasBalances.filter((b: any) => b.user_id === config.user_id);
        console.log(`   User has ${userBalances.length} gas fee balances:`);
        userBalances.forEach((b: any) => {
          console.log(`     - ${b.environment}: ${b.balance}`);
        });
        continue;
      }
      
      if (gasBalance.balance <= 0) {
        console.log(`❌ Insufficient gas balance for strategy ${config.id}`);
        console.log(`   Balance: ${gasBalance.balance}, Environment: ${gasBalance.environment}`);
        continue;
      }
      
      console.log(`✅ Gas fee balance OK: ${gasBalance.balance} for ${config.environment}`);

      // Check current positions count from PostgreSQL
      const positionsResult = await pool.query(
        `SELECT * FROM positions WHERE user_id = $1 AND is_open = true`,
        [config.user_id]
      );
      const positionCount = positionsResult.rows.length;

      if (positionCount >= config.max_positions) {
        console.log(`Max positions reached for strategy ${config.id}`);
        continue;
      }

      for (const pair of pairs) {
        try {
          // Fetch klines
          const interval = config.exchange === 'binance' ? '1m' : '1';
          const candles = await fetchKlines(config.exchange, pair, interval, isTestnet, config.product, 100);

          if (candles.length < 50) {
            console.log(`Insufficient candle data for ${pair} (got ${candles.length} candles, need 50+)`);
            continue;
          }

          // Analyze signal
          if (!config.auto_signal_indicators) {
            console.log(`❌ Strategy ${config.id} missing auto_signal_indicators, skipping ${pair}`);
            continue;
          }
          
          console.log(`🔍 Analyzing signal for ${pair}...`);
          const signal = analyzeSignal(candles, config.auto_signal_indicators, pair);
          console.log(`   Signal result: action=${signal.action}, confidence=${(signal.confidence * 100).toFixed(1)}%, price=${signal.price}`);

          // Save signal to database (whether executed or not)
          const signalId = crypto.randomUUID();
          const signalAction = signal.action; // 'buy', 'sell', or 'none'
          await pool.query(
            `INSERT INTO signals (
              id, user_id, strategy_id, signal_source, symbol, action, price, confidence,
              rsi_value, ema_short, ema_long, macd_value, indicators,
              gemini_validated, gemini_decision, gemini_confidence, gemini_reason,
              executed, execution_error, order_id, trade_id,
              exchange, product, environment, triggered_by, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
            [
              signalId,
              config.user_id,
              config.id,
              'auto', // signal_source
              pair,
              signalAction,
              signal.price,
              signal.confidence,
              signal.rsi_value || null,
              null, // ema_short (not available in current structure)
              null, // ema_long (not available in current structure)
              null, // macd_value (not available in current structure)
              JSON.stringify(signal.indicators),
              false, // gemini_validated (will update later if Gemini is used)
              null, // gemini_decision
              null, // gemini_confidence
              null, // gemini_reason
              false, // executed (will update to true if trade executes)
              null, // execution_error
              null, // order_id (will update if order placed)
              null, // trade_id (will update if trade recorded)
              config.exchange,
              config.product,
              config.environment,
              'auto_strategy',
              new Date().toISOString()
            ]
          );

          if (signal.action === 'none') {
            console.log(`   ⏭️  No signal for ${pair} (action: none)`);
            continue;
          }

          if (requireVolumeConfirmed && !signal.indicators.volume_confirmed) {
            console.log(`Volume not confirmed for ${pair}, skipping`);
            continue;
          }

          let latestBook: { bid: number; ask: number } | null = null;
          if (maxSpreadPercent > 0 || maxSlippagePercent > 0) {
            latestBook = await getBookTicker(config.exchange, config.product, pair, isTestnet);
            const book = latestBook;
            if (book) {
              const mid = (book.bid + book.ask) / 2;
              const spreadPct = ((book.ask - book.bid) / mid) * 100;
              const slippagePct = Math.abs(signal.price - mid) / mid * 100;
              if (maxSpreadPercent > 0 && spreadPct > maxSpreadPercent) {
                console.log(`Spread too high for ${pair}: ${spreadPct.toFixed(3)}%`);
                continue;
              }
              if (maxSlippagePercent > 0 && slippagePct > maxSlippagePercent) {
                console.log(`Slippage too high for ${pair}: ${slippagePct.toFixed(3)}%`);
                continue;
              }
            }
          }

          const engineConfidenceOk = signal.confidence >= minConfidence;
          let shouldExecute = false;
          let skipReason = '';
          let geminiDecision: GeminiDecision | null = null;

          if (!engineConfidenceOk) {
            skipReason = 'Confidence below threshold';
            console.log(`❌ ${pair}: Engine confidence ${(signal.confidence * 100).toFixed(1)}% < threshold ${(minConfidence * 100).toFixed(1)}%`);
          } else {
            const decision = await getGeminiFilterDecision(signal, config.auto_signal_indicators);
            if (decision.ok) {
              geminiDecision = decision;
              console.log(`🤖 ${pair}: Gemini decision - execute: ${decision.execute}, confidence: ${(decision.confidence * 100).toFixed(1)}%, reason: ${decision.reason}`);
              if (decision.execute && decision.confidence >= minConfidence) {
                shouldExecute = true;
              } else {
                skipReason = decision.reason || 'Gemini rejected signal';
                console.log(`❌ ${pair}: Gemini REJECTED - ${skipReason}`);
              }
            } else {
              // Gemini unavailable -> fallback to engine signal
              shouldExecute = true;
              skipReason = `Gemini unavailable: ${decision.reason || 'unknown_error'}`;
              console.log(`⚠️ ${pair}: Gemini unavailable, using engine signal only`);
            }
          }

          // Only execute if signal confidence >= 0.80 (80%) and Gemini filter passes (or Gemini fails)
          if (shouldExecute) {
            // For FUTURES: Check if we have open positions before selling
            if (signal.action === 'sell' && config.product === 'futures') {
              const positionsResult = await pool.query(
                `SELECT * FROM positions 
                 WHERE user_id = $1 AND exchange = $2 AND environment = $3 AND (product OR 'futures') = 'futures' AND symbol = $4 AND is_open = true`,
                [config.user_id, config.exchange, config.environment, pair]
              );
              const openPositions = positionsResult.rows;
              
              if (openPositions.length === 0) {
                shouldExecute = false;
                skipReason = 'No open position to close for futures sell signal';
                console.log(`❌ ${pair}: FUTURES SELL blocked - ${skipReason}`);
              } else {
                // For futures, check if position is profitable before selling
                const totalUnrealizedPnl = openPositions.reduce((sum, p) => sum + (Number(p.unrealized_pnl || 0)), 0);
                console.log(`📊 ${pair}: FUTURES SELL signal - Open positions: ${openPositions.length}, Total unrealized PnL: ${totalUnrealizedPnl.toFixed(2)}`);
                
                // Optionally: Only sell if profitable (can be configured)
                if (profitOnlySellEnabled && totalUnrealizedPnl <= 0) {
                  shouldExecute = false;
                  skipReason = `Futures position not profitable (PnL: ${totalUnrealizedPnl.toFixed(2)})`;
                  console.log(`❌ ${pair}: FUTURES SELL blocked - ${skipReason}`);
                } else {
                  console.log(`✅ ${pair}: FUTURES SELL approved - Will close ${openPositions.length} position(s)`);
                }
              }
            }
            
            // Spot sell signals are gated by profitability so we don't sell below entry.
            if (signal.action === 'sell' && config.product === 'spot' && profitOnlySellEnabled) {
              const positionsResult = await pool.query(
                `SELECT * FROM positions 
                 WHERE user_id = $1 AND exchange = $2 AND environment = $3 AND (product OR 'spot') = 'spot' AND symbol = $4 AND is_open = true AND side = 'long'`,
                [config.user_id, config.exchange, config.environment, pair]
              );
              const openLongPositions = positionsResult.rows;

              if (openLongPositions.length === 0) {
                shouldExecute = false;
                skipReason = 'No open long position available for profitable sell';
                console.log(`❌ ${pair}: SELL blocked - ${skipReason}`);
              } else {
                const totalSize = openLongPositions.reduce((sum, p) => sum + Number(p.size || 0), 0);
                const weightedEntry = openLongPositions.reduce(
                  (sum, p) => sum + Number(p.entry_price || 0) * Number(p.size || 0),
                  0
                );
                const avgEntryPrice = totalSize > 0 ? weightedEntry / totalSize : 0;
                if (avgEntryPrice <= 0) {
                  shouldExecute = false;
                  skipReason = 'Invalid entry price for profit-only sell check';
                  console.log(`❌ ${pair}: SELL blocked - ${skipReason}`);
                } else {
                  if (!latestBook) {
                    latestBook = await getBookTicker(config.exchange, config.product, pair, isTestnet);
                  }
                  const executionPrice = latestBook?.bid || signal.price;
                  const requiredProfitPercent = minProfitPercent + feeBufferPercent;
                  const requiredPrice = avgEntryPrice * (1 + requiredProfitPercent / 100);
                  const pnlPercent = ((executionPrice - avgEntryPrice) / avgEntryPrice) * 100;
                  if (executionPrice < requiredPrice) {
                    shouldExecute = false;
                    skipReason = `Profit gate: ${pnlPercent.toFixed(3)}% < required ${requiredProfitPercent.toFixed(3)}%`;
                    console.log(
                      `❌ ${pair}: SELL blocked by profit gate - entry: ${avgEntryPrice.toFixed(6)}, price: ${executionPrice.toFixed(6)}, required: ${requiredPrice.toFixed(6)}`
                    );
                  } else {
                    console.log(
                      `✅ ${pair}: Profit gate passed - entry: ${avgEntryPrice.toFixed(6)}, price: ${executionPrice.toFixed(6)}, pnl: ${pnlPercent.toFixed(3)}%`
                    );
                  }
                }
              }
            }

            if (!shouldExecute) {
              console.log(`❌ ${pair}: Signal FILTERED - shouldExecute: false, skipReason: ${skipReason}`);
              if (signal.action === 'buy' || signal.action === 'sell') {
                const webhookLogId = crypto.randomUUID();
                await pool.query(
                  `INSERT INTO webhook_logs (id, user_id, strategy_id, webhook_secret, request_body, signal_data, decision, status, error_message, created_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                  [webhookLogId, config.user_id, config.id, 'auto_signal', '{}',
                   JSON.stringify(signal),
                   JSON.stringify(geminiDecision || { execute: false }),
                   'filtered', skipReason || 'Signal was filtered', new Date().toISOString()]
                );
              }
              results.push({
                strategy: config.name,
                pair,
                signal: (signal.action === 'buy' || signal.action === 'sell') ? {
                  action: signal.action,
                  symbol: pair,
                  price: signal.price,
                  confidence: signal.confidence,
                } : null,
                executed: false,
                reason: skipReason || 'Signal was filtered',
              });
              continue;
            }

            console.log(`✅ ${pair}: Signal approved for execution - action: ${signal.action}, price: ${signal.price}, confidence: ${(signal.confidence * 100).toFixed(1)}%`);
            console.log(`   📍 Price source: Last candle close price from market data (${config.exchange} ${config.product})`);
            
            // Get current market price from order book for better execution
            let executionPrice = signal.price;
            if (!latestBook) {
              latestBook = await getBookTicker(config.exchange, config.product, pair, isTestnet);
            }
            
            if (latestBook) {
              // Use bid price for sell, ask price for buy (more realistic execution)
              executionPrice = signal.action === 'sell' ? latestBook.bid : latestBook.ask;
              console.log(`   💰 Execution price: ${executionPrice} (from order book), Signal price: ${signal.price} (from candle)`);
            } else {
              console.log(`   ⚠️  Order book not available, using signal price: ${signal.price}`);
            }
            
            const leverage = config.default_leverage;
            const price = executionPrice; // Use order book price if available, otherwise signal price

            // Calculate position size (balance-aware)
            let quantity = 0.001;
            if (riskPercent > 0 && config.stop_loss_percent > 0) {
              const { total: balance } = await getAccountBalance(
                config.exchange,
                config.product,
                config.environment,
                apiKey,
                apiSecret
              );
              const riskAmount = balance * (riskPercent / 100);
              const stopDistance = price * (config.stop_loss_percent / 100);
              quantity = stopDistance > 0 ? riskAmount / stopDistance : quantity;
            } else if (config.position_size_type === 'fixed') {
              quantity = config.position_size_value / price;
            } else {
              const { total: balance } = await getAccountBalance(
                config.exchange,
                config.product,
                config.environment,
                apiKey,
                apiSecret
              );
              const positionValue = balance * (config.position_size_value / 100);
              quantity = positionValue / price;
            }
            const roundedQty = Math.floor(quantity * 1000) / 1000;

            let orderId: string | undefined;
            let orderSuccess = false;
            let executionError: string | null = null;
            let orderQtyDecimals: number | null = null;

            if (config.exchange === 'binance' && config.product === 'futures') {
              const positionSide = (strategyConfig.position_side as string | undefined) || 'BOTH';
              // Set leverage
              const leverageResult = await callBinanceApi(
                '/fapi/v1/leverage',
                apiKey,
                apiSecret,
                isTestnet,
                config.product,
                'POST',
                {
                  symbol: pair,
                  leverage: leverage.toString(),
                }
              );
              if (!leverageResult.success) {
                executionError = leverageResult.error || 'Failed to set leverage';
                console.log(`❌ ${pair}: Failed to set leverage - ${executionError}`);
              } else {
                console.log(`✅ ${pair}: Leverage set to ${leverage}x`);
              }

              // Place market order
              const side = signal.action === 'buy' ? 'BUY' : 'SELL';
              let orderResult: { success: boolean; data?: unknown; error?: string } = {
                success: false,
                error: executionError || 'Failed to set leverage',
              };
              if (!executionError) {
                const attempts = [3, 2, 1, 0];
                let lastError: string | undefined;
                for (const decimals of attempts) {
                  const qtyStr = formatQty(quantity, decimals);
                  if (!qtyStr) continue;
                  const attemptResult = await callBinanceApi(
                    '/fapi/v1/order',
                    apiKey,
                    apiSecret,
                    isTestnet,
                    config.product,
                    'POST',
                    {
                      symbol: pair,
                      side,
                      type: 'MARKET',
                      ...(positionSide !== 'BOTH' && { positionSide }),
                      quantity: qtyStr,
                    }
                  );
                  if (attemptResult.success) {
                    orderResult = attemptResult;
                    orderQtyDecimals = decimals;
                    break;
                  }
                  lastError = attemptResult.error;
                  if (!isPrecisionError(attemptResult.error)) {
                    orderResult = attemptResult;
                    break;
                  }
                }
                if (!orderResult.success && lastError) {
                  orderResult = { success: false, error: lastError };
                }
              }

              if (orderResult.success) {
                const orderData = orderResult.data as { orderId: number };
                orderId = orderData.orderId.toString();
                orderSuccess = true;
                console.log(`✅ ${pair}: Binance order SUCCESS - orderId: ${orderId}, quantity: ${quantity}`);

                // Place SL/TP orders
                const tpSlErrors: string[] = [];
                if (price > 0) {
                  const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
                  const slPrice = side === 'BUY'
                    ? price * (1 - config.stop_loss_percent / 100)
                    : price * (1 + config.stop_loss_percent / 100);

                  const slResult = await callBinanceApi('/fapi/v1/order', apiKey, apiSecret, isTestnet, config.product, 'POST', {
                    symbol: pair,
                    side: closeSide,
                    type: 'STOP_MARKET',
                    stopPrice: slPrice.toFixed(2),
                    closePosition: 'true',
                    ...(positionSide !== 'BOTH' && { positionSide }),
                  });
                  if (!slResult.success) {
                    tpSlErrors.push(slResult.error || 'Stop loss failed');
                  }

                  const tpLevels = [
                    { enabled: config.use_tp1, percent: config.tp1_percent, closePercent: config.tp1_close_percent },
                    { enabled: config.use_tp2, percent: config.tp2_percent, closePercent: config.tp2_close_percent },
                    { enabled: config.use_tp3, percent: config.tp3_percent, closePercent: config.tp3_close_percent },
                  ];
                  const decimals = orderQtyDecimals ?? 3;

                  for (const tp of tpLevels) {
                    if (!tp.enabled) continue;
                    const tpPrice = side === 'BUY'
                      ? price * (1 + tp.percent / 100)
                      : price * (1 - tp.percent / 100);
                    const tpQty = Math.floor(roundedQty * (tp.closePercent / 100) * 1000) / 1000;
                    const tpQtyStr = formatQty(tpQty, decimals);

                    if (tpQtyStr) {
                      const tpResult = await callBinanceApi('/fapi/v1/order', apiKey, apiSecret, isTestnet, config.product, 'POST', {
                        symbol: pair,
                        side: closeSide,
                        type: 'TAKE_PROFIT_MARKET',
                        stopPrice: tpPrice.toFixed(2),
                        ...(positionSide !== 'BOTH' && { positionSide }),
                        quantity: tpQtyStr,
                      });
                      if (!tpResult.success) {
                        tpSlErrors.push(tpResult.error || `TP${tp.percent} failed`);
                      }
                    }
                  }

                  if (config.use_trailing_stop) {
                    const trailingStopCallback = typeof config.trailing_stop_callback === 'number' ? config.trailing_stop_callback : 0;
                    const trailingStopActivation = typeof config.trailing_stop_activation === 'number' ? config.trailing_stop_activation : 0;
                    if (trailingStopCallback > 0) {
                      const callbackRate = clampNumber(trailingStopCallback, 0.1, 5);
                      const activationPrice = trailingStopActivation > 0
                        ? side === 'BUY'
                          ? price * (1 + trailingStopActivation / 100)
                          : price * (1 - trailingStopActivation / 100)
                        : 0;
                      const params: Record<string, string> = {
                        symbol: pair,
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
                      const trailingResult = await callBinanceApi('/fapi/v1/order', apiKey, apiSecret, isTestnet, config.product, 'POST', params);
                      if (!trailingResult.success) {
                        tpSlErrors.push(trailingResult.error || 'Trailing stop failed');
                      }
                    }
                  }
                }
                if (tpSlErrors.length > 0) {
                  executionError = tpSlErrors.join(' | ');
                }
              }
              if (!orderResult.success) {
                executionError = orderResult.error || 'Binance order failed';
                console.log(`❌ ${pair}: Binance order FAILED - ${executionError}`);
              }
            } else if (config.exchange === 'binance' && config.product === 'spot') {
              // Binance Spot order execution
              // Note: Spot doesn't support leverage, so we skip leverage setting
              const side = signal.action === 'buy' ? 'BUY' : 'SELL';
              if (side === 'SELL') {
                const cancelResult = await cancelBinanceSpotSellOrders(apiKey, apiSecret, isTestnet, pair);
                if (cancelResult.cancelled > 0) {
                  console.log(`ℹ️ ${pair}: Cancelled ${cancelResult.cancelled} open SELL/OCO orders before market sell`);
                }
                if (cancelResult.errors.length > 0) {
                  console.log(`⚠️ ${pair}: Could not cancel some open sell orders - ${cancelResult.errors.join(' | ')}`);
                }
              }
              
              // Get symbol info to check minimum notional and quantity requirements
              const symbolInfo = await getBinanceSymbolInfo(pair, config.product, isTestnet);
              
              // Validate minimum notional before attempting order
              if (symbolInfo) {
                const minNotionalTarget = symbolInfo.minNotional * MIN_NOTIONAL_BUFFER;
                const orderValue = quantity * price;
                if (orderValue < minNotionalTarget) {
                  // Increase quantity to meet minimum notional
                  const requiredQty = Math.ceil((minNotionalTarget / price) / symbolInfo.stepSize) * symbolInfo.stepSize;
                  if (requiredQty > quantity) {
                    quantity = requiredQty;
                    console.log(`⚠️ ${pair}: Quantity adjusted to meet minimum notional: ${quantity} (value: ${(quantity * price).toFixed(2)} USDT)`);
                  }
                }
                
                // Ensure quantity meets minimum quantity requirement
                if (quantity < symbolInfo.minQty) {
                  quantity = symbolInfo.minQty;
                  console.log(`⚠️ ${pair}: Quantity adjusted to minimum: ${quantity}`);
                }
                
                // Round quantity to proper precision
                quantity = Math.ceil(quantity / symbolInfo.stepSize) * symbolInfo.stepSize;
              }

              let orderResult: { success: boolean; data?: unknown; error?: string } = {
                success: false,
                error: 'Order not attempted',
              };
              const minNotionalTarget = (symbolInfo?.minNotional || 5) * MIN_NOTIONAL_BUFFER;

              // Pre-check spot balances so we don't spam guaranteed-fail orders.
              const baseAsset = symbolInfo?.baseAsset || pair.replace(/USDT$|USDC$|BUSD$|FDUSD$/, '');
              const quoteAsset = symbolInfo?.quoteAsset || 'USDT';
              if (side === 'SELL') {
                const { available } = await getBinanceSpotAssetBalance(apiKey, apiSecret, isTestnet, baseAsset);
                if (available + 1e-12 < quantity) {
                  executionError = `Insufficient ${baseAsset} balance (${available.toFixed(8)} available, ${quantity.toFixed(8)} required)`;
                  console.log(`⚠️ ${pair}: ${executionError}`);
                  orderResult = { success: false, error: executionError };
                }
              } else {
                const { available } = await getBinanceSpotAssetBalance(apiKey, apiSecret, isTestnet, quoteAsset);
                const requiredQuote = quantity * price;
                if (available + 1e-12 < requiredQuote) {
                  executionError = `Insufficient ${quoteAsset} balance (${available.toFixed(2)} available, ${requiredQuote.toFixed(2)} required)`;
                  console.log(`⚠️ ${pair}: ${executionError}`);
                  orderResult = { success: false, error: executionError };
                }
              }

              // Use symbol precision if available, otherwise try multiple decimals
              const attempts = symbolInfo ? [symbolInfo.qtyPrecision] : [8, 6, 4, 3, 2, 1, 0];
              let lastError: string | undefined;
              
              if (!orderResult.error || orderResult.error === 'Order not attempted') {
              for (const decimals of attempts) {
                const qtyStr = formatQty(quantity, decimals);
                if (!qtyStr) continue;
                
                // Final notional check before API call
                const finalQty = parseFloat(qtyStr);
                const finalValue = finalQty * price;
                  if (symbolInfo && finalValue < minNotionalTarget) {
                  lastError = `Filter failure: NOTIONAL (order value ${finalValue.toFixed(2)} USDT < minimum ${symbolInfo.minNotional} USDT)`;
                  continue;
                }
                
                const attemptResult = await callBinanceApi(
                  '/api/v3/order',
                  apiKey,
                  apiSecret,
                  isTestnet,
                  config.product,
                  'POST',
                  {
                    symbol: pair,
                    side,
                    type: 'MARKET',
                    quantity: qtyStr,
                  }
                );
                
                if (attemptResult.success) {
                  orderResult = attemptResult;
                  orderQtyDecimals = decimals;
                  break;
                }
                
                lastError = attemptResult.error;
                
                // Check if error is NOTIONAL related
                if (attemptResult.error && /notional|min.*notional/i.test(attemptResult.error)) {
                  // Try to increase quantity to meet minimum notional
                  if (symbolInfo) {
                      const newQty = Math.ceil((minNotionalTarget / price) / symbolInfo.stepSize) * symbolInfo.stepSize;
                    if (newQty > quantity) {
                      quantity = newQty;
                      console.log(`⚠️ ${pair}: Retrying with increased quantity ${quantity} to meet minimum notional`);
                      // Reset attempts to try again with new quantity
                      continue;
                    }
                  }
                }
                
                if (!isPrecisionError(attemptResult.error)) {
                  orderResult = attemptResult;
                  break;
                  }
                }
              }
              
              if (!orderResult.success && lastError) {
                orderResult = { success: false, error: lastError };
              }

              if (orderResult.success) {
                const orderData = orderResult.data as { orderId: number };
                orderId = orderData.orderId.toString();
                orderSuccess = true;
                console.log(`✅ ${pair}: Binance SPOT order SUCCESS - orderId: ${orderId}, quantity: ${quantity}`);

                // Place protective exits for spot.
                // For Binance spot, OCO is the reliable way to combine TP + SL on the same quantity.
                const tpSlErrors: string[] = [];
                if (price > 0) {
                  const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
                  const decimals = orderQtyDecimals ?? 3;
                  const filledQtyStr = formatQty(quantity, decimals);

                  // For SPOT BUY entries, place one OCO (TP1 + SL).
                  // TP2/TP3/trailing are skipped to avoid over-reserving the same balance.
                  if (side === 'BUY' && closeSide === 'SELL' && filledQtyStr && symbolInfo) {
                    const tpPriceRaw = config.use_tp1
                      ? price * (1 + config.tp1_percent / 100)
                      : price * 1.01;
                    const slStopRaw = price * (1 - config.stop_loss_percent / 100);
                    const slLimitRaw = slStopRaw * 0.995;

                    const tpPriceStr = formatPriceByTickSize(tpPriceRaw, symbolInfo.tickSize);
                    const slStopStr = formatPriceByTickSize(slStopRaw, symbolInfo.tickSize);
                    const slLimitStr = formatPriceByTickSize(slLimitRaw, symbolInfo.tickSize);

                    if (!tpPriceStr || !slStopStr || !slLimitStr) {
                      tpSlErrors.push('Failed to format OCO prices');
                    } else {
                      const ocoResult = await callBinanceApi('/api/v3/order/oco', apiKey, apiSecret, isTestnet, config.product, 'POST', {
                        symbol: pair,
                        side: 'SELL',
                        quantity: filledQtyStr,
                        price: tpPriceStr,
                        stopPrice: slStopStr,
                        stopLimitPrice: slLimitStr,
                        stopLimitTimeInForce: 'GTC',
                      });
                      if (!ocoResult.success) {
                        tpSlErrors.push(ocoResult.error || 'OCO TP/SL failed');
                      } else {
                        if (config.use_tp2 || config.use_tp3) {
                          console.log(`⚠️ ${pair}: Spot TP2/TP3 skipped - single OCO (TP1+SL) is used for reliability`);
                        }
                        if (config.use_trailing_stop) {
                          console.log(`⚠️ ${pair}: Spot trailing stop is not enabled in this flow (Binance API limitations in current implementation)`);
                      }
                    }
                    }
                  } else if (side === 'SELL') {
                    console.log(`ℹ️ ${pair}: Spot SELL entry detected - protective TP/SL orders are skipped`);
                  }
                }
                if (tpSlErrors.length > 0) {
                  executionError = tpSlErrors.join(' | ');
                }
              } else {
                executionError = orderResult.error || 'Binance spot order failed';
                // Extract actual error message from Binance API response
                if (orderResult.error && orderResult.error.includes('NOTIONAL')) {
                  executionError = `Filter failure: NOTIONAL (order value too small, minimum required: ${symbolInfo?.minNotional || 5} USDT)`;
                } else if (orderResult.error && orderResult.error.includes('LOT_SIZE')) {
                  executionError = `Filter failure: LOT_SIZE (quantity too small, minimum: ${symbolInfo?.minQty || 0.001})`;
                }
                console.log(`❌ ${pair}: Binance SPOT order FAILED - ${executionError}`);
              }
            } else if (config.exchange === 'bybit') {
              const positionIdx = typeof strategyConfig.position_idx === 'number' ? strategyConfig.position_idx : 0;
              const category = config.product === 'spot' ? 'spot' : 'linear';
              
              // Set leverage only for futures (not for spot)
              if (config.product === 'futures') {
                const leverageResult = await callBybitApi(
                  '/v5/position/set-leverage',
                  apiKey,
                  apiSecret,
                  isTestnet,
                  'POST',
                  {
                    category: 'linear',
                    symbol: pair,
                    buyLeverage: leverage.toString(),
                    sellLeverage: leverage.toString(),
                  }
                );
                if (!leverageResult.success) {
                  executionError = leverageResult.error || 'Failed to set leverage';
                  console.log(`❌ ${pair}: Failed to set leverage - ${executionError}`);
                } else {
                  console.log(`✅ ${pair}: Leverage set to ${leverage}x`);
                }
              }

              // Place market order
              const side = signal.action === 'buy' ? 'Buy' : 'Sell';
              let orderResult: { success: boolean; data?: unknown; error?: string } = {
                success: false,
                error: executionError || (config.product === 'futures' ? 'Failed to set leverage' : 'Initializing order'),
              };
              if (!executionError || config.product === 'spot') {
                const attempts = [3, 2, 1, 0];
                let lastError: string | undefined;
                for (const decimals of attempts) {
                  const qtyStr = formatQty(quantity, decimals);
                  if (!qtyStr) continue;
                  const orderParams: Record<string, string> = {
                    category,
                    symbol: pair,
                    side,
                    orderType: 'Market',
                    qty: qtyStr,
                  };
                  
                  // For spot, we might need different parameters
                  if (config.product === 'spot') {
                    // Spot orders might need different format
                    // Bybit spot uses 'spot' category
                  }
                  
                  const attemptResult = await callBybitApi(
                    '/v5/order/create',
                    apiKey,
                    apiSecret,
                    isTestnet,
                    'POST',
                    orderParams
                  );
                  if (attemptResult.success) {
                    orderResult = attemptResult;
                    orderQtyDecimals = decimals;
                    break;
                  }
                  lastError = attemptResult.error;
                  if (!isPrecisionError(attemptResult.error)) {
                    orderResult = attemptResult;
                    break;
                  }
                }
                if (!orderResult.success && lastError) {
                  orderResult = { success: false, error: lastError };
                }
              }

              if (orderResult.success) {
                const orderData = orderResult.data as { result?: { orderId?: string } };
                orderId = orderData.result?.orderId;
                orderSuccess = true;
                console.log(`✅ ${pair}: Bybit ${config.product.toUpperCase()} order SUCCESS - orderId: ${orderId}, quantity: ${quantity}`);

                // Place SL/TP orders (only for futures - spot doesn't support position-based SL/TP)
                if (price > 0 && config.product === 'futures') {
                  const slPrice = side === 'Buy'
                    ? price * (1 - config.stop_loss_percent / 100)
                    : price * (1 + config.stop_loss_percent / 100);

                  const slResult = await callBybitApi('/v5/position/trading-stop', apiKey, apiSecret, isTestnet, 'POST', {
                    category: 'linear',
                    symbol: pair,
                    positionIdx,
                    stopLoss: slPrice.toFixed(2),
                    slTriggerBy: 'LastPrice',
                  });
                  if (!slResult.success) {
                    executionError = slResult.error || 'Bybit stop loss failed';
                  }

                  const closeSide = side === 'Buy' ? 'Sell' : 'Buy';
                  const tpLevels = [
                    { enabled: config.use_tp1, percent: config.tp1_percent, closePercent: config.tp1_close_percent },
                    { enabled: config.use_tp2, percent: config.tp2_percent, closePercent: config.tp2_close_percent },
                    { enabled: config.use_tp3, percent: config.tp3_percent, closePercent: config.tp3_close_percent },
                  ];
                  const decimals = orderQtyDecimals ?? 3;

                  for (const tp of tpLevels) {
                    if (!tp.enabled) continue;
                    const tpPrice = side === 'Buy'
                      ? price * (1 + tp.percent / 100)
                      : price * (1 - tp.percent / 100);
                    const tpQty = Math.floor(roundedQty * (tp.closePercent / 100) * 1000) / 1000;
                    const tpQtyStr = formatQty(tpQty, decimals);

                    if (tpQtyStr) {
                      const tpResult = await callBybitApi('/v5/order/create', apiKey, apiSecret, isTestnet, 'POST', {
                        category: 'linear',
                        symbol: pair,
                        side: closeSide,
                        orderType: 'Market',
                        qty: tpQtyStr,
                        reduceOnly: true,
                        closeOnTrigger: true,
                        triggerPrice: tpPrice.toFixed(2),
                        triggerBy: 'LastPrice',
                      });
                      if (!tpResult.success) {
                        executionError = tpResult.error || 'Bybit TP failed';
                      }
                    }
                  }

                  if (config.use_trailing_stop) {
                    const trailingStopCallback = typeof config.trailing_stop_callback === 'number' ? config.trailing_stop_callback : 0;
                    const trailingStopActivation = typeof config.trailing_stop_activation === 'number' ? config.trailing_stop_activation : 0;
                    if (trailingStopCallback > 0) {
                      const trailingDistance = price * (trailingStopCallback / 100);
                      const activePrice = trailingStopActivation > 0
                        ? side === 'Buy'
                          ? price * (1 + trailingStopActivation / 100)
                          : price * (1 - trailingStopActivation / 100)
                        : 0;
                      const params: Record<string, unknown> = {
                        category: 'linear',
                        symbol: pair,
                        positionIdx,
                        trailingStop: trailingDistance.toFixed(2),
                      };
                      if (activePrice > 0) {
                        params.activePrice = activePrice.toFixed(2);
                      }
                      const trailingResult = await callBybitApi('/v5/position/trading-stop', apiKey, apiSecret, isTestnet, 'POST', params);
                      if (!trailingResult.success) {
                        executionError = trailingResult.error || 'Bybit trailing stop failed';
                      }
                    }
                  }
                } else if (config.product === 'spot') {
                  // For Bybit spot, SL/TP are handled via conditional orders
                  // Note: Bybit spot doesn't support position-based SL/TP like futures
                  // You would need to use conditional orders or OCO orders
                  console.log(`⚠️ ${pair}: Bybit Spot SL/TP not implemented - spot trading requires conditional orders`);
                }
              }
              if (!orderResult.success) {
                executionError = orderResult.error || 'Bybit order failed';
                console.log(`❌ ${pair}: Bybit order FAILED - ${executionError}`);
              }
            }

            if (orderSuccess && orderId) {
              console.log(`✅ ${pair}: Trade EXECUTION SUCCESS - Recording trade and position in database`);
              // Record trade in database
              const tradeId = crypto.randomUUID();
              const trade: any = {
                id: tradeId,
                user_id: config.user_id,
                exchange: config.exchange,
                product: config.product,
                environment: config.environment as 'testnet' | 'mainnet',
                symbol: pair,
                side: signal.action,
                order_type: 'market',
                price: signal.price,
                quantity,
                status: 'filled',
                order_id: orderId,
                triggered_by: 'auto_strategy',
                created_at: new Date().toISOString(),
              };

              // Record trade in PostgreSQL
              await pool.query(
                `INSERT INTO trades (id, user_id, exchange, product, environment, symbol, side, order_type, price, quantity, realized_pnl, status, order_id, triggered_by, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
                [trade.id, trade.user_id, trade.exchange, trade.product, trade.environment,
                 trade.symbol, trade.side, trade.order_type, trade.price, trade.quantity,
                 trade.realized_pnl, trade.status, trade.order_id, trade.triggered_by, trade.created_at]
              );

              // Record position in PostgreSQL
              const positionId = crypto.randomUUID();
              await pool.query(
                `INSERT INTO positions (id, user_id, exchange, product, environment, symbol, side, size, entry_price, leverage, is_open, unrealized_pnl, stop_loss, take_profit, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
                [positionId, config.user_id, config.exchange, config.product, 
                 config.environment as 'testnet' | 'mainnet', pair, 
                 signal.action === 'buy' ? 'long' : 'short', quantity,
                 signal.price, leverage, true, 0,
                 signal.action === 'buy'
                   ? signal.price * (1 - config.stop_loss_percent / 100)
                   : signal.price * (1 + config.stop_loss_percent / 100),
                 config.use_tp1
                   ? signal.action === 'buy'
                     ? signal.price * (1 + config.tp1_percent / 100)
                     : signal.price * (1 - config.tp1_percent / 100)
                   : null,
                 new Date().toISOString(), new Date().toISOString()]
              );

              // Update last_signal_at in PostgreSQL
              await pool.query(
                `UPDATE trading_strategies SET last_signal_at = $1, updated_at = $2 WHERE id = $3`,
                [new Date().toISOString(), new Date().toISOString(), config.id]
              );

              // Log webhook to PostgreSQL
              const webhookLogId = crypto.randomUUID();
              await pool.query(
                `INSERT INTO webhook_logs (id, user_id, strategy_id, webhook_secret, request_body, signal_data, decision, status, error_message, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [webhookLogId, config.user_id, config.id, 'auto_signal', '{}', 
                 JSON.stringify(signal), 
                 JSON.stringify(geminiDecision || { execute: false }),
                 'executed', null, new Date().toISOString()]
              );

              results.push({
                strategy: config.name,
                pair,
                signal: {
                  action: signal.action,
                  symbol: pair,
                  price: signal.price,
                  confidence: signal.confidence,
                },
                executed: true,
                tradeId,
              });

              console.log(
                `✅ Auto signal EXECUTED: ${pair} ${signal.action} for strategy ${config.name} | Signal confidence: ${(signal.confidence * 100).toFixed(1)}%`
              );
            } else {
              console.log(`❌ ${pair}: Trade EXECUTION FAILED - orderSuccess: ${orderSuccess}, orderId: ${orderId || 'missing'}, error: ${executionError || 'unknown'}`);
              const webhookLogId = crypto.randomUUID();
              await pool.query(
                `INSERT INTO webhook_logs (id, user_id, strategy_id, webhook_secret, request_body, signal_data, decision, status, error_message, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [webhookLogId, config.user_id, config.id, 'auto_signal', '{}',
                 JSON.stringify(signal),
                 JSON.stringify(geminiDecision || { execute: false }),
                 'failed', executionError || 'Trade execution failed', new Date().toISOString()]
              );

              results.push({
                strategy: config.name,
                pair,
                signal: {
                  action: signal.action,
                  symbol: pair,
                  price: signal.price,
                  confidence: signal.confidence,
                },
                executed: false,
                reason: 'Trade execution failed',
              });
            }
          } else {
            console.log(`❌ ${pair}: Signal FILTERED - shouldExecute: false, skipReason: ${skipReason}`);
            if (signal.action === 'buy' || signal.action === 'sell') {
              const webhookLogId = crypto.randomUUID();
              await pool.query(
                `INSERT INTO webhook_logs (id, user_id, strategy_id, webhook_secret, request_body, signal_data, decision, status, error_message, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [webhookLogId, config.user_id, config.id, 'auto_signal', '{}',
                 JSON.stringify(signal),
                 JSON.stringify(geminiDecision || { execute: false }),
                 'filtered', skipReason || 'Signal filtered', new Date().toISOString()]
              );
            }

            results.push({
              strategy: config.name,
              pair,
              signal: (signal.action === 'buy' || signal.action === 'sell') ? {
                action: signal.action,
                symbol: pair,
                price: signal.price,
                confidence: signal.confidence,
              } : null,
              executed: false,
              reason: skipReason || 'Signal filtered',
            });
          }
        } catch (error) {
          console.error(`Error processing ${pair} for strategy ${config.id}:`, error);
        }
      }
    }

    // Calculate summary
    const executedCount = results.filter((r) => r.executed).length;
    const totalSignals = results.filter((r) => r.signal !== null).length;

    console.log(`📊 Auto-signal Summary: ${executedCount} executed, ${totalSignals} signals generated`);

    return res.json({
      processed: strategies.length,
      results,
      summary: {
        executed: executedCount,
        totalSignals,
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
      mode: 'direct_execution',
    });
  } catch (error) {
    console.error('Auto-signal generator error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export const autoSignalGeneratorRouter = router;
