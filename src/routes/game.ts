import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { Pool, getPrice, getPriceMultiplier, INITIAL_TOKEN_SUPPLY, VIRTUAL_SOL } from '../lib/poolEngine';
import { 
  getActiveRound, 
  createRound, 
  formatRoundResponse, 
  getPosition,
  getRoundTimeRemaining,
  isRoundExpired
} from '../services/roundService';
import { 
  executeBuy, 
  executeSell, 
  executeSellAll,
  previewBuy,
  previewSell,
  MIN_TRADE 
} from '../services/tradeService';
import { 
  broadcastPriceUpdate, 
  broadcastTrade, 
  getCountdownStatus,
  getCurrentRound
} from '../services/roundManager';
import { sendPositionUpdate, sendBalanceUpdate } from '../websocket/broadcast';

const router = Router();

// GET /api/game/round - Get active round or create new one
router.get('/round', async (req: Request, res: Response) => {
  try {
    // Check if we're in countdown
    const countdown = getCountdownStatus();
    if (countdown.inCountdown) {
      return res.json({
        status: 'countdown',
        countdown_seconds: countdown.secondsRemaining,
        message: `Next round in ${countdown.secondsRemaining}s`
      });
    }

    // Get or create active round
    let activeRound = await getActiveRound();
    
    if (!activeRound) {
      activeRound = await createRound();
    }
    
    return res.json(formatRoundResponse(activeRound));
    
  } catch (error) {
    console.error('Error in /game/round:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/game/position/:wallet_address - Get player position in current round
router.get('/position/:wallet_address', async (req: Request, res: Response) => {
  try {
    const { wallet_address } = req.params;
    
    // Get profile
    const profile = await prisma.profile.findUnique({
      where: { wallet_address }
    });
    
    if (!profile) {
      return res.json({ position: null });
    }
    
    // Get active round
    const activeRound = await getActiveRound();
    if (!activeRound) {
      return res.json({ position: null });
    }
    
    // Get position
    const position = await getPosition(activeRound.id, profile.id);
    if (!position) {
      return res.json({ position: null });
    }
    
    // Calculate current value
    const currentPrice = Number(activeRound.current_price);
    const tokenBalance = Number(position.token_balance);
    const currentValue = tokenBalance * currentPrice;
    const totalIn = Number(position.total_sol_in);
    const totalOut = Number(position.total_sol_out);
    const pnl = currentValue + totalOut - totalIn;
    const pnlPercent = totalIn > 0 ? (pnl / totalIn) * 100 : 0;
    
    // Calculate unrealized PnL based on entry price
    const entryPrice = position.entry_price ? Number(position.entry_price) : null;
    let unrealizedPnl = 0;
    let unrealizedPnlPercent = 0;
    if (entryPrice && tokenBalance > 0) {
      unrealizedPnl = (currentPrice - entryPrice) * tokenBalance;
      unrealizedPnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    }
    
    return res.json({
      position: {
        round_id: position.round_id,
        token_balance: tokenBalance,
        total_sol_in: totalIn,
        total_sol_out: totalOut,
        current_value: currentValue,
        entry_price: entryPrice,
        current_price: currentPrice,
        pnl: pnl,
        pnl_percent: pnlPercent,
        unrealized_pnl: unrealizedPnl,
        unrealized_pnl_percent: unrealizedPnlPercent
      }
    });
    
  } catch (error) {
    console.error('Error in /game/position:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/game/pnl/:wallet_address - Get current PnL snapshot for a player
router.get('/pnl/:wallet_address', async (req: Request, res: Response) => {
  try {
    const { wallet_address } = req.params;
    
    // Get profile
    const profile = await prisma.profile.findUnique({
      where: { wallet_address }
    });
    
    if (!profile) {
      return res.json({ 
        success: false, 
        error: 'Profile not found',
        pnl: null 
      });
    }
    
    // Get active round
    const activeRound = await getActiveRound();
    if (!activeRound) {
      return res.json({ 
        success: true,
        pnl: null,
        message: 'No active round' 
      });
    }
    
    // Get position
    const position = await getPosition(activeRound.id, profile.id);
    if (!position) {
      return res.json({ 
        success: true,
        pnl: null,
        message: 'No position in current round' 
      });
    }
    
    const currentPrice = Number(activeRound.current_price);
    const tokenBalance = Number(position.token_balance);
    const totalIn = Number(position.total_sol_in);
    const totalOut = Number(position.total_sol_out);
    const entryPrice = position.entry_price ? Number(position.entry_price) : null;
    
    // Current value of tokens held
    const currentValue = tokenBalance * currentPrice;
    
    // Total PnL = current value + SOL received from sells - SOL spent on buys
    const totalPnl = currentValue + totalOut - totalIn;
    const totalPnlPercent = totalIn > 0 ? (totalPnl / totalIn) * 100 : 0;
    
    // Unrealized PnL based on entry price (for open position only)
    let unrealizedPnl = 0;
    let unrealizedPnlPercent = 0;
    if (entryPrice && tokenBalance > 0) {
      unrealizedPnl = (currentPrice - entryPrice) * tokenBalance;
      unrealizedPnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    }
    
    return res.json({
      success: true,
      pnl: {
        round_id: activeRound.id,
        wallet_address: wallet_address,
        
        // Position info
        token_balance: tokenBalance,
        entry_price: entryPrice,
        current_price: currentPrice,
        
        // Value tracking
        total_sol_in: totalIn,
        total_sol_out: totalOut,
        current_value: currentValue,
        
        // PnL calculations
        total_pnl: totalPnl,
        total_pnl_percent: totalPnlPercent,
        unrealized_pnl: unrealizedPnl,
        unrealized_pnl_percent: unrealizedPnlPercent,
        
        // Timestamps
        timestamp: Date.now()
      }
    });
    
  } catch (error) {
    console.error('Error in /game/pnl:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/game/trade - Execute a trade
router.post('/trade', async (req: Request, res: Response) => {
  try {
    const { wallet_address, trade_type, sol_amount } = req.body;
    
    if (!wallet_address || !trade_type || sol_amount === undefined) {
      return res.status(400).json({ 
        success: false, 
        error: 'wallet_address, trade_type, and sol_amount are required' 
      });
    }
    
    if (trade_type !== 'buy' && trade_type !== 'sell') {
      return res.json({ success: false, error: 'trade_type must be "buy" or "sell"' });
    }
    
    if (sol_amount < MIN_TRADE) {
      return res.json({ success: false, error: `Minimum trade is ${MIN_TRADE} SOL` });
    }
    
    // Get profile
    const profile = await prisma.profile.findUnique({
      where: { wallet_address }
    });
    
    if (!profile) {
      return res.json({ success: false, error: 'Profile not found' });
    }
    
    // Get active round
    const activeRound = await getActiveRound();
    if (!activeRound) {
      return res.json({ success: false, error: 'No active round' });
    }
    
    // Check if round is expired
    if (isRoundExpired(activeRound)) {
      return res.json({ success: false, error: 'Round has ended' });
    }
    
    // Execute trade
    let result;
    if (trade_type === 'buy') {
      result = await executeBuy(profile.id, activeRound.id, sol_amount);
    } else {
      result = await executeSell(profile.id, activeRound.id, sol_amount);
    }
    
    if (!result.success) {
      return res.json(result);
    }
    
    // Broadcast updates
    if (result.newPrice !== undefined && result.priceMultiplier !== undefined) {
      // Get updated round for accurate pool values
      const updatedRound = await prisma.gameRound.findUnique({
        where: { id: activeRound.id }
      });
      
      if (updatedRound) {
        broadcastPriceUpdate(
          activeRound.id,
          result.newPrice,
          result.priceMultiplier,
          Number(updatedRound.pool_sol_balance),
          Number(updatedRound.pool_token_supply)
        );
        
        broadcastTrade(
          activeRound.id,
          trade_type,
          profile.username,
          wallet_address,
          sol_amount,
          result.tokensTraded || 0,
          result.newPrice
        );
      }
      
      // Send targeted updates to the user
      if (result.position) {
        const currentValue = result.position.token_balance * (result.newPrice || 0);
        const pnl = currentValue + result.position.total_sol_out - result.position.total_sol_in;
        const pnlPercent = result.position.total_sol_in > 0 ? (pnl / result.position.total_sol_in) * 100 : 0;
        
        sendPositionUpdate(wallet_address, {
          round_id: activeRound.id,
          token_balance: result.position.token_balance,
          total_sol_in: result.position.total_sol_in,
          total_sol_out: result.position.total_sol_out,
          current_value: currentValue,
          pnl: pnl,
          pnl_percent: pnlPercent
        });
      }
      
      if (result.newBalance !== undefined) {
        const change = trade_type === 'buy' ? -sol_amount : (result.solAmount || 0);
        sendBalanceUpdate(wallet_address, {
          deposited_balance: result.newBalance,
          change: change,
          reason: trade_type === 'buy' ? 'Token purchase' : 'Token sale'
        });
      }
    }
    
    return res.json({
      success: true,
      trade_type: trade_type,
      tokens_traded: result.tokensTraded,
      sol_amount: result.solAmount,
      new_price: result.newPrice,
      price_multiplier: result.priceMultiplier,
      fee_amount: result.feeAmount,
      new_balance: result.newBalance,
      position: result.position
    });
    
  } catch (error) {
    console.error('Error in /game/trade:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/game/sell-all - Sell all tokens
router.post('/sell-all', async (req: Request, res: Response) => {
  try {
    const { wallet_address } = req.body;
    
    if (!wallet_address) {
      return res.status(400).json({ success: false, error: 'wallet_address is required' });
    }
    
    // Get profile
    const profile = await prisma.profile.findUnique({
      where: { wallet_address }
    });
    
    if (!profile) {
      return res.json({ success: false, error: 'Profile not found' });
    }
    
    // Get active round
    const activeRound = await getActiveRound();
    if (!activeRound) {
      return res.json({ success: false, error: 'No active round' });
    }
    
    // Check if round is expired
    if (isRoundExpired(activeRound)) {
      return res.json({ success: false, error: 'Round has ended' });
    }
    
    // Execute sell all
    const result = await executeSellAll(profile.id, activeRound.id);
    
    if (!result.success) {
      return res.json(result);
    }
    
    // Broadcast updates
    if (result.newPrice !== undefined && result.priceMultiplier !== undefined) {
      const updatedRound = await prisma.gameRound.findUnique({
        where: { id: activeRound.id }
      });
      
      if (updatedRound) {
        broadcastPriceUpdate(
          activeRound.id,
          result.newPrice,
          result.priceMultiplier,
          Number(updatedRound.pool_sol_balance),
          Number(updatedRound.pool_token_supply)
        );
        
        broadcastTrade(
          activeRound.id,
          'sell',
          profile.username,
          wallet_address,
          result.solAmount || 0,
          result.tokensTraded || 0,
          result.newPrice
        );
      }
      
      // Send targeted balance update
      if (result.newBalance !== undefined) {
        sendBalanceUpdate(wallet_address, {
          deposited_balance: result.newBalance,
          change: result.solAmount || 0,
          reason: 'Sold all tokens'
        });
      }
    }
    
    return res.json({
      success: true,
      tokens_sold: result.tokensTraded,
      sol_received: result.solAmount,
      new_price: result.newPrice,
      price_multiplier: result.priceMultiplier,
      fee_amount: result.feeAmount,
      new_balance: result.newBalance
    });
    
  } catch (error) {
    console.error('Error in /game/sell-all:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/game/preview - Preview a trade
router.get('/preview', async (req: Request, res: Response) => {
  try {
    const { trade_type, sol_amount } = req.query;
    
    if (!trade_type || !sol_amount) {
      return res.status(400).json({ error: 'trade_type and sol_amount are required' });
    }
    
    const amount = parseFloat(sol_amount as string);
    if (isNaN(amount) || amount <= 0) {
      return res.json({ error: 'Invalid sol_amount' });
    }
    
    // Get active round
    const activeRound = await getActiveRound();
    if (!activeRound) {
      return res.json({ error: 'No active round' });
    }
    
    const pool: Pool = {
      sol_balance: Number(activeRound.pool_sol_balance),
      token_supply: Number(activeRound.pool_token_supply)
    };
    
    if (trade_type === 'buy') {
      const preview = previewBuy(pool, amount);
      return res.json({
        trade_type: 'buy',
        sol_in: amount,
        tokens_out: preview.tokensOut,
        new_price: preview.newPrice,
        price_multiplier: preview.priceMultiplier,
        price_impact: preview.priceImpact,
        fee_amount: preview.feeAmount
      });
    } else if (trade_type === 'sell') {
      // For sell preview, sol_amount represents token value
      const currentPrice = getPrice(pool);
      const tokensToSell = amount / currentPrice;
      const preview = previewSell(pool, tokensToSell);
      return res.json({
        trade_type: 'sell',
        tokens_in: tokensToSell,
        sol_out: preview.solOut,
        new_price: preview.newPrice,
        price_multiplier: preview.priceMultiplier,
        price_impact: preview.priceImpact,
        fee_amount: preview.feeAmount
      });
    } else {
      return res.json({ error: 'trade_type must be "buy" or "sell"' });
    }
    
  } catch (error) {
    console.error('Error in /game/preview:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/game/leaderboard - Get leaderboard for current round
router.get('/leaderboard', async (req: Request, res: Response) => {
  try {
    const activeRound = await getActiveRound();
    if (!activeRound) {
      return res.json({ leaderboard: [] });
    }
    
    const currentPrice = Number(activeRound.current_price);
    
    // Calculate PnL for each position
    const leaderboard = activeRound.positions
      .map(p => {
        const tokenBalance = Number(p.token_balance);
        const totalIn = Number(p.total_sol_in);
        const totalOut = Number(p.total_sol_out);
        const currentValue = tokenBalance * currentPrice;
        const pnl = currentValue + totalOut - totalIn;
        const pnlPercent = totalIn > 0 ? (pnl / totalIn) * 100 : 0;
        
        return {
          username: p.profile.username || `${p.profile.wallet_address.slice(0, 4)}...${p.profile.wallet_address.slice(-4)}`,
          wallet_address: p.profile.wallet_address,
          token_balance: tokenBalance,
          total_sol_in: totalIn,
          total_sol_out: totalOut,
          current_value: currentValue,
          pnl: pnl,
          pnl_percent: pnlPercent
        };
      })
      .filter(p => p.total_sol_in > 0) // Only include players who traded
      .sort((a, b) => b.pnl - a.pnl); // Sort by PnL descending
    
    return res.json({ leaderboard });
    
  } catch (error) {
    console.error('Error in /game/leaderboard:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/game/trades/:round_id - Get recent trades for a round
router.get('/trades/:round_id', async (req: Request, res: Response) => {
  try {
    const { round_id } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    
    const trades = await prisma.trade.findMany({
      where: { round_id },
      orderBy: { created_at: 'desc' },
      take: limit,
      include: {
        profile: {
          select: { username: true, wallet_address: true }
        }
      }
    });
    
    return res.json({
      trades: trades.map(t => ({
        id: t.id,
        trade_type: t.trade_type,
        username: t.profile.username || `${t.profile.wallet_address.slice(0, 4)}...${t.profile.wallet_address.slice(-4)}`,
        wallet_address: t.profile.wallet_address,
        sol_amount: Number(t.sol_amount),
        token_amount: Number(t.token_amount),
        price_at_trade: Number(t.price_at_trade),
        fee_amount: Number(t.fee_amount),
        created_at: t.created_at
      }))
    });
    
  } catch (error) {
    console.error('Error in /game/trades:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
