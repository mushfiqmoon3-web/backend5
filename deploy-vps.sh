#!/bin/bash

# VPS Deployment Script for Trading Bot Backend
# Run this script on your VPS after uploading the backend folder

set -e  # Exit on error

echo "🚀 Starting Backend Deployment..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}Please run as root (use sudo)${NC}"
    exit 1
fi

# Step 1: Update system
echo -e "${YELLOW}Step 1: Updating system...${NC}"
apt update && apt upgrade -y

# Step 2: Install Node.js if not installed
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}Step 2: Installing Node.js...${NC}"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
else
    echo -e "${GREEN}Node.js already installed: $(node --version)${NC}"
fi

# Step 3: Install PM2 if not installed
if ! command -v pm2 &> /dev/null; then
    echo -e "${YELLOW}Step 3: Installing PM2...${NC}"
    npm install -g pm2
else
    echo -e "${GREEN}PM2 already installed: $(pm2 --version)${NC}"
fi

# Step 4: Navigate to backend directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo -e "${YELLOW}Step 4: Current directory: $(pwd)${NC}"

# Step 5: Install dependencies
echo -e "${YELLOW}Step 5: Installing dependencies...${NC}"
npm install --production

# Step 6: Build project
echo -e "${YELLOW}Step 6: Building project...${NC}"
npm run build

# Step 7: Create required directories
echo -e "${YELLOW}Step 7: Creating directories...${NC}"
mkdir -p data logs uploads
chmod 755 data logs uploads

# Step 8: Check if .env exists
if [ ! -f .env ]; then
    echo -e "${RED}.env file not found!${NC}"
    echo -e "${YELLOW}Creating .env file template...${NC}"
    cat > .env << EOF
NODE_ENV=production
PORT=8080
JWT_SECRET=CHANGE-THIS-TO-A-STRONG-SECRET-MIN-32-CHARACTERS
JWT_EXPIRES_IN=60d
CRON_ENABLED=true
CORS_ORIGIN=*
LOG_LEVEL=info
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
EOF
    echo -e "${RED}⚠️  IMPORTANT: Edit .env file and set JWT_SECRET and CORS_ORIGIN!${NC}"
    echo -e "${YELLOW}Run: nano .env${NC}"
    exit 1
fi

# Step 9: Check if ecosystem.config.js exists
if [ ! -f ecosystem.config.js ]; then
    echo -e "${YELLOW}Step 9: Creating ecosystem.config.js...${NC}"
    cat > ecosystem.config.js << EOF
module.exports = {
  apps: [{
    name: 'trading-bot-backend',
    script: 'dist/index.js',
    cwd: '$(pwd)',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 8080,
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
  }]
};
EOF
fi

# Step 10: Stop existing PM2 process if running
echo -e "${YELLOW}Step 10: Managing PM2 process...${NC}"
pm2 delete trading-bot-backend 2>/dev/null || true

# Step 11: Start with PM2
echo -e "${YELLOW}Step 11: Starting backend with PM2...${NC}"
pm2 start ecosystem.config.js

# Step 12: Save PM2 process list
echo -e "${YELLOW}Step 12: Saving PM2 process list...${NC}"
pm2 save

# Step 13: Setup auto-start
echo -e "${YELLOW}Step 13: Setting up auto-start...${NC}"
STARTUP_CMD=$(pm2 startup | grep -v "PM2" | grep -v "command" | tail -1)
if [ ! -z "$STARTUP_CMD" ]; then
    echo -e "${GREEN}Run this command to enable auto-start:${NC}"
    echo -e "${YELLOW}$STARTUP_CMD${NC}"
fi

# Step 14: Check status
echo -e "${YELLOW}Step 14: Checking status...${NC}"
sleep 2
pm2 status

# Step 15: Test health endpoint
echo -e "${YELLOW}Step 15: Testing health endpoint...${NC}"
sleep 2
HEALTH_RESPONSE=$(curl -s http://localhost:8080/health || echo "FAILED")
if [[ $HEALTH_RESPONSE == *"ok"* ]]; then
    echo -e "${GREEN}✅ Backend is running successfully!${NC}"
    echo -e "${GREEN}Health check response: $HEALTH_RESPONSE${NC}"
else
    echo -e "${RED}❌ Backend health check failed${NC}"
    echo -e "${YELLOW}Check logs: pm2 logs trading-bot-backend${NC}"
fi

# Step 16: Firewall setup reminder
echo -e "${YELLOW}Step 16: Firewall reminder...${NC}"
echo -e "${YELLOW}Don't forget to:${NC}"
echo -e "  - Allow port 8080: ${GREEN}ufw allow 8080/tcp${NC}"
echo -e "  - Enable firewall: ${GREEN}ufw enable${NC}"

echo ""
echo -e "${GREEN}🎉 Deployment completed!${NC}"
echo ""
echo -e "${YELLOW}Useful commands:${NC}"
echo -e "  View logs: ${GREEN}pm2 logs trading-bot-backend${NC}"
echo -e "  Restart: ${GREEN}pm2 restart trading-bot-backend${NC}"
echo -e "  Status: ${GREEN}pm2 status${NC}"
echo -e "  Monitor: ${GREEN}pm2 monit${NC}"

