import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Try multiple locations for .env file
// 1. Backend root (where PM2 runs from)
const backendRootEnv = path.resolve(process.cwd(), '.env');
dotenv.config({ path: backendRootEnv });
// 2. Relative to dist/config (../../.env from dist/config = backend root)
const relativeEnv = path.resolve(__dirname, '../../.env');
dotenv.config({ path: relativeEnv });
// 3. Default location (current working directory)
dotenv.config();
