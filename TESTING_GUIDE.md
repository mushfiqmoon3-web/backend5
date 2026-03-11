# Testing Guide - Supabase PostgreSQL Connection

## ✅ Step 1: Start the Backend Server

The server is already running with:
```bash
npm run dev
```

Wait for it to compile and show:
```
✅ Backend server started successfully
```

## 🧪 Step 2: Test Health Endpoints

Once the server is running, open your browser or use curl/Postman:

### Test 1: Health Check
**URL:** `http://localhost:8080/health`
**Method:** GET

**Expected Response:**
```json
{
  "ok": true,
  "status": "healthy",
  "timestamp": "2026-03-11T...",
  "uptime": 123.456,
  "environment": "development",
  "version": "1.0.0"
}
```

### Test 2: Database Readiness Check
**URL:** `http://localhost:8080/ready`
**Method:** GET

**Expected Response (Success):**
```json
{
  "ready": true,
  "database": "postgres",
  "timestamp": "2026-03-11T..."
}
```

**If you see `"database": "postgres"`, that means Supabase is connected! ✅**

**Error Response (if schema not set up):**
```json
{
  "ready": false,
  "error": "Database not ready",
  "timestamp": "2026-03-11T..."
}
```

## 👤 Step 3: Test User Registration

If `/ready` shows `"database": "postgres"`, test registration:

### Register a New User
**URL:** `http://localhost:8080/api/auth/register` or `http://localhost:8080/api/auth/signup`
**Method:** POST
**Headers:** `Content-Type: application/json`

**Request Body:**
```json
{
  "email": "test@example.com",
  "password": "TestPassword123!",
  "referralCode": null
}
```

**Expected Success Response (201):**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "uuid-here",
    "email": "test@example.com"
  }
}
```

**This means the user was created in Supabase! ✅**

### Verify in Supabase Dashboard

1. Go to your Supabase project dashboard
2. Navigate to **Table Editor**
3. Open `app_users` table
4. You should see the newly created user!

## 🔐 Step 4: Test User Login

### Login with Registered User
**URL:** `http://localhost:8080/api/auth/login`
**Method:** POST
**Headers:** `Content-Type: application/json`

**Request Body:**
```json
{
  "email": "test@example.com",
  "password": "TestPassword123!"
}
```

**Expected Success Response (200):**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "uuid-here",
    "email": "test@example.com"
  }
}
```

## 📊 Step 5: Check Database Tables

If you have access to Supabase SQL Editor, run:

```sql
-- Check all tables
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
ORDER BY table_name;

-- Count users
SELECT COUNT(*) FROM app_users;

-- View all users
SELECT id, email, created_at FROM app_users ORDER BY created_at DESC;

-- Check profiles
SELECT id, user_id, email, referral_code FROM profiles;

-- Check bot status
SELECT * FROM bot_status WHERE user_id = 'your-user-id-here';
```

## 🔍 Troubleshooting

### Issue 1: Server won't start
**Check:** Look for compilation errors in the terminal
**Fix:** Run `npm run type-check` to see TypeScript errors

### Issue 2: `/ready` returns `"ready": false`
**Possible causes:**
1. Schema not set up on Supabase
2. DATABASE_URL incorrect
3. Network issue to Supabase

**Solution:**
```bash
# Set up schema on Supabase
npm run db:setup
```

Or manually via Supabase Dashboard:
1. Go to SQL Editor
2. Copy contents of `src/db/schema.sql`
3. Paste and run in Supabase SQL Editor

### Issue 3: Registration fails with error
**Check terminal logs** for database errors

Common errors:
- **"relation does not exist"** → Schema not set up
- **"duplicate key value violates unique constraint"** → Email already exists
- **"connection timeout"** → Network issue to Supabase

### Issue 4: Can't connect to Supabase
**Verify DATABASE_URL:**
```bash
# In .env file, check:
DATABASE_URL=postgresql://postgres.tdqsbutkwcuwvstsbqba:Mushfiq2026@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres
```

**Test connection directly:**
```bash
psql "postgresql://postgres.tdqsbutkwcuwvstsbqba:Mushfiq2026@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres" -c "SELECT NOW();"
```

## ✅ Success Indicators

You'll know Supabase is working when:

1. ✅ Server starts without errors
2. ✅ `/ready` endpoint returns `"database": "postgres"`
3. ✅ Registration creates user in database
4. ✅ Login works with registered credentials
5. ✅ You can see data in Supabase Dashboard

## 🎯 Next Steps After Testing

If auth routes work with Supabase:

### Option A: Continue Using Auth Only
- Keep using LowDB for other routes temporarily
- Auth uses PostgreSQL, others use LowDB
- Migrate gradually as needed

### Option B: Full Migration (Recommended)
Migrate all remaining route files to PostgreSQL:
- strategies.ts
- webhook.ts
- exchangeApi.ts
- autoSignalGenerator.ts
- positionMonitor.ts
- tradingviewWebhook.ts (most complex)
- rpc.ts
- assignAdminRole.ts
- db.ts

## 📝 Test Results Template

Use this to track your testing:

```
Date: _______________

[ ] Backend server started
    Time: ________
    
[ ] /health endpoint working
    Response: _________________________
    
[ ] /ready endpoint shows postgres
    Response: _________________________
    
[ ] User registration successful
    Email used: _________________________
    Token received: [ ] Yes [ ] No
    
[ ] User login successful
    Token received: [ ] Yes [ ] No
    
[ ] Verified in Supabase Dashboard
    Users found: ______
    
Overall Status: [ ] SUCCESS [ ] PARTIAL [ ] FAILED

Notes:
_______________________________________
_______________________________________
```

## 🚀 Quick Test Commands

Using curl (command line):

```bash
# Health check
curl http://localhost:8080/health

# Ready check
curl http://localhost:8080/ready

# Register user
curl -X POST http://localhost:8080/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"TestPass123!"}'

# Login
curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"TestPass123!"}'
```

Using PowerShell:

```powershell
# Health check
Invoke-RestMethod -Uri "http://localhost:8080/health" -Method Get

# Ready check
Invoke-RestMethod -Uri "http://localhost:8080/ready" -Method Get

# Register user
$body = @{
    email = "test@example.com"
    password = "TestPass123!"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:8080/api/auth/register" -Method Post -ContentType "application/json" -Body $body

# Login
$body = @{
    email = "test@example.com"
    password = "TestPass123!"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:8080/api/auth/login" -Method Post -ContentType "application/json" -Body $body
```

Good luck with testing! 🎉
