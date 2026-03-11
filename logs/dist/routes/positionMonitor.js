import { Router } from 'express';
import crypto from 'node:crypto';
import { db, safeWrite } from '../db/index.js';
import { createHmac } from 'node:crypto';
const router = Router();
const SERVICE_FEE_RATE = 0.3;
const REFERRAL_RATES = [0.005, 0.003, 0.002];
const decryptValue = (encrypted) => {
    try {
        const decoded = Buffer.from(encrypted, 'base64').toString('utf-8');
        return decoded || encrypted;
    }
    catch {
        return encrypted;
    }
};
const createBinanceSignature = (queryString, secret) => {
    const hmac = createHmac('sha256', secret);
    hmac.update(queryString);
    return hmac.digest('hex');
};
const callBinanceApi = async (endpoint, apiKey, apiSecret, isTestnet, product, method = 'GET', params = {}) => {
    const baseUrl = product === 'futures'
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
            return { success: false, error: data.msg || 'Binance API error' };
        }
        return { success: true, data };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
};
const createBybitSignature = (timestamp, apiKey, recvWindow, payload, secret) => {
    const signStr = timestamp + apiKey + recvWindow + payload;
    const hmac = createHmac('sha256', secret);
    hmac.update(signStr);
    return hmac.digest('hex');
};
const callBybitApi = async (endpoint, apiKey, apiSecret, isTestnet, method = 'GET', params = {}) => {
    const baseUrl = isTestnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    const timestamp = Date.now().toString();
    const recvWindow = '5000';
    let url = `${baseUrl}${endpoint}`;
    let body = '';
    if (method === 'GET') {
        const queryString = new URLSearchParams(params).toString();
        if (queryString)
            url += '?' + queryString;
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
            const data = await response.json();
            if (data.retCode !== 0) {
                return { success: false, error: data.retMsg || 'Bybit API error' };
            }
            return { success: true, data };
        }
        catch (error) {
            return { success: false, error: error instanceof Error ? error.message : 'Network error' };
        }
    }
    else {
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
            const data = await response.json();
            if (data.retCode !== 0) {
                return { success: false, error: data.retMsg || 'Bybit API error' };
            }
            return { success: true, data };
        }
        catch (error) {
            return { success: false, error: error instanceof Error ? error.message : 'Network error' };
        }
    }
};
const getBaseAssetFromSymbol = (symbol) => {
    const quoteAssets = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'BTC', 'ETH'];
    const quote = quoteAssets.find((asset) => symbol.endsWith(asset));
    if (!quote)
        return symbol;
    return symbol.slice(0, symbol.length - quote.length);
};
async function getRealizedPnlFromBinance(symbol, apiKey, apiSecret, isTestnet, since) {
    try {
        // Get user trades to calculate realized PnL
        const tradesResult = await callBinanceApi('/fapi/v1/userTrades', apiKey, apiSecret, isTestnet, 'futures', 'GET', {
            symbol,
            startTime: since.toString(),
            limit: '100',
        });
        if (tradesResult.success && Array.isArray(tradesResult.data)) {
            const trades = tradesResult.data;
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
    }
    catch (error) {
        console.error(`Error fetching realized PnL for ${symbol}:`, error);
    }
    return 0;
}
async function checkExchangePosition(symbol, exchange, product, isTestnet, apiKey, apiSecret, dbPosition) {
    if (exchange === 'binance' && product === 'futures') {
        const result = await callBinanceApi('/fapi/v2/positionRisk', apiKey, apiSecret, isTestnet, product, 'GET', { symbol });
        if (result.success && Array.isArray(result.data)) {
            const positions = result.data;
            const position = positions.find(p => p.symbol === symbol);
            if (position) {
                const size = parseFloat(position.positionAmt);
                const isOpen = size !== 0;
                // If position was open in DB but now closed on exchange, get realized PnL
                let realizedPnl;
                if (dbPosition?.is_open && !isOpen) {
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
    }
    else if (exchange === 'binance' && product === 'spot') {
        const accountResult = await callBinanceApi('/api/v3/account', apiKey, apiSecret, isTestnet, product, 'GET');
        if (accountResult.success && accountResult.data) {
            const accountData = accountResult.data;
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
                        const tickerData = await tickerRes.json();
                        currentPrice = parseFloat(tickerData.price || '0') || 0;
                    }
                }
                catch {
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
    }
    else if (exchange === 'bybit') {
        const result = await callBybitApi('/v5/position/list', apiKey, apiSecret, isTestnet, 'GET', {
            category: 'linear',
            symbol
        });
        if (result.success && result.data) {
            const data = result.data;
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
const getReferralChain = (userId) => {
    const chain = [];
    if (!db.data)
        return chain;
    let currentProfile = db.data.profiles.find((p) => p.user_id === userId);
    let level = 1;
    while (currentProfile?.referrer_id && level <= 3) {
        const referrerProfile = db.data.profiles.find((p) => p.id === currentProfile?.referrer_id);
        if (!referrerProfile)
            break;
        chain.push({ level, referrerProfile });
        currentProfile = referrerProfile;
        level += 1;
    }
    return chain;
};
const getOrCreateGasBalance = (userId, environment) => {
    const now = new Date().toISOString();
    const existing = (db.data?.gas_fee_balances || []).find((b) => b.user_id === userId && b.environment === environment);
    if (existing)
        return existing;
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
    db.data?.gas_fee_balances.push(created);
    return created;
};
const processProfitSharing = (userId, tradeId, grossProfit, environment) => {
    if (!db.data || grossProfit <= 0) {
        console.log(`Skipping profit sharing - grossProfit: ${grossProfit}, userId: ${userId}, tradeId: ${tradeId}`);
        return;
    }
    const now = new Date().toISOString();
    const serviceFee = grossProfit * SERVICE_FEE_RATE;
    const netProfit = grossProfit - serviceFee;
    console.log(`Processing profit sharing - User: ${userId}, Trade: ${tradeId}, Gross: ${grossProfit}, Fee: ${serviceFee}, Net: ${netProfit}`);
    // Check if already processed
    const existingSettlement = db.data.profit_settlements.find(s => s.trade_id === tradeId);
    if (existingSettlement) {
        console.log(`Trade ${tradeId} already has profit settlement, skipping`);
        return;
    }
    db.data.profit_settlements.push({
        id: crypto.randomUUID(),
        user_id: userId,
        trade_id: tradeId,
        gross_profit: grossProfit,
        service_fee_rate: SERVICE_FEE_RATE,
        service_fee_amount: serviceFee,
        net_profit: netProfit,
        created_at: now,
    });
    const userBalance = getOrCreateGasBalance(userId, environment);
    const balanceBefore = userBalance.balance;
    userBalance.balance = Math.max(0, balanceBefore - serviceFee); // Ensure balance doesn't go negative
    userBalance.total_deducted = (userBalance.total_deducted || 0) + serviceFee;
    userBalance.updated_at = now;
    console.log(`Gas fee balance updated - User: ${userId}, Environment: ${environment}, Before: ${balanceBefore}, After: ${userBalance.balance}, Deducted: ${serviceFee}`);
    db.data.gas_fee_transactions.push({
        id: crypto.randomUUID(),
        user_id: userId,
        amount: -serviceFee,
        transaction_type: 'service_fee',
        description: `Service fee for profitable trade (${environment})`,
        trade_id: tradeId,
        balance_before: balanceBefore,
        balance_after: userBalance.balance,
        environment,
        created_at: now,
    });
    let totalReferralPaid = 0;
    const referralChain = getReferralChain(userId);
    for (const entry of referralChain) {
        const rate = REFERRAL_RATES[entry.level - 1] || 0;
        const commission = grossProfit * rate;
        if (commission <= 0)
            continue;
        const beneficiaryUserId = entry.referrerProfile.user_id;
        db.data.referral_commissions.push({
            id: crypto.randomUUID(),
            beneficiary_user_id: beneficiaryUserId,
            source_user_id: userId,
            trade_id: tradeId,
            level: entry.level,
            gross_profit: grossProfit,
            commission_rate: rate,
            commission_amount: commission,
            status: 'paid',
            created_at: now,
            paid_at: now,
        });
        const beneficiaryBalance = getOrCreateGasBalance(beneficiaryUserId, environment);
        const beneficiaryBefore = beneficiaryBalance.balance;
        beneficiaryBalance.balance = beneficiaryBefore + commission;
        beneficiaryBalance.total_deposited = (beneficiaryBalance.total_deposited || 0) + commission;
        beneficiaryBalance.updated_at = now;
        db.data.gas_fee_transactions.push({
            id: crypto.randomUUID(),
            user_id: beneficiaryUserId,
            amount: commission,
            transaction_type: 'referral_commission',
            description: `Referral commission (level ${entry.level})`,
            trade_id: tradeId,
            balance_before: beneficiaryBefore,
            balance_after: beneficiaryBalance.balance,
            environment,
            created_at: now,
        });
        totalReferralPaid += commission;
    }
    const adminShare = serviceFee - totalReferralPaid;
    db.data.admin_earnings.push({
        id: crypto.randomUUID(),
        source_user_id: userId,
        trade_id: tradeId,
        gross_profit: grossProfit,
        total_service_fee: serviceFee,
        referral_commissions_paid: totalReferralPaid,
        admin_share: adminShare,
        created_at: now,
    });
};
router.post('/', async (_req, res) => {
    try {
        await db.read();
        if (!db.data) {
            return res.status(500).json({ error: 'Database not initialized' });
        }
        // Ensure required tables exist
        db.data.trades ||= [];
        db.data.positions ||= [];
        db.data.gas_fee_balances ||= [];
        db.data.gas_fee_transactions ||= [];
        db.data.profit_settlements ||= [];
        db.data.referral_commissions ||= [];
        db.data.admin_earnings ||= [];
        db.data.profiles ||= [];
        console.log('Position monitor started...');
        // Backfill profit settlements for closed trades with realized PnL
        if (db.data) {
            db.data.profit_settlements ||= [];
            const settledTradeIds = new Set(db.data.profit_settlements
                .map((s) => s.trade_id)
                .filter((id) => typeof id === 'string' && id.length > 0));
            // Process profitable trades that haven't been settled yet
            const profitableTrades = (db.data.trades || []).filter((t) => (t.realized_pnl ?? 0) > 0 && t.status === 'filled');
            console.log(`Found ${profitableTrades.length} profitable trades, ${settledTradeIds.size} already settled`);
            for (const trade of profitableTrades) {
                if (settledTradeIds.has(trade.id)) {
                    console.log(`Trade ${trade.id} already settled, skipping`);
                    continue;
                }
                const grossProfit = Number(trade.realized_pnl || 0);
                const environment = trade.environment || 'testnet';
                console.log(`Processing profit sharing for trade ${trade.id} - User: ${trade.user_id}, Profit: ${grossProfit}, Environment: ${environment}`);
                processProfitSharing(trade.user_id, trade.id, grossProfit, environment);
                settledTradeIds.add(trade.id);
            }
            if (profitableTrades.length > settledTradeIds.size) {
                console.log(`Processed ${profitableTrades.length - settledTradeIds.size} new profit settlements`);
            }
        }
        // Get all open positions from database
        const allOpenPositions = (db.data?.positions || []).filter(p => p.is_open);
        if (allOpenPositions.length === 0) {
            return res.json({ message: 'No open positions to monitor' });
        }
        console.log(`Found ${allOpenPositions.length} open positions in database. Checking which can be monitored...`);
        // Group positions by user and exchange for efficient API calls
        const userPositions = new Map();
        for (const pos of allOpenPositions) {
            const product = pos.product || 'futures';
            const key = `${pos.user_id}-${pos.exchange}-${pos.environment}-${product}`;
            if (!userPositions.has(key)) {
                userPositions.set(key, []);
            }
            userPositions.get(key).push(pos);
        }
        const results = [];
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
            const apiKeys = (db.data?.api_keys || []).find((k) => k.user_id === userId &&
                k.exchange === exchange &&
                k.product === product &&
                k.environment === environment &&
                k.is_active);
            if (!apiKeys) {
                console.log(`⚠️  No API keys found for ${key} (${userPosGroup.length} positions) - checking for stale positions...`);
                // Handle positions without API keys - close very old ones
                for (const position of userPosGroup) {
                    const positionAge = new Date().getTime() - new Date(position.created_at || position.updated_at || Date.now()).getTime();
                    // If position is older than threshold, mark as closed (likely already closed on exchange)
                    if (positionAge > stalePositionThreshold) {
                        console.log(`Closing stale position ${position.symbol} (${Math.round(positionAge / (24 * 60 * 60 * 1000))} days old, no API keys)`);
                        const posIndex = db.data?.positions.findIndex(p => p.id === position.id);
                        if (posIndex !== undefined && posIndex >= 0 && db.data) {
                            db.data.positions[posIndex].is_open = false;
                            db.data.positions[posIndex].updated_at = new Date().toISOString();
                            results.push({
                                position_id: position.id,
                                symbol: position.symbol,
                                status: 'closed',
                                trigger: 'stale_cleanup',
                                realized_pnl: position.unrealized_pnl || 0,
                            });
                        }
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
                    const exchangePos = await checkExchangePosition(position.symbol, exchange, product, isTestnet, apiKey, apiSecret, position);
                    // Update current price in database
                    if (exchangePos.currentPrice > 0) {
                        const posIndex = db.data?.positions.findIndex(p => p.id === position.id);
                        if (posIndex !== undefined && posIndex >= 0 && db.data) {
                            db.data.positions[posIndex].current_price = exchangePos.currentPrice;
                            db.data.positions[posIndex].unrealized_pnl = exchangePos.unrealizedPnl;
                            db.data.positions[posIndex].updated_at = new Date().toISOString();
                        }
                    }
                    // If position is closed on exchange but open in DB
                    if (!exchangePos.isOpen && position.is_open) {
                        console.log(`Position ${position.symbol} closed on exchange, updating DB...`);
                        const posIndex = db.data?.positions.findIndex(p => p.id === position.id);
                        if (posIndex !== undefined && posIndex >= 0 && db.data) {
                            db.data.positions[posIndex].is_open = false;
                            db.data.positions[posIndex].unrealized_pnl = 0; // Position closed, no unrealized PnL
                            db.data.positions[posIndex].updated_at = new Date().toISOString();
                            // Use realized PnL from API if available, otherwise use unrealized as fallback
                            const realizedPnl = exchangePos.realizedPnl !== undefined
                                ? exchangePos.realizedPnl
                                : exchangePos.unrealizedPnl;
                            console.log(`Position ${position.symbol} closed - Realized PnL: ${realizedPnl}`);
                            // Record trade with actual realized PnL
                            const tradeId = crypto.randomUUID();
                            db.data.trades.push({
                                id: tradeId,
                                user_id: position.user_id,
                                exchange: position.exchange,
                                product: position.product || 'futures',
                                environment: position.environment,
                                symbol: position.symbol,
                                side: position.side === 'long' ? 'sell' : 'buy',
                                order_type: 'market',
                                price: exchangePos.currentPrice || position.entry_price,
                                quantity: position.size,
                                realized_pnl: realizedPnl,
                                status: 'filled',
                                order_id: null,
                                triggered_by: 'position_monitor',
                                created_at: new Date().toISOString(),
                            });
                            // Only process profit sharing if there's actual profit (realized PnL > 0)
                            if (realizedPnl > 0) {
                                console.log(`Processing profit sharing for trade ${tradeId} - Gross Profit: ${realizedPnl}`);
                                processProfitSharing(position.user_id, tradeId, realizedPnl, position.environment);
                            }
                            else {
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
                    }
                }
                catch (error) {
                    console.error(`Error monitoring position ${position.id}:`, error);
                }
            }
        }
        await safeWrite();
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
    }
    catch (error) {
        console.error('Position monitor error:', error);
        return res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
});
export const positionMonitorRouter = router;
