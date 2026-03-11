# Fix Port 8080 Conflict

## Problem
Error: `EADDRINUSE: address already in use :::8080`

This means another process is already using port 8080.

## Solutions

### Option 1: Kill the Process Using Port 8080

**Windows PowerShell:**
```powershell
# Find the process
netstat -ano | findstr :8080

# Kill the process (replace <PID> with the actual process ID)
taskkill /PID <PID> /F

# Or use the helper script
powershell -ExecutionPolicy Bypass -File fix-port-conflict.ps1
```

**Quick PowerShell Command:**
```powershell
Get-NetTCPConnection -LocalPort 8080 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### Option 2: Use a Different Port

1. Edit `backend/.env` file:
```
PORT=8081
```

2. Restart the backend:
```bash
npm run dev
```

### Option 3: Check What's Running

```powershell
# See what's using port 8080
Get-NetTCPConnection -LocalPort 8080 | Select-Object OwningProcess, State | ForEach-Object { Get-Process -Id $_.OwningProcess | Select-Object Id, ProcessName, Path }
```

## Backend Improvements

The backend now:
- ✅ Checks if port is available before starting
- ✅ Shows helpful error messages with solutions
- ✅ Provides clear instructions on how to fix the issue

## After Fixing

Once the port is free, run:
```bash
cd backend
npm run dev
```

The backend should start successfully on port 8080 (or your configured port).

