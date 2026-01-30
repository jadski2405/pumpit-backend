import prisma from '../lib/prisma';
import { 
  Pool, 
  calculateBuy, 
  calculateSell, 
  applyBuy, 
  applySell, 
  getPrice,
  getPriceMultiplier,
  getMultiplier,
  getMultiplierAfterBuy,
  calculateAverageEntry
} from '../lib/poolEngine';
import { getActiveRound, isRoundExpired, getPosition } from './roundService';

// Fee configuration
export const BUY_FEE = 0.02;  // 2% buy fee
export const SELL_FEE = 0.02; // 2% sell fee
export const MIN_TRADE = 0.001; // Minimum trade in SOL

// House wallet receives all fees (from .env HOUSE_WALLET_ADDRESS)
export const HOUSE_WALLET = process.env.HOUSE_WALLET_ADDRESS || '';

export interface TradeResult {
  success: boolean;
  error?: string;
  tokensTraded?: number;
  solAmount?: number;
  newPrice?: number;
  priceMultiplier?: number;
  newBalance?: number;
  feeAmount?: number;
  entryMultiplier?: number;
  position?: {
    token_balance: number;
    total_sol_in: number;
    total_sol_out: number;
    entry_price: number | null;
  };
}

/**
 * Execute a buy trade
 * 
 * New logic:
 * 1. Calculate multiplier BEFORE buy
 * 2. Apply 2% fee, add remaining to pool
 * 3. Calculate multiplier AFTER buy  
 * 4. User's entry = average of before/after (anti-self-profit)
 * 5. Tokens = SOL amount (1:1 stake)
 */
export async function executeBuy(
  profileId: string, 
  roundId: string, 
  solAmount: number
): Promise<TradeResult> {
  // Validate minimum trade
  if (solAmount < MIN_TRADE) {
    return { success: false, error: `Minimum trade is ${MIN_TRADE} SOL` };
  }

  // Get profile
  const profile = await prisma.profile.findUnique({
    where: { id: profileId }
  });

  if (!profile) {
    return { success: false, error: 'Profile not found' };
  }

  // Check balance
  const balance = Number(profile.deposited_balance);
  if (balance < solAmount) {
    return { success: false, error: `Insufficient balance. You have ${balance.toFixed(4)} SOL` };
  }

  // Get round
  const round = await prisma.gameRound.findUnique({
    where: { id: roundId }
  });

  if (!round) {
    return { success: false, error: 'Round not found' };
  }

  if (round.status !== 'active') {
    return { success: false, error: 'Round is not active' };
  }

  if (isRoundExpired(round)) {
    return { success: false, error: 'Round has ended' };
  }

  // Calculate 2% buy fee
  const feeAmount = solAmount * BUY_FEE;
  const solAfterFee = solAmount - feeAmount;

  // Get current pool state
  const pool: Pool = {
    sol_balance: Number(round.pool_sol_balance),
    token_supply: Number(round.pool_token_supply)
  };

  // Calculate multiplier BEFORE buy
  const multiplierBefore = getMultiplier(pool);

  // Tokens = SOL stake (1:1 in new system)
  const tokensOut = calculateBuy(pool, solAfterFee);
  if (tokensOut <= 0) {
    return { success: false, error: 'Trade too small' };
  }

  // Apply to pool (just adds SOL to pool)
  const newPool = applyBuy(pool, solAfterFee);
  
  // Calculate multiplier AFTER buy
  const multiplierAfter = getMultiplier(newPool);
  const priceMultiplier = multiplierAfter;
  const newPrice = multiplierAfter;

  // Calculate user's average entry (anti-self-profit mechanism)
  const tradeEntryMultiplier = calculateAverageEntry(multiplierBefore, multiplierAfter);

  // Get existing position to calculate weighted average entry
  const existingPosition = await prisma.playerPosition.findUnique({
    where: {
      round_id_profile_id: {
        round_id: roundId,
        profile_id: profileId
      }
    }
  });

  // Calculate new weighted average entry multiplier
  let newEntryPrice: number;
  if (existingPosition && Number(existingPosition.token_balance) > 0 && existingPosition.entry_price) {
    // Weighted average: (old_tokens * old_entry + new_tokens * trade_entry) / total_tokens
    const oldTokens = Number(existingPosition.token_balance);
    const oldEntry = Number(existingPosition.entry_price);
    const totalTokens = oldTokens + tokensOut;
    newEntryPrice = (oldTokens * oldEntry + tokensOut * tradeEntryMultiplier) / totalTokens;
  } else {
    // First buy - entry is the average multiplier
    newEntryPrice = tradeEntryMultiplier;
  }

  // Execute transaction
  const result = await prisma.$transaction(async (tx) => {
    // Update round pool state
    await tx.gameRound.update({
      where: { id: roundId },
      data: {
        pool_sol_balance: newPool.sol_balance,
        pool_token_supply: newPool.token_supply,
        current_price: newPrice
      }
    });

    // Update or create player position
    const position = await tx.playerPosition.upsert({
      where: {
        round_id_profile_id: {
          round_id: roundId,
          profile_id: profileId
        }
      },
      create: {
        round_id: roundId,
        profile_id: profileId,
        token_balance: tokensOut,
        total_sol_in: solAmount,
        total_sol_out: 0,
        entry_price: newEntryPrice
      },
      update: {
        token_balance: { increment: tokensOut },
        total_sol_in: { increment: solAmount },
        entry_price: newEntryPrice
      }
    });

    // Deduct from profile balance (full amount including fee)
    const updatedProfile = await tx.profile.update({
      where: { id: profileId },
      data: {
        deposited_balance: { decrement: solAmount },
        total_wagered: { increment: solAmount },
        games_played: { increment: 1 }
      }
    });

    // Record trade with fee going to house
    await tx.trade.create({
      data: {
        round_id: roundId,
        profile_id: profileId,
        trade_type: 'buy',
        sol_amount: solAmount,
        token_amount: tokensOut,
        price_at_trade: newPrice,
        fee_amount: feeAmount
      }
    });

    return { position, updatedProfile };
  });

  console.log(`[Trade] BUY: ${solAmount} SOL -> ${tokensOut} tokens, entry: ${newEntryPrice.toFixed(4)}x, mult: ${priceMultiplier.toFixed(4)}x`);

  return {
    success: true,
    tokensTraded: tokensOut,
    solAmount: solAmount,
    newPrice,
    priceMultiplier,
    newBalance: Number(result.updatedProfile.deposited_balance),
    feeAmount,
    entryMultiplier: newEntryPrice,
    position: {
      token_balance: Number(result.position.token_balance),
      total_sol_in: Number(result.position.total_sol_in),
      total_sol_out: Number(result.position.total_sol_out),
      entry_price: Number(result.position.entry_price)
    }
  };
}

/**
 * Execute a sell trade
 * 
 * New logic:
 * 1. Calculate SOL out based on: tokens * (currentMultiplier / entryMultiplier)
 * 2. Apply 2% sell fee
 * 3. Safety: payout can never exceed pool balance
 */
export async function executeSell(
  profileId: string, 
  roundId: string, 
  tokensToSell: number
): Promise<TradeResult> {
  // Validate minimum trade
  if (tokensToSell < MIN_TRADE) {
    return { success: false, error: `Minimum trade is ${MIN_TRADE} SOL` };
  }

  // Get round
  const round = await prisma.gameRound.findUnique({
    where: { id: roundId }
  });

  if (!round) {
    return { success: false, error: 'Round not found' };
  }

  if (round.status !== 'active') {
    return { success: false, error: 'Round is not active' };
  }

  if (isRoundExpired(round)) {
    return { success: false, error: 'Round has ended' };
  }

  // Get player position
  const position = await getPosition(roundId, profileId);
  if (!position) {
    return { success: false, error: 'No position in this round' };
  }

  const tokenBalance = Number(position.token_balance);
  if (tokenBalance <= 0) {
    return { success: false, error: 'No tokens to sell' };
  }

  // Get user's entry multiplier
  const entryMultiplier = Number(position.entry_price) || 1;

  // Cap at available balance
  if (tokensToSell > tokenBalance) {
    tokensToSell = tokenBalance;
  }

  // Get current pool state
  const pool: Pool = {
    sol_balance: Number(round.pool_sol_balance),
    token_supply: Number(round.pool_token_supply)
  };

  // Calculate SOL out based on entry vs current multiplier
  const solOutBeforeFee = calculateSell(pool, tokensToSell, entryMultiplier);
  if (solOutBeforeFee <= 0) {
    return { success: false, error: 'Trade too small or insufficient pool liquidity' };
  }

  // Apply 2% sell fee
  const feeAmount = solOutBeforeFee * SELL_FEE;
  const solAfterFee = solOutBeforeFee - feeAmount;

  // Apply to pool (remove SOL from pool)
  const newPool = applySell(pool, solOutBeforeFee);
  const newPrice = getPrice(newPool);
  const priceMultiplier = getPriceMultiplier(newPool);

  // Check if this sell closes the entire position
  const remainingTokens = tokenBalance - tokensToSell;
  const shouldClearEntryPrice = remainingTokens <= 0.000001;

  // Execute transaction
  const result = await prisma.$transaction(async (tx) => {
    // Update round pool state
    await tx.gameRound.update({
      where: { id: roundId },
      data: {
        pool_sol_balance: newPool.sol_balance,
        pool_token_supply: newPool.token_supply,
        current_price: newPrice
      }
    });

    // Update player position
    const updatedPosition = await tx.playerPosition.update({
      where: {
        round_id_profile_id: {
          round_id: roundId,
          profile_id: profileId
        }
      },
      data: {
        token_balance: { decrement: tokensToSell },
        total_sol_out: { increment: solAfterFee },
        entry_price: shouldClearEntryPrice ? null : undefined
      }
    });

    // Credit profile balance (after fee)
    const updatedProfile = await tx.profile.update({
      where: { id: profileId },
      data: {
        deposited_balance: { increment: solAfterFee },
        total_won: { increment: solAfterFee }
      }
    });

    // Record trade
    await tx.trade.create({
      data: {
        round_id: roundId,
        profile_id: profileId,
        trade_type: 'sell',
        sol_amount: solOutBeforeFee,
        token_amount: tokensToSell,
        price_at_trade: newPrice,
        fee_amount: feeAmount
      }
    });

    return { position: updatedPosition, updatedProfile };
  });

  const pnlRatio = getMultiplier(pool) / entryMultiplier;
  console.log(`[Trade] SELL: ${tokensToSell} tokens -> ${solAfterFee.toFixed(4)} SOL, entry: ${entryMultiplier.toFixed(4)}x, PnL: ${((pnlRatio - 1) * 100).toFixed(2)}%`);

  return {
    success: true,
    tokensTraded: tokensToSell,
    solAmount: solAfterFee,
    newPrice,
    priceMultiplier,
    newBalance: Number(result.updatedProfile.deposited_balance),
    feeAmount,
    position: {
      token_balance: Number(result.position.token_balance),
      total_sol_in: Number(result.position.total_sol_in),
      total_sol_out: Number(result.position.total_sol_out),
      entry_price: result.position.entry_price ? Number(result.position.entry_price) : null
    }
  };
}

/**
 * Sell all tokens at once
 */
export async function executeSellAll(
  profileId: string,
  roundId: string
): Promise<TradeResult> {
  const position = await getPosition(roundId, profileId);
  if (!position) {
    return { success: false, error: 'No position in this round' };
  }

  const tokenBalance = Number(position.token_balance);
  if (tokenBalance <= 0) {
    return { success: false, error: 'No tokens to sell' };
  }

  return executeSell(profileId, roundId, tokenBalance);
}

/**
 * Get buy preview without executing
 */
export function previewBuy(pool: Pool, solAmount: number) {
  const feeAmount = solAmount * BUY_FEE;
  const solAfterFee = solAmount - feeAmount;
  const multiplierBefore = getMultiplier(pool);
  const newPool = applyBuy(pool, solAfterFee);
  const multiplierAfter = getMultiplier(newPool);
  const entryMultiplier = calculateAverageEntry(multiplierBefore, multiplierAfter);
  const priceImpact = ((multiplierAfter - multiplierBefore) / multiplierBefore) * 100;

  return {
    tokensOut: solAfterFee,
    newPrice: multiplierAfter,
    priceMultiplier: multiplierAfter,
    entryMultiplier,
    priceImpact,
    feeAmount
  };
}

/**
 * Get sell preview without executing
 */
export function previewSell(pool: Pool, tokensToSell: number, entryMultiplier: number) {
  const solOutBeforeFee = calculateSell(pool, tokensToSell, entryMultiplier);
  const feeAmount = solOutBeforeFee * SELL_FEE;
  const solAfterFee = solOutBeforeFee - feeAmount;
  const newPool = applySell(pool, solOutBeforeFee);
  const newMultiplier = getMultiplier(newPool);
  const currentMultiplier = getMultiplier(pool);
  const priceImpact = ((currentMultiplier - newMultiplier) / currentMultiplier) * 100;

  return {
    solOut: solAfterFee,
    newPrice: newMultiplier,
    priceMultiplier: newMultiplier,
    priceImpact,
    feeAmount
  };
}

/**
 * Calculate accumulated fees for a round (for house wallet)
 */
export async function getRoundFees(roundId: string): Promise<number> {
  const trades = await prisma.trade.findMany({
    where: { round_id: roundId },
    select: { fee_amount: true }
  });
  
  return trades.reduce((sum, t) => sum + Number(t.fee_amount), 0);
}
