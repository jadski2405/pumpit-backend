import { WebSocket } from 'ws';
import { 
  getAllClients, 
  getSubscribers, 
  getClientByWallet, 
  sendToClient,
  CHANNELS 
} from './server';

// Event types
export const WS_EVENTS = {
  // Round events
  ROUND_UPDATE: 'ROUND_UPDATE',
  ROUND_STARTED: 'ROUND_STARTED',
  ROUND_ENDING: 'ROUND_ENDING',
  ROUND_ENDED: 'ROUND_ENDED',
  COUNTDOWN: 'COUNTDOWN',
  
  // Trade events
  TRADE: 'TRADE',
  PRICE_UPDATE: 'PRICE_UPDATE',
  
  // Position events
  POSITION_UPDATE: 'POSITION_UPDATE',
  BALANCE_UPDATE: 'BALANCE_UPDATE',
  
  // Chat events
  CHAT: 'CHAT',
  
  // Other
  FORFEITURE: 'FORFEITURE'
} as const;

// Round data for broadcast
export interface RoundBroadcast {
  id: string;
  status: string;
  pool_sol_balance: number;
  pool_token_supply: number;
  current_price: number;
  price_multiplier: number;
  time_remaining: number;
  positions_count?: number;
}

// Trade data for broadcast
export interface TradeBroadcast {
  id?: string;
  round_id: string;
  trade_type: 'buy' | 'sell';
  username: string;
  wallet_address: string;
  sol_amount: number;
  token_amount: number;
  price: number;
  timestamp: number;
}

// Chat data for broadcast
export interface ChatBroadcast {
  id: string;
  username: string;
  wallet_address?: string;
  message: string;
  room: string;
  created_at: Date;
}

// Position update for specific user
export interface PositionBroadcast {
  round_id: string;
  token_balance: number;
  total_sol_in: number;
  total_sol_out: number;
  current_value: number;
  pnl: number;
  pnl_percent: number;
}

// Balance update for specific user
export interface BalanceBroadcast {
  deposited_balance: number;
  change: number;
  reason: string;
}

/**
 * Broadcast to all clients subscribed to a channel
 */
function broadcastToChannel(channel: string, data: object): void {
  const subscribers = getSubscribers(channel);
  const message = JSON.stringify(data);
  
  subscribers.forEach(client => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  });
}

/**
 * Broadcast to all connected clients
 */
export function broadcastToAll(data: object): void {
  const clients = getAllClients();
  const message = JSON.stringify(data);
  
  clients.forEach(client => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  });
}

/**
 * Broadcast round update to round subscribers
 */
export function broadcastRoundUpdate(round: RoundBroadcast): void {
  broadcastToChannel(CHANNELS.ROUND, {
    type: WS_EVENTS.ROUND_UPDATE,
    round,
    timestamp: Date.now()
  });
}

/**
 * Broadcast round started event
 */
export function broadcastRoundStarted(round: RoundBroadcast): void {
  broadcastToChannel(CHANNELS.ROUND, {
    type: WS_EVENTS.ROUND_STARTED,
    round,
    timestamp: Date.now()
  });
}

/**
 * Broadcast round ending warning (last few seconds)
 */
export function broadcastRoundEnding(roundId: string, secondsRemaining: number): void {
  broadcastToChannel(CHANNELS.ROUND, {
    type: WS_EVENTS.ROUND_ENDING,
    round_id: roundId,
    seconds_remaining: secondsRemaining,
    timestamp: Date.now()
  });
}

/**
 * Broadcast round ended event
 */
export function broadcastRoundEnded(
  roundId: string, 
  finalPrice: number, 
  poolSolBalance: number,
  forfeitures: { profile_id: string; tokens_forfeited: number; sol_value_lost: number }[]
): void {
  broadcastToChannel(CHANNELS.ROUND, {
    type: WS_EVENTS.ROUND_ENDED,
    round_id: roundId,
    final_price: finalPrice,
    pool_sol_balance: poolSolBalance,
    forfeitures,
    timestamp: Date.now()
  });
}

/**
 * Broadcast countdown between rounds
 */
export function broadcastCountdown(secondsRemaining: number): void {
  broadcastToChannel(CHANNELS.ROUND, {
    type: WS_EVENTS.COUNTDOWN,
    seconds_remaining: secondsRemaining,
    message: secondsRemaining > 0 
      ? `Next round in ${secondsRemaining}s` 
      : 'Starting new round!',
    timestamp: Date.now()
  });
}

/**
 * Broadcast trade to trades subscribers
 */
export function broadcastTrade(trade: TradeBroadcast): void {
  broadcastToChannel(CHANNELS.TRADES, {
    type: WS_EVENTS.TRADE,
    trade,
    timestamp: Date.now()
  });
}

/**
 * Broadcast price update
 */
export function broadcastPriceUpdate(
  roundId: string,
  price: number,
  priceMultiplier: number,
  poolSol: number,
  poolTokens: number
): void {
  broadcastToChannel(CHANNELS.PRICES, {
    type: WS_EVENTS.PRICE_UPDATE,
    round_id: roundId,
    price,
    price_multiplier: priceMultiplier,
    pool_sol_balance: poolSol,
    pool_token_supply: poolTokens,
    timestamp: Date.now()
  });
  
  // Also send to round subscribers
  broadcastToChannel(CHANNELS.ROUND, {
    type: WS_EVENTS.PRICE_UPDATE,
    round_id: roundId,
    price,
    price_multiplier: priceMultiplier,
    pool_sol_balance: poolSol,
    pool_token_supply: poolTokens,
    timestamp: Date.now()
  });
}

/**
 * Broadcast chat message to chat subscribers
 */
export function broadcastChat(message: ChatBroadcast): void {
  broadcastToChannel(CHANNELS.CHAT, {
    type: WS_EVENTS.CHAT,
    message,
    timestamp: Date.now()
  });
}

/**
 * Send position update to specific wallet
 */
export function sendPositionUpdate(walletAddress: string, position: PositionBroadcast): void {
  const client = getClientByWallet(walletAddress);
  if (client) {
    sendToClient(client.ws, {
      type: WS_EVENTS.POSITION_UPDATE,
      position,
      timestamp: Date.now()
    });
  }
}

/**
 * Send balance update to specific wallet
 */
export function sendBalanceUpdate(walletAddress: string, balance: BalanceBroadcast): void {
  const client = getClientByWallet(walletAddress);
  if (client) {
    sendToClient(client.ws, {
      type: WS_EVENTS.BALANCE_UPDATE,
      balance,
      timestamp: Date.now()
    });
  }
}

/**
 * Send forfeiture notification to specific wallet
 */
export function sendForfeitureNotification(
  walletAddress: string, 
  tokensForfeited: number, 
  solValueLost: number
): void {
  const client = getClientByWallet(walletAddress);
  if (client) {
    sendToClient(client.ws, {
      type: WS_EVENTS.FORFEITURE,
      tokens_forfeited: tokensForfeited,
      sol_value_lost: solValueLost,
      message: `Round ended! You forfeited ${tokensForfeited.toFixed(2)} tokens worth ${solValueLost.toFixed(4)} SOL`,
      timestamp: Date.now()
    });
  }
}

/**
 * Send message to specific wallet
 */
export function sendToWallet(walletAddress: string, event: object): void {
  const client = getClientByWallet(walletAddress);
  if (client) {
    sendToClient(client.ws, event);
  }
}
