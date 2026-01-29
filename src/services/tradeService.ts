import prisma from '../lib/prisma';
import { 
  Pool, 
  calculateBuy, 
  calculateSell, 
  applyBuy, 
  applySell, 
  getPrice,
  getPriceMultiplier
} from '../lib/poolEngine';
import { getActiveRound, isRoundExpired, getPosition } from './roundService';

// Trade configuration
export const HOUSE_FEE = 0.02; // 2% fee
export const MIN_TRADE = 0.001; // Minimum trade in SOL

export interface TradeResult {
  success: boolean;
  error?: string;
  tokensTraded?: number;
  solAmount?: number;
  newPrice?: number;
  priceMultiplier?: number;
  newBalance?: number;
  feeAmount?: number;
  position?: {
    token_balance: number;
    total_sol_in: number;
    total_sol_out: number;
  };
}

/**
 * Execute a buy trade
 * @param profileId - Profile making the trade
 * @param roundId - Round to trade in
 * @param solAmount - Amount of SOL to spend (before fees)
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

  // Calculate fee
  const feeAmount = solAmount * HOUSE_FEE;
  const solAfterFee = solAmount - feeAmount;

  // Get current pool state
  const pool: Pool = {
    sol_balance: Number(round.pool_sol_balance),
    token_supply: Number(round.pool_token_supply)
  };

  // Calculate tokens out
  const tokensOut = calculateBuy(pool, solAfterFee);
  if (tokensOut <= 0) {
    return { success: false, error: 'Trade too small' };
  }

  // Apply to pool
  const newPool = applyBuy(pool, solAfterFee, tokensOut);
  const newPrice = getPrice(newPool);
  const priceMultiplier = getPriceMultiplier(newPool);

  // Get existing position to calculate weighted average entry price
  const existingPosition = await prisma.playerPosition.findUnique({
    where: {
      round_id_profile_id: {
        round_id: roundId,
        profile_id: profileId
      }
    }
  });

  // Calculate weighted average entry price
  const tradePrice = newPrice;
  let newEntryPrice: number;
  
  if (existingPosition && Number(existingPosition.token_balance) > 0 && existingPosition.entry_price) {
    // Weighted average: (old_tokens * old_entry + new_tokens * trade_price) / total_tokens
    const oldTokens = Number(existingPosition.token_balance);
    const oldEntry = Number(existingPosition.entry_price);
    const totalTokens = oldTokens + tokensOut;
    newEntryPrice = (oldTokens * oldEntry + tokensOut * tradePrice) / totalTokens;
  } else {
    // First buy - entry price is the trade price
    newEntryPrice = tradePrice;
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

    // Deduct from profile balance
    const updatedProfile = await tx.profile.update({
      where: { id: profileId },
      data: {
        deposited_balance: { decrement: solAmount },
        total_wagered: { increment: solAmount },
        games_played: { increment: 1 }
      }
    });

    // Record trade
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

  return {
    success: true,
    tokensTraded: tokensOut,
    solAmount: solAmount,
    newPrice,
    priceMultiplier,
    newBalance: Number(result.updatedProfile.deposited_balance),
    feeAmount,
    position: {
      token_balance: Number(result.position.token_balance),
      total_sol_in: Number(result.position.total_sol_in),
      total_sol_out: Number(result.position.total_sol_out)
    }
  };
}

/**
 * Execute a sell trade
 * @param profileId - Profile making the trade
 * @param roundId - Round to trade in
 * @param solAmount - Amount of SOL worth of tokens to sell (before fees)
 */
export async function executeSell(
  profileId: string, 
  roundId: string, 
  solAmount: number
): Promise<TradeResult> {
  // Validate minimum trade
  if (solAmount < MIN_TRADE) {
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

  // Get current pool state
  const pool: Pool = {
    sol_balance: Number(round.pool_sol_balance),
    token_supply: Number(round.pool_token_supply)
  };

  // Calculate how many tokens needed for the requested SOL amount
  const currentPrice = getPrice(pool);
  let tokensToSell = solAmount / currentPrice;

  // Cap at available balance
  if (tokensToSell > tokenBalance) {
    tokensToSell = tokenBalance;
  }

  // Calculate SOL out
  const solOut = calculateSell(pool, tokensToSell);
  if (solOut <= 0) {
    return { success: false, error: 'Trade too small' };
  }

  // Calculate fee
  const feeAmount = solOut * HOUSE_FEE;
  const solAfterFee = solOut - feeAmount;

  // Apply to pool
  const newPool = applySell(pool, tokensToSell, solOut);
  const newPrice = getPrice(newPool);
  const priceMultiplier = getPriceMultiplier(newPool);

  // Check if this sell closes the entire position
  const remainingTokens = tokenBalance - tokensToSell;
  const shouldClearEntryPrice = remainingTokens <= 0.000001; // Near-zero check for floating point

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

    // Update player position (reset entry_price if fully closed)
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

    // Credit profile balance
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
        sol_amount: solOut,
        token_amount: tokensToSell,
        price_at_trade: newPrice,
        fee_amount: feeAmount
      }
    });

    return { position: updatedPosition, updatedProfile };
  });

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
      total_sol_out: Number(result.position.total_sol_out)
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

  // Get round for price
  const round = await prisma.gameRound.findUnique({
    where: { id: roundId }
  });

  if (!round) {
    return { success: false, error: 'Round not found' };
  }

  const currentPrice = Number(round.current_price);
  const solValue = tokenBalance * currentPrice;

  return executeSell(profileId, roundId, solValue);
}

/**
 * Get trade preview without executing
 */
export function previewBuy(pool: Pool, solAmount: number) {
  const feeAmount = solAmount * HOUSE_FEE;
  const solAfterFee = solAmount - feeAmount;
  const tokensOut = calculateBuy(pool, solAfterFee);
  const newPool = applyBuy(pool, solAfterFee, tokensOut);
  const newPrice = getPrice(newPool);
  const priceMultiplier = getPriceMultiplier(newPool);
  const priceImpact = ((newPrice - getPrice(pool)) / getPrice(pool)) * 100;

  return {
    tokensOut,
    newPrice,
    priceMultiplier,
    priceImpact,
    feeAmount
  };
}

/**
 * Get sell preview without executing
 */
export function previewSell(pool: Pool, tokensToSell: number) {
  const solOut = calculateSell(pool, tokensToSell);
  const feeAmount = solOut * HOUSE_FEE;
  const solAfterFee = solOut - feeAmount;
  const newPool = applySell(pool, tokensToSell, solOut);
  const newPrice = getPrice(newPool);
  const priceMultiplier = getPriceMultiplier(newPool);
  const priceImpact = ((getPrice(pool) - newPrice) / getPrice(pool)) * 100;

  return {
    solOut: solAfterFee,
    newPrice,
    priceMultiplier,
    priceImpact,
    feeAmount
  };
}
