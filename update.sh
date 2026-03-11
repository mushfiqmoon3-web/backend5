#!/bin/bash

echo "🔄 Updating Backend5 from GitHub..."

# Navigate to backend directory
cd /root/backend5 || exit 1

# Stop the application
echo "⏹️  Stopping PM2 process..."
pm2 stop trading-bot-backend

# Pull latest changes
echo "📥 Pulling latest code..."
git pull origin main

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Build the application
echo "🔨 Building application..."
npm run build

# Restart the application
echo "▶️  Restarting PM2 process..."
pm2 restart trading-bot-backend

# Show status
echo ""
echo "✅ Update complete!"
echo ""
pm2 list
