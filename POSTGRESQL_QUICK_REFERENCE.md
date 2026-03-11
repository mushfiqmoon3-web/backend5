# PostgreSQL Migration Quick Reference

## Common LowDB to PostgreSQL Conversions

### Reading Data

#### Find by ID
```typescript
// LOWDB:
const user= db.data?.app_users.find(u => u.id === userId);

// POSTGRESQL (Option 1- Direct):
const result = await pool.query('SELECT * FROM app_users WHERE id = $1', [userId]);
const user= result.rows[0];

// POSTGRESQL (Option 2 - Helper):
const user = await PostgresQueries.getAppUserById(userId);
```

#### Find by Email
```typescript
// LOWDB:
const user= db.data?.app_users.find(u => u.email === email);

// POSTGRESQL:
const result = await pool.query('SELECT * FROM app_users WHERE email = $1', [email.toLowerCase()]);
const user = result.rows[0];

// Or use helper:
const user = await PostgresQueries.getAppUserByEmail(email);
```

#### Filter Array
```typescript
// LOWDB:
const openPositions = db.data.positions.filter(p => p.is_open && p.user_id === userId);

// POSTGRESQL:
const result = await pool.query(
  'SELECT * FROM positions WHERE is_open = true AND user_id = $1',
  [userId]
);
const openPositions = result.rows;
```

#### Find with Multiple Conditions
```typescript
// LOWDB:
const apiKey = db.data?.api_keys.find(k => 
  k.user_id === userId && 
  k.exchange === 'binance' &&
  k.environment === 'testnet'
);

// POSTGRESQL:
const result = await pool.query(
  `SELECT * FROM api_keys 
   WHERE user_id = $1 AND exchange = $2 AND environment = $3 AND is_active = true`,
  [userId, 'binance', 'testnet']
);
const apiKey = result.rows[0];
```

### Writing Data

#### Insert New Record
```typescript
// LOWDB:
db.data.trades.push({
  id: crypto.randomUUID(),
  user_id: userId,
  symbol: 'BTCUSDT',
  side: 'buy',
  price: 50000,
  quantity: 0.1,
  status: 'filled',
  created_at: new Date().toISOString()
});
await safeWrite();

// POSTGRESQL:
await pool.query(
  `INSERT INTO trades (id, user_id, symbol, side, price, quantity, status, created_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [
    crypto.randomUUID(),
    userId,
    'BTCUSDT',
    'buy',
    50000,
    0.1,
    'filled',
    new Date().toISOString()
  ]
);

// Or use helper:
await PostgresQueries.insert('trades', {
  id: crypto.randomUUID(),
  user_id: userId,
  symbol: 'BTCUSDT',
  side: 'buy',
  price: 50000,
  quantity: 0.1,
  status: 'filled',
  created_at: new Date().toISOString()
});
```

#### Update Record
```typescript
// LOWDB:
const position = db.data.positions.find(p => p.id === positionId);
if (position) {
  position.is_open = false;
  position.updated_at = new Date().toISOString();
}
await safeWrite();

// POSTGRESQL:
await pool.query(
  `UPDATE positions 
   SET is_open = false, updated_at = CURRENT_TIMESTAMP 
   WHERE id = $1`,
  [positionId]
);

// Or use helper:
await PostgresQueries.update('positions', positionId, {
  is_open: false,
  updated_at: new Date().toISOString()
});
```

#### Delete Record
```typescript
// LOWDB:
db.data.api_keys = db.data.api_keys.filter(k => k.id !== keyId);
await safeWrite();

// POSTGRESQL:
await pool.query('DELETE FROM api_keys WHERE id = $1', [keyId]);

// Or use helper:
await PostgresQueries.delete('api_keys', keyId);
```

### Complex Operations

#### Transaction (Multiple Operations)
```typescript
// LOWDB:
try {
  db.data.users.push(newUser);
  db.data.profiles.push(newProfile);
  db.data.bot_status.push(newBotStatus);
  await safeWrite();
} catch (error) {
  // Handle error
}

// POSTGRESQL:
const client = await pool.connect();
try {
  await client.query('BEGIN');
  
  await client.query('INSERT INTO users (...) VALUES (...)', [...values]);
  await client.query('INSERT INTO profiles (...) VALUES (...)', [...values]);
  await client.query('INSERT INTO bot_status (...) VALUES (...)', [...values]);
  
  await client.query('COMMIT');
  
 res.json({ success: true });
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
}
```

#### Count Records
```typescript
// LOWDB:
const tradeCount = db.data.trades.filter(t => t.user_id === userId).length;

// POSTGRESQL:
const result = await pool.query(
  'SELECT COUNT(*) FROM trades WHERE user_id = $1',
  [userId]
);
const tradeCount = parseInt(result.rows[0].count);
```

#### Aggregate/Sum
```typescript
// LOWDB:
const totalPnl = db.data.trades
  .filter(t => t.user_id === userId)
  .reduce((sum, t) => sum + (t.realized_pnl || 0), 0);

// POSTGRESQL:
const result = await pool.query(
  'SELECT SUM(realized_pnl) as total_pnl FROM trades WHERE user_id = $1',
  [userId]
);
const totalPnl = parseFloat(result.rows[0].total_pnl || 0);
```

#### Get Recent Records with Limit
```typescript
// LOWDB:
const recentTrades = db.data.trades
  .filter(t => t.user_id === userId)
  .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  .slice(0, 10);

// POSTGRESQL:
const result = await pool.query(
  `SELECT * FROM trades 
   WHERE user_id = $1 
   ORDER BY created_at DESC 
   LIMIT 10`,
  [userId]
);
const recentTrades = result.rows;
```

### Checking Existence

#### Check if Record Exists
```typescript
// LOWDB:
const exists = db.data.app_users.some(u => u.email === email);

// POSTGRESQL:
const result = await pool.query(
  'SELECT 1 FROM app_users WHERE email = $1 LIMIT 1',
  [email.toLowerCase()]
);
const exists = result.rows.length > 0;
```

### Working with JSONB

#### Store JSON Config
```typescript
// LOWDB:
strategy.config = { leverage: 10, tp: 5 };
await safeWrite();

// POSTGRESQL:
await pool.query(
  'UPDATE trading_strategies SET config = $1 WHERE id = $2',
  [JSON.stringify({ leverage: 10, tp: 5 }), strategyId]
);

// Or query JSONB field:
const result = await pool.query(
  `SELECT * FROM trading_strategies 
   WHERE id = $1 AND (config->>'leverage')::int > 5`,
  [strategyId]
);
```

## Import Statements Cheat Sheet

### Use PostgresQueries Helper
```typescript
import { PostgresQueries } from '../db/adapter.js';
```

### Use Direct Pool Queries
```typescript
import { pool} from '../db/postgres.js';
```

### Use Both
```typescript
import { pool } from '../db/postgres.js';
import { PostgresQueries } from '../db/adapter.js';
```

## Type Imports

Keep these for type safety:
```typescript
import type { 
  AppUser, 
  ApiKey, 
  TradingStrategy, 
  Trade, 
  Position,
  WebhookLog 
} from '../db/index.js';
```

## Error Handling Pattern

```typescript
router.post('/endpoint', asyncHandler(async (req, res) => {
  try {
   const client = await pool.connect();
    
   try {
     await client.query('BEGIN');
      
      // Database operations
     await client.query('INSERT INTO ...');
     await client.query('UPDATE ...');
      
     await client.query('COMMIT');
      
     res.json({ success: true });
    } catch (error) {
     await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
   logger.error('Operation failed', { error });
    throw new CustomError('Internal error', 500, 'INTERNAL_ERROR');
  }
}));
```

## Testing Checklist

After migrating each route:

- [ ] TypeScript compiles without errors
- [ ] No references to `db.data` or `safeWrite`
- [ ] All queries use parameterized statements (`$1`, `$2`, etc.)
- [ ] Transactions are used for multi-step operations
- [ ] Error handling includes ROLLBACK
- [ ] Client is properly released in finally block
- [ ] Route works when tested with API client

## Common Patterns by Table

### app_users
```typescript
// Get by email
const user = await PostgresQueries.getAppUserByEmail(email);

// Create user
await PostgresQueries.insert('app_users', {
  id: crypto.randomUUID(),
  email: email.toLowerCase(),
  password_hash: hash,
  created_at: new Date().toISOString()
});
```

### profiles
```typescript
// Get by user_id
const profile = await PostgresQueries.getProfileByUserId(userId);

// Get by referral code
const referrer = await PostgresQueries.getProfileByReferralCode(code);
```

### api_keys
```typescript
// Get active keys for user
const keys = await PostgresQueries.getApiKeysByUserId(userId);

// Get specific key
const key = await PostgresQueries.getApiKeyByUserAndEnv(
  userId, 
  'binance', 
  'futures', 
  'testnet'
);
```

### trading_strategies
```typescript
// Get all strategies for user
const strategies = await PostgresQueries.getStrategiesByUserId(userId);

// Get by ID
const strategy = await PostgresQueries.getStrategyById(strategyId);

// Create strategy
await PostgresQueries.insert('trading_strategies', {
  id: crypto.randomUUID(),
  user_id: userId,
  name: 'My Strategy',
  webhook_secret: secret,
  is_active: true,
  config: JSON.stringify(configObj)
});
```

### positions
```typescript
// Get open positions for user
const result = await pool.query(
  'SELECT * FROM positions WHERE user_id = $1 AND is_open = true',
  [userId]
);
const positions = result.rows;

// Close position
await PostgresQueries.update('positions', positionId, {
  is_open: false,
  current_price: exitPrice,
  unrealized_pnl: pnl,
  updated_at: new Date().toISOString()
});
```

### trades
```typescript
// Get recent trades
const result = await pool.query(
  `SELECT * FROM trades 
   WHERE user_id = $1 
   ORDER BY created_at DESC 
   LIMIT 50`,
  [userId]
);

// Record trade
await PostgresQueries.insert('trades', {
  id: crypto.randomUUID(),
  user_id: userId,
  exchange: 'binance',
  symbol: 'BTCUSDT',
  side: 'buy',
  price: 50000,
  quantity: 0.1,
  status: 'filled',
  created_at: new Date().toISOString()
});
```

## Quick Migration Steps for Any File

1. **Change imports** at top of file
2. **Search for** `db.data?` and replace with appropriate queries
3. **Search for** `await safeWrite()` and remove (not needed with PostgreSQL)
4. **Add transactions** where multiple writes happen
5. **Test** the route thoroughly

## Need Help?

Refer to:
- `POSTGRESQL_MIGRATION_SUMMARY.md` - Full migration guide
- `src/db/adapter.ts` - PostgresQueries helper class
- `src/db/schema.sql` - Database schema reference
- `src/db/postgres.ts` - Pool configuration
