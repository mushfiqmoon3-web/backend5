import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import type { Express } from 'express';

// Security headers middleware
export function setupSecurityHeaders(app: Express): void {
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'https:'],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );
}

// Rate limiting middleware
export const generalRateLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 500, // limit each IP to 500 requests per windowMs (increased for Cloudflare tunnel)
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests from this IP, please try again later.',
    },
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  skip: (req) => {
    // Skip rate limiting for health checks, ready endpoints, and internal cron jobs
    const isHealthCheck = req.path === '/health' || req.path === '/ready';
    const userAgent = req.get('user-agent') || '';
    const isCronJob = req.get('x-cron-job') === 'true' || 
                      userAgent === 'node' || 
                      userAgent === 'node-cron' ||
                      userAgent.startsWith('node/');
    return isHealthCheck || isCronJob;
  },
  // Trust proxy for Cloudflare tunnel
  trustProxy: true,
});

// Stricter rate limiter for auth endpoints
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 20, // limit each IP to 20 requests per windowMs (increased)
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many authentication attempts, please try again later.',
    },
  },
  skipSuccessfulRequests: true, // Don't count successful requests
  // Trust proxy for Cloudflare tunnel
  trustProxy: true,
});

// Strict rate limiter for sensitive operations
export const strictRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // limit each IP to 10 requests per hour
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests, please try again later.',
    },
  },
});

