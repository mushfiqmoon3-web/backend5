import type { Request, Response, NextFunction } from 'express';
import { logger, logError } from '../lib/logger.js';

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
  isOperational?: boolean;
}

export class CustomError extends Error implements AppError {
  statusCode: number;
  code: string;
  isOperational: boolean;

  constructor(message: string, statusCode: number = 500, code: string = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

// Error handler middleware
export function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Log the error
  logError(err, {
    method: req.method,
    url: req.url,
    ip: req.ip,
    body: req.body,
    query: req.query,
  });

  // Determine status code
  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';

  // Don't leak error details in production
  const message =
    process.env.NODE_ENV === 'production' && statusCode === 500
      ? 'Internal server error'
      : err.message;

  // Send error response
  const response: {
    success: false;
    error: {
      code: string;
      message: string;
      details?: unknown;
      stack?: string;
    };
  } = {
    success: false,
    error: {
      code,
      message,
      ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
    },
  };

  // Include validation details if available
  if (code === 'VALIDATION_ERROR' && (err as CustomError & { details?: unknown }).details) {
    response.error.details = (err as CustomError & { details?: unknown }).details;
  }

  res.status(statusCode).json(response);
}

// Async error wrapper
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// 404 handler
export function notFoundHandler(req: Request, res: Response, next: NextFunction): void {
  const error = new CustomError(`Route ${req.originalUrl} not found`, 404, 'NOT_FOUND');
  next(error);
}

