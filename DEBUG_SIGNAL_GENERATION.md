# Debug: Binance Live Futures Signal Generation

## সমস্যা (Problem)
Binance live futures-এ signal generate হচ্ছে না এবং trade execute হচ্ছে না।

## সম্ভাব্য কারণ (Possible Causes)

### 1. Bot Status Not Running
- Bot status `is_running` must be `true`
- Check: `bot_status` table in database

### 2. Gas Fee Balance Zero
- Gas fee balance must be > 0 for the environment (mainnet/testnet)
- Check: `gas_fee_balances` table

### 3. API Keys Missing or Inactive
- API keys must exist for: user_id, exchange='binance', product='futures', environment='mainnet', is_active=true
- Check: `api_keys` table

### 4. Strategy Not Active
- Strategy must have: `is_active=true`, `auto_signal_enabled=true`, `signal_mode='auto'`
- Check: `trading_strategies` table

### 5. Signal Interval
- Must wait for `auto_signal_interval` minutes between signals
- Check: `last_signal_at` field

### 6. Max Positions Reached
- Cannot open more than `max_positions` positions
- Check: Count of open positions

### 7. Signal Confidence Too Low
- Signal confidence must be >= `min_confidence` (default: 0.8)
- Gemini filter might reject signals

## Debug Steps

### Step 1: Check Logs
```bash
pm2 logs backend | grep -i "signal\|strategy\|bot\|gas"
```

### Step 2: Check Database

#### Check Strategies:
```javascript
// In database or via API
GET /api/db/trading_strategies
// Filter: is_active=true, auto_signal_enabled=true, signal_mode='auto'
```

#### Check Bot Status:
```javascript
GET /api/db/bot_status
// Filter: user_id=YOUR_USER_ID, environment='mainnet', is_running=true
```

#### Check Gas Fee Balance:
```javascript
GET /api/db/gas_fee_balances
// Filter: user_id=YOUR_USER_ID, environment='mainnet', balance > 0
```

#### Check API Keys:
```javascript
GET /api/db/api_keys
// Filter: user_id=YOUR_USER_ID, exchange='binance', product='futures', environment='mainnet', is_active=true
```

### Step 3: Manual Test

Call auto-signal generator manually:
```bash
curl -X POST http://localhost:8080/api/auto-signal-generator
```

Check response and logs for detailed information.

### Step 4: Check Cron Job

Verify cron is running:
```bash
pm2 logs backend | grep "cron"
```

Should see:
```
[cron] jobs scheduled | auto-signal: "* * * * *" | position-monitor: "* * * * *"
[cron] /api/auto-signal-generator executed
```

## Enhanced Logging

Now the code includes detailed logging for:
- ✅ Strategy filtering
- ✅ API key checks
- ✅ Bot status checks
- ✅ Gas fee balance checks
- ✅ Signal analysis results
- ✅ Trade execution attempts

## Common Fixes

### Fix 1: Enable Bot
```javascript
// Via API or database
POST /api/rpc/set_bot_status
{
  "user_id": "YOUR_USER_ID",
  "environment": "mainnet",
  "is_running": true
}
```

### Fix 2: Add Gas Fee Balance
```javascript
// Via admin panel or API
POST /api/rpc/add_gas_fee
{
  "user_id": "YOUR_USER_ID",
  "environment": "mainnet",
  "amount": 100
}
```

### Fix 3: Verify API Keys
- Ensure API keys are saved correctly
- Check `is_active=true`
- Verify `environment='mainnet'` (not 'testnet')
- Verify `exchange='binance'` and `product='futures'`

### Fix 4: Check Strategy Settings
- `is_active=true`
- `auto_signal_enabled=true`
- `signal_mode='auto'` or undefined
- `allowed_pairs` contains valid pairs (e.g., ['BTCUSDT', 'ETHUSDT'])
- `auto_signal_indicators` is configured

## Testing Checklist

- [ ] Bot status is running for mainnet
- [ ] Gas fee balance > 0 for mainnet
- [ ] API keys exist and are active for binance/futures/mainnet
- [ ] Strategy is active and auto-signal enabled
- [ ] Signal interval has passed (if `last_signal_at` exists)
- [ ] Max positions not reached
- [ ] Signal confidence >= min_confidence
- [ ] Gemini API key configured (if using Gemini filter)
- [ ] Cron job is running
- [ ] Auto-signal generator endpoint is accessible

## Next Steps

1. Check logs with enhanced logging
2. Verify all requirements above
3. Test manually by calling the endpoint
4. Check database values
5. Review error messages in logs

---

**Note:** Enhanced logging has been added to help diagnose the issue. Check `pm2 logs backend` for detailed information about why signals are not being generated.
