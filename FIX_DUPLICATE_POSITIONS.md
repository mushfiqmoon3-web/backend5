# Fix: Prevent Duplicate Positions for Same Symbol

## Problem
When a position closes and goes to the database, if a new signal comes for the same symbol, the system could create a duplicate position. This happened because:

1. **No check for existing open positions** for the same symbol before creating a new one
2. **Only checked total position count**, not symbol-specific positions
3. **Stale positions** (closed on exchange but still `is_open = true` in DB) could cause issues

## Solution

### Changes Made

**File:** `backend/src/routes/autoSignalGenerator.ts`

Added a check **before processing each signal** to verify if there's already an open position for the same symbol:

```typescript
// Check if there's already an open position for this symbol
const existingPosition = (db.data?.positions || []).find(
  (p) =>
    p.user_id === config.user_id &&
    p.symbol === pair &&
    p.is_open &&
    p.exchange === config.exchange &&
    p.environment === config.environment
);

if (existingPosition) {
  console.log(`⚠️  ${pair}: Already has an open position (ID: ${existingPosition.id}), skipping new signal to prevent duplicate`);
  continue;
}
```

### How It Works

1. **Before processing a signal** for a symbol, check if there's an open position for that symbol
2. **Check criteria:**
   - Same user
   - Same symbol (e.g., BTCUSDT)
   - Position is open (`is_open = true`)
   - Same exchange (binance/bybit)
   - Same environment (testnet/mainnet)

3. **If found:** Skip the signal and log a warning
4. **If not found:** Proceed with signal execution

### Why This Works

- **Prevents duplicates:** Won't create a new position if one already exists for the symbol
- **Handles stale positions:** If position monitor hasn't run yet and old position is still marked as open, this prevents duplicate
- **Exchange-specific:** Checks same exchange and environment to avoid conflicts
- **User-specific:** Only checks positions for the same user

### Example Scenarios

#### Scenario 1: Normal Flow ✅
1. Position opens for BTCUSDT
2. Position closes (is_open = false)
3. New signal comes for BTCUSDT
4. Check finds no open position → **New position created** ✅

#### Scenario 2: Duplicate Prevention ✅
1. Position opens for BTCUSDT (is_open = true)
2. New signal comes for BTCUSDT
3. Check finds existing open position → **Signal skipped** ✅
4. Log: "Already has an open position, skipping new signal to prevent duplicate"

#### Scenario 3: Stale Position Protection ✅
1. Position closes on exchange but DB still has is_open = true (stale)
2. New signal comes for BTCUSDT
3. Check finds stale position → **Signal skipped** ✅
4. Position monitor will eventually close the stale position
5. Next signal will then create new position

### Benefits

- ✅ **No duplicate positions** for the same symbol
- ✅ **Protects against stale positions** causing duplicates
- ✅ **Clear logging** when signals are skipped
- ✅ **Works with position monitor** - stale positions will be cleaned up

### Note

This check is **symbol-specific**, not side-specific (long vs short). In futures trading:
- You can only have **one position per symbol** (either long OR short)
- Opening a new position in the opposite direction will close the existing one
- But we prevent creating a duplicate in the same direction

If you want to allow opposite-side positions, you would need to modify the check to also compare `side` (long vs short), but this is typically not needed for futures.

