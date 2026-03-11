# Fix: Stale Positions Without API Keys

## Problem
Position monitor was showing "Monitoring 12 open positions" even though there were no actual open positions. This happened because:

1. **Database had positions marked as `is_open = true`** but they were actually closed on the exchange
2. **No API keys** for those positions, so the monitor couldn't verify with the exchange
3. **Monitor skipped positions without API keys** using `continue`, leaving them in the database as open

## Solution

### Changes Made

1. **Stale Position Cleanup**: When API keys are missing, the monitor now:
   - Checks the age of positions without API keys
   - Closes positions older than **7 days** (likely already closed on exchange)
   - Logs which positions are being closed

2. **Better Logging**:
   - Shows total positions found in database
   - Shows how many can be monitored (with API keys)
   - Shows how many cannot be verified (without API keys)
   - Logs when stale positions are closed

3. **Accurate Counting**:
   - Only counts positions we can actually monitor
   - Separates positions with and without API keys
   - Provides summary of what was processed

### Code Changes

**File:** `backend/src/routes/positionMonitor.ts`

- Added stale position cleanup for positions without API keys (>7 days old)
- Improved logging to show:
  - Total positions in database
  - Positions with API keys (monitorable)
  - Positions without API keys (cannot verify)
  - Stale positions closed

### How It Works Now

1. **Get all open positions** from database
2. **Group by user/exchange/environment**
3. **For each group**:
   - If API keys exist: Monitor positions with exchange API
   - If no API keys: Check if positions are stale (>7 days) and close them
4. **Log summary** showing what was processed

### Example Log Output

```
Position monitor started...
Found 12 open positions in database. Checking which can be monitored...
⚠️  No API keys found for e70b4418-6af6-4930-8e3a-6e772836c44e-binance-testnet (5 positions) - checking for stale positions...
Closing stale position BTCUSDT (15 days old, no API keys)
Closing stale position ETHUSDT (10 days old, no API keys)
✓ Monitoring 7 positions for user123-binance-testnet...
Position monitor completed: 2 positions closed
Note: 5 positions cannot be verified (no API keys). Stale positions (>7 days) have been closed.
```

## Result

- ✅ Stale positions without API keys are automatically closed
- ✅ Accurate count of positions being monitored
- ✅ Clear logging of what's happening
- ✅ No more false "open positions" in the database

## Next Steps

If you still see positions without API keys that are less than 7 days old:
1. Add API keys for those positions, OR
2. Manually close them in the database, OR
3. Wait 7 days for automatic cleanup

