import { WebSocket } from 'ws';
import prisma from '../lib/prisma';
import { 
  getClient, 
  subscribeClient, 
  unsubscribeClient, 
  identifyClient,
  sendToClient,
  CHANNELS
} from './server';
import { broadcastChat } from './broadcast';

// Message types from client
export interface SubscribeMessage {
  type: 'subscribe';
  channels: string[];
}

export interface UnsubscribeMessage {
  type: 'unsubscribe';
  channels: string[];
}

export interface IdentifyMessage {
  type: 'identify';
  wallet_address: string;
}

export interface ChatMessage {
  type: 'chat';
  message: string;
  room?: string;
}

export interface PingMessage {
  type: 'ping';
}

export type ClientMessage = 
  | SubscribeMessage 
  | UnsubscribeMessage 
  | IdentifyMessage 
  | ChatMessage 
  | PingMessage;

/**
 * Handle incoming WebSocket message
 */
export async function handleMessage(ws: WebSocket, data: string): Promise<void> {
  try {
    const message = JSON.parse(data) as ClientMessage;
    
    switch (message.type) {
      case 'subscribe':
        handleSubscribe(ws, message);
        break;
        
      case 'unsubscribe':
        handleUnsubscribe(ws, message);
        break;
        
      case 'identify':
        await handleIdentify(ws, message);
        break;
        
      case 'chat':
        await handleChat(ws, message);
        break;
        
      case 'ping':
        handlePing(ws);
        break;
        
      default:
        sendToClient(ws, {
          type: 'ERROR',
          error: 'Unknown message type'
        });
    }
  } catch (error) {
    console.error('[WebSocket] Error handling message:', error);
    sendToClient(ws, {
      type: 'ERROR',
      error: 'Invalid message format'
    });
  }
}

/**
 * Handle subscribe request
 */
function handleSubscribe(ws: WebSocket, message: SubscribeMessage): void {
  const validChannels = message.channels.filter(ch => 
    Object.values(CHANNELS).includes(ch as any)
  );
  
  if (validChannels.length === 0) {
    sendToClient(ws, {
      type: 'ERROR',
      error: 'No valid channels specified'
    });
    return;
  }
  
  subscribeClient(ws, validChannels);
  
  sendToClient(ws, {
    type: 'SUBSCRIBED',
    channels: validChannels
  });
}

/**
 * Handle unsubscribe request
 */
function handleUnsubscribe(ws: WebSocket, message: UnsubscribeMessage): void {
  unsubscribeClient(ws, message.channels);
  
  sendToClient(ws, {
    type: 'UNSUBSCRIBED',
    channels: message.channels
  });
}

/**
 * Handle identify request
 */
async function handleIdentify(ws: WebSocket, message: IdentifyMessage): Promise<void> {
  const { wallet_address } = message;
  
  if (!wallet_address) {
    sendToClient(ws, {
      type: 'ERROR',
      error: 'wallet_address is required'
    });
    return;
  }
  
  // Verify profile exists
  const profile = await prisma.profile.findUnique({
    where: { wallet_address }
  });
  
  if (!profile) {
    sendToClient(ws, {
      type: 'ERROR',
      error: 'Profile not found'
    });
    return;
  }
  
  identifyClient(ws, wallet_address);
  
  sendToClient(ws, {
    type: 'IDENTIFIED',
    wallet_address,
    username: profile.username,
    deposited_balance: Number(profile.deposited_balance)
  });
}

/**
 * Handle chat message
 */
async function handleChat(ws: WebSocket, message: ChatMessage): Promise<void> {
  const client = getClient(ws);
  
  if (!client?.walletAddress) {
    sendToClient(ws, {
      type: 'ERROR',
      error: 'Must identify before sending chat messages'
    });
    return;
  }
  
  const { message: text, room = 'pumpit' } = message;
  
  if (!text || text.trim().length === 0) {
    sendToClient(ws, {
      type: 'ERROR',
      error: 'Message cannot be empty'
    });
    return;
  }
  
  if (text.length > 500) {
    sendToClient(ws, {
      type: 'ERROR',
      error: 'Message too long (max 500 characters)'
    });
    return;
  }
  
  // Get profile
  const profile = await prisma.profile.findUnique({
    where: { wallet_address: client.walletAddress }
  });
  
  if (!profile) {
    sendToClient(ws, {
      type: 'ERROR',
      error: 'Profile not found'
    });
    return;
  }
  
  // Sanitize message
  const sanitizedMessage = text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim();
  
  const displayName = profile.username || 
    `${client.walletAddress.slice(0, 4)}...${client.walletAddress.slice(-4)}`;
  
  // Save to database
  const chatMessage = await prisma.chatMessage.create({
    data: {
      profile_id: profile.id,
      username: displayName,
      message: sanitizedMessage,
      room
    }
  });
  
  // Broadcast to all chat subscribers
  broadcastChat({
    id: chatMessage.id,
    username: displayName,
    wallet_address: client.walletAddress,
    message: sanitizedMessage,
    room,
    created_at: chatMessage.created_at
  });
}

/**
 * Handle ping message
 */
function handlePing(ws: WebSocket): void {
  sendToClient(ws, {
    type: 'PONG',
    timestamp: Date.now()
  });
}
