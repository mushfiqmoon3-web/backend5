# Fix: Spot Trading Balance Check for Both BUY and SELL Orders

## Problem
Spot trading-এ balance check শুধু SELL order-এর জন্য ছিল, BUY order-এর জন্য ছিল না। ফলে:
- BUY order-এর জন্য USDT balance check হচ্ছিল না
- "Account has insufficient balance" error হচ্ছিল
- User-এর কাছে 90 USDT থাকলেও order fail হচ্ছিল

## Solution

### Changes Made

**File:** `backend/src/routes/autoSignalGenerator.ts`

**Added balance check for both BUY and SELL orders:**

1. **BUY Orders**: USDT balance check
   ```typescript
   if (side === 'BUY') {
     const usdtBalance = await getAssetBalance(..., 'USDT', ...);
     const requiredUsdt = quantity * price;
     
     if (usdtBalance.available < requiredUsdt) {
       // Skip order, log error
     }
   }
   ```

2. **SELL Orders**: Coin balance check (already existed, improved)
   ```typescript
   if (side === 'SELL') {
     const baseAsset = pair.replace('USDT', '')...;
     const assetBalance = await getAssetBalance(..., baseAsset, ...);
     
     if (assetBalance.available < quantity) {
       // Skip order, log error
     }
   }
   ```

### How It Works

**For BUY Orders:**
1. Calculate required USDT: `quantity * price`
2. Get USDT balance from account
3. Check if `available USDT >= required USDT`
4. If insufficient, skip order and log error
5. If sufficient, proceed with order

**For SELL Orders:**
1. Extract base asset from symbol (ETH, BTC, etc.)
2. Get asset balance from account
3. Check if `available asset >= quantity`
4. If insufficient, skip order and log error
5. If sufficient, proceed with order

### Example Logs

**BUY Order - Sufficient Balance:**
```
✅ ETHUSDT: Signal approved for execution - action: buy
✓ ETHUSDT: Sufficient USDT balance for BUY order. Available: 90.00 USDT, Required: 5.12 USDT
✅ ETHUSDT: Binance SPOT order SUCCESS
```

**BUY Order - Insufficient Balance:**
```
✅ ETHUSDT: Signal approved for execution - action: buy
⚠️  ETHUSDT: Insufficient USDT balance for BUY order. Available: 3.50 USDT, Required: 5.12 USDT
❌ ETHUSDT: Trade EXECUTION FAILED - Insufficient USDT balance...
```

**SELL Order - Sufficient Balance:**
```
✅ ETHUSDT: Signal approved for execution - action: sell
✓ ETHUSDT: Sufficient ETH balance for SELL order. Available: 0.10000000, Required: 0.00260000
✅ ETHUSDT: Binance SPOT order SUCCESS
```

**SELL Order - Insufficient Balance:**
```
✅ ETHUSDT: Signal approved for execution - action: sell
⚠️  ETHUSDT: Insufficient ETH balance for SELL order. Available: 0.00000000, Required: 0.00260000
❌ ETHUSDT: Trade EXECUTION FAILED - Insufficient ETH balance...
```

### Benefits

- ✅ **BUY orders**: USDT balance check before execution
- ✅ **SELL orders**: Coin balance check before execution
- ✅ **Prevents unnecessary API calls** when balance is insufficient
- ✅ **Clear error messages** showing available vs required
- ✅ **Works for all spot trading pairs** (ETHUSDT, BTCUSDT, etc.)

### Result

এখন:
- BUY order-এর জন্য USDT balance check হবে
- SELL order-এর জন্য coin balance check হবে
- Insufficient balance হলে order attempt হবে না
- Clear logging থাকবে
- "Account has insufficient balance" error কমবে

### Testing

1. **BUY Order Test:**
   - Account-এ 90 USDT আছে
   - BUY signal আসলে USDT balance check হবে
   - যদি required amount (quantity * price) <= 90 USDT হয়, order execute হবে
   - যদি required amount > 90 USDT হয়, order skip হবে

2. **SELL Order Test:**
   - Account-এ coin আছে কিনা check হবে
   - SELL signal আসলে coin balance check হবে
   - যদি available coin >= quantity হয়, order execute হবে
   - যদি available coin < quantity হয়, order skip হবে

