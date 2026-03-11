/**
 * Test Database Connection Script
 * Run this to verify Supabase PostgreSQL connection is working
 */

import './config/env.js';
import { pool} from './db/postgres.js';
import { logger } from './lib/logger.js';

async function testConnection() {
  console.log('\n🧪 Testing Supabase PostgreSQL Connection...\n');
  
  try {
    // Test 1: Basic connection
   console.log('✓ Testing basic connection...');
   const client = await pool.connect();
    
    // Test 2: Simple query
   console.log('✓ Executing simple query...');
   const timeResult = await client.query('SELECT NOW() as current_time');
   console.log(`   Database time: ${timeResult.rows[0].current_time}`);
    
    // Test 3: Check if tables exist
   console.log('✓ Checking for required tables...');
   const tablesQuery = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name IN (
          'app_users', 'profiles', 'api_keys', 
          'trading_strategies', 'trades', 'positions',
          'webhook_logs', 'bot_status', 'gas_fee_balances'
        )
      ORDER BY table_name
    `);
    
   console.log(`   Found ${tablesQuery.rows.length} tables:`);
    tablesQuery.rows.forEach(row => {
     console.log(`     - ${row.table_name}`);
    });
    
    // Test 4: Check app_users structure
   console.log('\n✓ Checking app_users table structure...');
   const columnsQuery = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'app_users'
      ORDER BY ordinal_position
    `);
    
   console.log('   Columns in app_users:');
   columnsQuery.rows.forEach(row => {
     console.log(`     - ${row.column_name} (${row.data_type}) ${row.is_nullable === 'YES' ? '[NULL]' : '[NOT NULL]'}`);
    });
    
    // Test 5: Try to count existing users
   console.log('\n✓ Checking existing users...');
   const countResult = await client.query('SELECT COUNT(*) as count FROM app_users');
   console.log(`   Total users in database: ${countResult.rows[0].count}`);
    
    client.release();
    
   console.log('\n✅ All tests passed! Supabase connection is working correctly.\n');
   console.log('📊 Summary:');
   console.log(`   - Database: ${process.env.DB_NAME || 'postgres'}`);
   console.log(`   - Host: ${process.env.DB_HOST}`);
   console.log(`   - Port: ${process.env.DB_PORT || 5432}`);
   console.log(`   - Tables found: ${tablesQuery.rows.length}`);
   console.log(`   - Connection: ✅ Working\n`);
    
    process.exit(0);
  } catch (error) {
   console.error('\n❌ Database connection test failed!\n');
   console.error('Error:', error instanceof Error ? error.message : String(error));
   console.error('\nTroubleshooting tips:');
   console.error('1. Make sure DATABASE_URL is set in .env file');
   console.error('2. Check if Supabase project is active');
   console.error('3. Verify network connection to Supabase');
   console.error('4. Run schema migration: npm run db:setup\n');
    process.exit(1);
  }
}

testConnection();
