# Database Migration Guide: LowDB to PostgreSQL

## Overview

This project now supports both LowDB (JSON file) and PostgreSQL. PostgreSQL is recommended for production use.

## Current Status

- ✅ PostgreSQL support added
- ✅ Automatic fallback to LowDB if PostgreSQL not configured
- ✅ Migration script available
- ✅ Unified database adapter

## Setup PostgreSQL

### Option 1: Using DATABASE_URL (Recommended)

Add to `backend/.env`:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/trading_bot
```

### Option 2: Using Individual Variables

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=trading_bot
DB_USER=your_username
DB_PASSWORD=your_password
```

## Create PostgreSQL Database

```bash
# Connect to PostgreSQL
psql -U postgres

# Create database
CREATE DATABASE trading_bot;

# Create user (optional)
CREATE USER trading_user WITH PASSWORD 'your_password';
GRANT ALL PRIVILEGES ON DATABASE trading_bot TO trading_user;

# Exit
\q
```

## Run Schema Migration

### Method 1: Using psql

```bash
psql $DATABASE_URL -f backend/src/db/schema.sql
```

### Method 2: Using npm script

```bash
cd backend
npm run db:setup
```

### Method 3: Manual

```bash
psql -U your_user -d trading_bot -f backend/src/db/schema.sql
```

## Migrate Data from LowDB

If you have existing data in LowDB:

```bash
cd backend
npm run migrate:postgres
```

This will:
1. Read all data from `backend/data/db.json`
2. Insert into PostgreSQL tables
3. Skip duplicates (ON CONFLICT DO NOTHING)
4. Log migration progress

## Verify Migration

```bash
# Connect to PostgreSQL
psql $DATABASE_URL

# Check tables
\dt

# Check data
SELECT COUNT(*) FROM app_users;
SELECT COUNT(*) FROM profiles;
SELECT COUNT(*) FROM api_keys;
```

## Using the Database

The application automatically detects PostgreSQL configuration:

- **If PostgreSQL is configured**: Uses PostgreSQL
- **If PostgreSQL is NOT configured**: Falls back to LowDB

### Check Current Database

The `/ready` endpoint shows which database is being used:

```bash
curl http://localhost:8080/ready
```

Response:
```json
{
  "ready": true,
  "database": "postgres",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Code Usage

### Using PostgreSQL Queries

```typescript
import { PostgresQueries } from './db/adapter.js';
import { getAdapter } from './db/adapter.js';

if (getAdapter() === 'postgres') {
  const user = await PostgresQueries.getAppUserByEmail('user@example.com');
}
```

### Using LowDB (Backward Compatible)

```typescript
import { getDb, getAdapter } from './db/adapter.js';

if (getAdapter() === 'lowdb') {
  const db = getDb();
  const user = db.data?.app_users.find(u => u.email === email);
}
```

## Production Recommendations

1. **Use PostgreSQL** for production
2. **Setup connection pooling** (already configured)
3. **Enable SSL** for remote connections:
   ```env
   DATABASE_URL=postgresql://user:pass@host:5432/db?sslmode=require
   ```
4. **Regular backups**:
   ```bash
   pg_dump $DATABASE_URL > backup_$(date +%Y%m%d).sql
   ```
5. **Monitor connections**:
   ```sql
   SELECT count(*) FROM pg_stat_activity;
   ```

## Troubleshooting

### Connection Issues

```bash
# Test connection
psql $DATABASE_URL -c "SELECT version();"

# Check if PostgreSQL is running
sudo systemctl status postgresql
```

### Migration Errors

- Check PostgreSQL logs
- Verify schema.sql was run
- Check data types match
- Verify foreign key constraints

### Performance Issues

- Check connection pool size (default: 20)
- Add indexes for frequently queried columns
- Use EXPLAIN ANALYZE for slow queries

## Rollback to LowDB

If you need to rollback:

1. Remove PostgreSQL environment variables
2. Restart the application
3. It will automatically use LowDB

## Next Steps

1. ✅ Setup PostgreSQL database
2. ✅ Run schema migration
3. ✅ Migrate existing data (if any)
4. ✅ Update environment variables
5. ✅ Test application
6. ✅ Deploy to production

---

**Note**: LowDB is still supported for development, but PostgreSQL is required for production scale.

