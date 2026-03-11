# 🔄 LowDB to Supabase Migration Guide

## Overview
This guide will help you migrate all your data from `db.json` (LowDB) to Supabase (PostgreSQL).

## Prerequisites

1. **Supabase Database URL configured** in `backend/.env`:
   ```bash
   DATABASE_URL=postgresql://postgres:[YOUR_PASSWORD]@db.nmepquzyabhiipdpjrkm.supabase.co:5432/postgres?sslmode=require
   ```

2. **Backup your data** - The migration script will read from `backend/data/db.json`

## Step-by-Step Migration

### Step 1: Check Your Current Data

First, verify what data you have in `db.json`:

```bash
cd backend
cat data/db.json | jq 'keys'
```

Expected tables:
- ✅ app_users
- ✅ api_keys
- ✅ trading_strategies
- ✅ webhook_logs
- ✅ user_roles
- ✅ trades
- ✅ gas_fee_balances
- ✅ profit_sharing
- ✅ bot_status
- ✅ deposit_proofs
- ✅ maintenance_settings

### Step 2: Configure Supabase Connection

Edit `backend/.env`:

```bash
# Add your Supabase database password
DATABASE_URL=postgresql://postgres:[YOUR_DB_PASSWORD]@db.nmepquzyabhiipdpjrkm.supabase.co:5432/postgres?sslmode=require
```

### Step 3: Test Database Connection

```bash
cd backend
npm run db:test
```

Expected output:
```
PostgreSQL connection successful
```

### Step 4: Run Migration Script

```bash
cd backend
npm run migrate:postgres
```

This will:
1. ✅ Create all necessary tables in Supabase
2. ✅ Migrate all users
3. ✅ Migrate all strategies with their configurations
4. ✅ Migrate API keys, trades, positions, gas balances, etc.
5. ✅ Preserve all UUIDs and relationships

### Step 5: Verify Migration

Connect to your Supabase database and check:

```sql
-- Check users
SELECT COUNT(*) FROM app_users;

-- Check strategies
SELECT id, user_id, name, is_active FROM trading_strategies;

-- Check gas balances
SELECT user_id, balance FROM gas_fee_balances;
```

### Step 6: Update Backend to Use PostgreSQL

After successful migration, the backend will automatically use PostgreSQL if `DATABASE_URL` is configured.

To verify:
```bash
cd backend
npm start
```

Check logs for:
```
Using PostgreSQL database
```

## What Gets Migrated

### From Your db.json:

| Table | Records | Notes |
|-------|---------|-------|
| app_users | All users | Passwords preserved |
| trading_strategies | All strategies | All config values preserved |
| api_keys | All exchange keys | Encrypted keys preserved |
| trades | All trade history | Complete history |
| positions | All positions | Open/closed positions |
| gas_fee_balances | All balances | Balance history preserved |
| profit_sharing | All records | Profit calculations preserved |
| bot_status | All status records | Bot running state |
| deposit_proofs | All deposits | Deposit verification |
| webhook_logs | All logs | Signal history |

## Troubleshooting

### Issue: "DATABASE_URL not configured"
**Solution**: Add `DATABASE_URL` to `backend/.env`

### Issue: "Connection refused"
**Solution**: 
1. Check your database password is correct
2. Verify SSL is enabled in connection string
3. Check Supabase dashboard for connection issues

### Issue: "Table doesn't exist"
**Solution**: The migration script creates tables automatically. If it fails, check the schema file exists at `backend/src/db/schema.sql`

### Issue: "Duplicate key value violates unique constraint"
**Solution**: This means some data was already migrated. The script uses `ON CONFLICT DO NOTHING` to handle this safely.

## Post-Migration Steps

1. **Verify all data** in Supabase Dashboard
2. **Test the application** - Create a new strategy, check if it saves to Supabase
3. **Monitor logs** for any database errors
4. **Keep backup** of `db.json` for safety

## Rollback (If Needed)

If you need to go back to LowDB:
1. Remove `DATABASE_URL` from `.env`
2. Restart backend
3. Application will automatically use LowDB

## Summary

✅ **Migration preserves all data**  
✅ **All user strategies maintained**  
✅ **No data loss**  
✅ **Automatic table creation**  
✅ **Safe rollback option available**  

## Next Steps After Migration

1. Each user will only see their own strategies (RLS enforced)
2. Strategies are completely independent per user
3. Better performance and scalability
4. Better security with Row Level Security
