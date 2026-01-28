import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocket } from 'ws';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

// Import routes
import authRoutes from './routes/auth';
import depositRoutes from './routes/deposit';
import gameRoutes from './routes/game';
import chatRoutes from './routes/chat';

// Import services
import { startRoundManager, stopRoundManager } from './services/roundManager';

// Import WebSocket modules
import { 
  initializeWebSocket, 
  handleConnection, 
  handleClose, 
  handleError,
  getConnectionStats
} from './websocket/server';
import { handleMessage } from './websocket/handlers';
import { broadcastToAll } from './websocket/broadcast';

// Load environment variables
dotenv.config();

// Server port
const PORT = process.env.PORT || 3001;

// Allowed origins for CORS
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'https://str8.fun',
  'https://www.str8.fun'
];

// Initialize Prisma client
export const prisma = new PrismaClient();

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Initialize WebSocket server
const wss = initializeWebSocket(server);

// Middleware
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    
    if (ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      // In development, allow all origins
      if (process.env.NODE_ENV !== 'production') {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  const wsStats = getConnectionStats();
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    ws: `ws://localhost:${PORT}`,
    connections: wsStats
  });
});

// API routes
app.get('/api', (req, res) => {
  res.json({ 
    message: 'Welcome to PumpIt API',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      deposit: '/api/deposit',
      withdraw: '/api/withdraw',
      game: '/api/game',
      chat: '/api/chat'
    },
    websocket: {
      url: `ws://localhost:${PORT}`,
      channels: ['round', 'trades', 'chat', 'prices']
    }
  });
});

// Mount route modules
app.use('/api/auth', authRoutes);
app.use('/api/deposit', depositRoutes);
app.use('/api/withdraw', depositRoutes);
app.use('/api/game', gameRoutes);
app.use('/api/chat', chatRoutes);

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  handleConnection(ws, req);

  ws.on('message', (data) => {
    handleMessage(ws, data.toString());
  });

  ws.on('close', () => {
    handleClose(ws);
  });

  ws.on('error', (error) => {
    handleError(ws, error);
  });
});

// Export broadcast function for backward compatibility with roundManager
export function broadcast(data: object) {
  broadcastToAll(data);
}

// Graceful shutdown
async function shutdown() {
  console.log('Shutting down gracefully...');
  
  // Stop round manager
  stopRoundManager();
  console.log('Round manager stopped');
  
  wss.close(() => {
    console.log('WebSocket server closed');
  });
  
  await prisma.$disconnect();
  console.log('Database connection closed');
  
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start server
server.listen(PORT, () => {
  console.log(`🚀 PumpIt server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  
  // Start round manager background job
  startRoundManager();
  console.log(`🎮 Round manager started`);
});
