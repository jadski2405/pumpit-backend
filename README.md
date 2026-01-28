# PumpIt Backend

Backend server for the PumpIt crypto trading game. Built with Express.js, TypeScript, Prisma, WebSocket, and Solana integration.

## Features

- 🎮 30-second trading rounds with AMM-based price discovery
- 💰 Solana wallet authentication and deposits
- 📡 Real-time WebSocket updates for trades and prices
- 💬 In-game chat system
- 🏆 Leaderboards and player stats

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Language**: TypeScript
- **Database**: PostgreSQL with Prisma ORM
- **WebSocket**: ws library
- **Blockchain**: Solana (@solana/web3.js)

---

## Local Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy environment file and fill in values:
   ```bash
   cp .env.example .env
   ```

3. Set up the database:
   ```bash
   npx prisma db push
   ```

4. Start development server:
   ```bash
   npm run dev
   ```

The server will start at `http://localhost:3001`

---

## AWS EC2 Deployment

### 1. Create RDS PostgreSQL Database

1. Go to **AWS Console → RDS → Create database**
2. Select **PostgreSQL 15**
3. Template: **Free tier** (or production for live)
4. Settings:
   - DB identifier: `pumpit-db`
   - Master username: `pumpit`
   - Create and save a secure password
5. Connectivity:
   - Public access: **Yes** (for initial setup, disable later)
   - VPC security group: Create new or use existing
6. Click **Create database**
7. Note the **Endpoint** after creation (e.g., `pumpit-db.xxxx.us-east-1.rds.amazonaws.com`)

### 2. Create EC2 Instance

1. Go to **AWS Console → EC2 → Launch instance**
2. Name: `pumpit-backend`
3. AMI: **Amazon Linux 2023**
4. Instance type: **t3.micro** (free tier) or **t3.small** (recommended)
5. Key pair: Create new, download `.pem` file
6. Network settings:
   - Allow SSH traffic from: My IP
   - Allow HTTPS traffic from: Anywhere
   - Allow HTTP traffic from: Anywhere
7. Add **Custom TCP Rule** for port **3001** from **Anywhere**
8. Click **Launch instance**

### 3. Configure RDS Security Group

1. Go to RDS → Your database → Security group
2. Edit inbound rules
3. Add rule: **PostgreSQL (5432)** from EC2 security group or EC2's private IP

### 4. Connect to EC2

```bash
# Make key file secure (on Mac/Linux)
chmod 400 your-key.pem

# Connect
ssh -i your-key.pem ec2-user@YOUR_EC2_PUBLIC_IP
```

### 5. Install Dependencies on EC2

```bash
# Update system
sudo yum update -y

# Install Git
sudo yum install -y git

# Install Node.js 18
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs

# Verify installation
node --version  # Should be v18.x.x
npm --version

# Install PM2 globally
sudo npm install -g pm2
```

### 6. Clone and Setup Application

```bash
# Clone repository
git clone https://github.com/jadski2405/pumpit-backend.git
cd pumpit-backend

# Install dependencies
npm install

# Create environment file
nano .env
```

Add the following to `.env`:
```env
DATABASE_URL=postgresql://pumpit:YOUR_PASSWORD@YOUR_RDS_ENDPOINT:5432/pumpit
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
ESCROW_PRIVATE_KEY=your_base58_private_key
ESCROW_WALLET_ADDRESS=your_escrow_public_address
HOUSE_WALLET_ADDRESS=your_house_wallet_address
PORT=3001
NODE_ENV=production
```

```bash
# Build application
npm run build

# Setup database
npx prisma db push

# Start with PM2
pm2 start ecosystem.config.js

# Save PM2 process list
pm2 save

# Setup PM2 to start on reboot
pm2 startup
# Run the command it outputs
```

### 7. Setup Nginx Reverse Proxy (Recommended for SSL)

```bash
# Install Nginx
sudo yum install -y nginx

# Start Nginx
sudo systemctl start nginx
sudo systemctl enable nginx

# Create config
sudo nano /etc/nginx/conf.d/pumpit.conf
```

Add this configuration:
```nginx
server {
    listen 80;
    server_name your-domain.com;  # Or use EC2 public IP

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

```bash
# Test config
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

### 8. Setup SSL with Certbot (Optional but Recommended)

```bash
# Install Certbot
sudo yum install -y certbot python3-certbot-nginx

# Get certificate
sudo certbot --nginx -d your-domain.com

# Auto-renewal is configured automatically
```

---

## Deployment Updates

After making changes, SSH to EC2 and run:

```bash
cd /home/ec2-user/pumpit-backend
./deploy.sh
```

Or manually:
```bash
git pull origin main
npm install
npm run build
npx prisma migrate deploy
pm2 restart pumpit-backend
```

---

## API Endpoints

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/profile` | Get/create user profile |
| POST | `/api/auth/username` | Set username |
| GET | `/api/auth/check-username/:username` | Check username availability |

### Deposits & Withdrawals
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/deposit/confirm` | Confirm SOL deposit |
| POST | `/api/withdraw` | Withdraw winnings |

### Game
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/game/round` | Get current round |
| POST | `/api/game/trade` | Execute buy/sell trade |
| POST | `/api/game/sell-all` | Sell all tokens |
| GET | `/api/game/position/:walletAddress` | Get player position |
| GET | `/api/game/leaderboard` | Get leaderboard |
| GET | `/api/game/preview` | Preview trade impact |

### Chat
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/chat/:room` | Get chat messages |
| POST | `/api/chat` | Send message |

### Health
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Server health check |

---

## WebSocket

Connect to `ws://YOUR_HOST:3001` (or `wss://` with SSL)

### Subscribe to channels:
```json
{"type": "SUBSCRIBE", "channels": ["round", "trades", "prices"]}
```

### Identify with wallet:
```json
{"type": "IDENTIFY", "wallet_address": "YOUR_WALLET"}
```

### Send chat message:
```json
{"type": "CHAT", "message": "Hello!", "room": "pumpit"}
```

### Events received:
- `ROUND_UPDATE` - Round state updates (every second)
- `ROUND_STARTED` - New round begins
- `ROUND_ENDED` - Round completed
- `TRADE` - Trade executed
- `PRICE_UPDATE` - Price changed
- `CHAT` - New chat message
- `POSITION_UPDATE` - Your position changed
- `BALANCE_UPDATE` - Your balance changed

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Development server with hot reload |
| `npm run build` | Build for production |
| `npm start` | Start production server |
| `npm run db:push` | Push schema to database |
| `npm run db:migrate` | Run migrations |

---

## PM2 Commands

```bash
# View status
pm2 status

# View logs
pm2 logs pumpit-backend

# Restart
pm2 restart pumpit-backend

# Stop
pm2 stop pumpit-backend

# Monitor
pm2 monit
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `SOLANA_RPC_URL` | Solana RPC endpoint |
| `ESCROW_PRIVATE_KEY` | Base58 escrow wallet private key |
| `ESCROW_WALLET_ADDRESS` | Escrow wallet public address |
| `HOUSE_WALLET_ADDRESS` | House fee wallet address |
| `PORT` | Server port (default: 3001) |
| `NODE_ENV` | Environment (development/production) |

---

## Troubleshooting

### WebSocket not connecting
- Check security group allows port 3001
- Verify Nginx upgrade headers are set
- Check PM2 logs for errors

### Database connection failed
- Verify RDS security group allows EC2
- Check DATABASE_URL is correct
- Ensure RDS is publicly accessible (or use VPC)

### PM2 not starting on reboot
```bash
pm2 startup
pm2 save
```

---

## License

ISC
