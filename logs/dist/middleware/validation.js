import { z, ZodError } from 'zod';
import { CustomError } from './errorHandler.js';
// Validation middleware factory
export function validate(schema) {
    return (req, res, next) => {
        try {
            schema.parse(req.body);
            next();
        }
        catch (error) {
            if (error instanceof ZodError) {
                const errorMessages = error.issues.map((err) => ({
                    path: err.path.join('.'),
                    message: err.message,
                }));
                const validationError = new CustomError('Validation failed', 400, 'VALIDATION_ERROR');
                validationError.details = errorMessages;
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
        .min(8, 'Password must be at least 8 characters')
        .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
        .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
        .regex(/[0-9]/, 'Password must contain at least one number'),
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
