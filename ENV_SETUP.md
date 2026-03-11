# Environment Variables Setup

## Backend (.env file in backend/ directory)

```env
# Server Configuration
NODE_ENV=production
PORT=8080

# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production-min-32-chars
JWT_EXPIRES_IN=60d

# Database Configuration (for future PostgreSQL migration)
# DATABASE_URL=postgresql://user:password@localhost:5432/trading_bot

# Current Database (LowDB - for development only)
DB_PATH=./data/db.json

# Cron Jobs
CRON_ENABLED=true

# CORS Configuration
CORS_ORIGIN=*

# Security
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# Logging
LOG_LEVEL=info
LOG_FILE=./logs/app.log
LOG_ERROR_FILE=./logs/error.log

# File Upload
MAX_FILE_SIZE=5242880
UPLOAD_DIR=./uploads
```

## Frontend (.env file in root directory)

```env
# Backend API URL
VITE_BACKEND_URL=http://localhost:8080

# Environment
VITE_NODE_ENV=development
```

## Important Notes

1. **JWT_SECRET**: Must be at least 32 characters long in production
2. **Never commit .env files** to version control
3. Use different values for development and production
4. Rotate secrets regularly in production

