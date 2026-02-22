import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { db, safeWrite } from '../db/index.js';
import crypto from 'node:crypto';
import { createHmac } from 'node:crypto';

const router = Router();

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
  params: Record<string, string> = {}
): Promise<{ success: boolean; data?: unknown; error?: string }> => {
  const baseUrl = isTestnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
  const timestamp = Date.now().toString();
  const recvWindow = '5000';

  if (method === 'GET') {
    const queryString = new URLSearchParams(params).toString();
    const signature = createBybitSignature(timestamp, apiKey, recvWindow, queryString, apiSecret);
    const url = `${baseUrl}${endpoint}${queryString ? `?${queryString}` : ''}`;
    try {
      const response = await fetch(url, {
        method: 'GET',
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
  }

  const body = JSON.stringify(params);
  const signature = createBybitSignature(timestamp, apiKey, recvWindow, body, apiSecret);
  const url = `${baseUrl}${endpoint}`;
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
};

const getBaseAssetFromSymbol = (symbol: string): string => {
  const quoteAssets = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'BTC', 'ETH'];
  const quote = quoteAssets.find((asset) => symbol.endsWith(asset));
  if (!quote) return symbol;
  return symbol.slice(0, symbol.length - quote.length);
};

const cancelBinanceSpotSellOrders = async (
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  symbol: string
): Promise<void> => {
  const openOrdersResult = await callBinanceApi('/api/v3/openOrders', apiKey, apiSecret, isTestnet, 'spot', 'GET', { symbol });
  if (!openOrdersResult.success || !openOrdersResult.data) return;
  const openOrders = openOrdersResult.data as Array<{ orderId: number; orderListId?: number; side?: string }>;
  const sellOrders = openOrders.filter((o) => (o.side || '').toUpperCase() === 'SELL');
  const ocoListIds = new Set<number>();
  const standaloneOrderIds: number[] = [];
  for (const order of sellOrders) {
    if (order.orderListId && order.orderListId > 0) ocoListIds.add(order.orderListId);
    else standaloneOrderIds.push(order.orderId);
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

router.post('/has_role', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { _user_id, _role } = req.body as { _user_id?: string; _role?: string };
  if (!_role) {
    return res.status(400).json({ error: 'Missing _role' });
  }

  // Use current authenticated user's ID if _user_id not provided or matches current user
  // This allows users to check their own role, and admins can check any user's role
  const targetUserId = _user_id || req.user?.id;
  if (!targetUserId) {
    return res.status(400).json({ error: 'Missing user ID' });
  }

  // Security: Non-admin users can only check their own role
  if (targetUserId !== req.user?.id) {
    // Check if current user is admin
    await db.read();
    const currentUserRoles = db.data?.user_roles || [];
    const isCurrentUserAdmin = currentUserRoles.some(
      (r) => r.user_id === req.user?.id && r.role === 'admin'
    );
    
    if (!isCurrentUserAdmin) {
      return res.status(403).json({ error: 'Only admins can check other users\' roles' });
    }
  }

  await db.read();
  const roles = db.data?.user_roles || [];
  const hasRole = roles.some((r) => r.user_id === targetUserId && r.role === _role);
  return res.json(hasRole);
});

router.post('/emergency_stop', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const environment = ((req.body as { environment?: 'testnet' | 'mainnet' }).environment || 'testnet') as 'testnet' | 'mainnet';
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    await db.read();
    if (!db.data) {
      return res.status(500).json({ success: false, error: 'Database not initialized' });
    }

    db.data.bot_status ||= [];
    db.data.positions ||= [];
    db.data.trades ||= [];
    db.data.api_keys ||= [];

    const now = new Date().toISOString();

    const statuses = db.data.bot_status.filter((b) => b.user_id === userId && b.environment === environment);
    if (statuses.length === 0) {
      db.data.bot_status.push({
        id: crypto.randomUUID(),
        user_id: userId,
        is_running: false,
        environment,
        exchange: 'binance',
        last_trade_at: null,
        total_trades: 0,
        successful_trades: 0,
        failed_trades: 0,
        created_at: now,
        updated_at: now,
      });
    } else {
      statuses.forEach((s) => {
        s.is_running = false;
        s.updated_at = now;
      });
    }

    const openPositions = db.data.positions.filter(
      (p) => p.user_id === userId && p.environment === environment && p.is_open
    );

    const results: Array<{ symbol: string; exchange: string; product: string; closed: boolean; reason?: string }> = [];
    let closedCount = 0;

    for (const position of openPositions) {
      const product = position.product || 'futures';
      const apiKeyRow = db.data.api_keys.find(
        (k) =>
          k.user_id === userId &&
          k.exchange === position.exchange &&
          k.product === product &&
          k.environment === environment &&
          k.is_active
      );

      if (!apiKeyRow) {
        results.push({
          symbol: position.symbol,
          exchange: position.exchange,
          product,
          closed: false,
          reason: 'API keys not found',
        });
        continue;
      }

      const apiKey = decryptValue(apiKeyRow.api_key_encrypted);
      const apiSecret = decryptValue(apiKeyRow.api_secret_encrypted);
      const isTestnet = environment === 'testnet';
      let closed = false;
      let closeReason = 'Unknown close error';
      let closeOrderId: string | null = null;

      if (position.exchange === 'binance' && product === 'futures') {
        const side = position.side === 'long' ? 'SELL' : 'BUY';
        const qty = String(Math.abs(Number(position.size || 0)));
        const closeResult = await callBinanceApi('/fapi/v1/order', apiKey, apiSecret, isTestnet, 'futures', 'POST', {
          symbol: position.symbol,
          side,
          type: 'MARKET',
          quantity: qty,
          reduceOnly: 'true',
        });
        if (closeResult.success) {
          const data = closeResult.data as { orderId?: number };
          closeOrderId = data.orderId ? String(data.orderId) : null;
          closed = true;
        } else {
          closeReason = closeResult.error || closeReason;
        }
      } else if (position.exchange === 'binance' && product === 'spot') {
        await cancelBinanceSpotSellOrders(apiKey, apiSecret, isTestnet, position.symbol);
        const accountResult = await callBinanceApi('/api/v3/account', apiKey, apiSecret, isTestnet, 'spot', 'GET');
        if (accountResult.success && accountResult.data) {
          type SpotAccount = { balances?: Array<{ asset: string; free: string }> };
          const accountData = accountResult.data as SpotAccount;
          const baseAsset = getBaseAssetFromSymbol(position.symbol);
          const free = parseFloat(accountData.balances?.find((b) => b.asset === baseAsset)?.free || '0');
          const qty = Math.min(free, Math.abs(Number(position.size || 0)));
          if (qty > 0) {
            const closeResult = await callBinanceApi('/api/v3/order', apiKey, apiSecret, isTestnet, 'spot', 'POST', {
              symbol: position.symbol,
              side: 'SELL',
              type: 'MARKET',
              quantity: qty.toString(),
            });
            if (closeResult.success) {
              const data = closeResult.data as { orderId?: number };
              closeOrderId = data.orderId ? String(data.orderId) : null;
              closed = true;
            } else {
              closeReason = closeResult.error || closeReason;
            }
          } else {
            closeReason = 'No available spot balance to close';
          }
        } else {
          closeReason = accountResult.error || closeReason;
        }
      } else if (position.exchange === 'bybit' && product === 'futures') {
        const side = position.side === 'long' ? 'Sell' : 'Buy';
        const closeResult = await callBybitApi('/v5/order/create', apiKey, apiSecret, isTestnet, 'POST', {
          category: 'linear',
          symbol: position.symbol,
          side,
          orderType: 'Market',
          qty: Math.abs(Number(position.size || 0)).toString(),
          reduceOnly: 'true',
        });
        if (closeResult.success) {
          const data = closeResult.data as { result?: { orderId?: string } };
          closeOrderId = data.result?.orderId || null;
          closed = true;
        } else {
          closeReason = closeResult.error || closeReason;
        }
      } else {
        closeReason = `Unsupported close flow for ${position.exchange} ${product}`;
      }

      if (closed) {
        position.is_open = false;
        position.updated_at = now;
        db.data.trades.push({
          id: crypto.randomUUID(),
          user_id: userId,
          exchange: position.exchange,
          product,
          environment,
          symbol: position.symbol,
          side: position.side === 'long' ? 'sell' : 'buy',
          order_type: 'market',
          price: Number(position.current_price || position.entry_price || 0),
          quantity: Number(position.size || 0),
          realized_pnl: Number(position.unrealized_pnl || 0),
          status: 'filled',
          order_id: closeOrderId,
          triggered_by: 'emergency_stop',
          created_at: now,
        });
        closedCount += 1;
        results.push({
          symbol: position.symbol,
          exchange: position.exchange,
          product,
          closed: true,
        });
      } else {
        results.push({
          symbol: position.symbol,
          exchange: position.exchange,
          product,
          closed: false,
          reason: closeReason,
        });
      }
    }

    await safeWrite();

    return res.json({
      success: true,
      environment,
      bot_stopped: true,
      total_open_positions: openPositions.length,
      positions_closed: closedCount,
      positions_failed: openPositions.length - closedCount,
      results,
    });
  } catch (error) {
    console.error('Emergency stop error:', error);
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

router.post('/approve_deposit', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { p_deposit_id, p_admin_id, p_notes } = req.body as {
      p_deposit_id?: string;
      p_admin_id?: string;
      p_notes?: string;
    };

    if (!p_deposit_id || !p_admin_id) {
      return res.status(400).json({ success: false, error: 'Missing deposit_id or admin_id' });
    }

    // Check if current user is admin
    await db.read();
    const currentUserRoles = db.data?.user_roles || [];
    const isAdmin = currentUserRoles.some((r) => r.user_id === req.user?.id && r.role === 'admin');
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: 'Only admins can approve deposits' });
    }

    // Find pending deposit
    const deposits = db.data?.pending_deposits || [];
    const deposit = deposits.find((d) => d.id === p_deposit_id && d.status === 'pending');
    if (!deposit) {
      return res.status(404).json({ success: false, error: 'Deposit not found or already processed' });
    }

    // Get current gas fee balance
    const balances = db.data?.gas_fee_balances || [];
    const existingBalance = balances.find(
      (b) => b.user_id === deposit.user_id && b.environment === deposit.environment
    );

    const balanceBefore = existingBalance?.balance || 0;
    const totalDepositedBefore = existingBalance?.total_deposited || 0;
    const balanceAfter = balanceBefore + deposit.amount;
    const totalDepositedAfter = totalDepositedBefore + deposit.amount;

    // Update or create gas fee balance
    if (existingBalance) {
      existingBalance.balance = balanceAfter;
      existingBalance.total_deposited = totalDepositedAfter;
      existingBalance.updated_at = new Date().toISOString();
    } else {
      db.data?.gas_fee_balances.push({
        id: crypto.randomUUID(),
        user_id: deposit.user_id,
        environment: deposit.environment,
        balance: balanceAfter,
        total_deposited: totalDepositedAfter,
        total_deducted: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    // Record transaction
    db.data?.gas_fee_transactions.push({
      id: crypto.randomUUID(),
      user_id: deposit.user_id,
      amount: deposit.amount,
      transaction_type: 'deposit',
      description: `Deposit approved by admin${p_notes ? ': ' + p_notes : ''}`,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      environment: deposit.environment,
      created_at: new Date().toISOString(),
    });

    // Update deposit status
    deposit.status = 'approved';
    deposit.admin_notes = p_notes || null;
    deposit.approved_by = p_admin_id;
    deposit.approved_at = new Date().toISOString();

    await safeWrite();

    return res.json({
      success: true,
      message: 'Deposit approved successfully',
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      amount: deposit.amount,
    });
  } catch (error) {
    console.error('Approve deposit error:', error);
    return res.status(500).json({ success: false, error: 'Internal error' });
  }
});

router.post('/reject_deposit', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { p_deposit_id, p_admin_id, p_notes } = req.body as {
      p_deposit_id?: string;
      p_admin_id?: string;
      p_notes?: string;
    };

    if (!p_deposit_id || !p_admin_id) {
      return res.status(400).json({ success: false, error: 'Missing deposit_id or admin_id' });
    }

    // Check if current user is admin
    await db.read();
    const currentUserRoles = db.data?.user_roles || [];
    const isAdmin = currentUserRoles.some((r) => r.user_id === req.user?.id && r.role === 'admin');
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: 'Only admins can reject deposits' });
    }

    // Find pending deposit
    const deposits = db.data?.pending_deposits || [];
    const deposit = deposits.find((d) => d.id === p_deposit_id && d.status === 'pending');
    if (!deposit) {
      return res.status(404).json({ success: false, error: 'Deposit not found or already processed' });
    }

    // Update deposit status
    deposit.status = 'rejected';
    deposit.admin_notes = p_notes || null;
    deposit.approved_by = p_admin_id;
    deposit.approved_at = new Date().toISOString();

    await safeWrite();

    return res.json({
      success: true,
      message: 'Deposit rejected',
      deposit_id: p_deposit_id,
    });
  } catch (error) {
    console.error('Reject deposit error:', error);
    return res.status(500).json({ success: false, error: 'Internal error' });
  }
});

export const rpcRouter = router;

