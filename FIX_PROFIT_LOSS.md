# Fix: Binance Live Futures Profit/Loss & Gas Fee Deduction

## সমস্যা (Problems)

1. **Realized PnL সঠিকভাবে calculate হচ্ছে না** - Position close হলে Binance API থেকে actual realized PnL fetch করা হচ্ছিল না
2. **Gas fee deduction কাজ করছিল না** - Profit sharing function properly call হচ্ছিল না
3. **Position monitor** - Position close detect করলেও realized PnL সঠিক ছিল না

## সমাধান (Solutions)

### 1. Realized PnL Calculation Fix

**Before:** `unrealizedPnl` use করা হচ্ছিল যখন position close হয়
**After:** Binance `/fapi/v1/userTrades` API থেকে actual `realizedPnl` fetch করা হচ্ছে

```typescript
// New function to get actual realized PnL from Binance
async function getRealizedPnlFromBinance(
  symbol: string,
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  since: number
): Promise<number>
```

### 2. Profit Sharing Fix

**Before:** 
- `processProfitSharing` call হচ্ছিল কিন্তু duplicate check ছিল না
- Logging ছিল না

**After:**
- Duplicate settlement check added
- Better logging
- Balance validation (negative balance prevention)

### 3. Position Monitor Improvements

**Changes:**
- Realized PnL properly fetched from Binance API
- Only process profit sharing if `realizedPnl > 0`
- Better error handling and logging
- Backfill process improved with logging

## Testing

### Test Steps:

1. **Create a position** via auto-signal or manual trade
2. **Wait for position to close** (via TP/SL or manual close)
3. **Check position monitor logs:**
   ```bash
   pm2 logs backend | grep "Position.*closed"
   ```

4. **Verify in database:**
   - `trades` table - `realized_pnl` should have value
   - `profit_settlements` table - should have entry if profit > 0
   - `gas_fee_balances` table - balance should be deducted
   - `gas_fee_transactions` table - transaction should be recorded

### Expected Behavior:

1. ✅ Position closes on Binance
2. ✅ Position monitor detects closure
3. ✅ Realized PnL fetched from Binance API
4. ✅ Trade recorded with correct `realized_pnl`
5. ✅ If profit > 0:
   - Profit settlement created
   - Gas fee balance deducted (30% of profit)
   - Gas fee transaction recorded
   - Referral commissions processed (if applicable)

## Cron Job Configuration

Position monitor runs every minute by default. To change:

```env
POSITION_MONITOR_CRON=*/1 * * * *  # Every minute (default)
```

Or in `backend/.env`:
```env
POSITION_MONITOR_CRON=*/5 * * * *  # Every 5 minutes
```

## Monitoring

### Check if position monitor is running:

```bash
pm2 logs backend | grep "position-monitor"
```

### Check profit settlements:

```bash
# In database or via API
GET /api/db/profit_settlements
```

### Check gas fee transactions:

```bash
# In database or via API  
GET /api/db/gas_fee_transactions
```

## Important Notes

1. **Only profitable trades** trigger gas fee deduction
2. **Losses** don't deduct gas fees (correct behavior)
3. **Realized PnL** is fetched from Binance API, not calculated locally
4. **Position monitor** must run regularly (via cron) to detect closed positions
5. **Duplicate settlements** are prevented

## Troubleshooting

### Gas fees not deducting?

1. Check if position monitor is running:
   ```bash
   pm2 logs backend | grep "Position monitor"
   ```

2. Check if trades have `realized_pnl > 0`:
   ```bash
   # Check database
   ```

3. Check logs for errors:
   ```bash
   pm2 logs backend --lines 100 | grep -i "profit\|gas\|fee"
   ```

### Realized PnL is 0?

1. Check Binance API response
2. Verify API keys have correct permissions
3. Check if position actually closed on exchange
4. Verify `userTrades` API is returning data

### Position not detected as closed?

1. Check position monitor cron is running
2. Verify API keys are active
3. Check exchange position status manually
4. Review position monitor logs

---

**Status:** ✅ Fixed - Profit/Loss calculation and gas fee deduction should now work correctly for Binance live futures.

