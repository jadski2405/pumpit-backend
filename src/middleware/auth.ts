import { Request, Response, NextFunction } from 'express';
import privy from '../lib/privy';
import { User } from '@privy-io/node';

// Infer LinkedAccount type from User
type LinkedAccount = User['linked_accounts'][number];

// Extend Express Request type to include auth info
declare global {
  namespace Express {
    interface Request {
      privyUserId?: string;
      walletAddress?: string;
    }
  }
}

// Type guard for Solana wallet linked account
function isSolanaWallet(account: LinkedAccount): account is LinkedAccount & { address: string; chain_type: 'solana' } {
  return account.type === 'wallet' && 'chain_type' in account && (account as any).chain_type === 'solana';
}

/**
 * Middleware to verify Privy authentication token
 * Extracts user ID and wallet address from the verified token
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        error: 'Authentication required. Please connect your wallet.' 
      });
    }
    
    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    
    try {
      // Verify the token with Privy using utils().auth()
      const verifiedClaims = await privy.utils().auth().verifyAccessToken(token);
      
      // Get user details to extract wallet address
      const user = await privy.users()._get(verifiedClaims.user_id);
      
      // Find Solana wallet from linked accounts
      const solanaWallet = user.linked_accounts.find(isSolanaWallet);
      
      if (!solanaWallet) {
        return res.status(401).json({ 
          success: false, 
          error: 'No Solana wallet linked to this account' 
        });
      }
      
      // Attach auth info to request
      req.privyUserId = verifiedClaims.user_id;
      req.walletAddress = solanaWallet.address;
      
      next();
    } catch (verifyError) {
      console.error('[Auth] Token verification failed:', verifyError);
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid or expired authentication token' 
      });
    }
  } catch (error) {
    console.error('[Auth] Middleware error:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Authentication service error' 
    });
  }
}

/**
 * Optional auth middleware - doesn't fail if no token, but attaches user info if present
 */
export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // No auth token, continue without user info
      return next();
    }
    
    const token = authHeader.substring(7);
    
    try {
      const verifiedClaims = await privy.utils().auth().verifyAccessToken(token);
      const user = await privy.users()._get(verifiedClaims.user_id);
      
      const solanaWallet = user.linked_accounts.find(isSolanaWallet);
      
      if (solanaWallet) {
        req.privyUserId = verifiedClaims.user_id;
        req.walletAddress = solanaWallet.address;
      }
    } catch {
      // Token invalid, continue without user info
    }
    
    next();
  } catch (error) {
    // On error, continue without user info
    next();
  }
}

export default { requireAuth, optionalAuth };
