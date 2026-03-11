import { Router } from 'express';
import crypto from 'node:crypto';
import { pool } from '../db/postgres.js';
import { createHmac } from 'node:crypto';

// Type for position parameter (matching database schema)
interface Position {
  id: string;
  user_id: string;
  symbol: string;
  exchange: string;
  product?: string;
  environment: string;
  side: string;
  size: number;
  entry_price: number;
  current_price?: number;
  unrealized_pnl?: number;
  is_open: boolean;
  created_at?: string;
  updated_at?: string;
}

const router = Router();
const SERVICE_FEE_RATE = 0.3;
const REFERRAL_RATES = [0.05, 0.03, 0.02]; // Level 1: 5%, Level 2: 3%, Level 3: 2%

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

const getBaseAssetFromSymbol = (symbol: string): string => {
  const quoteAssets = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'BTC', 'ETH'];
  const quote = quoteAssets.find((asset) => symbol.endsWith(asset));
  if (!quote) return symbol;
  return symbol.slice(0, symbol.length - quote.length);
};

async function getRealizedPnlFromBinance(
  symbol: string,
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  since: number
): Promise<number> {
  try {
    // Get user trades to calculate realized PnL
    const tradesResult = await callBinanceApi(
      '/fapi/v1/userTrades',
      apiKey,
      apiSecret,
      isTestnet,
      'futures',
      'GET',
      {
        symbol,
        startTime: since.toString(),
        limit: '100',
      }
    );

    if (tradesResult.success && Array.isArray(tradesResult.data)) {
      const trades = tradesResult.data as Array<{
        realizedPnl?: string;
        commission?: string;
        price: string;
        qty: string;
        side: string;
        time: number;
      }>;
      
      // Sum up realized PnL from all trades
      let totalRealizedPnl = 0;
      for (const trade of trades) {
        const realizedPnl = parseFloat(trade.realizedPnl || '0');
        const commission = parseFloat(trade.commission || '0');
        // Realized PnL already includes commission, but we want net profit
        totalRealizedPnl += realizedPnl;
      }
      return totalRealizedPnl;
    }
  } catch (error) {
    console.error(`Error fetching realized PnL for ${symbol}:`, error);
  }
  return 0;
}

async function checkExchangePosition(
  symbol: string,
  exchange: string,
  product: string,
  isTestnet: boolean,
  apiKey: string,
  apiSecret: string,
  dbPosition?: Position
): Promise<{ isOpen: boolean; currentSize: number; unrealizedPnl: number; currentPrice: number; realizedPnl?: number }> {
  if (exchange === 'binance' && product === 'futures') {
    const result = await callBinanceApi('/fapi/v2/positionRisk', apiKey, apiSecret, isTestnet, product, 'GET', { symbol });
    
    if (result.success && Array.isArray(result.data)) {
      const positions = result.data as Array<{ symbol: string; positionAmt: string; unRealizedProfit: string; markPrice: string }>;
      const position = positions.find(p => p.symbol === symbol);
      
      if (position) {
        const size = parseFloat(position.positionAmt);
        const isOpen = size !== 0;
        
        // If position was open in DB but now closed on exchange, get realized PnL
        let realizedPnl: number | undefined;
        if (dbPosition?.is_open && !isOpen && dbPosition.created_at) {
          // Position just closed - get realized PnL from recent trades
          const since = new Date(dbPosition.created_at).getTime();
          realizedPnl = await getRealizedPnlFromBinance(symbol, apiKey, apiSecret, isTestnet, since);
        }
        
        return {
          isOpen,
          currentSize: Math.abs(size),
          unrealizedPnl: parseFloat(position.unRealizedProfit) || 0,
          currentPrice: parseFloat(position.markPrice) || 0,
          realizedPnl,
        };
      }
    }
  } else if (exchange === 'binance' && product === 'spot') {
    const accountResult = await callBinanceApi('/api/v3/account', apiKey, apiSecret, isTestnet, product, 'GET');
    if (accountResult.success && accountResult.data) {
      type BinanceSpotAccount = { balances?: Array<{ asset: string; free: string; locked: string }> };
      const accountData = accountResult.data as BinanceSpotAccount;
      const baseAsset = getBaseAssetFromSymbol(symbol);
      const balance = accountData.balances?.find((b) => b.asset === baseAsset);
      const free = parseFloat(balance?.free || '0');
      const locked = parseFloat(balance?.locked || '0');
      const size = Math.max(0, free + locked);
      let currentPrice = 0;
      let unrealizedPnl = 0;

      if (size > 0) {
        const baseUrl = isTestnet ? 'https://testnet.binance.vision' : 'https://api.binance.com';
        try {
          const tickerRes = await fetch(`${baseUrl}/api/v3/ticker/price?symbol=${symbol}`);
          if (tickerRes.ok) {
            const tickerData = await tickerRes.json() as { price?: string };
            currentPrice = parseFloat(tickerData.price || '0') || 0;
          }
        } catch {
          // best-effort for UI updates; keep fallback values on network issues
        }

        const entryPrice = Number(dbPosition?.entry_price || 0);
        if (currentPrice > 0 && entryPrice > 0) {
          unrealizedPnl = (currentPrice - entryPrice) * size;
        }
      }

      return {
        isOpen: size > 0,
        currentSize: size,
        unrealizedPnl,
        currentPrice,
      };
    }
  } else if (exchange === 'bybit') {
    const result = await callBybitApi('/v5/position/list', apiKey, apiSecret, isTestnet, 'GET', { 
      category: 'linear',
      symbol 
    });
    
    if (result.success && result.data) {
      type BybitPositionResponse = {
        result?: {
          list?: Array<{
            symbol: string;
            size: string;
            unrealisedPnl: string;
            markPrice: string;
          }>;
        };
      };
      const data = result.data as BybitPositionResponse;
      const position = data.result?.list?.[0];
      
      if (position) {
        const size = parseFloat(position.size);
        return {
          isOpen: size !== 0,
          currentSize: size,
          unrealizedPnl: parseFloat(position.unrealisedPnl) || 0,
          currentPrice: parseFloat(position.markPrice) || 0,
        };
      }
    }
  }
  
  return { isOpen: false, currentSize: 0, unrealizedPnl: 0, currentPrice: 0 };
}

const getReferralChain = async (userId: string) => {
  const chain: Array<{ level: number; referrerProfile: any }> = [];
  
  let currentProfileResult = await pool.query('SELECT * FROM profiles WHERE user_id = $1', [userId]);
  let currentProfile = currentProfileResult.rows[0];
  let level = 1;

  while (currentProfile?.referrer_id && level <= 3) {
    const referrerProfileResult = await pool.query('SELECT * FROM profiles WHERE id = $1', [currentProfile.referrer_id]);
    const referrerProfile = referrerProfileResult.rows[0];
    if (!referrerProfile) break;
    chain.push({ level, referrerProfile });
    currentProfile = referrerProfile;
    level += 1;
  }

  return chain;
};

const getOrCreateGasBalance = async (userId: string, environment: 'testnet' | 'mainnet') => {
  const now = new Date().toISOString();
  
  // Try to get existing balance
  const result = await pool.query(
    'SELECT * FROM gas_fee_balances WHERE user_id = $1 AND environment = $2',
    [userId, environment]
  );
  
  if (result.rows.length > 0) {
    return result.rows[0];
  }

  // Create new balance
  const created = {
    id: crypto.randomUUID(),
    user_id: userId,
    environment,
    balance: 0,
    total_deposited: 0,
    total_deducted: 0,
    created_at: now,
    updated_at: now,
  };
  
  await pool.query(
    `INSERT INTO gas_fee_balances (id, user_id, environment, balance, total_deposited, total_deducted, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [created.id, userId, environment, 0, 0, 0, now, now]
  );
  
  return created;
};

const processProfitSharing = async (
  userId: string,
  tradeId: string,
  grossProfit: number,
  environment: 'testnet' | 'mainnet'
) => {
  if (grossProfit <= 0) {
    console.log(`Skipping profit sharing - grossProfit: ${grossProfit}, userId: ${userId}, tradeId: ${tradeId}`);
    return;
  }

  const now = new Date().toISOString();
  const serviceFee = grossProfit * SERVICE_FEE_RATE;
  const netProfit = grossProfit - serviceFee;

  console.log(`Processing profit sharing - User: ${userId}, Trade: ${tradeId}, Gross: ${grossProfit}, Fee: ${serviceFee}, Net: ${netProfit}`);

  // Use transaction for atomicity
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if already processed
    const existingSettlement = await client.query(
      'SELECT id FROM profit_settlements WHERE trade_id = $1 LIMIT 1',
      [tradeId]
    );
    if (existingSettlement.rows.length > 0) {
      console.log(`Trade ${tradeId} already has profit settlement, skipping`);
      await client.query('ROLLBACK');
      return;
    }

    // Insert profit settlement
    await client.query(
      `INSERT INTO profit_settlements (id, user_id, trade_id, gross_profit, service_fee_rate, service_fee_amount, net_profit, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [crypto.randomUUID(), userId, tradeId, grossProfit, SERVICE_FEE_RATE, serviceFee, netProfit, now]
    );

    // Update user's gas balance
    const userBalance = await getOrCreateGasBalance(userId, environment);
    const balanceBefore = parseFloat(userBalance.balance);
    const newBalance = Math.max(0, balanceBefore - serviceFee);
    
    await client.query(
      `UPDATE gas_fee_balances SET balance = $1, total_deducted = COALESCE(total_deducted, 0) + $2, updated_at = $3
       WHERE user_id = $4 AND environment = $5`,
      [newBalance, serviceFee, now, userId, environment]
    );

    // Record gas fee transaction
    await client.query(
      `INSERT INTO gas_fee_transactions (id, user_id, amount, transaction_type, description, trade_id, balance_before, balance_after, environment, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [crypto.randomUUID(), userId, -serviceFee, 'service_fee', 
       `Service fee for profitable trade (${environment})`, tradeId, balanceBefore, newBalance, environment, now]
    );

    // Process referral chain
    let totalReferralPaid = 0;
    const referralChain = await getReferralChain(userId);
    
    for (const entry of referralChain) {
      const rate = REFERRAL_RATES[entry.level - 1] || 0;
      const commission = grossProfit * rate;
      if (commission <= 0) continue;

      const beneficiaryUserId = entry.referrerProfile.user_id;

      // Insert referral commission
      await client.query(
        `INSERT INTO referral_commissions (id, beneficiary_user_id, source_user_id, trade_id, level, gross_profit, commission_rate, commission_amount, status, created_at, paid_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [crypto.randomUUID(), beneficiaryUserId, userId, tradeId, entry.level, grossProfit, rate, commission, 'paid', now, now]
      );

      // Update beneficiary's gas balance
      const beneficiaryBalance = await getOrCreateGasBalance(beneficiaryUserId, environment);
      const beneficiaryBefore = parseFloat(beneficiaryBalance.balance);
      const beneficiaryAfter = beneficiaryBefore + commission;
      
      await client.query(
        `UPDATE gas_fee_balances SET balance = $1, total_deposited = COALESCE(total_deposited, 0) + $2, updated_at = $3
         WHERE user_id = $4 AND environment = $5`,
        [beneficiaryAfter, commission, now, beneficiaryUserId, environment]
      );

      // Record gas fee transaction for beneficiary
      await client.query(
        `INSERT INTO gas_fee_transactions (id, user_id, amount, transaction_type, description, trade_id, balance_before, balance_after, environment, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [crypto.randomUUID(), beneficiaryUserId, commission, 'referral_commission',
         `Referral commission (level ${entry.level})`, tradeId, beneficiaryBefore, beneficiaryAfter, environment, now]
      );

      totalReferralPaid += commission;
    }

    // Record admin earnings
    const adminShare = serviceFee - totalReferralPaid;
    await client.query(
      `INSERT INTO admin_earnings (id, source_user_id, trade_id, gross_profit, total_service_fee, referral_commissions_paid, admin_share, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [crypto.randomUUID(), userId, tradeId, grossProfit, serviceFee, totalReferralPaid, adminShare, now]
    );

    await client.query('COMMIT');
    console.log(`Profit sharing completed for trade ${tradeId}`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error in profit sharing:', error);
    throw error;
  } finally {
    client.release();
  }
};

router.post('/', async (_req, res) => {
  try {
    console.log('Position monitor started...');
    
    // Backfill profit settlements for closed trades with realized PnL
    const settledTradesResult = await pool.query('SELECT trade_id FROM profit_settlements');
    const settledTradeIds = new Set(settledTradesResult.rows.map(r => r.trade_id));

    // Process profitable trades that haven't been settled yet
    const profitableTradesResult = await pool.query(
      `SELECT * FROM trades WHERE realized_pnl > 0 AND status = 'filled'`
    );

    console.log(`Found ${profitableTradesResult.rows.length} profitable trades, ${settledTradeIds.size} already settled`);

    for (const trade of profitableTradesResult.rows) {
      if (settledTradeIds.has(trade.id)) {
        console.log(`Trade ${trade.id} already settled, skipping`);
        continue;
      }
      
      const grossProfit = Number(trade.realized_pnl || 0);
      const environment = (trade.environment as 'testnet' | 'mainnet') || 'testnet';
      
      console.log(`Processing profit sharing for trade ${trade.id} - User: ${trade.user_id}, Profit: ${grossProfit}, Environment: ${environment}`);
      
      await processProfitSharing(
        trade.user_id,
        trade.id,
        grossProfit,
        environment
      );
      settledTradeIds.add(trade.id);
    }
    
    if (profitableTradesResult.rows.length > settledTradeIds.size) {
      console.log(`Processed ${profitableTradesResult.rows.length - settledTradeIds.size} new profit settlements`);
    }
    
    // Get all open positions from database
    const allOpenPositionsResult = await pool.query('SELECT * FROM positions WHERE is_open = true');
    const allOpenPositions = allOpenPositionsResult.rows;
    
    if (allOpenPositions.length === 0) {
      return res.json({ message: 'No open positions to monitor' });
    }
    
    console.log(`Found ${allOpenPositions.length} open positions in database. Checking which can be monitored...`);
    
    // Group positions by user and exchange for efficient API calls
    const userPositions = new Map<string, any[]>();
    for (const pos of allOpenPositions) {
      const product = pos.product || 'futures';
      const key = `${pos.user_id}-${pos.exchange}-${pos.environment}-${product}`;
      if (!userPositions.has(key)) {
        userPositions.set(key, []);
      }
      userPositions.get(key)!.push(pos);
    }
    
    const results: Array<{
      position_id: string;
      symbol: string;
      status: string;
      trigger?: string;
      realized_pnl?: number;
    }> = [];
    
    // Track positions we can actually monitor (with API keys)
    let monitorableCount = 0;
    const stalePositionThreshold = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
    
    for (const [key, userPosGroup] of userPositions.entries()) {
      // user_id is a UUID (contains "-"), so parse from the right side.
      const keyParts = key.split('-');
      if (keyParts.length < 4) {
        console.log(`⚠️  Invalid position monitor key format: ${key}`);
        continue;
      }
      const product = keyParts[keyParts.length - 1];
      const environment = keyParts[keyParts.length - 2];
      const exchange = keyParts[keyParts.length - 3];
      const userId = keyParts.slice(0, -3).join('-');
      
      // Get API keys for this user/exchange/environment
      const apiKeysResult = await pool.query(
        `SELECT * FROM api_keys 
         WHERE user_id = $1 AND exchange = $2 AND product = $3 AND environment = $4 AND is_active = true`,
        [userId, exchange, product, environment]
      );
      
      const apiKeys = apiKeysResult.rows[0];
      
      if (!apiKeys) {
        console.log(`⚠️  No API keys found for ${key} (${userPosGroup.length} positions) - checking for stale positions...`);
        
        // Handle positions without API keys - close very old ones
        for (const position of userPosGroup) {
          const positionAge = new Date().getTime() - new Date(position.created_at || position.updated_at || Date.now()).getTime();
          
          // If position is older than threshold, mark as closed (likely already closed on exchange)
          if (positionAge > stalePositionThreshold) {
            console.log(`Closing stale position ${position.symbol} (${Math.round(positionAge / (24 * 60 * 60 * 1000))} days old, no API keys)`);
            
            await pool.query(
              `UPDATE positions SET is_open = false, updated_at = $1 WHERE id = $2`,
              [new Date().toISOString(), position.id]
            );
            
            results.push({
              position_id: position.id,
              symbol: position.symbol,
              status: 'closed',
              trigger: 'stale_cleanup',
              realized_pnl: position.unrealized_pnl || 0,
            });
          }
        }
        continue;
      }
      
      monitorableCount += userPosGroup.length;
      
      const apiKey = decryptValue(apiKeys.api_key_encrypted);
      const apiSecret = decryptValue(apiKeys.api_secret_encrypted);
      const isTestnet = environment === 'testnet';
      
      console.log(`✓ Monitoring ${userPosGroup.length} positions for ${key}...`);
      
      for (const position of userPosGroup) {
        try {
          // Check current position on exchange
          const exchangePos = await checkExchangePosition(
            position.symbol,
            exchange,
            product,
            isTestnet,
            apiKey,
            apiSecret,
            position
          );
          
          // Update current price in database
          if (exchangePos.currentPrice > 0) {
            await pool.query(
              `UPDATE positions 
               SET current_price = $1, unrealized_pnl = $2, updated_at = $3 
               WHERE id = $4`,
              [exchangePos.currentPrice, exchangePos.unrealizedPnl, new Date().toISOString(), position.id]
            );
          }
          
          // If position is closed on exchange but open in DB
          if (!exchangePos.isOpen && position.is_open) {
            console.log(`Position ${position.symbol} closed on exchange, updating DB...`);
            
            await pool.query(
              `UPDATE positions SET is_open = false, unrealized_pnl = 0, updated_at = $1 WHERE id = $2`,
              [new Date().toISOString(), position.id]
            );
            
            // Use realized PnL from API if available, otherwise use unrealized as fallback
            const realizedPnl = exchangePos.realizedPnl !== undefined 
              ? exchangePos.realizedPnl 
              : exchangePos.unrealizedPnl;
            
            console.log(`Position ${position.symbol} closed - Realized PnL: ${realizedPnl}`);
            
            // Record trade with actual realized PnL
            const tradeId = crypto.randomUUID();
            await pool.query(
              `INSERT INTO trades (id, user_id, exchange, product, environment, symbol, side, order_type, price, quantity, realized_pnl, status, order_id, triggered_by, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
              [tradeId, position.user_id, position.exchange, position.product || 'futures', 
               position.environment as 'testnet' | 'mainnet', position.symbol, 
               position.side === 'long' ? 'sell' : 'buy', 'market',
               exchangePos.currentPrice || position.entry_price, position.size,
               realizedPnl, 'filled', null, 'position_monitor', new Date().toISOString()]
            );

            // Only process profit sharing if there's actual profit (realized PnL > 0)
            if (realizedPnl > 0) {
              console.log(`Processing profit sharing for trade ${tradeId} - Gross Profit: ${realizedPnl}`);
              await processProfitSharing(
                position.user_id,
                tradeId,
                realizedPnl,
                position.environment as 'testnet' | 'mainnet'
              );
            } else {
              console.log(`No profit sharing - trade ${tradeId} has loss or zero PnL: ${realizedPnl}`);
            }
            
            results.push({
              position_id: position.id,
              symbol: position.symbol,
              status: 'closed',
              trigger: 'exchange_close',
              realized_pnl: realizedPnl,
            });
          }
        } catch (error) {
          console.error(`Error monitoring position ${position.id}:`, error);
        }
      }
    }
    
    console.log(`Position monitor completed: ${results.length} positions closed`);
    
    // Log summary
    const totalOpen = allOpenPositions.length;
    const withApiKeys = monitorableCount;
    const withoutApiKeys = totalOpen - monitorableCount;
    
    if (withoutApiKeys > 0) {
      console.log(`Note: ${withoutApiKeys} positions cannot be verified (no API keys). Stale positions (>7 days) have been closed.`);
    }
    
    return res.json({
      monitored: monitorableCount,
      total_open: totalOpen,
      without_api_keys: withoutApiKeys,
      closed: results.length,
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Position monitor error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export const positionMonitorRouter = router;
