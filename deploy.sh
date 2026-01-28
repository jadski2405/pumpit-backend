#!/bin/bash

# PumpIt Backend Deployment Script for AWS EC2
# Usage: ./deploy.sh

set -e

echo "🚀 Starting PumpIt deployment..."

cd /home/ec2-user/pumpit-backend

echo "📥 Pulling latest code..."
git pull origin main

echo "📦 Installing dependencies..."
npm install

echo "🔨 Building application..."
npm run build

echo "🗄️ Running database migrations..."
npx prisma migrate deploy

echo "🔄 Restarting PM2 process..."
pm2 restart pumpit-backend || pm2 start ecosystem.config.js

echo "💾 Saving PM2 process list..."
pm2 save

echo "✅ Deployment complete!"
echo "📊 Check status with: pm2 status"
echo "📋 View logs with: pm2 logs pumpit-backend"
