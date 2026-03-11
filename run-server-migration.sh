cat > run-server-migration.sh << 'EOF'

# Server Migration Script- Convert db.json to SQL and import to Supabase
# Run this from your backend5 directory

echo "======================================"
echo "🚀 Starting JSON to SQL Migration"
echo "======================================"
echo ""

# Check if we're in the right directory
if [ ! -f "data/db.json" ]; then
   echo "❌ Error: data/db.json not found!"
   echo "Please run this script from the backend5 directory."
   exit 1
fi

echo "✅ Found db.json file"
DB_SIZE=$(ls -lh data/db.json | awk '{print $5}')
echo "   File size: $DB_SIZE"
echo ""

# Check if .env exists
if [ ! -f ".env" ]; then
   echo "❌ Error: .env file not found!"
   exit 1
fi

echo "✅ Found .env file"

# Extract database connection from .env
DATABASE_URL=$(grep "^DATABASE_URL=" .env | cut -d'=' -f2)

if [ -z "$DATABASE_URL" ]; then
   echo "❌ Error: DATABASE_URL not found in .env!"
   exit 1
fi

echo "✅ Database URL configured"
echo ""

# Check if Node.js is available
if ! command -v node &> /dev/null; then
   echo "❌ Error: Node.js is not installed!"
   echo ""
   echo "Please install Node.js first:"
   echo "  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -"
   echo "  sudo yum install -y nodejs"
   exit 1
fi

NODE_VERSION=$(node --version)
echo "✅ Node.js found: $NODE_VERSION"

# Check if pg package is available
if ! npm list pg &> /dev/null; then
   echo ""
   echo "⚙️  Installing pg package..."
    npm install pg --save
fi

echo "✅ PostgreSQL client ready"
echo ""

# Create a Node.js script to read db.json and generate SQL
echo "📝 Reading db.json and converting to SQL..."

cat > temp-convert-db.js << 'CONVERT_EOF'
const fs = require('fs');
const path = require('path');

// Read db.json
const dbPath = path.join(process.cwd(), 'data', 'db.json');
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

console.log('📊 Data found in db.json:');
console.log('-------------------');
for (const [table, data] of Object.entries(db)) {
    console.log(`  ${table}: ${Array.isArray(data) ? data.length : 0} records`);
}
console.log('');

// Generate SQL INSERT statements
let sqlContent = `-- Auto-generated migration from db.json
-- Generated at: ${new Date().toISOString()}

`;

// Helper function to escape strings for SQL
function escapeSql(str) {
    if (str === null || str === undefined) return 'NULL';
    if (typeof str === 'boolean') return str ? 'true' : 'false';
    if (typeof str === 'number') return str.toString();
    if (typeof str === 'string') {
        // Escape single quotes and backslashes
        const escaped = str.replace(/'/g, "''").replace(/\\/g, '\\\\');
        return `'${escaped}'`;
    }
    return str;
}

// Generate INSERT for each table
const tables = [
    'app_users', 'api_keys', 'trading_strategies', 'webhook_logs',
    'user_roles', 'trades', 'gas_fee_balances', 'gas_fee_transactions',
    'bot_status', 'profiles', 'pending_deposits', 'deposit_addresses',
    'app_settings', 'positions', 'profit_settlements', 'referral_commissions',
    'admin_earnings', 'user_settings', 'account_balances'
];

tables.forEach(table => {
    const records = db[table] || [];
    if (records.length === 0) {
        console.log(`⏭️  Skipping ${table} (no data)`);
        return;
    }
    
    console.log(`✏️  Generating SQL for ${table} (${records.length} records)`);
    
    // Skip empty arrays
    if (!Array.isArray(records) || records.length === 0) return;
    
    sqlContent += `\n-- ============================================\n`;
    sqlContent += `-- ${table.toUpperCase()}\n`;
    sqlContent += `-- ============================================\n`;
    
    records.forEach((record, idx) => {
        try {
            const keys = Object.keys(record);
            const values = keys.map(key => {
                const val = record[key];
                if (val === null || val === undefined) return 'NULL';
                if (Array.isArray(val)) {
                    // Convert array to PostgreSQL array format
                    const arrayVals = val.map(v => typeof v === 'string' ? `'${v}'` : v).join(', ');
                    return `ARRAY[${arrayVals}]`;
                }
                if (typeof val === 'object') {
                    // Convert object to JSONB
                    return `'${JSON.stringify(val)}'::jsonb`;
                }
                return escapeSql(val);
            });
            
            const columns = keys.join(', ');
            const valuesStr = values.join(', ');
            
            sqlContent += `\nINSERT INTO ${table} (${columns}) VALUES (${valuesStr}) ON CONFLICT DO NOTHING;\n`;
        } catch (error) {
            console.error(`❌ Error processing record ${idx} in ${table}:`, error.message);
        }
    });
    
    sqlContent += '\n';
});

console.log('');
console.log('✅ SQL generation complete!');

// Write SQL file
const outputPath = path.join(process.cwd(), 'src', 'db', 'import-json-data.sql');
fs.writeFileSync(outputPath, sqlContent, 'utf8');
console.log(`💾 Saved to: ${outputPath}`);
console.log('');
console.log('🎉 Next step: Run this SQL in Supabase Dashboard or use psql command');

CONVERT_EOF

# Run the conversion script
node temp-convert-db.js

if [ $? -ne 0 ]; then
   echo ""
   echo "❌ Conversion failed!"
    rm -f temp-convert-db.js
   exit 1
fi

# Clean up
rm -f temp-convert-db.js

echo ""
echo "======================================"
echo "✅ SQL file generated successfully!"
echo "======================================"
echo ""
echo "📄 Location: src/db/import-json-data.sql"
echo ""
echo "Now you have 2 options:"
echo ""
echo "Option 1: Run via psql (Direct)"
echo "  psql \"$DATABASE_URL\" < src/db/import-json-data.sql"
echo ""
echo "Option 2: Run via Supabase Dashboard"
echo "  1. Go to: https://supabase.com/dashboard/project/nmepquzyabhiipdpjrkm"
echo "  2. Open SQL Editor"
echo "  3. Copy content from src/db/import-json-data.sql"
echo "  4. Paste and Run"
echo ""
read -p "Do you want to run the migration now via psql? (y/n): " -n 1-r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
   echo ""
   echo "======================================"
   echo "🚀 Running Migration..."
   echo "======================================"
   echo ""
    
    # Run the migration
    psql "$DATABASE_URL" < src/db/import-json-data.sql
    
    if [ $? -eq 0 ]; then
       echo ""
       echo "======================================"
       echo "✅ Migration completed successfully!"
       echo "======================================"
       echo ""
        
        # Verify the migration
       echo "🔍 Verifying migrated data..."
       echo ""
        
        psql "$DATABASE_URL" << 'VERIFY_SQL'
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
ORDER BY table_name;
VERIFY_SQL
        
       echo ""
       echo "🎉 All done! Don't forget to restart your backend:"
       echo "   pm2 restart all"
       echo ""
    else
       echo ""
       echo "❌ Migration failed! Please check the error messages above."
       echo ""
       exit 1
    fi
else
   echo ""
   echo "No problem! You can run the migration later with:"
   echo "  psql \"$DATABASE_URL\" < src/db/import-json-data.sql"
   echo ""
   echo "Or copy the SQL file content to Supabase Dashboard."
   echo ""
fi
EOF

# Make executable
chmod +x run-server-migration.sh