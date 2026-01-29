import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { broadcastChat } from '../websocket/broadcast';
import { requireAuth } from '../middleware/auth';

const router = Router();

// Max message length
const MAX_MESSAGE_LENGTH = 500;

// GET /api/chat/:room - Get last 50 messages for room
router.get('/:room', async (req: Request, res: Response) => {
  try {
    const { room } = req.params;
    
    const messages = await prisma.chatMessage.findMany({
      where: { room },
      orderBy: { created_at: 'desc' },
      take: 50,
      include: {
        profile: {
          select: { wallet_address: true }
        }
      }
    });
    
    // Return in chronological order (oldest first)
    return res.json(messages.reverse().map(msg => ({
      id: msg.id,
      username: msg.username,
      wallet_address: msg.profile?.wallet_address || null,
      message: msg.message,
      room: msg.room,
      created_at: msg.created_at
    })));
    
  } catch (error) {
    console.error('Error in GET /chat/:room:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/chat - Send a message (requires auth)
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const wallet_address = req.walletAddress!;
    const { message, room = 'pumpit' } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }
    
    // Validate message length
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ 
        error: `Message too long. Max ${MAX_MESSAGE_LENGTH} characters` 
      });
    }
    
    // Sanitize message (basic XSS prevention)
    const sanitizedMessage = message
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .trim();
    
    if (!sanitizedMessage) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }
    
    // Get profile to get username
    const profile = await prisma.profile.findUnique({
      where: { wallet_address }
    });
    
    if (!profile) {
      return res.status(400).json({ error: 'Profile not found' });
    }
    
    // Use username or truncated wallet address
    const displayName = profile.username || 
      `${wallet_address.slice(0, 4)}...${wallet_address.slice(-4)}`;

    
    // Save message
    const chatMessage = await prisma.chatMessage.create({
      data: {
        profile_id: profile.id,
        username: displayName,
        message: sanitizedMessage,
        room
      }
    });
    
    const response = {
      id: chatMessage.id,
      username: chatMessage.username,
      wallet_address: profile.wallet_address,
      message: chatMessage.message,
      room: chatMessage.room,
      created_at: chatMessage.created_at
    };
    
    // Broadcast to WebSocket subscribers
    broadcastChat(response);
    
    return res.json(response);
    
  } catch (error) {
    console.error('Error in POST /chat:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
