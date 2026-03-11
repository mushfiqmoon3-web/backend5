const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Database connection configuration
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function runMigration() {
  const client = await pool.connect();
  
  try {
    console.log('🚀 Starting JSON to SQL migration...');
    
    // Read the SQL migration file
    const sqlPath = path.join(__dirname, 'import-json-data.sql');
    const sqlContent = fs.readFileSync(sqlPath, 'utf8');
    
    console.log('📝 Executing SQL statements...');
    
    // Execute the migration SQL
    await client.query(sqlContent);
    
    console.log('✅ Migration completed successfully!');
    console.log('✨ Your data has been imported from db.json to PostgreSQL');
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run the migration
runMigration().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
