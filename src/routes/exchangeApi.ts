import { Router } from 'express';
import { createHmac } from 'node:crypto';
import crypto from 'node:crypto';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { db, safeWrite } from '../db/index.js';

const router = Router();

interface ApiKeyData {
  api_key_encrypted: string;
  api_secret_encrypted: string;
  exchange: string;
  product: string;
  environment: string;
}

const getBaseAssetFromSymbol = (symbol: string): string => {
  const quoteAssets = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'BTC', 'ETH'];
  const quote = quoteAssets.find((asset) => symbol.endsWith(asset));
  if (!quote) return symbol;
  return symbol.slice(0, symbol.length - quote.length);
};

const formatQty = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return null;
  return value.toFixed(8).replace(/\.?0+$/, '');
};

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
): Promise<Response> => {
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
  return fetch(url, {
    method,
    headers: {
      'X-MBX-APIKEY': apiKey,
      'Content-Type': 'application/json',
    },
  });
};

const createBybitSignature = (
  timestamp: string,
  apiKey: string,
  recvWindow: string,
  queryString: string,
  secret: string
): string => {
  const payload = timestamp + apiKey + recvWindow + queryString;
  const hmac = createHmac('sha256', secret);
  hmac.update(payload);
  return hmac.digest('hex');
};

const callBybitApi = async (
  endpoint: string,
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  method = 'GET',
  params: Record<string, string> = {}
): Promise<Response> => {
  const baseUrl = isTestnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';

  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const queryString = new URLSearchParams(params).toString();
  const signature = createBybitSignature(timestamp, apiKey, recvWindow, queryString, apiSecret);

  const url = `${baseUrl}${endpoint}${queryString ? '?' + queryString : ''}`;
  return fetch(url, {
    method,
    headers: {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': recvWindow,
      'X-BAPI-SIGN': signature,
      'Content-Type': 'application/json',
    },
  });
};

const cancelBinanceSpotSellOrders = async (
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  symbol: string
): Promise<void> => {
  const openOrdersResponse = await callBinanceApi('/api/v3/openOrders', apiKey, apiSecret, isTestnet, 'spot', 'GET', { symbol });
  const openOrders = await openOrdersResponse.json() as Array<{ orderId: number; orderListId?: number; side?: string }>;
  if (!openOrdersResponse.ok || !Array.isArray(openOrders)) return;

  const sellOrders = openOrders.filter((o) => (o.side || '').toUpperCase() === 'SELL');
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
    await callBinanceApi('/api/v3/orderList', apiKey, apiSecret, isTestnet, 'spot', 'DELETE', {
      symbol,
      orderListId: String(orderListId),
    });
  }

  for (const orderId of standaloneOrderIds) {
    await callBinanceApi('/api/v3/order', apiKey, apiSecret, isTestnet, 'spot', 'DELETE', {
      symbol,
      orderId: String(orderId),
    });
  }
};

router.post('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { action, exchange, product, environment, symbol } = req.body as {
      action: string;
      exchange: string;
      product: string;
      environment: string;
      symbol?: string;
    };

    // Validate required fields
    if (!action || !exchange || !product || !environment) {
      console.error('[exchange-api] Missing required fields:', { action, exchange, product, environment, body: req.body });
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['action', 'exchange', 'product', 'environment'],
        received: { action, exchange, product, environment }
      });
    }

    // Ensure req.user exists (should be guaranteed by requireAuth, but TypeScript needs this)
    if (!req.user) {
      return res.status(401).json({ code: 401, message: 'Unauthorized' });
    }

    // Read database to ensure it's up to date
    await db.read();

    // At this point, req.user is guaranteed to exist due to the check above
    const userId = req.user.id;

    const apiKeyData = db.data?.api_keys.find(
      (k) =>
        k.user_id === userId &&
        k.exchange === exchange &&
        k.product === product &&
        k.environment === environment &&
        k.is_active
    ) as ApiKeyData | undefined;

    if (!apiKeyData) {
      console.error('[exchange-api] API keys not found:', { 
        user_id: userId, 
        exchange, 
        product, 
        environment,
        available_keys: db.data?.api_keys.filter(k => k.user_id === userId).map(k => ({
          exchange: k.exchange,
          product: k.product,
          environment: k.environment,
          is_active: k.is_active
        }))
      });
      return res.status(400).json({ 
        error: 'API keys not configured',
        message: `No active API key found for ${exchange} ${product} ${environment}`,
        user_id: userId
      });
    }

    const apiKey = decryptValue(apiKeyData.api_key_encrypted);
    const apiSecret = decryptValue(apiKeyData.api_secret_encrypted);
    const isTestnet = environment === 'testnet';

    let result: unknown;

    if (exchange === 'binance') {
      switch (action) {
        case 'getBalance': {
          const endpoint = product === 'futures' ? '/fapi/v2/balance' : '/api/v3/account';
          const response = await callBinanceApi(endpoint, apiKey, apiSecret, isTestnet, product);
          result = await response.json();
          break;
        }
        case 'getPositions': {
          if (product === 'futures') {
            const response = await callBinanceApi('/fapi/v2/positionRisk', apiKey, apiSecret, isTestnet, product);
            result = await response.json();
            // Debug logging
            console.log(`[getPositions] Binance Futures - User: ${userId}, Exchange: ${exchange}, Product: ${product}, Environment: ${environment}`);
            if (Array.isArray(result)) {
              console.log(`[getPositions] Response type: Array, Length: ${result.length}`);
              if (result.length > 0 && result[0] && typeof result[0] === 'object' && 'symbol' in result[0]) {
                const firstPos = result[0] as { symbol?: string; positionAmt?: string };
                console.log(`[getPositions] Sample position:`, {
                  symbol: firstPos.symbol,
                  positionAmt: firstPos.positionAmt,
                  isZero: parseFloat(firstPos.positionAmt || '0') === 0,
                });
              }
            } else {
              console.log(`[getPositions] Response type: ${typeof result}`);
            }
          } else {
            // Spot "open positions" are tracked in app DB from executed bot trades.
            const allPositions = db.data?.positions || [];
            result = allPositions.filter(
              (p) =>
                p.user_id === userId &&
                p.exchange === exchange &&
                p.environment === environment &&
                (p.product || 'spot') === 'spot' &&
                p.is_open
            );
            // Debug logging
            console.log(`[getPositions] Binance Spot - User: ${userId}, Exchange: ${exchange}, Product: ${product}, Environment: ${environment}`);
            console.log(`[getPositions] Total positions in DB: ${allPositions.length}, Filtered (open): ${Array.isArray(result) ? result.length : 0}`);
            if (Array.isArray(result) && result.length > 0 && result[0]) {
              const firstPos = result[0] as { symbol?: string; size?: number | string; is_open?: boolean };
              console.log(`[getPositions] Sample position:`, {
                symbol: firstPos.symbol,
                size: firstPos.size,
                is_open: firstPos.is_open,
              });
            }
          }
          break;
        }
        case 'getOrders': {
          if (product === 'futures') {
            const response = await callBinanceApi('/fapi/v1/allOrders', apiKey, apiSecret, isTestnet, product, 'GET', { limit: '100' });
            result = await response.json();
          } else {
            result = [];
          }
          break;
        }
        case 'getTrades': {
          if (product === 'futures') {
            const response = await callBinanceApi('/fapi/v1/userTrades', apiKey, apiSecret, isTestnet, product, 'GET', { limit: '100' });
            result = await response.json();
          } else {
            // Binance spot trade history endpoint requires symbol; use app DB history for UI.
            result = (db.data?.trades || [])
              .filter(
                (t) =>
                  t.user_id === userId &&
                  t.exchange === exchange &&
                  t.environment === environment &&
                  (t.product || 'spot') === 'spot'
              )
              .sort((a, b) => new Date(b.created_at || '').getTime() - new Date(a.created_at || '').getTime())
              .slice(0, 100);
          }
          break;
        }
        case 'getAccountInfo': {
          const endpoint = product === 'futures' ? '/fapi/v2/account' : '/api/v3/account';
          const response = await callBinanceApi(endpoint, apiKey, apiSecret, isTestnet, product);
          result = await response.json();
          break;
        }
        case 'getPrice': {
          if (!symbol) {
            return res.status(400).json({ error: 'Symbol required for getPrice' });
          }
          const endpoint = product === 'futures' ? '/fapi/v1/ticker/price' : '/api/v3/ticker/price';
          const response = await callBinanceApi(endpoint, apiKey, apiSecret, isTestnet, product, 'GET', { symbol });
          result = await response.json();
          break;
        }
        case 'closePosition': {
          if (!symbol) {
            return res.status(400).json({ error: 'Symbol required for closing position' });
          }

          if (product === 'futures') {
            const posResponse = await callBinanceApi('/fapi/v2/positionRisk', apiKey, apiSecret, isTestnet, product);
            const positions = await posResponse.json();

            if (!Array.isArray(positions)) {
              return res.status(400).json({ error: 'Failed to fetch positions' });
            }

            const position = positions.find((p: { symbol: string }) => p.symbol === symbol);
            if (!position || parseFloat(position.positionAmt) === 0) {
              return res.json({ success: true, message: 'No position to close', realizedPnl: 0 });
            }

            const positionAmt = parseFloat(position.positionAmt);
            const unrealizedPnl = parseFloat(position.unRealizedProfit) || 0;
            const side = positionAmt > 0 ? 'SELL' : 'BUY';
            const quantity = Math.abs(positionAmt);

            const closeResponse = await callBinanceApi('/fapi/v1/order', apiKey, apiSecret, isTestnet, product, 'POST', {
              symbol,
              side,
              type: 'MARKET',
              quantity: quantity.toString(),
              reduceOnly: 'true',
            });
            const closeResult = await closeResponse.json();

            if (closeResponse.ok) {
              db.data?.trades.push({
                id: crypto.randomUUID(),
                user_id: userId,
                exchange,
                product,
                environment,
                symbol,
                side: side.toLowerCase(),
                order_type: 'market',
                price: parseFloat(position.markPrice) || 0,
                quantity,
                realized_pnl: unrealizedPnl,
                status: 'filled',
                order_id: closeResult.orderId?.toString() || null,
                triggered_by: 'manual_close',
                created_at: new Date().toISOString(),
              });
              await safeWrite();

              result = { success: true, orderId: closeResult.orderId, realizedPnl: unrealizedPnl };
            } else {
              result = { success: false, error: closeResult.msg || 'Failed to close position' };
            }
          } else {
            // Spot close: cancel existing sell/OCO orders, then market-sell available base quantity.
            await cancelBinanceSpotSellOrders(apiKey, apiSecret, isTestnet, symbol);

            const accountResponse = await callBinanceApi('/api/v3/account', apiKey, apiSecret, isTestnet, product, 'GET');
            const accountData = await accountResponse.json() as { balances?: Array<{ asset: string; free: string }> };
            if (!accountResponse.ok) {
              result = { success: false, error: (accountData as { msg?: string }).msg || 'Failed to fetch spot account' };
              break;
            }

            const baseAsset = getBaseAssetFromSymbol(symbol);
            const availableBase = parseFloat(accountData.balances?.find((b) => b.asset === baseAsset)?.free || '0');

            const dbOpenPosition = (db.data?.positions || [])
              .filter(
                (p) =>
                  p.user_id === userId &&
                  p.exchange === exchange &&
                  p.environment === environment &&
                  (p.product || 'spot') === 'spot' &&
                  p.symbol === symbol &&
                  p.is_open
              )
              .sort((a, b) => new Date(b.created_at || '').getTime() - new Date(a.created_at || '').getTime())[0];

            const targetSize = Math.abs(Number(dbOpenPosition?.size || 0));
            const qtyToSell = Math.min(availableBase, targetSize || availableBase);
            const qtyStr = formatQty(qtyToSell);

            if (!qtyStr || qtyToSell <= 0) {
              if (dbOpenPosition) {
                dbOpenPosition.is_open = false;
                dbOpenPosition.updated_at = new Date().toISOString();
                await safeWrite();
              }
              result = { success: true, message: 'No spot quantity available to close', realizedPnl: 0 };
              break;
            }

            const closeResponse = await callBinanceApi('/api/v3/order', apiKey, apiSecret, isTestnet, product, 'POST', {
              symbol,
              side: 'SELL',
              type: 'MARKET',
              quantity: qtyStr,
            });
            const closeResult = await closeResponse.json() as {
              msg?: string;
              orderId?: number;
              cummulativeQuoteQty?: string;
              executedQty?: string;
              fills?: Array<{ price: string; qty: string }>;
            };

            if (closeResponse.ok) {
              const executedQty = parseFloat(closeResult.executedQty || qtyStr) || qtyToSell;
              const avgExitPrice = (() => {
                const fromQuote = parseFloat(closeResult.cummulativeQuoteQty || '0');
                if (executedQty > 0 && fromQuote > 0) return fromQuote / executedQty;
                if (Array.isArray(closeResult.fills) && closeResult.fills.length > 0) {
                  const totalQty = closeResult.fills.reduce((s, f) => s + (parseFloat(f.qty) || 0), 0);
                  const totalQuote = closeResult.fills.reduce((s, f) => s + (parseFloat(f.qty) || 0) * (parseFloat(f.price) || 0), 0);
                  if (totalQty > 0) return totalQuote / totalQty;
                }
                return Number(dbOpenPosition?.current_price || dbOpenPosition?.entry_price || 0);
              })();
              const entryPrice = Number(dbOpenPosition?.entry_price || 0);
              const realizedPnl = entryPrice > 0 ? (avgExitPrice - entryPrice) * executedQty : 0;

              // Close matching app positions for this symbol/user context.
              (db.data?.positions || []).forEach((p) => {
                if (
                  p.user_id === userId &&
                  p.exchange === exchange &&
                  p.environment === environment &&
                  (p.product || 'spot') === 'spot' &&
                  p.symbol === symbol &&
                  p.is_open
                ) {
                  p.is_open = false;
                  p.current_price = avgExitPrice;
                  p.unrealized_pnl = realizedPnl;
                  p.updated_at = new Date().toISOString();
                }
              });

              db.data?.trades.push({
                id: crypto.randomUUID(),
                user_id: userId,
                exchange,
                product,
                environment,
                symbol,
                side: 'sell',
                order_type: 'market',
                price: avgExitPrice,
                quantity: executedQty,
                realized_pnl: realizedPnl,
                status: 'filled',
                order_id: closeResult.orderId?.toString() || null,
                triggered_by: 'manual_close',
                created_at: new Date().toISOString(),
              });
              await safeWrite();

              result = { success: true, orderId: closeResult.orderId, realizedPnl };
            } else {
              result = { success: false, error: closeResult.msg || 'Failed to close spot position' };
            }
          }
          break;
        }
        default:
          return res.status(400).json({ error: 'Unknown action' });
      }
    } else if (exchange === 'bybit') {
      switch (action) {
        case 'getBalance': {
          const response = await callBybitApi('/v5/account/wallet-balance', apiKey, apiSecret, isTestnet, 'GET', {
            accountType: 'UNIFIED',
          });
          result = await response.json();
          break;
        }
        case 'getPositions': {
          const response = await callBybitApi('/v5/position/list', apiKey, apiSecret, isTestnet, 'GET', {
            category: 'linear',
            settleCoin: 'USDT',
          });
          result = await response.json();
          break;
        }
        case 'getOrders': {
          const response = await callBybitApi('/v5/order/history', apiKey, apiSecret, isTestnet, 'GET', {
            category: 'linear',
            limit: '100',
          });
          result = await response.json();
          break;
        }
        case 'getTrades': {
          const response = await callBybitApi('/v5/execution/list', apiKey, apiSecret, isTestnet, 'GET', {
            category: 'linear',
            limit: '100',
          });
          result = await response.json();
          break;
        }
        case 'getAccountInfo': {
          const response = await callBybitApi('/v5/account/info', apiKey, apiSecret, isTestnet);
          result = await response.json();
          break;
        }
        case 'getPrice': {
          if (!symbol) {
            return res.status(400).json({ error: 'Symbol required for getPrice' });
          }
          const response = await callBybitApi('/v5/market/tickers', apiKey, apiSecret, isTestnet, 'GET', {
            category: 'spot',
            symbol,
          });
          const tickerData = await response.json();
          // Extract price from Bybit response
          if (tickerData.result?.list?.[0]?.lastPrice) {
            result = { price: tickerData.result.list[0].lastPrice };
          } else {
            result = { price: '0' };
          }
          break;
        }
        case 'closePosition': {
          if (!symbol) {
            return res.status(400).json({ error: 'Symbol required for closing position' });
          }

          const posResponse = await callBybitApi('/v5/position/list', apiKey, apiSecret, isTestnet, 'GET', {
            category: 'linear',
            symbol,
          });
          const posData = await posResponse.json();
          const position = posData.result?.list?.[0];

          if (!position || parseFloat(position.size) === 0) {
            return res.json({ success: true, message: 'No position to close', realizedPnl: 0 });
          }

          const unrealizedPnl = parseFloat(position.unrealisedPnl) || 0;
          const side = position.side === 'Buy' ? 'Sell' : 'Buy';

          const closeResponse = await callBybitApi('/v5/order/create', apiKey, apiSecret, isTestnet, 'POST', {
            category: 'linear',
            symbol,
            side,
            orderType: 'Market',
            qty: position.size,
            reduceOnly: 'true',
          });
          const closeResult = await closeResponse.json();

          if (closeResult.retCode === 0) {
            db.data?.trades.push({
              id: crypto.randomUUID(),
              user_id: userId,
              exchange,
              product,
              environment,
              symbol,
              side: side.toLowerCase(),
              order_type: 'market',
              price: parseFloat(position.markPrice) || 0,
              quantity: parseFloat(position.size),
              realized_pnl: unrealizedPnl,
              status: 'filled',
              order_id: closeResult.result?.orderId || null,
              triggered_by: 'manual_close',
              created_at: new Date().toISOString(),
            });
            await safeWrite();

            result = { success: true, orderId: closeResult.result?.orderId, realizedPnl: unrealizedPnl };
          } else {
            result = { success: false, error: closeResult.retMsg || 'Failed to close position' };
          }
          break;
        }
        default:
          return res.status(400).json({ error: 'Unknown action' });
      }
    } else {
      return res.status(400).json({ error: 'Unknown exchange' });
    }

    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('Exchange API error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: errorMessage });
  }
});

export const exchangeApiRouter = router;

