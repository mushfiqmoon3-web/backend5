import { logError } from '../lib/logger.js';
export class CustomError extends Error {
    statusCode;
    code;
    isOperational;
    constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }
}
// Error handler middleware
export function errorHandler(err, req, res, next) {
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
    const message = process.env.NODE_ENV === 'production' && statusCode === 500
        ? 'Internal server error'
        : err.message;
    // Send error response
    res.status(statusCode).json({
        success: false,
        error: {
            code,
            message,
            ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
        },
    });
}
// Async error wrapper
export function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}
// 404 handler
export function notFoundHandler(req, res, next) {
    const error = new CustomError(`Route ${req.originalUrl} not found`, 404, 'NOT_FOUND');
    next(error);
}
