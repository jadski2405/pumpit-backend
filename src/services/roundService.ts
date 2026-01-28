import prisma from '../lib/prisma';
import { getInitialPool, getPrice, INITIAL_TOKEN_SUPPLY, VIRTUAL_SOL } from '../lib/poolEngine';
import { GameRound, PlayerPosition, Profile } from '@prisma/client';

// Round configuration
export const ROUND_DURATION = 30; // seconds
export const COUNTDOWN_DURATION = 20; // seconds between rounds

export interface RoundWithPositions extends GameRound {
  positions: (PlayerPosition & {
    profile: Pick<Profile, 'username' | 'wallet_address'>;
  })[];
}

/**
 * Get the currently active round, or create a new one if none exists or current is expired
 */
export async function getActiveRound(): Promise<RoundWithPositions | null> {
  // Find active round
  let activeRound = await prisma.gameRound.findFirst({
    where: { status: 'active' },
    include: {
      positions: {
        include: {
          profile: {
            select: { username: true, wallet_address: true }
          }
        }
      }
    }
  });

  if (!activeRound) {
    return null;
  }

  // Check if round has expired
  const timeRemaining = getRoundTimeRemaining(activeRound);
  if (timeRemaining <= 0) {
    // Round is expired but not yet ended by the background job
    return activeRound;
  }

  return activeRound;
}

/**
 * Create a new round with initial pool state
 */
export async function createRound(): Promise<RoundWithPositions> {
  const initialPool = getInitialPool();
  const initialPrice = getPrice(initialPool);

  const round = await prisma.gameRound.create({
    data: {
      status: 'active',
      duration_seconds: ROUND_DURATION,
      pool_sol_balance: initialPool.sol_balance,
      pool_token_supply: initialPool.token_supply,
      current_price: initialPrice
    },
    include: {
      positions: {
        include: {
          profile: {
            select: { username: true, wallet_address: true }
          }
        }
      }
    }
  });

  console.log(`[RoundService] Created new round: ${round.id}`);
  return round;
}

/**
 * End a round and handle forfeitures
 * Players who didn't sell lose their remaining tokens
 */
export async function endRound(roundId: string): Promise<{
  round: GameRound;
  forfeitures: { profileId: string; tokenBalance: number; solValue: number }[];
}> {
  const round = await prisma.gameRound.findUnique({
    where: { id: roundId },
    include: {
      positions: {
        include: {
          profile: true
        }
      }
    }
  });

  if (!round) {
    throw new Error('Round not found');
  }

  if (round.status === 'completed') {
    return { round, forfeitures: [] };
  }

  const forfeitures: { profileId: string; tokenBalance: number; solValue: number }[] = [];

  // Calculate forfeitures for players who still hold tokens
  for (const position of round.positions) {
    const tokenBalance = Number(position.token_balance);
    if (tokenBalance > 0) {
      // Calculate what their tokens were worth at final price
      const solValue = tokenBalance * Number(round.current_price);
      forfeitures.push({
        profileId: position.profile_id,
        tokenBalance,
        solValue
      });
    }
  }

  // Update round status
  const updatedRound = await prisma.gameRound.update({
    where: { id: roundId },
    data: {
      status: 'completed',
      ended_at: new Date()
    }
  });

  console.log(`[RoundService] Ended round: ${roundId}, forfeitures: ${forfeitures.length}`);
  return { round: updatedRound, forfeitures };
}

/**
 * Get time remaining in a round (in seconds)
 */
export function getRoundTimeRemaining(round: GameRound): number {
  const startedAt = new Date(round.started_at).getTime();
  const now = Date.now();
  const elapsedSeconds = (now - startedAt) / 1000;
  const remaining = round.duration_seconds - elapsedSeconds;
  return Math.max(0, remaining);
}

/**
 * Check if a round is expired
 */
export function isRoundExpired(round: GameRound): boolean {
  return getRoundTimeRemaining(round) <= 0;
}

/**
 * Get round by ID with positions
 */
export async function getRoundById(roundId: string): Promise<RoundWithPositions | null> {
  return prisma.gameRound.findUnique({
    where: { id: roundId },
    include: {
      positions: {
        include: {
          profile: {
            select: { username: true, wallet_address: true }
          }
        }
      }
    }
  });
}

/**
 * Get position for a profile in a round
 */
export async function getPosition(roundId: string, profileId: string) {
  return prisma.playerPosition.findUnique({
    where: {
      round_id_profile_id: {
        round_id: roundId,
        profile_id: profileId
      }
    }
  });
}

/**
 * Format round for API response
 */
export function formatRoundResponse(round: RoundWithPositions) {
  const timeRemaining = getRoundTimeRemaining(round);
  
  return {
    id: round.id,
    status: round.status,
    started_at: round.started_at,
    ended_at: round.ended_at,
    duration_seconds: round.duration_seconds,
    time_remaining: timeRemaining,
    pool_sol_balance: Number(round.pool_sol_balance),
    pool_token_supply: Number(round.pool_token_supply),
    current_price: Number(round.current_price),
    price_multiplier: Number(round.current_price) / (VIRTUAL_SOL / INITIAL_TOKEN_SUPPLY),
    positions: round.positions.map(p => ({
      profile_id: p.profile_id,
      username: p.profile.username,
      wallet_address: p.profile.wallet_address,
      token_balance: Number(p.token_balance),
      total_sol_in: Number(p.total_sol_in),
      total_sol_out: Number(p.total_sol_out)
    }))
  };
}
