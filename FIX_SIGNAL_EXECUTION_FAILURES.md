# Fix Signal Execution Failures

## Issues Found

### 1. "Filter failure: NOTIONAL" Error
**Problem:** Binance requires a minimum order value (notional) for spot orders, typically 5-10 USDT. Orders with values below this minimum are rejected.

**Solution:**
- Added `getBinanceSymbolInfo()` function to fetch exchange info (minimum notional, minimum quantity, step size, etc.)
- Validate minimum notional before placing orders
- Automatically adjust quantity to meet minimum notional requirements
- Show clear error messages when notional requirements cannot be met

### 2. "Initializing spot order" Error
**Problem:** Generic error message that doesn't show the actual Binance API error.

**Solution:**
- Improved error handling to capture and display actual Binance API errors
- Extract error messages from Binance API response (`msg`, `message`, `code`)
- Better error logging with specific failure reasons

## Changes Made

### 1. Added Symbol Info Function
```typescript
getBinanceSymbolInfo(symbol, product, isTestnet)
```
- Fetches exchange info from Binance API
- Returns: `minNotional`, `minQty`, `stepSize`, `tickSize`, `qtyPrecision`
- Caches results for performance

### 2. Enhanced Spot Order Execution
- Check minimum notional before placing orders
- Automatically adjust quantity if below minimum
- Validate minimum quantity requirements
- Round quantity to proper precision based on symbol info
- Retry with adjusted quantity if NOTIONAL error occurs

### 3. Improved Error Handling
- Extract actual error messages from Binance API responses
- Show specific error codes and messages
- Better error messages for NOTIONAL and LOT_SIZE failures

## Testing

After deploying, signals should:
1. ✅ Automatically adjust quantity to meet minimum notional
2. ✅ Show actual Binance API errors instead of generic messages
3. ✅ Successfully execute spot orders that meet requirements
4. ✅ Provide clear error messages when requirements cannot be met

## Example Error Messages

**Before:**
- "Initializing spot order"
- "Filter failure: NOTIONAL"

**After:**
- "Filter failure: NOTIONAL (order value 2.50 USDT < minimum 5.00 USDT)"
- "Filter failure: LOT_SIZE (quantity too small, minimum: 0.001)"
- Actual Binance API error messages with codes

## Files Modified

- `backend/src/routes/autoSignalGenerator.ts`
  - Added `getBinanceSymbolInfo()` function
  - Enhanced spot order execution logic
  - Improved error handling in `callBinanceApi()`

