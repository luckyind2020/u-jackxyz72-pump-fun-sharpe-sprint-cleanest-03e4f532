// Steady Momentum Scalper — a Sharpe-first paper bot for the pump.fun replay.
//
// Idea: hourly Sharpe rewards smooth, repeatable gains, not moonshots. So this bot
// only buys confirmed, non-vertical momentum on liquid-enough curves, risks a small
// fixed slice per coin, banks half at +8%, dumps the rest at +15% or at a -5% stop,
// and walks away from stale coins. Small wins, many coins, no blowups.
//
// Deterministic by construction: every decision comes from the harness state only
// (no clock, no environment, no Math.random).

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { BotState, Batch } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;
const ENTRY_TARGET = (SOL * 25n) / 100n; // 0.25 SOL per entry
const MIN_BUY = (SOL * 2n) / 100n; // 0.02 SOL — never bother below this
const CASH_FLOOR = SOL; // keep at least 1 SOL uncommitted after any buy
const MIN_REAL_RESERVE = SOL; // entry needs >= 1 SOL of real reserve
const MIN_CURVE_TRADES = 10; // need some history before trusting a curve
const WINDOW = 8; // momentum measured over the last 8 trades
const MOM_MIN = 0.05; // +5% over the window to enter
const MOM_MIN_LATE = 0.03; // relaxed once the run is deep and coins are short
const LATE_SEQ = 2000; // seq after which the relaxed bar applies
const MAX_LAST_JUMP = 0.06; // never chase a single-trade vertical spike
const MIN_LAST_JUMP = -0.03; // ...or buy into a dump
const TP1 = 0.08; // sell half at +8%
const TP2 = 0.15; // sell the rest at +15%
const STOP = -0.05; // sell everything at -5%
const STALE_BATCHES = 500; // exit a position that goes nowhere for 500 batches
const DD_PAUSE = 0.08; // stop new entries after an 8% equity drawdown
const DD_RESUME = 0.05; // resume entries once back within 5% of the peak
const BUY_SLIPPAGE = 500;
const SELL_SLIPPAGE = 800;
const MAX_ENTRIES_PER_BATCH = 2;

interface Tape {
  prices: number[];
  buyVol: number;
  sellVol: number;
  lastSeq: number;
}

interface OpenTrade {
  entryPrice: number;
  entrySeq: number;
  halfSold: boolean;
}

const tape = new Map<string, Tape>();
const openTrades = new Map<string, OpenTrade>();
const coinsClosed = new Set<string>();
let peakEquity = 0;
let entriesPaused = false;

// Mark-to-market equity; pauses new entries while the book is in a drawdown
// so one bad stretch cannot compound into the 50% guardrail.
function markEquity(state: BotState): void {
  let equity = Number(state.cash);
  for (const [mint, pos] of state.positions) {
    const curve = state.curves.get(mint);
    if (curve === undefined) continue;
    equity += Number(pos.token_amount) * curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
  }
  if (equity > peakEquity) peakEquity = equity;
  if (peakEquity > 0) {
    const dd = 1 - equity / peakEquity;
    if (dd >= DD_PAUSE) entriesPaused = true;
    else if (dd <= DD_RESUME) entriesPaused = false;
  }
}

function curvePrice(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

function foldTrades(state: BotState, batch: Batch): string[] {
  const touched: string[] = [];
  for (const e of batch.events) {
    if (e.event !== 'TradeEvent') continue;
    const price = curvePrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
    if (!(price > 0)) continue;
    let t = tape.get(e.mint);
    if (t === undefined) {
      t = { prices: [], buyVol: 0, sellVol: 0, lastSeq: state.seq };
      tape.set(e.mint, t);
    }
    t.prices.push(price);
    if (t.prices.length > WINDOW + 4) t.prices.shift();
    const vol = Number(e.sol_amount);
    if (e.is_buy) t.buyVol += vol;
    else t.sellVol += vol;
    t.lastSeq = state.seq;
    touched.push(e.mint);
  }
  // Forget curves that went quiet long ago so the scan stays cheap.
  for (const [mint, t] of tape) {
    if (state.seq - t.lastSeq > 300) tape.delete(mint);
  }
  return touched;
}

function settleFills(state: BotState, batch: Batch): void {
  for (const f of batch.fills) {
    if (f.status !== 'filled') continue;
    if (f.side === 'buy') {
      const tokens = Number(f.token_amount);
      if (tokens > 0) {
        openTrades.set(f.mint, {
          entryPrice: Number(f.quote_lamports) / tokens,
          entrySeq: state.seq,
          halfSold: false,
        });
      }
    } else {
      const held = state.positions.get(f.mint);
      if (held === undefined) {
        openTrades.delete(f.mint);
        coinsClosed.add(f.mint);
      } else {
        const tr = openTrades.get(f.mint);
        if (tr !== undefined) tr.halfSold = true;
      }
    }
  }
  // Harness closes (complete / flatten / writeoff) arrive as fills too; anything
  // no longer held is a closed round trip.
  for (const mint of openTrades.keys()) {
    if (!state.positions.has(mint)) {
      openTrades.delete(mint);
      coinsClosed.add(mint);
    }
  }
}

function planExits(state: BotState): { side: 'sell'; mint: string; token_amount: bigint; max_slippage_bps: number }[] {
  const orders: { side: 'sell'; mint: string; token_amount: bigint; max_slippage_bps: number }[] = [];
  for (const [mint, pos] of state.positions) {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (!(price > 0)) continue;
    const tr = openTrades.get(mint);
    const entryPrice =
      tr !== undefined ? tr.entryPrice : Number(pos.cost_lamports) / Number(pos.token_amount);
    if (!(entryPrice > 0)) continue;
    const ret = price / entryPrice - 1;
    const stale = tr !== undefined && state.seq - tr.entrySeq > STALE_BATCHES;
    if (ret <= STOP || ret >= TP2 || stale) {
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE });
    } else if (ret >= TP1 && tr !== undefined && !tr.halfSold) {
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount / 2n, max_slippage_bps: SELL_SLIPPAGE });
      tr.halfSold = true;
    }
  }
  return orders;
}

function planEntries(state: BotState, touched: string[]): { side: 'buy'; mint: string; quote_lamports: bigint; max_slippage_bps: number }[] {
  const orders: { side: 'buy'; mint: string; quote_lamports: bigint; max_slippage_bps: number }[] = [];
  if (entriesPaused) return orders;
  if (state.committedPositionCount() >= state.hello.caps.max_open_positions) return orders;
  const bar = coinsClosed.size < 20 && state.seq > LATE_SEQ ? MOM_MIN_LATE : MOM_MIN;
  const seen = new Set<string>();
  const candidates: { mint: string; fresh: boolean }[] = [];
  for (const mint of touched) {
    if (seen.has(mint)) continue;
    seen.add(mint);
    if (state.positions.has(mint)) continue;
    if (state.pending.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (curve.trades < MIN_CURVE_TRADES) continue;
    if (curve.real_quote_reserves < MIN_REAL_RESERVE) continue;
    const t = tape.get(mint);
    if (t === undefined || t.prices.length < WINDOW + 1) continue;
    const now = t.prices[t.prices.length - 1]!;
    const ago = t.prices[t.prices.length - 1 - WINDOW]!;
    const prev = t.prices[t.prices.length - 2]!;
    const windowRet = now / ago - 1;
    const lastJump = now / prev - 1;
    if (windowRet < bar) continue;
    if (lastJump >= MAX_LAST_JUMP || lastJump <= MIN_LAST_JUMP) continue;
    if (t.buyVol <= t.sellVol) continue;
    candidates.push({ mint, fresh: !coinsClosed.has(mint) });
  }
  // Spread across new coins first: the 20-distinct-mint bar is a hard guardrail.
  candidates.sort((a, b) => Number(b.fresh) - Number(a.fresh) || (a.mint < b.mint ? -1 : 1));
  for (const c of candidates) {
    if (orders.length >= MAX_ENTRIES_PER_BATCH) break;
    if (state.committedPositionCount() + orders.length >= state.hello.caps.max_open_positions) break;
    const cap = state.maxBuyLamports(c.mint);
    let size = ENTRY_TARGET < cap ? ENTRY_TARGET : cap;
    const free = state.freeCashLamports() - CASH_FLOOR;
    if (size > free) size = free;
    if (size < MIN_BUY) continue;
    orders.push({ side: 'buy', mint: c.mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE });
  }
  return orders;
}

await runBot({
  onBatch(state, batch) {
    const touched = foldTrades(state, batch);
    settleFills(state, batch);
    markEquity(state);
    const exits = planExits(state);
    const entries = planEntries(state, touched);
    return [...exits, ...entries];
  },
});
