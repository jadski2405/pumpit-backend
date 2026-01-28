import { Router, Request, Response } from 'express';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import prisma from '../lib/prisma';
import { 
  connection, 
  getEscrowPublicKey, 
  transferFromEscrow,
  lamportsToSol 
} from '../lib/solana';
import { Decimal } from '@prisma/client/runtime/library';

const router = Router();

// POST /api/deposit/confirm - Confirm a deposit transaction
router.post('/confirm', async (req: Request, res: Response) => {
  try {
    const { wallet_address, tx_signature, amount } = req.body;
    
    if (!wallet_address || !tx_signature || amount === undefined) {
      return res.status(400).json({ 
        success: false, 
        error: 'wallet_address, tx_signature, and amount are required' 
      });
    }
    
    // Get or create profile
    let profile = await prisma.profile.findUnique({
      where: { wallet_address }
    });
    
    if (!profile) {
      profile = await prisma.profile.create({
        data: {
          wallet_address,
          deposited_balance: 0,
          total_wagered: 0,
          total_won: 0,
          games_played: 0
        }
      });
    }
    
    // Check if this transaction was already processed
    const existingDeposit = await prisma.depositHistory.findFirst({
      where: { tx_signature }
    });
    
    if (existingDeposit) {
      return res.json({ 
        success: false, 
        error: 'Transaction already processed',
        new_balance: profile.deposited_balance.toString()
      });
    }
    
    // Fetch transaction from chain
    const transaction = await connection.getTransaction(tx_signature, {
      maxSupportedTransactionVersion: 0
    });
    
    if (!transaction) {
      // Save as pending if not found yet
      await prisma.depositHistory.create({
        data: {
          profile_id: profile.id,
          tx_type: 'deposit',
          amount: amount,
          tx_signature,
          status: 'pending'
        }
      });
      
      return res.json({ 
        success: false, 
        error: 'Transaction not found on chain yet. Please wait for confirmation.' 
      });
    }
    
    // Verify transaction is confirmed
    if (!transaction.meta || transaction.meta.err) {
      await prisma.depositHistory.create({
        data: {
          profile_id: profile.id,
          tx_type: 'deposit',
          amount: amount,
          tx_signature,
          status: 'failed'
        }
      });
      
      return res.json({ success: false, error: 'Transaction failed on chain' });
    }
    
    // Get escrow wallet address
    const escrowPubkey = getEscrowPublicKey();
    
    // Parse the transaction to verify it's a transfer to escrow
    const accountKeys = transaction.transaction.message.getAccountKeys();
    const preBalances = transaction.meta.preBalances;
    const postBalances = transaction.meta.postBalances;
    
    // Find escrow account index
    let escrowIndex = -1;
    for (let i = 0; i < accountKeys.length; i++) {
      if (accountKeys.get(i)?.equals(escrowPubkey)) {
        escrowIndex = i;
        break;
      }
    }
    
    if (escrowIndex === -1) {
      return res.json({ 
        success: false, 
        error: 'Transaction is not a transfer to the escrow wallet' 
      });
    }
    
    // Calculate the amount received by escrow
    const escrowReceived = lamportsToSol(postBalances[escrowIndex] - preBalances[escrowIndex]);
    
    // Allow small tolerance for rounding (0.001 SOL)
    const tolerance = 0.001;
    if (Math.abs(escrowReceived - amount) > tolerance) {
      return res.json({ 
        success: false, 
        error: `Amount mismatch. Expected ${amount} SOL, received ${escrowReceived} SOL` 
      });
    }
    
    // Credit the user's balance
    const updatedProfile = await prisma.profile.update({
      where: { id: profile.id },
      data: {
        deposited_balance: {
          increment: amount
        }
      }
    });
    
    // Save to deposit history
    await prisma.depositHistory.create({
      data: {
        profile_id: profile.id,
        tx_type: 'deposit',
        amount: amount,
        tx_signature,
        status: 'confirmed'
      }
    });
    
    return res.json({ 
      success: true, 
      new_balance: updatedProfile.deposited_balance.toString() 
    });
    
  } catch (error) {
    console.error('Error in /deposit/confirm:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/withdraw - Withdraw SOL to user's wallet
router.post('/', async (req: Request, res: Response) => {
  try {
    const { wallet_address, amount } = req.body;
    
    if (!wallet_address || amount === undefined) {
      return res.status(400).json({ 
        success: false, 
        error: 'wallet_address and amount are required' 
      });
    }
    
    if (amount <= 0) {
      return res.json({ success: false, error: 'Amount must be greater than 0' });
    }
    
    // Get profile
    const profile = await prisma.profile.findUnique({
      where: { wallet_address }
    });
    
    if (!profile) {
      return res.json({ success: false, error: 'Profile not found' });
    }
    
    // Check balance
    const currentBalance = Number(profile.deposited_balance);
    if (currentBalance < amount) {
      return res.json({ 
        success: false, 
        error: `Insufficient balance. You have ${currentBalance} SOL` 
      });
    }
    
    // Create pending withdrawal record
    const withdrawal = await prisma.depositHistory.create({
      data: {
        profile_id: profile.id,
        tx_type: 'withdrawal',
        amount: amount,
        tx_signature: 'pending',
        status: 'pending'
      }
    });
    
    try {
      // Transfer SOL from escrow to user
      const tx_signature = await transferFromEscrow(wallet_address, amount);
      
      // Update profile balance
      const updatedProfile = await prisma.profile.update({
        where: { id: profile.id },
        data: {
          deposited_balance: {
            decrement: amount
          }
        }
      });
      
      // Update withdrawal record
      await prisma.depositHistory.update({
        where: { id: withdrawal.id },
        data: {
          tx_signature,
          status: 'confirmed'
        }
      });
      
      return res.json({ 
        success: true, 
        tx_signature,
        new_balance: updatedProfile.deposited_balance.toString()
      });
      
    } catch (txError) {
      // Mark withdrawal as failed
      await prisma.depositHistory.update({
        where: { id: withdrawal.id },
        data: { status: 'failed' }
      });
      
      console.error('Withdrawal transaction failed:', txError);
      return res.json({ 
        success: false, 
        error: 'Transaction failed. Please try again.' 
      });
    }
    
  } catch (error) {
    console.error('Error in /withdraw:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
