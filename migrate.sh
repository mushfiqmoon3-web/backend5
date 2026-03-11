#!/bin/bash

# Migration Runner Script for Putty/SSH
# This script will migrate your JSON data to Supabase PostgreSQL

echo "======================================"
echo "🚀 Starting Database Migration"
echo "======================================"
echo ""

# Check if .env file exists
if [ ! -f .env ]; then
    echo "❌ Error: .env file not found!"
    echo "Please make sure you're in the backend directory."
    exit 1
fi

echo "✅ Found .env file"

# Check if DATABASE_URL is set
if ! grep -q "DATABASE_URL" .env; then
    echo "❌ Error: DATABASE_URL not found in .env file!"
    exit 1
fi

echo "✅ Database connection configured"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed!"
    echo "Please install Node.js first:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -"
    echo "  sudo apt-get install -y nodejs"
    exit 1
fi

echo "✅ Node.js found: $(node --version)"

# Check if migration SQL file exists
if [ ! -f "src/db/import-json-data.sql" ]; then
    echo "❌ Error: import-json-data.sql not found!"
    exit 1
fi

echo "✅ Migration SQL file found"
echo ""
echo "======================================"
echo "📝 Running Migration..."
echo "======================================"
echo ""

# Create a temporary Node.js script to run the migration
cat > temp-migrate.js << 'EOF'
const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function runMigration() {
  const client = await pool.connect();
  
  try {
    console.log('🔗 Connecting to database...');
    
    // Test connection
    const testResult = await client.query('SELECT NOW()');
    console.log('✅ Connected to database:', testResult.rows[0].now);
    console.log('');
    
    // Read SQL file
    console.log('📖 Reading migration SQL...');
    const sqlContent = fs.readFileSync('src/db/import-json-data.sql', 'utf8');
    
    console.log('⚙️  Executing migration...');
   await client.query(sqlContent);
    
    console.log('');
    console.log('✅ Migration completed successfully!');
    console.log('✨ Your data has been imported to PostgreSQL');
    console.log('');
    
    // Verify data
    console.log('🔍 Verifying migrated data...');
    const counts = await client.query(`
      SELECT 
        'app_users' as table_name, COUNT(*) as count FROM app_users
      UNION ALL 
        SELECT 'profiles', COUNT(*) FROM profiles
      UNION ALL 
        SELECT 'trading_strategies', COUNT(*) FROM trading_strategies
      UNION ALL 
        SELECT 'bot_status', COUNT(*) FROM bot_status
      UNION ALL 
        SELECT 'gas_fee_balances', COUNT(*) FROM gas_fee_balances
    `);
    
    console.log('');
    console.log('📊 Migrated Records:');
    console.log('-------------------');
    counts.rows.forEach(row => {
      console.log(`  ${row.table_name}: ${row.count}`);
    });
    console.log('');
    console.log('======================================');
    console.log('🎉 All done! Your database is ready!');
    console.log('======================================');
    
  } catch (error) {
    console.error('');
    console.error('❌ Migration failed!');
    console.error('Error:', error.message);
    console.error('');
    throw error;
  } finally {
    client.release();
   await pool.end();
  }
}

runMigration().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
EOF

# Run the migration
node temp-migrate.js

# Store exit code
EXIT_CODE=$?

# Clean up temporary file
rm -f temp-migrate.js

# Exit with the same code as the Node script
exit $EXIT_CODE
