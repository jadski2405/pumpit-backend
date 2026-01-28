import { 
  getActiveRound, 
  createRound, 
  endRound, 
  getRoundTimeRemaining,
  isRoundExpired,
  formatRoundResponse,
  COUNTDOWN_DURATION,
  RoundWithPositions
} from './roundService';
import { 
  broadcastRoundUpdate as wsBroadcastRoundUpdate,
  broadcastRoundStarted as wsBroadcastRoundStarted,
  broadcastRoundEnding,
  broadcastRoundEnded,
  broadcastCountdown,
  broadcastTrade as wsBroadcastTrade,
  broadcastPriceUpdate as wsBroadcastPriceUpdate,
  sendForfeitureNotification,
  RoundBroadcast,
  TradeBroadcast
} from '../websocket/broadcast';
import prisma from '../lib/prisma';
import { VIRTUAL_SOL, INITIAL_TOKEN_SUPPLY } from '../lib/poolEngine';

// Round manager state
let isRunning = false;
let checkInterval: NodeJS.Timeout | null = null;
let countdownInterval: NodeJS.Timeout | null = null;
let countdownSeconds = 0;
let currentRound: RoundWithPositions | null = null;

// Event types for WebSocket broadcasts
export const RoundEvents = {
  ROUND_UPDATE: 'round_update',
  ROUND_STARTED: 'round_started',
  ROUND_ENDING: 'round_ending',
  ROUND_ENDED: 'round_ended',
  COUNTDOWN: 'countdown',
  PRICE_UPDATE: 'price_update',
  TRADE: 'trade',
  FORFEITURE: 'forfeiture'
} as const;

/**
 * Start the round manager background job
 */
export function startRoundManager() {
  if (isRunning) {
    console.log('[RoundManager] Already running');
    return;
  }

  isRunning = true;
  console.log('[RoundManager] Starting background job...');

  // Check every second
  checkInterval = setInterval(async () => {
    try {
      await checkAndManageRounds();
    } catch (error) {
      console.error('[RoundManager] Error in check cycle:', error);
    }
  }, 1000);

  // Initial check
  checkAndManageRounds();
}

/**
 * Stop the round manager
 */
export function stopRoundManager() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  isRunning = false;
  console.log('[RoundManager] Stopped');
}

/**
 * Main check and manage function
 */
async function checkAndManageRounds() {
  // If we're in countdown, don't check for rounds
  if (countdownSeconds > 0) {
    return;
  }

  const activeRound = await getActiveRound();

  if (!activeRound) {
    // No active round, create one
    console.log('[RoundManager] No active round, creating new one...');
    currentRound = await createRound();
    broadcastRoundStarted(currentRound);
    return;
  }

  currentRound = activeRound;
  const timeRemaining = getRoundTimeRemaining(activeRound);

  // Broadcast time update
  broadcastRoundUpdate(activeRound, timeRemaining);

  // Check if round is about to end (last 5 seconds warning)
  if (timeRemaining <= 5 && timeRemaining > 0) {
    broadcastRoundEnding(activeRound.id, Math.ceil(timeRemaining));
  }

  // Check if round has expired
  if (isRoundExpired(activeRound)) {
    await handleRoundEnd(activeRound);
  }
}

/**
 * Handle round ending
 */
async function handleRoundEnd(round: RoundWithPositions) {
  console.log(`[RoundManager] Round ${round.id} has ended`);

  // End the round and get forfeitures
  const { forfeitures } = await endRound(round.id);

  // Broadcast round ended
  broadcastRoundEnded(
    round.id,
    Number(round.current_price),
    Number(round.pool_sol_balance),
    forfeitures.map(f => ({
      profile_id: f.profileId,
      tokens_forfeited: f.tokenBalance,
      sol_value_lost: f.solValue
    }))
  );

  // Send individual forfeiture notifications to affected users
  for (const forfeiture of forfeitures) {
    // Get wallet address for this profile
    const profile = await prisma.profile.findUnique({
      where: { id: forfeiture.profileId }
    });
    if (profile) {
      sendForfeitureNotification(
        profile.wallet_address,
        forfeiture.tokenBalance,
        forfeiture.solValue
      );
    }
  }

  // Start countdown to next round
  startCountdown();
}

/**
 * Start countdown to next round
 */
function startCountdown() {
  countdownSeconds = COUNTDOWN_DURATION;
  console.log(`[RoundManager] Starting ${COUNTDOWN_DURATION}s countdown to next round`);

  countdownInterval = setInterval(async () => {
    countdownSeconds--;

    broadcastCountdown(countdownSeconds);

    if (countdownSeconds <= 0) {
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }

      // Create new round
      try {
        currentRound = await createRound();
        broadcastRoundStarted(currentRound);
      } catch (error) {
        console.error('[RoundManager] Error creating new round:', error);
      }
    }
  }, 1000);
}

/**
 * Helper to format round for broadcasting
 */
function formatRoundBroadcast(round: RoundWithPositions, timeRemaining: number): RoundBroadcast {
  const price = Number(round.current_price);
  const initialPrice = VIRTUAL_SOL / INITIAL_TOKEN_SUPPLY;
  
  return {
    id: round.id,
    status: round.status,
    pool_sol_balance: Number(round.pool_sol_balance),
    pool_token_supply: Number(round.pool_token_supply),
    current_price: price,
    price_multiplier: price / initialPrice,
    time_remaining: Math.ceil(timeRemaining),
    positions_count: round.positions.length
  };
}

/**
 * Broadcast round started
 */
function broadcastRoundStarted(round: RoundWithPositions) {
  const timeRemaining = getRoundTimeRemaining(round);
  wsBroadcastRoundStarted(formatRoundBroadcast(round, timeRemaining));
}

/**
 * Broadcast round update
 */
function broadcastRoundUpdate(round: RoundWithPositions, timeRemaining: number) {
  wsBroadcastRoundUpdate(formatRoundBroadcast(round, timeRemaining));
}

/**
 * Broadcast price update (called after trades)
 */
export function broadcastPriceUpdate(
  roundId: string,
  newPrice: number,
  priceMultiplier: number,
  poolSol: number,
  poolTokens: number
) {
  wsBroadcastPriceUpdate(roundId, newPrice, priceMultiplier, poolSol, poolTokens);
}

/**
 * Broadcast trade event
 */
export function broadcastTrade(
  roundId: string,
  tradeType: 'buy' | 'sell',
  username: string | null,
  walletAddress: string,
  solAmount: number,
  tokensTraded: number,
  newPrice: number
) {
  const trade: TradeBroadcast = {
    round_id: roundId,
    trade_type: tradeType,
    username: username || `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`,
    wallet_address: walletAddress,
    sol_amount: solAmount,
    token_amount: tokensTraded,
    price: newPrice,
    timestamp: Date.now()
  };
  wsBroadcastTrade(trade);
}

/**
 * Get current round state
 */
export function getCurrentRound(): RoundWithPositions | null {
  return currentRound;
}

/**
 * Get countdown status
 */
export function getCountdownStatus(): { inCountdown: boolean; secondsRemaining: number } {
  return {
    inCountdown: countdownSeconds > 0,
    secondsRemaining: countdownSeconds
  };
}

/**
 * Force start a new round (admin function)
 */
export async function forceNewRound(): Promise<RoundWithPositions> {
  // End current round if exists
  if (currentRound && currentRound.status === 'active') {
    await endRound(currentRound.id);
  }

  // Clear any countdown
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  countdownSeconds = 0;

  // Create new round
  currentRound = await createRound();
  broadcastRoundStarted(currentRound);
  
  return currentRound;
}

export default {
  start: startRoundManager,
  stop: stopRoundManager,
  getCurrentRound,
  getCountdownStatus,
  forceNewRound,
  broadcastPriceUpdate,
  broadcastTrade
};
