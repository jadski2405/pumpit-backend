/**
 * Constant Product AMM Pool Engine
 * 
 * Implements x * y = k formula for token price discovery
 */

export interface Pool {
  sol_balance: number;
  token_supply: number;
}

// Initial pool constants
export const INITIAL_TOKEN_SUPPLY = 1_000_000;
export const INITIAL_SOL = 0;
export const VIRTUAL_SOL = 1; // Prevents division by zero, provides initial price

/**
 * Get the effective SOL balance (actual + virtual)
 */
function getEffectiveSol(pool: Pool): number {
  return pool.sol_balance + VIRTUAL_SOL;
}

/**
 * Calculate the constant product k
 */
function getK(pool: Pool): number {
  return getEffectiveSol(pool) * pool.token_supply;
}

/**
 * Calculate how many tokens received for a given SOL input
 * Formula: tokens_out = token_supply - (k / (effective_sol + sol_in))
 */
export function calculateBuy(pool: Pool, solIn: number): number {
  if (solIn <= 0) return 0;
  
  const effectiveSol = getEffectiveSol(pool);
  const k = effectiveSol * pool.token_supply;
  
  const newEffectiveSol = effectiveSol + solIn;
  const newTokenSupply = k / newEffectiveSol;
  const tokensOut = pool.token_supply - newTokenSupply;
  
  return Math.max(0, tokensOut);
}

/**
 * Calculate how much SOL received for a given token input
 * Formula: sol_out = effective_sol - (k / (token_supply + tokens_in))
 */
export function calculateSell(pool: Pool, tokensIn: number): number {
  if (tokensIn <= 0) return 0;
  
  const effectiveSol = getEffectiveSol(pool);
  const k = effectiveSol * pool.token_supply;
  
  const newTokenSupply = pool.token_supply + tokensIn;
  const newEffectiveSol = k / newTokenSupply;
  const solOut = effectiveSol - newEffectiveSol;
  
  // Can only withdraw up to actual SOL balance (not virtual)
  return Math.max(0, Math.min(solOut, pool.sol_balance));
}

/**
 * Apply a buy to the pool and return new state
 */
export function applyBuy(pool: Pool, solIn: number, tokensOut: number): Pool {
  return {
    sol_balance: pool.sol_balance + solIn,
    token_supply: pool.token_supply - tokensOut
  };
}

/**
 * Apply a sell to the pool and return new state
 */
export function applySell(pool: Pool, tokensIn: number, solOut: number): Pool {
  return {
    sol_balance: pool.sol_balance - solOut,
    token_supply: pool.token_supply + tokensIn
  };
}

/**
 * Get current token price in SOL
 * Price = effective_sol / token_supply
 */
export function getPrice(pool: Pool): number {
  if (pool.token_supply === 0) return 0;
  return getEffectiveSol(pool) / pool.token_supply;
}

/**
 * Get price multiplier relative to initial price (for display)
 * Initial price = VIRTUAL_SOL / INITIAL_TOKEN_SUPPLY
 */
export function getPriceMultiplier(pool: Pool): number {
  const currentPrice = getPrice(pool);
  const initialPrice = VIRTUAL_SOL / INITIAL_TOKEN_SUPPLY;
  
  if (initialPrice === 0) return 1;
  return currentPrice / initialPrice;
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
 * Calculate price impact of a buy
 * Returns percentage price increase
 */
export function calculateBuyPriceImpact(pool: Pool, solIn: number): number {
  const currentPrice = getPrice(pool);
  const tokensOut = calculateBuy(pool, solIn);
  const newPool = applyBuy(pool, solIn, tokensOut);
  const newPrice = getPrice(newPool);
  
  if (currentPrice === 0) return 0;
  return ((newPrice - currentPrice) / currentPrice) * 100;
}

/**
 * Calculate price impact of a sell
 * Returns percentage price decrease
 */
export function calculateSellPriceImpact(pool: Pool, tokensIn: number): number {
  const currentPrice = getPrice(pool);
  const solOut = calculateSell(pool, tokensIn);
  const newPool = applySell(pool, tokensIn, solOut);
  const newPrice = getPrice(newPool);
  
  if (currentPrice === 0) return 0;
  return ((currentPrice - newPrice) / currentPrice) * 100;
}

/**
 * Get market cap in SOL
 */
export function getMarketCap(pool: Pool): number {
  const price = getPrice(pool);
  return price * INITIAL_TOKEN_SUPPLY;
}
