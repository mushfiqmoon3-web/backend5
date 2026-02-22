import '../config/env.js';
import jwt from 'jsonwebtoken';
const getJwtSecret = () => {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('Missing JWT_SECRET');
    }
    return secret;
};
export async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ code: 401, message: 'Unauthorized' });
    }
    const token = authHeader.slice('Bearer '.length);
    try {
        const payload = jwt.verify(token, getJwtSecret());
        req.user = { id: payload.sub, email: payload.email ?? null };
        return next();
    }
    catch {
        return res.status(401).json({ code: 401, message: 'Invalid JWT' });
    }
}
