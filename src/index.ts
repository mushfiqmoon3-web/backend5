import './config/env.js';
import cors from 'cors';
import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { registerRoutes } from './routes/index.js';
import { startCronJobs } from './cron.js';
import { initDatabase } from './db/adapter.js';
import { setupSecurityHeaders, generalRateLimiter } from './middleware/security.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { logger, logInfo } from './lib/logger.js';

const app = express();

// Trust proxy for Cloudflare tunnel and reverse proxies
app.set('trust proxy', true);

// Security headers
setupSecurityHeaders(app);

// Compression middleware
app.use(compression());

// CORS configuration
const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(
  cors({
    origin: corsOrigin === '*' ? true : corsOrigin.split(','),
    credentials: true,
  })
);

// Body parsing with increased limit for file uploads
app.use(express.json({ limit: process.env.MAX_FILE_SIZE || '5mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.MAX_FILE_SIZE || '5mb' }));

// Rate limiting
app.use(generalRateLimiter);

// Request logging middleware
app.use((req, res, next) => {
  logger.info('Incoming request', {
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  next();
});

// Enhanced health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    version: process.env.npm_package_version || '1.0.0',
  });
});

// Readiness check (for Kubernetes/Docker)
app.get('/ready', async (_req, res) => {
  try {
    // Check database connection
    const { getAdapter, isPostgresConfigured } = await import('./db/adapter.js');
    const adapter = getAdapter();
    
    if (adapter === 'postgres' && isPostgresConfigured()) {
      const { pool } = await import('./db/postgres.js');
      await pool.query('SELECT 1');
    }
    
    res.json({
      ready: true,
      database: adapter,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      ready: false,
      error: 'Database not ready',
      timestamp: new Date().toISOString(),
    });
  }
});

// Register all routes
registerRoutes(app);

// 404 handler (must be after all routes)
app.use(notFoundHandler);

// Error handler (must be last)
app.use(errorHandler);

const port = Number(process.env.PORT || 8080);

// Helper function to check if port is available
async function checkPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.once('close', () => resolve(true));
      server.close();
    });
    server.on('error', () => resolve(false));
  });
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Custom static file serving with fallback for old file structure
app.use('/uploads', async (req, res, next) => {
  const requestedPath = req.path;
  
  // Remove leading /uploads if present
  const cleanPath = requestedPath.startsWith('/') ? requestedPath.slice(1) : requestedPath;

  // Try the exact path first
  const exactPath = path.resolve(__dirname, '../uploads', cleanPath);
  
  const { promises: fs } = await import('node:fs');
  
  try {
    await fs.access(exactPath);
    // File exists at exact path, serve it
    return res.sendFile(exactPath);
  } catch {
    // File doesn't exist at exact path
    // If it's a nested path (e.g., deposit-proofs/user_id/filename), try flat structure
    if (cleanPath.includes('/')) {
      const parts = cleanPath.split('/');
      const bucket = parts[0];
      const filename = parts[parts.length - 1];
      
      // Try flat structure: bucket/filename
      const flatPath = path.resolve(__dirname, '../uploads', bucket, filename);
      
      try {
        await fs.access(flatPath);
        // File exists in flat structure, serve it
        return res.sendFile(flatPath);
      } catch {
        // File doesn't exist in either location
        return res.status(404).json({ error: 'File not found' });
      }
    } else {
      // Not a nested path and file doesn't exist
      return res.status(404).json({ error: 'File not found' });
    }
  }
});

await initDatabase();

// Check if port is available before starting
const portAvailable = await checkPortAvailable(port);
if (!portAvailable) {
  logger.error(`Port ${port} is already in use`, {
    port,
    suggestions: [
      'Stop the process using this port',
      'Use a different port by setting PORT in .env file',
    ],
  });
  console.error(`❌ Port ${port} is already in use.`);
  console.error(`   Options:`);
  console.error(`   1. Stop the process using port ${port}`);
  console.error(`      Windows: netstat -ano | findstr :${port}`);
  console.error(`      Then: taskkill /PID <process_id> /F`);
  console.error(`   2. Use a different port by setting PORT in .env file`);
  console.error(`   3. Run: powershell -ExecutionPolicy Bypass -File fix-port-conflict.ps1`);
  process.exit(1);
}

const server = app.listen(port, () => {
  logInfo(`✅ Backend server started successfully`, {
    port,
    environment: process.env.NODE_ENV || 'development',
    nodeVersion: process.version,
  });
  startCronJobs(port);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`Port ${port} is already in use`, { port, error: err.message });
    console.error(`❌ Port ${port} is already in use.`);
    console.error(`   Please stop the process using port ${port} or change PORT in .env`);
    console.error(`   To find the process: netstat -ano | findstr :${port}`);
    process.exit(1);
  } else {
    logger.error('Server error', { error: err.message, stack: err.stack });
    throw err;
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logInfo('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logInfo('Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logInfo('SIGINT received, shutting down gracefully');
  server.close(() => {
    logInfo('Process terminated');
    process.exit(0);
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason, promise });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

