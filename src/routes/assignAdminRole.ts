import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { pool } from '../db/postgres.js';
import crypto from 'node:crypto';

const router = Router();

router.post('/', requireAuth, async (req, res) => {
  try {
   const { user_id, action } = req.body as { user_id?: string; action?: 'add' | 'remove' };

   if (!user_id) {
      return res.status(400).json({ success: false, error: 'user_id is required' });
    }

   if (action === 'add') {
     // Check if role already exists
     const existingResult = await pool.query(
       'SELECT id FROM user_roles WHERE user_id = $1 AND role = $2',
       [user_id, 'admin']
     );
      
     if (existingResult.rows.length > 0) {
        return res.status(200).json({ success: true, message: 'Admin role already assigned' });
      }
      
     await pool.query(
       'INSERT INTO user_roles (id, user_id, role, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)',
       [crypto.randomUUID(), user_id, 'admin']
     );

     return res.status(200).json({ success: true, message: 'Admin role assigned' });
    }

   if (action === 'remove') {
     await pool.query(
       'DELETE FROM user_roles WHERE user_id = $1 AND role = $2',
       [user_id, 'admin']
     );

     return res.status(200).json({ success: true, message: 'Admin role removed' });
    }

   return res.status(400).json({ success: false, error: 'Invalid action. Use "add" or "remove"' });
  } catch (error) {
   console.error('Error:', error);
   return res.status(500).json({ success: false, error: 'Internal error' });
  }
});

export const assignAdminRoleRouter = router;
