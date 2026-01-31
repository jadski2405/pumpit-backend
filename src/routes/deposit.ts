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

// POST /api/deposit/confirm - Confirm a deposit transaction (no auth - tx proves ownership)
router.post('/confirm', async (req: Request, res: Response) => {
  try {
    const { wallet_address, tx_signature, amount } = req.body;
    
    if (!wallet_address || !tx_signature || amount === undefined) {
      return res.status(400).json({ 
        success: false, 
        error: 'wallet_address, tx_signature and amount are required' 
      });
    }
    
    // Use upsert to avoid race conditions
    const profile = await prisma.profile.upsert({
      where: { wallet_address },
      update: {},
      create: {
        wallet_address,
        deposited_balance: 0,
        total_wagered: 0,
        total_won: 0,
        games_played: 0
      }
    });
    
    // Check if this transaction was already processed
    const existingDeposit = await prisma.depositHistory.findFirst({
      where: { tx_signature }
    });
    
    if (existingDeposit) {
      // If pending, refetch balance
      if (existingDeposit.status === 'pending') {
        const currentProfile = await prisma.profile.findUnique({
          where: { wallet_address }
        });
        return res.json({ 
          success: true,
          message: 'Deposit is being processed',
          new_balance: currentProfile?.deposited_balance.toString() || '0'
        });
      }
      return res.json({ 
        success: true, 
        message: 'Transaction already processed',
        new_balance: profile.deposited_balance.toString()
      });
    }
    
    // Retry fetching transaction with backoff (wait for confirmation)
    let transaction = null;
    const maxRetries = 10;
    const baseDelay = 1000;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      transaction = await connection.getTransaction(tx_signature, {
        maxSupportedTransactionVersion: 0
      });
      
      if (transaction) break;
      
      // Wait before retry (1s, 1.5s, 2s, 2.5s, etc.)
      const delay = baseDelay + (attempt * 500);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    if (!transaction) {
      // Save as pending (check if not already exists)
      const existingPending = await prisma.depositHistory.findFirst({
        where: { tx_signature }
      });
      
      if (!existingPending) {
        await prisma.depositHistory.create({
          data: {
            profile_id: profile.id,
            tx_type: 'deposit',
            amount: amount,
            tx_signature,
            status: 'pending'
          }
        });
      }
      
      return res.json({ 
        success: false, 
        error: 'Transaction not confirmed yet. Please wait a moment and refresh.' 
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
    
    // Verify sender (accountKeys[0] is the fee payer/sender) matches wallet_address
    const senderPubkey = accountKeys.get(0);
    if (!senderPubkey || senderPubkey.toBase58() !== wallet_address) {
      return res.json({ 
        success: false, 
        error: 'Transaction sender does not match wallet_address' 
      });
    }
    
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

// POST /api/withdraw - Withdraw SOL to user's wallet (no auth - funds go TO the wallet)
router.post('/', async (req: Request, res: Response) => {
  try {
    const { wallet_address, amount } = req.body;
    
    if (!wallet_address || amount === undefined) {
      return res.status(400).json({ 
        success: false, 
        error: 'wallet_address and amount are required' 
      });
    }
    
    const withdrawAmount = Number(amount);
    
    if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
      return res.json({ success: false, error: 'Amount must be greater than 0' });
    }
    
    // Minimum withdrawal to cover transaction fees
    const MIN_WITHDRAWAL = 0.001;
    if (withdrawAmount < MIN_WITHDRAWAL) {
      return res.json({ 
        success: false, 
        error: `Minimum withdrawal is ${MIN_WITHDRAWAL} SOL` 
      });
    }
    
    // Use a transaction with row locking to prevent race conditions
    const result = await prisma.$transaction(async (tx) => {
      // Lock the profile row for update (prevents concurrent withdrawals)
      const profiles = await tx.$queryRaw<Array<{
        id: string;
        deposited_balance: Decimal;
      }>>`
        SELECT id, deposited_balance 
        FROM profile 
        WHERE wallet_address = ${wallet_address} 
        FOR UPDATE
      `;
      
      if (profiles.length === 0) {
        throw new Error('PROFILE_NOT_FOUND');
      }
      
      const profile = profiles[0];
      const currentBalance = Number(profile.deposited_balance);
      
      // Check if user has sufficient balance
      if (currentBalance < withdrawAmount) {
        throw new Error(`INSUFFICIENT_BALANCE:${currentBalance}`);
      }
      
      // Deduct balance BEFORE sending SOL (safer - can refund on failure)
      const updatedProfile = await tx.profile.update({
        where: { id: profile.id },
        data: {
          deposited_balance: {
            decrement: withdrawAmount
          }
        }
      });
      
      // Create withdrawal record as pending
      const withdrawal = await tx.depositHistory.create({
        data: {
          profile_id: profile.id,
          tx_type: 'withdrawal',
          amount: withdrawAmount,
          tx_signature: 'pending',
          status: 'pending'
        }
      });
      
      return { 
        profile: updatedProfile, 
        withdrawal,
        previousBalance: currentBalance 
      };
    });
    
    // Now send the SOL outside of the transaction
    // If this fails, we need to refund the balance
    let tx_signature: string;
    try {
      tx_signature = await transferFromEscrow(wallet_address, withdrawAmount);
      
      // Update withdrawal record with successful transaction
      await prisma.depositHistory.update({
        where: { id: result.withdrawal.id },
        data: {
          tx_signature,
          status: 'confirmed'
        }
      });
      
      console.log(`[Withdraw] Sent ${withdrawAmount} SOL to ${wallet_address}, tx: ${tx_signature}`);
      
      return res.json({ 
        success: true, 
        tx_signature,
        new_balance: result.profile.deposited_balance.toString()
      });
      
    } catch (txError) {
      // SOL transfer failed - refund the deducted balance
      console.error('[Withdraw] Transfer failed, refunding balance:', txError);
      
      try {
        await prisma.profile.update({
          where: { id: result.profile.id },
          data: {
            deposited_balance: {
              increment: withdrawAmount
            }
          }
        });
        
        // Mark withdrawal as failed
        await prisma.depositHistory.update({
          where: { id: result.withdrawal.id },
          data: { status: 'failed' }
        });
        
        console.log(`[Withdraw] Refunded ${withdrawAmount} SOL to ${wallet_address} database balance`);
        
      } catch (refundError) {
        // Critical: Failed to refund - log for manual intervention
        console.error('[Withdraw] CRITICAL: Failed to refund balance after failed transfer!', {
          wallet_address,
          amount: withdrawAmount,
          error: refundError
        });
      }
      
      return res.json({ 
        success: false, 
        error: 'Transaction failed. Your balance has been refunded.' 
      });
    }
    
  } catch (error: any) {
    // Handle known errors from the transaction
    if (error.message === 'PROFILE_NOT_FOUND') {
      return res.json({ success: false, error: 'Profile not found' });
    }
    
    if (error.message?.startsWith('INSUFFICIENT_BALANCE:')) {
      const balance = error.message.split(':')[1];
      return res.json({ 
        success: false, 
        error: `Insufficient balance. You have ${balance} SOL` 
      });
    }
    
    console.error('Error in /withdraw:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
