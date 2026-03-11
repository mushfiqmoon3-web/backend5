# API Documentation

## Base URL
```
http://localhost:8080
```

## Authentication
Most endpoints require JWT authentication. Include the token in the Authorization header:
```
Authorization: Bearer <your-jwt-token>
```

## Endpoints

### Health Check

#### GET /health
Check server health status.

**Response:**
```json
{
  "ok": true,
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime": 3600,
  "environment": "production",
  "version": "1.0.0"
}
```

#### GET /ready
Check if server is ready (database connection check).

**Response:**
```json
{
  "ready": true,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

---

### Authentication

#### POST /api/auth/register
Register a new user.

**Rate Limit:** 5 requests per 15 minutes per IP

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "SecurePass123",
  "referralCode": "optional-referral-code"
}
```

**Validation:**
- Email must be valid
- Password must be at least 8 characters
- Password must contain uppercase, lowercase, and number

**Response:**
```json
{
  "token": "jwt-token-here",
  "user": {
    "id": "user-uuid",
    "email": "user@example.com"
  }
}
```

**Error Responses:**
- `400` - Validation error
- `409` - Email already registered
- `429` - Rate limit exceeded
- `500` - Internal server error

#### POST /api/auth/login
Login with email and password.

**Rate Limit:** 5 requests per 15 minutes per IP

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "SecurePass123"
}
```

**Response:**
```json
{
  "token": "jwt-token-here",
  "user": {
    "id": "user-uuid",
    "email": "user@example.com"
  }
}
```

**Error Responses:**
- `400` - Validation error
- `401` - Invalid credentials
- `429` - Rate limit exceeded
- `500` - Internal server error

#### GET /api/auth/me
Get current user information.

**Authentication:** Required

**Response:**
```json
{
  "user": {
    "id": "user-uuid",
    "email": "user@example.com"
  }
}
```

**Error Responses:**
- `401` - Unauthorized (missing or invalid token)

---

### Exchange API

#### POST /api/exchange-api
Execute exchange operations.

**Authentication:** Required
**Rate Limit:** 100 requests per 15 minutes per IP

**Request Body:**
```json
{
  "action": "balance",
  "exchange": "binance",
  "product": "futures",
  "environment": "testnet",
  "symbol": "BTCUSDT",
  "qty": 0.001
}
```

---

### Strategies

#### GET /api/strategies
Get user's trading strategies.

**Authentication:** Required

**Response:**
```json
{
  "strategies": [...]
}
```

#### POST /api/strategies
Create or update a trading strategy.

**Authentication:** Required

**Request Body:**
```json
{
  "name": "Strategy Name",
  "config": {...}
}
```

---

### Database Operations

#### POST /api/db/*
Various database operations (protected routes).

**Authentication:** Required

---

## Error Response Format

All errors follow this format:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "stack": "Error stack (only in development)"
  }
}
```

## Common Error Codes

- `VALIDATION_ERROR` - Request validation failed
- `UNAUTHORIZED` - Authentication required or invalid
- `NOT_FOUND` - Resource not found
- `RATE_LIMIT_EXCEEDED` - Too many requests
- `INTERNAL_ERROR` - Server error

## Rate Limits

- **General API:** 100 requests per 15 minutes per IP
- **Auth endpoints:** 5 requests per 15 minutes per IP
- **Sensitive operations:** 10 requests per hour per IP

## Status Codes

- `200` - Success
- `201` - Created
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `409` - Conflict
- `429` - Too Many Requests
- `500` - Internal Server Error
- `503` - Service Unavailable

