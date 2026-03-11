# Signal Generation Issue - এক ঘণ্টা পরেও Signal Generate হচ্ছে না

## 🔍 মূল সমস্যা:

### Current Status:
- ✅ Strategy active এবং auto-signal enabled
- ✅ Bot running (mainnet)
- ✅ API keys configured
- ✅ Gas balance: 20 USDT (sufficient)
- ✅ Last signal: 2026-02-05 (interval pass করেছে)

### ❌ সম্ভাব্য কারণ:

#### 1. **Confidence Threshold খুব বেশি**
- Code-এ default: `MIN_SIGNAL_CONFIDENCE = 0.8` (80%)
- Strategy config-এ `min_confidence` নেই, তাই default 0.8 use হচ্ছে
- Signal analysis থেকে আসা confidence < 80% হলে signal reject হবে
- **Solution**: Strategy config-এ `min_confidence: 0.6` বা 0.7 add করুন

#### 2. **Gemini API Reject করছে**
- Gemini filter সব signal reject করতে পারে
- Gemini API key missing বা invalid হতে পারে
- **Solution**: Gemini API key verify করুন

#### 3. **Cron Job চালু নেই**
- Backend server running আছে কিনা
- `CRON_ENABLED=false` set করা আছে কিনা
- **Solution**: Backend logs check করুন

#### 4. **Signal Analysis কোনো Signal Generate করছে না**
- Market conditions signal generate করার মতো না
- `signal.action === 'none'` হচ্ছে
- **Solution**: Manual test করুন

#### 5. **Trading Session Outside**
- Strategy config-এ `session_start`/`session_end` set করা থাকলে
- Current time session-এর বাইরে হলে signal generate হবে না

## 🛠️ Quick Fixes:

### Fix 1: Strategy Config-এ min_confidence কমিয়ে দিন

`backend/data/db.json`-এ strategy config update করুন:

```json
{
  "strategy_config": {
    "htf_timeframe": "1h",
    "ltf_timeframe": "5m",
    "ema_fast": 9,
    "ema_slow": 21,
    "rsi_period": 14,
    "rsi_overbought": 70,
    "rsi_oversold": 30,
    "volume_multiplier": 1.2,
    "trade_interval_minutes": 144,
    "min_signal_strength": 0.6,
    "min_confidence": 0.6  // ← এই line add করুন
  }
}
```

### Fix 2: last_signal_at Reset করুন

```json
{
  "last_signal_at": null  // ← null করুন
}
```

### Fix 3: Backend Logs Check করুন

Railway/VPS-এ backend logs দেখুন:
```bash
# এই messages খুঁজুন:
- "⏳ Strategy ...: Waiting ..."
- "❌ ...: Engine confidence ..."
- "🤖 ...: Gemini decision ..."
- "Bot is not running ..."
- "Insufficient gas balance ..."
- "No API keys found ..."
```

### Fix 4: Manual Test করুন

Backend API-তে manual request করুন:
```bash
POST /api/auto-signal-generator
Content-Type: application/json

{"source": "manual_test"}
```

## 📊 Expected Behavior:

### যদি সব ঠিক থাকে:
```
[cron] /api/auto-signal-generator executed
✅ BTCUSDT: Signal approved for execution - action: buy, price: 65000, confidence: 85.0%
```

### যদি signal generate না হয়:
```
⏳ Strategy Daily Profit: Waiting 30s before next signal (interval: 1min)
❌ BTCUSDT: Engine confidence 75.0% < threshold 80.0%
🤖 BTCUSDT: Gemini REJECTED - signal looks weak
```

## 🔧 Code References:

1. **Confidence Check**: `backend/src/routes/autoSignalGenerator.ts:501-505`
2. **Gemini Filter**: `backend/src/routes/autoSignalGenerator.ts:217-282`
3. **Cron Schedule**: `backend/src/cron.ts:35-39`
4. **Signal Analysis**: `backend/src/lib/signalAnalysis.ts`

## ✅ Verification Steps:

1. ✅ Strategy `is_active: true`
2. ✅ `auto_signal_enabled: true`
3. ✅ Bot `is_running: true`
4. ✅ API keys configured
5. ✅ Gas balance > 0
6. ✅ `last_signal_at` interval pass করেছে
7. ⚠️ **`min_confidence` threshold check করুন**
8. ⚠️ **Gemini API key verify করুন**
9. ⚠️ **Backend logs check করুন**

