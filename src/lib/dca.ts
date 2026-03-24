// DCA (Dollar Cost Averaging) Helper Functions
import { pool } from '../db/postgres.js';

interface DCAEntry {
  id: string;
  strategy_id: string;
  user_id: string;
  symbol: string;
  level: number;
  entry_price: number;
  target_price: number;
  position_size: number;
  executed: boolean;
}

interface StrategyConfig {
  id: string;
  user_id: string;
  dca_enabled?: boolean;
  dca_max_levels?: number;
  dca_price_drop_percent?: number;
  dca_position_multiplier?: number;
  dca_total_capital_percent?: number;
  exchange: string;
  product: string;
  environment: string;
  position_size_value?: number;
  position_size_type?: 'fixed' | 'percentage';
  [key: string]: any;
}

/**
 * Setup DCA levels after initial position is opened
 */
export const setupDCALevels = async (
  config: StrategyConfig,
  symbol: string,
  initialPrice: number,
  initialQty: number
): Promise<void> => {
  const dcaLevels = config.dca_max_levels || 3;
  const priceDropPercent = config.dca_price_drop_percent || 2.0;
  const multiplier = config.dca_position_multiplier || 1.5;

  console.log(`📊 Setting up ${dcaLevels} DCA levels for ${symbol}`);
  console.log(`   Initial: ${initialQty} @ $${initialPrice}`);

  for (let level = 1; level <= dcaLevels; level++) {
    const targetPrice = initialPrice * (1 - (priceDropPercent * level) / 100);
    const positionSize = initialQty * Math.pow(multiplier, level - 1);

    const dcaId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO dca_entries (
        id, strategy_id, user_id, symbol, level, 
        entry_price, target_price, position_size, 
        executed, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9)`,
      [
        dcaId,
        config.id,
        config.user_id,
        symbol,
        level,
        initialPrice,
        targetPrice,
        positionSize,
        new Date().toISOString()
      ]
    );

    console.log(`   📍 Level ${level}: Buy ${positionSize.toFixed(6)} @ $${targetPrice.toFixed(2)}`);
  }

  console.log(`✅ DCA setup complete for ${symbol}`);
};

/**
 * Check and execute pending DCA orders
 */
export const checkAndExecuteDCA = async (
  strategyId: string,
  symbol: string,
  currentPrice: number,
  apiKey: string,
  apiSecret: string,
  exchange: string,
  product: string,
  isTestnet: boolean
): Promise<{ executed: number; errors: string[] }> => {
  const executedCount = 0;
  const errors: string[] = [];

  try {
    // Get pending DCA orders where current price <= target price
    const result = await pool.query<DCAEntry>(
      `SELECT * FROM dca_entries 
       WHERE strategy_id = $1 
         AND symbol = $2 
         AND executed = false 
         AND target_price >= $3
       ORDER BY level ASC`,
      [strategyId, symbol, currentPrice]
    );

    if (result.rows.length === 0) {
      return { executed: 0, errors: [] };
    }

    console.log(`🔍 Found ${result.rows.length} pending DCA order(s) for ${symbol}`);

    for (const dcaOrder of result.rows) {
      console.log(`📊 Executing DCA Level ${dcaOrder.level}: ${dcaOrder.position_size} @ $${dcaOrder.target_price}`);

      try {
        // Execute buy order on exchange
        const executionResult = await executeDCABuyOrder(
          dcaOrder,
          currentPrice,
          apiKey,
          apiSecret,
          exchange,
          product,
          isTestnet
        );

        if (executionResult.success) {
          // Update DCA entry in database
          await pool.query(
            `UPDATE dca_entries 
             SET executed = true, 
                 executed_at = NOW(),
                 order_id = $1,
                 average_price = $2,
                 total_quantity = $3
             WHERE id = $4`,
            [
              executionResult.orderId,
              executionResult.averagePrice,
              executionResult.totalQuantity,
              dcaOrder.id
            ]
          );

          console.log(`✅ DCA Level ${dcaOrder.level} executed successfully!`);
          console.log(`   Order ID: ${executionResult.orderId}`);
          console.log(`   Avg Price: $${executionResult.averagePrice}`);
          console.log(`   Total Qty: ${executionResult.totalQuantity}`);
        } else {
          errors.push(`Level ${dcaOrder.level}: ${executionResult.error}`);
          console.log(`❌ DCA Level ${dcaOrder.level} failed: ${executionResult.error}`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        errors.push(`Level ${dcaOrder.level}: ${errorMsg}`);
        console.log(`❌ DCA Level ${dcaOrder.level} error: ${errorMsg}`);
      }
    }

    return { executed: result.rows.length - errors.length, errors };
  } catch (error) {
    console.error('Error checking DCA orders:', error);
    return { executed: 0, errors: [error instanceof Error ? error.message : 'Unknown error'] };
  }
};

/**
 * Execute a single DCA buy order
 */
const executeDCABuyOrder = async (
  dcaOrder: DCAEntry,
  currentPrice: number,
  apiKey: string,
  apiSecret: string,
  exchange: string,
  product: string,
  isTestnet: boolean
): Promise<{ success: boolean; orderId?: string; averagePrice?: number; totalQuantity?: number; error?: string }> => {
  try {
    const { callBinanceApi } = await import('./exchangeApi.js');
    
    // Call Binance API directly for Futures
    if (exchange === 'binance' && product === 'futures') {
      // Place market buy order
      const orderResult = await callBinanceApi(
        '/fapi/v1/order',
        apiKey,
        apiSecret,
        isTestnet,
        product,
        'POST',
        {
          symbol: dcaOrder.symbol,
          side: 'BUY',
          type: 'MARKET',
          quantity: dcaOrder.position_size.toFixed(3),
        }
      );

      if (!orderResult.success) {
        return {
          success: false,
          error: orderResult.error || 'Failed to execute DCA order'
        };
      }

      const orderData = orderResult.data as { 
        orderId: number; 
        avgPrice?: string; 
        executedQty?: string;
      };

      // Get updated average price from all positions
      const positionsResult = await pool.query(
        `SELECT AVG(entry_price) as avg_price, SUM(size) as total_qty
         FROM positions 
         WHERE user_id = $1 
           AND symbol = $2 
           AND is_open = true`,
        [dcaOrder.user_id, dcaOrder.symbol]
      );

      const avgPrice = parseFloat(positionsResult.rows[0].avg_price || currentPrice.toString());
      const totalQty = parseFloat(positionsResult.rows[0].total_qty || dcaOrder.position_size.toString());

      return {
        success: true,
        orderId: orderData.orderId.toString(),
        averagePrice: avgPrice,
        totalQuantity: totalQty
      };

    } else if (exchange === 'binance' && product === 'spot') {
      // Spot market order
      const orderResult = await callBinanceApi(
        '/api/v3/order',
        apiKey,
        apiSecret,
        isTestnet,
        product,
        'POST',
        {
          symbol: dcaOrder.symbol,
          side: 'BUY',
          type: 'MARKET',
          quantity: dcaOrder.position_size.toFixed(3),
        }
      );

      if (!orderResult.success) {
        return {
          success: false,
          error: orderResult.error || 'Failed to execute DCA spot order'
        };
      }

      const orderData = orderResult.data as { 
        orderId: number;
        cummulativeQuoteQty?: string;
        executedQty?: string;
      };

      const execQty = parseFloat(orderData.executedQty || dcaOrder.position_size.toString());
      const quoteQty = parseFloat(orderData.cummulativeQuoteQty || '0');
      const avgPrice = quoteQty > 0 ? quoteQty / execQty : currentPrice;

      return {
        success: true,
        orderId: orderData.orderId.toString(),
        averagePrice: avgPrice,
        totalQuantity: execQty
      };
    }

    return {
      success: false,
      error: 'Unsupported exchange/product combination'
    };

  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
};

/**
 * Get DCA entries for a strategy
 */
export const getDCAEntries = async (
  strategyId: string,
  options?: { executed?: boolean; symbol?: string }
): Promise<DCAEntry[]> => {
  let query = `SELECT * FROM dca_entries WHERE strategy_id = $1`;
  const params: any[] = [strategyId];
  let paramCount = 1;

  if (options?.executed !== undefined) {
    paramCount++;
    query += ` AND executed = $${paramCount}`;
    params.push(options.executed);
  }

  if (options?.symbol) {
    paramCount++;
    query += ` AND symbol = $${paramCount}`;
    params.push(options.symbol);
  }

  query += ' ORDER BY level ASC';

  const result = await pool.query<DCAEntry>(query, params);
  return result.rows;
};

/**
 * Cancel all pending DCA orders for a strategy
 */
export const cancelPendingDCAOrders = async (strategyId: string): Promise<void> => {
  await pool.query(
    `UPDATE dca_entries 
     SET executed = true 
     WHERE strategy_id = $1 AND executed = false`,
    [strategyId]
  );

  console.log(`✅ Cancelled all pending DCA orders for strategy ${strategyId}`);
};

/**
 * Get DCA statistics for a user
 */
export const getDCAStats = async (userId: string) => {
  const stats = await pool.query(
    `SELECT 
       COUNT(*) as total_entries,
       COUNT(*) FILTER (WHERE executed = true) as executed_entries,
       COUNT(*) FILTER (WHERE executed = false) as pending_entries,
       SUM(position_size) FILTER (WHERE executed = true) as total_deployed,
       AVG(average_price) FILTER (WHERE executed = true) as avg_entry_price
     FROM dca_entries 
     WHERE user_id = $1`,
    [userId]
  );

  return stats.rows[0];
};
