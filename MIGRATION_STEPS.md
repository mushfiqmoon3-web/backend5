# 🚀 Complete Migration Instructions

## Step-by-Step Guide to Migrate from db.json to Supabase

### Prerequisites ✅

1. **Supabase account** - You already have project: `nmepquzyabhiipdpjrkm`
2. **Database password** - Get from Supabase Dashboard > Settings > Database

### Step 1: Configure DATABASE_URL

Edit `backend/.env`:

```bash
DATABASE_URL=postgresql://postgres:[YOUR_PASSWORD]@db.nmepquzyabhiipdpjrkm.supabase.co:5432/postgres?sslmode=require
```

Replace `[YOUR_PASSWORD]` with your actual database password.

### Step 2: Test Connection

```bash
cd backend
npm run db:test
```

Expected output: PostgreSQL version info

### Step 3: Run Migration

```bash
cd backend
npm run migrate:postgres
```

This will migrate ALL your data:
- ✅ app_users (1 user)
- ✅ trading_strategies (1 strategy)
- ✅ gas_fee_balances(2 balances)
- ✅ bot_status (2 records)
- ✅ profiles (1 profile)
- ✅ deposit_addresses (1 address)
- ✅ admin_earnings (5 records)
- ✅ gas_fee_transactions (1 transaction)
- ✅ app_settings (1 setting)
- ✅ user_roles (1 role)
- And all other tables...

### Step 4: Verify Migration

Connect to Supabase and check:

```sql
-- Check strategies
SELECT id, name, user_id, position_size_value, tp1_percent 
FROM trading_strategies;

-- Should show your strategy with all values preserved!
```

### Step 5: Start Backend

```bash
cd backend
npm start
```

Check logs for: `Using PostgreSQL database`

### What Happens During Migration

1. **Reads db.json** - All data from LowDB
2. **Creates tables** - Automatically creates all tables in Supabase
3. **Migrates data** - Copies all records preserving UUIDs
4. **Preserves relationships** - All user_id references maintained
5. **Safe migration** - Uses ON CONFLICT to avoid duplicates

### After Migration

✅ Each user will only see THEIR OWN strategies  
✅ Strategies are completely independent per user  
✅ All data preserved with same UUIDs  
✅ Better performance with PostgreSQL  
✅ Row Level Security enforced  

### Rollback Option

If you need to go back to LowDB:
1. Remove `DATABASE_URL` from `.env`
2. Restart backend
3. Application uses db.json again

### Troubleshooting

**Problem**: "DATABASE_URL not configured"  
**Solution**: Add DATABASE_URL to backend/.env

**Problem**: "Connection refused"  
**Solution**: Check password is correct, SSL enabled

**Problem**: "Table doesn't exist"  
**Solution**: Migration script creates tables automatically

## Summary

🎯 **Migration preserves EVERYTHING**  
🎯 **No data loss**  
🎯 **User isolation enforced**  
🎯 **Strategies independent per user**  

Ready to migrate? Just add DATABASE_URL and run `npm run migrate:postgres`!
