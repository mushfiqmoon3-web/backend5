import '../config/env.js';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbDir = path.resolve(__dirname, '../../data');
const dbFile = path.resolve(dbDir, 'db.json');
const adapter = new JSONFile(dbFile);
const defaultData = {
    app_users: [],
    api_keys: [],
    trading_strategies: [],
    webhook_logs: [],
    user_roles: [],
    trades: [],
    bot_status: [],
    profiles: [],
    positions: [],
    account_balances: [],
    gas_fee_balances: [],
    gas_fee_transactions: [],
    referral_commissions: [],
    admin_earnings: [],
    profit_settlements: [],
    pending_deposits: [],
    deposit_addresses: [],
    user_settings: [],
    app_settings: [{ key: 'maintenance_mode', bool_value: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
};
export const db = new Low(adapter, defaultData);
// Wrapper for safe writes with retry logic (handles Windows EPERM errors)
export async function safeWrite(retries = 5, delay = 200) {
    for (let i = 0; i < retries; i++) {
        try {
            await db.write();
            return;
        }
        catch (error) {
            const err = error;
            if ((err.code === 'EPERM' || err.code === 'EBUSY') && i < retries - 1) {
                console.warn(`[db] Write failed (attempt ${i + 1}/${retries}): ${err.message || err.code}, retrying...`);
                await new Promise((resolve) => setTimeout(resolve, delay * (i + 1)));
                continue;
            }
            console.error(`[db] Write failed after ${retries} attempts:`, err);
            throw error;
        }
    }
}
export async function initDb() {
    await fs.mkdir(dbDir, { recursive: true });
    // Check if file exists and is readable
    try {
        await fs.access(dbFile);
    }
    catch {
        // File doesn't exist, create empty file first
        await fs.writeFile(dbFile, JSON.stringify(defaultData, null, 2), 'utf-8');
    }
    await db.read();
    db.data ||= { ...defaultData };
    await safeWrite();
}
