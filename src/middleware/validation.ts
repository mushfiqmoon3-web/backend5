import type { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { CustomError } from './errorHandler.js';

// Validation middleware factory
export function validate(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errorMessages = error.issues.map((err) => ({
          path: err.path.join('.'),
          message: err.message,
        }));

        // Log validation errors for debugging
        console.error('Validation errors:', JSON.stringify(errorMessages, null, 2));
        console.error('Request body:', JSON.stringify(req.body, null, 2));

        const validationError = new CustomError(
          `Validation failed: ${errorMessages.map(e => `${e.path}: ${e.message}`).join(', ')}`,
          400,
          'VALIDATION_ERROR'
        );
        (validationError as CustomError & { details: unknown }).details = errorMessages;
        return next(validationError);
      }
      next(error);
    }
  };
}

// Common validation schemas
export const schemas = {
  email: z.string().email('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters'),
  uuid: z.string().uuid('Invalid UUID format'),
  positiveNumber: z.number().positive('Must be a positive number'),
  nonEmptyString: z.string().min(1, 'Cannot be empty'),
};

// Auth validation schemas
export const authSchemas = {
  register: z.object({
    email: schemas.email,
    password: schemas.password,
    referralCode: z.string().optional(),
  }),
  login: z.object({
    email: schemas.email,
    password: z.string().min(1, 'Password is required'),
  }),
};

