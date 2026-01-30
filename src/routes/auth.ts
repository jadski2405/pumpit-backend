import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth } from '../middleware/auth';

const router = Router();

// Username validation: 1-20 chars, alphanumeric only, max 1 capital letter
function validateUsername(username: string): { valid: boolean; error?: string } {
  if (!username || username.length < 1 || username.length > 20) {
    return { valid: false, error: 'Username must be 1-20 characters' };
  }
  
  if (!/^[a-zA-Z0-9]+$/.test(username)) {
    return { valid: false, error: 'Username must be alphanumeric only' };
  }
  
  const capitalCount = (username.match(/[A-Z]/g) || []).length;
  if (capitalCount > 1) {
    return { valid: false, error: 'Username can have at most 1 capital letter' };
  }
  
  return { valid: true };
}

// POST /api/auth/profile - Get or create profile (requires Privy auth)
router.post('/profile', requireAuth, async (req: Request, res: Response) => {
  try {
    const wallet_address = req.walletAddress!;
    const privy_user_id = req.privyUserId!;
    
    // First, check if this Privy user already has a profile
    const existingPrivyProfile = await prisma.profile.findFirst({
      where: { privy_user_id }
    });

    if (existingPrivyProfile) {
      // Privy user already has a profile - return it
      if (existingPrivyProfile.wallet_address !== wallet_address) {
        return res.status(400).json({
          success: false,
          error: 'This account is already linked to a different wallet. Please use the original wallet.'
        });
      }
      
      // Same wallet, same privy user - return existing profile
      return res.json({
        success: true,
        id: existingPrivyProfile.id,
        wallet_address: existingPrivyProfile.wallet_address,
        username: existingPrivyProfile.username,
        deposited_balance: existingPrivyProfile.deposited_balance.toString(),
        needsUsername: !existingPrivyProfile.username
      });
    }

    // Check if this wallet already has a profile
    const existingWalletProfile = await prisma.profile.findUnique({
      where: { wallet_address }
    });

    if (existingWalletProfile) {
      if (existingWalletProfile.privy_user_id && existingWalletProfile.privy_user_id !== privy_user_id) {
        // Wallet is linked to a different Privy account
        return res.status(400).json({
          success: false,
          error: 'This wallet is already linked to a different account'
        });
      }
      
      // Wallet exists but no privy_user_id or same privy_user_id - return it
      // Don't try to update privy_user_id to avoid unique constraint issues
      return res.json({
        success: true,
        id: existingWalletProfile.id,
        wallet_address: existingWalletProfile.wallet_address,
        username: existingWalletProfile.username,
        deposited_balance: existingWalletProfile.deposited_balance.toString(),
        needsUsername: !existingWalletProfile.username
      });
    }

    // No existing profile - create new one WITHOUT privy_user_id first
    const profile = await prisma.profile.create({
      data: {
        wallet_address,
        deposited_balance: 0,
        total_wagered: 0,
        total_won: 0,
        games_played: 0
      }
    });
    
    return res.json({
      success: true,
      id: profile.id,
      wallet_address: profile.wallet_address,
      username: profile.username,
      deposited_balance: profile.deposited_balance.toString(),
      needsUsername: !profile.username
    });
  } catch (error: any) {
    // Handle unique constraint errors gracefully
    if (error?.code === 'P2002') {
      // Race condition - profile was just created, fetch it
      const profile = await prisma.profile.findUnique({
        where: { wallet_address: req.walletAddress! }
      });
      if (profile) {
        return res.json({
          success: true,
          id: profile.id,
          wallet_address: profile.wallet_address,
          username: profile.username,
          deposited_balance: profile.deposited_balance.toString(),
          needsUsername: !profile.username
        });
      }
    }
    console.error('Error in /auth/profile:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/auth/username - Set username (requires Privy auth)
router.post('/username', requireAuth, async (req: Request, res: Response) => {
  try {
    const wallet_address = req.walletAddress!;
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ success: false, error: 'username is required' });
    }
    
    // Validate username format
    const validation = validateUsername(username);
    if (!validation.valid) {
      return res.json({ success: false, error: validation.error });
    }
    
    // Check if username is already taken
    const existingUser = await prisma.profile.findUnique({
      where: { username }
    });
    
    if (existingUser && existingUser.wallet_address !== wallet_address) {
      return res.json({ success: false, error: 'Username is already taken' });
    }
    
    // Find profile by wallet
    const profile = await prisma.profile.findUnique({
      where: { wallet_address }
    });
    
    if (!profile) {
      return res.json({ success: false, error: 'Profile not found' });
    }
    
    // Update username
    await prisma.profile.update({
      where: { wallet_address },
      data: { username }
    });
    
    return res.json({ success: true });
  } catch (error) {
    console.error('Error in /auth/username:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/auth/check-username/:username - Check if username is available
router.get('/check-username/:username', async (req: Request, res: Response) => {
  try {
    const { username } = req.params;
    
    // First validate the format
    const validation = validateUsername(username);
    if (!validation.valid) {
      return res.json({ available: false, error: validation.error });
    }
    
    // Check if exists
    const existingUser = await prisma.profile.findUnique({
      where: { username }
    });
    
    return res.json({ available: !existingUser });
  } catch (error) {
    console.error('Error in /auth/check-username:', error);
    return res.status(500).json({ available: false, error: 'Internal server error' });
  }
});

export default router;
