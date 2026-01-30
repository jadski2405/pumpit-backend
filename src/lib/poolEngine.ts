/**
 * PvP Trading Pool Engine
 * 
 * Simplified multiplier-based system:
 * - Multiplier = (VIRTUAL_BASE + Total_SOL_Deposited) / VIRTUAL_BASE
 * - Starts at 1.00x
 * - 0.5 SOL buy creates 2x move ("God Candle")
 * - No bonding curve graduation - rounds end after 30 seconds
 */

export interface Pool {
  sol_balance: number;      // Total SOL deposited into pool this round
  token_supply: number;     // User's stake (SOL they put in)
}

// Virtual base liquidity - determines price sensitivity
// 0.5 SOL buy = 2x move (God Candle)
export const VIRTUAL_BASE = 0.5;

// Initial state (kept for compatibility)
export const INITIAL_TOKEN_SUPPLY = 1_000_000;
export const INITIAL_SOL = 0;
export const VIRTUAL_SOL = VIRTUAL_BASE; // Alias for compatibility

/**
 * Calculate current multiplier
 * Formula: (VIRTUAL_BASE + Total_SOL_Deposited) / VIRTUAL_BASE
 * 
 * At start (0 SOL): 0.5 / 0.5 = 1.00x
 * After 0.01 SOL: (0.5 + 0.01) / 0.5 = 1.02x (+2%)
 * After 0.5 SOL: (0.5 + 0.5) / 0.5 = 2.00x
 * After 1.0 SOL: (0.5 + 1.0) / 0.5 = 3.00x
 */
export function getMultiplier(pool: Pool): number {
  return (VIRTUAL_BASE + pool.sol_balance) / VIRTUAL_BASE;
}

/**
 * Calculate multiplier after adding more SOL
 */
export function getMultiplierAfterBuy(pool: Pool, solIn: number): number {
  return (VIRTUAL_BASE + pool.sol_balance + solIn) / VIRTUAL_BASE;
}

/**
 * Calculate multiplier after removing SOL (sell)
 */
export function getMultiplierAfterSell(pool: Pool, solOut: number): number {
  const newBalance = Math.max(0, pool.sol_balance - solOut);
  return (VIRTUAL_BASE + newBalance) / VIRTUAL_BASE;
}

/**
 * Calculate user's average entry price for anti-self-profit
 * Entry = (Multiplier_Before + Multiplier_After) / 2
 * 
 * This prevents users from profiting purely from their own buys.
 * Example: User buys 1 SOL, price goes 1x -> 3x
 *          Their entry is 2x, so they only profit if others push it above 2x
 */
export function calculateAverageEntry(multiplierBefore: number, multiplierAfter: number): number {
  return (multiplierBefore + multiplierAfter) / 2;
}

/**
 * Calculate "tokens" received for a given SOL input
 * In this system, tokens represent the user's SOL stake
 * tokens = solIn (1:1 relationship)
 */
export function calculateBuy(pool: Pool, solIn: number): number {
  if (solIn <= 0) return 0;
  return solIn;
}

/**
 * Calculate how much SOL a user receives when selling
 * Based on their entry multiplier vs current multiplier
 * 
 * Formula: solOut = tokens * (currentMultiplier / entryMultiplier)
 * 
 * Safety: Total payouts can never exceed total deposited SOL
 */
export function calculateSell(pool: Pool, userTokens: number, userEntryMultiplier: number): number {
  if (userTokens <= 0 || pool.sol_balance <= 0) return 0;
  if (userEntryMultiplier <= 0) return 0;
  
  const currentMultiplier = getMultiplier(pool);
  
  // User's profit/loss ratio based on multiplier change
  const pnlRatio = currentMultiplier / userEntryMultiplier;
  
  // SOL out = stake * pnlRatio
  let solOut = userTokens * pnlRatio;
  
  // Safety: Can never withdraw more than pool has
  solOut = Math.min(solOut, pool.sol_balance);
  
  return Math.max(0, solOut);
}

/**
 * Apply a buy to the pool and return new state
 */
export function applyBuy(pool: Pool, solIn: number): Pool {
  return {
    sol_balance: pool.sol_balance + solIn,
    token_supply: pool.token_supply
  };
}

/**
 * Apply a sell to the pool and return new state
 */
export function applySell(pool: Pool, solOut: number): Pool {
  return {
    sol_balance: Math.max(0, pool.sol_balance - solOut),
    token_supply: pool.token_supply
  };
}

/**
 * Get current "price" (same as multiplier in new system)
 */
export function getPrice(pool: Pool): number {
  return getMultiplier(pool);
}

/**
 * Get price multiplier (same as getMultiplier)
 */
export function getPriceMultiplier(pool: Pool): number {
  return getMultiplier(pool);
}

/**
 * Get initial pool state for new rounds
 */
export function getInitialPool(): Pool {
  return {
    sol_balance: INITIAL_SOL,
    token_supply: INITIAL_TOKEN_SUPPLY
  };
}

/**
 * Calculate price impact of a buy (percentage)
 */
export function calculateBuyPriceImpact(pool: Pool, solIn: number): number {
  const currentMult = getMultiplier(pool);
  const newMult = getMultiplierAfterBuy(pool, solIn);
  return ((newMult - currentMult) / currentMult) * 100;
}

/**
 * Calculate price impact of a sell (percentage)
 */
export function calculateSellPriceImpact(pool: Pool, solOut: number): number {
  const currentMult = getMultiplier(pool);
  const newMult = getMultiplierAfterSell(pool, solOut);
  return ((currentMult - newMult) / currentMult) * 100;
}

/**
 * Get total value locked (same as sol_balance in new system)
 */
export function getMarketCap(pool: Pool): number {
  return pool.sol_balance;
}
