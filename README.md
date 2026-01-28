# PumpIt Backend

Backend server for the PumpIt crypto trading game. Built with Express.js, TypeScript, Prisma, and WebSocket.

## Tech Stack

- **Express.js** - REST API framework
- **TypeScript** - Type safety
- **Prisma** - PostgreSQL ORM
- **WebSocket (ws)** - Real-time updates
- **@solana/web3.js** - Blockchain integration

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

## Railway Deployment

1. Create a new Railway project

2. Add PostgreSQL plugin
   - Railway auto-sets `DATABASE_URL` environment variable

3. Connect your GitHub repository

4. Add environment variables in Railway dashboard:
   ```
   SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
   ESCROW_PRIVATE_KEY=your_base58_private_key
   ESCROW_WALLET_ADDRESS=your_escrow_public_address
   HOUSE_WALLET_ADDRESS=your_house_wallet_address
   ```

5. Deploy
   - Railway auto-runs: `npm install` → `prisma generate` → `npm run build` → `npm start`

## API Endpoints

### Authentication
- `POST /api/auth/profile` - Get or create profile by wallet
- `POST /api/auth/username` - Set username
- `GET /api/auth/check-username/:username` - Check username availability

### Deposits & Withdrawals
- `POST /api/deposit/confirm` - Confirm deposit transaction
- `POST /api/withdraw` - Withdraw SOL to wallet

### Game
- `GET /api/game/round` - Get active round
- `POST /api/game/trade` - Execute buy/sell trade
- `POST /api/game/sell-all` - Sell all tokens
- `GET /api/game/position/:wallet_address` - Get player position
- `GET /api/game/leaderboard` - Get round leaderboard
- `GET /api/game/preview` - Preview trade impact

### Chat
- `GET /api/chat/:room` - Get chat history (last 50 messages)
- `POST /api/chat` - Send chat message

### Health
- `GET /health` - Server health check

## WebSocket

Connect to `ws://localhost:3001` (or your deployed URL)

### Subscribe to channels:
```json
{ "type": "subscribe", "channels": ["round", "trades", "chat"] }
```

### Identify with wallet:
```json
{ "type": "identify", "wallet_address": "YOUR_WALLET" }
```

### Send chat message:
```json
{ "type": "chat", "message": "Hello!", "room": "pumpit" }
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

## Scripts

- `npm run dev` - Development server with hot reload
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run db:push` - Push schema to database
- `npm run db:migrate` - Run migrations

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `SOLANA_RPC_URL` | Solana RPC endpoint |
| `ESCROW_PRIVATE_KEY` | Base58 private key for escrow wallet |
| `ESCROW_WALLET_ADDRESS` | Public address of escrow wallet |
| `HOUSE_WALLET_ADDRESS` | Public address for house fees |
| `PORT` | Server port (default: 3001) |
