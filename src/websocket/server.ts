import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { Server } from 'http';

// Client interface for tracking connected users
export interface Client {
  ws: WebSocket;
  walletAddress?: string;
  subscriptions: Set<string>;
  isAlive: boolean;
}

// Subscription channels
export const CHANNELS = {
  ROUND: 'round',
  TRADES: 'trades',
  CHAT: 'chat',
  PRICES: 'prices'
} as const;

export type Channel = typeof CHANNELS[keyof typeof CHANNELS];

// Connected clients store
const clients: Map<WebSocket, Client> = new Map();

// WebSocket server instance
let wss: WebSocketServer | null = null;

/**
 * Initialize WebSocket server on existing HTTP server
 * Uses noServer mode for proper nginx/load balancer compatibility
 */
export function initializeWebSocket(server: Server): WebSocketServer {
  wss = new WebSocketServer({ 
    noServer: true,
    clientTracking: true
  });

  // Setup heartbeat to detect dead connections
  const heartbeatInterval = setInterval(() => {
    clients.forEach((client, ws) => {
      if (!client.isAlive) {
        console.log('[WebSocket] Terminating dead connection');
        clients.delete(ws);
        return ws.terminate();
      }
      client.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  console.log('[WebSocket] Server initialized');
  return wss;
}

/**
 * Handle new WebSocket connection
 */
export function handleConnection(ws: WebSocket, req: IncomingMessage): void {
  // Create client entry
  const client: Client = {
    ws,
    subscriptions: new Set(),
    isAlive: true
  };
  clients.set(ws, client);

  console.log(`[WebSocket] New connection. Total clients: ${clients.size}`);

  // Handle pong responses (heartbeat)
  ws.on('pong', () => {
    const client = clients.get(ws);
    if (client) {
      client.isAlive = true;
    }
  });

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'CONNECTED',
    message: 'Welcome to PumpIt!',
    timestamp: Date.now()
  }));
}

/**
 * Handle WebSocket close
 */
export function handleClose(ws: WebSocket): void {
  const client = clients.get(ws);
  if (client) {
    console.log(`[WebSocket] Client disconnected${client.walletAddress ? `: ${client.walletAddress}` : ''}`);
  }
  clients.delete(ws);
}

/**
 * Handle WebSocket error
 */
export function handleError(ws: WebSocket, error: Error): void {
  console.error('[WebSocket] Error:', error.message);
  clients.delete(ws);
}

/**
 * Get client by WebSocket
 */
export function getClient(ws: WebSocket): Client | undefined {
  return clients.get(ws);
}

/**
 * Get all connected clients
 */
export function getAllClients(): Map<WebSocket, Client> {
  return clients;
}

/**
 * Get clients subscribed to a channel
 */
export function getSubscribers(channel: string): Client[] {
  const subscribers: Client[] = [];
  clients.forEach(client => {
    if (client.subscriptions.has(channel)) {
      subscribers.push(client);
    }
  });
  return subscribers;
}

/**
 * Get client by wallet address
 */
export function getClientByWallet(walletAddress: string): Client | undefined {
  for (const client of clients.values()) {
    if (client.walletAddress === walletAddress) {
      return client;
    }
  }
  return undefined;
}

/**
 * Subscribe client to channels
 */
export function subscribeClient(ws: WebSocket, channels: string[]): void {
  const client = clients.get(ws);
  if (!client) return;

  channels.forEach(channel => {
    client.subscriptions.add(channel);
  });

  console.log(`[WebSocket] Client subscribed to: ${channels.join(', ')}`);
}

/**
 * Unsubscribe client from channels
 */
export function unsubscribeClient(ws: WebSocket, channels: string[]): void {
  const client = clients.get(ws);
  if (!client) return;

  channels.forEach(channel => {
    client.subscriptions.delete(channel);
  });
}

/**
 * Identify client with wallet address
 */
export function identifyClient(ws: WebSocket, walletAddress: string): void {
  const client = clients.get(ws);
  if (!client) return;

  client.walletAddress = walletAddress;
  console.log(`[WebSocket] Client identified: ${walletAddress}`);
}

/**
 * Send message to specific WebSocket
 */
export function sendToClient(ws: WebSocket, data: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

/**
 * Get WebSocket server instance
 */
export function getWebSocketServer(): WebSocketServer | null {
  return wss;
}

/**
 * Get connection stats
 */
export function getConnectionStats(): {
  totalConnections: number;
  identifiedUsers: number;
  subscriptionCounts: Record<string, number>;
} {
  let identifiedUsers = 0;
  const subscriptionCounts: Record<string, number> = {
    [CHANNELS.ROUND]: 0,
    [CHANNELS.TRADES]: 0,
    [CHANNELS.CHAT]: 0,
    [CHANNELS.PRICES]: 0
  };

  clients.forEach(client => {
    if (client.walletAddress) identifiedUsers++;
    client.subscriptions.forEach(sub => {
      subscriptionCounts[sub] = (subscriptionCounts[sub] || 0) + 1;
    });
  });

  return {
    totalConnections: clients.size,
    identifiedUsers,
    subscriptionCounts
  };
}
