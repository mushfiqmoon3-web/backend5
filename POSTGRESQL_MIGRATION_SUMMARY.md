# PostgreSQL Migration Summary

## ✅ Current Status

### DATABASE_URL Configuration
Your `.env` file is **correctly configured** with the Supabase PostgreSQL connection:

```env
DATABASE_URL=postgresql://postgres.tdqsbutkwcuwvstsbqba:Mushfiq2026@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres
DB_HOST=aws-1-ap-northeast-2.pooler.supabase.com
DB_PORT=5432
DB_NAME=postgres
DB_USER=postgres.tdqsbutkwcuwvstsbqba
DB_PASSWORD=Mushfiq2026
DB_SSL=true
```

### Backend Architecture
The backend already has a **dual-database adapter system** in place:
- ✅ PostgreSQL adapter (`src/db/postgres.ts`)
- ✅ LowDB adapter (`src/db/index.ts`) 
- ✅ Unified adapter layer (`src/db/adapter.ts`)
- ✅ Database schema (`src/db/schema.sql`) with all required tables

### What's Working
1. **Database connection** - PostgreSQL pool is properly configured
2. **Adapter system** - Can switch between PostgreSQL and LowDB automatically
3. **Schema** - All 20+ tables are defined in `schema.sql`
4. **Helper class** - `PostgresQueries` provides ready-to-use query methods

## ⚠️ Issue Identified

### Routes Still Using LowDB
All route files are currently importing and using LowDB directly:

```typescript
import { db, safeWrite } from '../db/index.js';

// Example usage (LOWDB):
const user = db.data?.app_users.find(u => u.email === email);
db.data.trades.push(trade);
await safeWrite();
```

**Files that need migration:**
1. ✅ `auth.ts` - **MIGRATED** to PostgreSQL
2. ❌ `tradingviewWebhook.ts` - Uses LowDB (920 lines, complex)
3. ❌ `exchangeApi.ts` - Uses LowDB
4. ❌ `autoSignalGenerator.ts` - Uses LowDB
5. ❌ `positionMonitor.ts` - Uses LowDB
6. ❌ `strategies.ts` - Uses LowDB
7. ❌ `webhook.ts` - Uses LowDB
8. ❌ `rpc.ts` - Uses LowDB
9. ❌ `assignAdminRole.ts` - Uses LowDB
10. ❌ `db.ts` - Uses LowDB

## 🎯 Migration Approach

### Option 1: Use PostgresQueries Helper (RECOMMENDED)
The `src/db/adapter.ts` file already has a `PostgresQueries` class with methods like:

```typescript
import { PostgresQueries } from '../db/adapter.js';

// Get user by email
const user= await PostgresQueries.getAppUserByEmail(email);

// Get strategies by user
const strategies = await PostgresQueries.getStrategiesByUserId(userId);

// Generic insert
await PostgresQueries.insert('trades', { id, user_id, ... });

// Generic update
await PostgresQueries.update('positions', positionId, { is_open: false });
```

**Advantages:**
- ✅ Clean, consistent API
- ✅ Type-safe helpers available
- ✅ No need to write raw SQL for common operations
- ✅ Easier to maintain

### Option 2: Direct Pool Queries
Use the PostgreSQL pool directly:

```typescript
import { pool} from '../db/postgres.js';

const result = await pool.query(
  'SELECT * FROM app_users WHERE email = $1',
  [email.toLowerCase()]
);
const user = result.rows[0];
```

**Advantages:**
- ✅ Full control over queries
- ✅ Better for complex queries
- ✅ Can use transactions easily

## 📋 Migration Steps

### For Each Route File:

1. **Change imports:**
   ```typescript
   // REMOVE:
   import { db, safeWrite } from '../db/index.js';
   
   // ADD:
   import { pool } from '../db/postgres.js';
   // OR
   import { PostgresQueries } from '../db/adapter.js';
   ```

2. **Replace array operations with SQL queries:**
   ```typescript
   // LOWDB:
  const user = db.data?.app_users.find(u => u.email === email);
   
   // POSTGRESQL:
  const result = await pool.query('SELECT * FROM app_users WHERE email = $1', [email]);
  const user = result.rows[0];
   ```

3. **Replace push operations with INSERT:**
   ```typescript
   // LOWDB:
   db.data.trades.push(trade);
  await safeWrite();
   
   // POSTGRESQL:
  await pool.query('INSERT INTO trades (...) VALUES (...)', [...values]);
   ```

4. **Replace filter/find operations:**
   ```typescript
   // LOWDB:
  const openPositions = db.data.positions.filter(p => p.is_open);
   
   // POSTGRESQL:
  const result = await pool.query('SELECT * FROM positions WHERE is_open = true');
  const openPositions = result.rows;
   ```

5. **Use transactions for multiple operations:**
   ```typescript
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO ...');
    await client.query('UPDATE ...');
    await client.query('COMMIT');
   } catch (error) {
    await client.query('ROLLBACK');
     throw error;
   } finally {
     client.release();
   }
   ```

## 🚀 Quick Start Migration Example

### Before (LowDB):
```typescript
import { db, safeWrite } from '../db/index.js';

router.post('/trade', async (req, res) => {
  const user = db.data?.app_users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  db.data.trades.push({
    id: crypto.randomUUID(),
    user_id: userId,
    symbol: 'BTCUSDT',
    // ... other fields
  });
  
  await safeWrite();
 res.json({ success: true });
});
```

### After (PostgreSQL with PostgresQueries):
```typescript
import { PostgresQueries } from '../db/adapter.js';

router.post('/trade', async (req, res) => {
  const user = await PostgresQueries.getAppUserById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  await PostgresQueries.insert('trades', {
    id: crypto.randomUUID(),
    user_id: userId,
    symbol: 'BTCUSDT',
    // ... other fields
  });
  
 res.json({ success: true });
});
```

## 📊 Database Tables Available

All these tables are ready in PostgreSQL:

1. `app_users` - User authentication
2. `profiles` - User profiles with referral system
3. `api_keys` - Encrypted exchange API keys
4. `trading_strategies` - Strategy configuration
5. `trades` - Trade history
6. `positions` - Open/closed positions
7. `webhook_logs` - Webhook delivery logs
8. `bot_status` - Bot running status
9. `account_balances` - Balance tracking
10. `gas_fee_balances` - Gas fee management
11. `gas_fee_transactions` - Transaction history
12. `referral_commissions` - Referral system
13. `admin_earnings` - Admin earnings
14. `profit_settlements` - Profit distribution
15. `pending_deposits` - Deposit approval queue
16. `deposit_addresses` - Deposit addresses
17. `user_settings` - User preferences
18. `user_roles` - Role-based access
19. `app_settings` - Application settings

## 🔧 Testing the Migration

After migrating each file, test:

1. **TypeScript compilation:**
   ```bash
   npm run type-check
   ```

2. **Build:**
   ```bash
   npm run build
   ```

3. **Start server:**
   ```bash
   npm run dev  # or npm run start
   ```

4. **Check database connection:**
   - Visit `http://localhost:8080/health`
   - Visit `http://localhost:8080/ready`

## 🎯 Next Steps

To complete the migration to PostgreSQL:

1. **✅ COMPLETED:** Migrate `auth.ts` (login/register routes)
2. **PENDING:** Migrate remaining 9 route files
3. **PENDING:** Test all endpoints with PostgreSQL
4. **PENDING:** Remove LowDB dependency from package.json
5. **PENDING:** Run database schema on Supabase:
   ```bash
   npm run db:setup
   ```

## 💡 Recommendation

Since you want to use **PostgreSQL instead of db.json**, I recommend:

1. **Use the PostgresQueries helper class** - It's already built and provides a clean API
2. **Migrate route files one by one** - Start with simpler ones (`strategies.ts`, `webhook.ts`)
3. **Test thoroughly** after each migration
4. **Keep LowDB as fallback** temporarily until all routes are migrated
5. **Remove LowDB completely** once everything works with PostgreSQL

## 📞 Need Help?

The migration is straightforward but time-consuming. Each route file needs:
- Import statement changes
- Query rewrites (find → SELECT, push → INSERT, etc.)
- Transaction handling for multi-step operations

Would you like me to:
1. Continue migrating the remaining route files?
2. Create a migration script for specific routes?
3. Provide more detailed examples for complex operations?
