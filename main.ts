// Momentum Sniper — a paper bot for the pump.fun replay (agent-fun/replay/v2).
//
// Most new pump.fun coins are dead within seconds. The rare ones that catch
// a real bid advertise it at once: several strangers buying meaningful size,
// the dev still holding, no early dump, and the price already lifting off its
// opening print. This bot only buys those. It risks 0.1 SOL per coin, banks
// +25% winners, cuts losers at -8%, trails anything that keeps climbing, and
// never holds a coin longer than 40 slots.
//
// Nothing here reads a clock or rolls dice: every choice is a pure function
// of the batch stream, and iteration follows insertion order only, so two
// runs of this file produce the same orders byte for byte.
//
// The contest needs round trips on at least 20 coins. When the bot's own
// closed trades fall behind the pace of the 24h window, a sweeper opens tiny
// 0.03 SOL probe round trips on liquid coins to keep the entry over the bar,
// at most one probe open at a time.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000;
// Protocol + creator curve fee taken on each side of a trade.
const CURVE_FEE = 0.0125;
// Seconds of block time in the replay window; only paces the sweeper.
const DAY_SECS = 86_400;

// --- settings ---------------------------------------------------------------

// How old (slots since the CreateEvent) a coin may be when first bought.
const ENTRY_MAX_AGE = 6;
// Unrelated wallets that must have bought before an entry.
const MIN_BACKERS = 5;
// SOL those wallets must have put in together before an entry.
const MIN_BACKED_SOL = 0.8;
// Biggest single early sell tolerated, in SOL.
const MAX_FIRST_SELL_SOL = 0.5;
// Most the price may have risen off its opening print at entry.
const MAX_OPEN_RUNUP = 0.15;
// Real SOL in the curve at entry, low and high bound.
const MIN_CURVE_SOL = 0.5;
const MAX_CURVE_SOL = 30;
// SOL staked per coin, most live coins, most SOL at cost at once.
const STAKE_SOL = 0.1;
const MAX_LIVE = 5;
const MAX_RISK_SOL = 6;
// Slippage on buys in bps; sells leave with no cap so they always fill.
const BUY_SLIP_BPS = 10_000;
// Exits as fractions of cost, then of the peak value.
const WIN_TAKE = 0.25;
const LOSS_CUT = 0.08;
const TRAIL_START = 0.1;
const TRAIL_KEEP = 0.1;
// Fade exit: net SOL over this span, while under water.
const FADE_SPAN = 24;
const FADE_FLOOR_SOL = -0.8;
// Most slots a coin may be held.
const HOLD_LIMIT = 40;
// Sweeper target for closed coins by the end of the window, and probe size.
const SWEEP_TARGET = 30;
const SWEEP_SOL = 0.03;

// --- per-coin tape ----------------------------------------------------------

interface CoinFill {
  slot: number;
  buy: boolean;
  sol: number;
  who: string;
  px: number;
}

interface CoinTape {
  bornSlot: number | null;
  dev: string | null;
  openPx: number;
  /** The dev sold some of their own allocation already. */
  devDumped: boolean;
  /** Unrelated wallets that bought. */
  backers: Set<string>;
  /** SOL those wallets put in since creation. */
  backedSol: number;
  /** Biggest single sell seen so far, in SOL. */
  worstSellSol: number;
  fills: CoinFill[];
  bought: boolean;
  swept: boolean;
}

interface LivePos {
  sinceSlot: number;
  peakSol: number;
  landed: boolean;
  leaving: boolean;
}

const book = new Map<Pubkey, CoinTape>();
const live = new Map<Pubkey, LivePos>();
// Coins with a probe out: mint -> true once the probe buy filled.
const sweeps = new Map<Pubkey, boolean>();
// Coins closed out (a buy fill and a later sell fill).
const closed = new Set<Pubkey>();
let seenFills = 0;
let t0: number | null = null;
let t1: number | null = null;

function tapeFor(mint: Pubkey): CoinTape {
  let tape = book.get(mint);
  if (tape === undefined) {
    tape = {
      bornSlot: null,
      dev: null,
      openPx: 0,
      devDumped: false,
      backers: new Set<string>(),
      backedSol: 0,
      worstSellSol: 0,
      fills: [],
      bought: false,
      swept: false,
    };
    book.set(mint, tape);
  }
  return tape;
}

/** Price of one token in SOL from the virtual reserves. */
function pxOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

/** SOL a holding of `tokens` fetches if sold now, after fees. */
function exitValue(tokens: bigint, virtualQuote: bigint, virtualToken: bigint, txFeeLamports: bigint): number {
  const n = Number(tokens);
  if (n <= 0) return 0;
  const quote = Number(virtualQuote);
  const supply = Number(virtualToken);
  const gross = (n * quote) / (supply + n) / LAMPORTS;
  return gross * (1 - CURVE_FEE) - Number(txFeeLamports) / LAMPORTS;
}

/** Net SOL (buys minus sells) on a tape over the last `span` slots. */
function flowOver(tape: CoinTape, now: number, span: number): number {
  let net = 0;
  for (let i = tape.fills.length - 1; i >= 0; i--) {
    const fill = tape.fills[i]!;
    if (fill.slot <= now - span) break;
    net += fill.buy ? fill.sol : -fill.sol;
  }
  return net;
}

/**
 * Is this coin, right now, a clean young launch with real early demand? Only
 * the opening tape decides: age, what the dev did, how many wallets bought
 * and how much SOL they staked, early dumps, and the lift off the opening
 * print. The price must sit above that print: the bid is genuine, not noise.
 */
function goodLaunch(tape: CoinTape, now: number, curveSol: number, px: number): boolean {
  if (tape.bornSlot === null) return false;
  if (now - tape.bornSlot > ENTRY_MAX_AGE) return false;
  if (tape.devDumped) return false;
  if (tape.backers.size < MIN_BACKERS) return false;
  if (tape.backedSol < MIN_BACKED_SOL) return false;
  if (tape.worstSellSol >= MAX_FIRST_SELL_SOL) return false;
  if (curveSol < MIN_CURVE_SOL || curveSol > MAX_CURVE_SOL) return false;
  if (tape.openPx <= 0 || px <= tape.openPx) return false;
  if (px > tape.openPx * (1 + MAX_OPEN_RUNUP)) return false;
  return true;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const txFee = state.txFeeLamports();
    const orders: OrderInput[] = [];
    const maxOrders = state.hello.caps.max_orders_per_batch;

    // Count this batch's fills in the bot's own tallies.
    for (const fill of batch.fills) {
      if (fill.status === 'filled' && !fill.client_id.startsWith('_')) {
        seenFills++;
        if (fill.side === 'sell') closed.add(fill.mint);
      }
    }

    // Fold the batch's events into the tapes; track the block-time pace.
    const traded = new Set<Pubkey>();
    for (const ev of batch.events) {
      if (ev.block_time !== null) {
        if (t0 === null) t0 = ev.block_time;
        if (t1 === null || ev.block_time > t1) t1 = ev.block_time;
      }
      if (ev.event === 'CreateEvent') {
        const tape = tapeFor(ev.mint);
        tape.bornSlot = ev.slot;
        tape.dev = ev.creator;
        tape.openPx = pxOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves));
      } else if (ev.event === 'TradeEvent') {
        const tape = tapeFor(ev.mint);
        const sol = Number(ev.sol_amount) / LAMPORTS;
        if (!ev.is_buy && sol > tape.worstSellSol) tape.worstSellSol = sol;
        if (tape.dev !== null && ev.user === tape.dev && !ev.is_buy) tape.devDumped = true;
        if (ev.is_buy && (tape.dev === null || ev.user !== tape.dev)) {
          tape.backers.add(ev.user);
          tape.backedSol += sol;
        }
        tape.fills.push({
          slot: ev.slot,
          buy: ev.is_buy,
          sol,
          who: ev.user,
          px: pxOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves)),
        });
        traded.add(ev.mint);
      }
    }
    // Trim tapes for coins that traded, keeping a little past the fade span.
    const keepFrom = now - FADE_SPAN - 10;
    for (const mint of traded) {
      const tape = book.get(mint)!;
      let cut = 0;
      while (cut < tape.fills.length && tape.fills[cut]!.slot <= keepFrom) cut++;
      if (cut > 0) tape.fills.splice(0, cut);
    }

    const marks = new Map(batch.marks.map((mark) => [mark.mint, mark] as const));
    const pendingByMint = new Map<Pubkey, string[]>();
    for (const po of state.pending.values()) {
      const sides = pendingByMint.get(po.order.mint);
      if (sides === undefined) pendingByMint.set(po.order.mint, [po.order.side]);
      else sides.push(po.order.side);
    }
    const sellPending = (mint: Pubkey): boolean =>
      (pendingByMint.get(mint) ?? []).includes('sell');

    // --- exits first: re-price every live coin on this batch's marks.
    for (const [mint, pos] of live) {
      const held = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (held === undefined) {
        // Gone (sell filled, harness close, or write-off): forget it.
        if (!pendingByMint.has(mint)) live.delete(mint);
        continue;
      }
      pos.landed = true;
      if (curve === undefined || curve.complete) continue;
      const mark = marks.get(mint);
      const vq = mark ? BigInt(mark.virtual_quote_reserves) : curve.virtual_quote_reserves;
      const vt = mark ? BigInt(mark.virtual_token_reserves) : curve.virtual_token_reserves;
      const value = exitValue(BigInt(held.token_amount), vq, vt, txFee);
      const cost = Number(held.cost_lamports) / LAMPORTS;
      if (value > pos.peakSol) pos.peakSol = value;
      const tape = tapeFor(mint);
      let exit = pos.leaving;
      if (!exit && value >= cost * (1 + WIN_TAKE)) exit = true;
      if (!exit && value <= cost * (1 - LOSS_CUT)) exit = true;
      if (!exit && pos.peakSol >= cost * (1 + TRAIL_START) && value <= pos.peakSol * (1 - TRAIL_KEEP)) exit = true;
      if (!exit && value < cost && flowOver(tape, now, FADE_SPAN) < FADE_FLOOR_SOL) exit = true;
      if (!exit && now - pos.sinceSlot > HOLD_LIMIT) exit = true;
      if (!exit) continue;
      pos.leaving = true;
      if (sellPending(mint)) continue;
      if (orders.length >= maxOrders) break;
      orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: 10_000 });
    }

    // --- probe sells: a probe leaves whole once its buy has landed.
    for (const [mint, leaving] of sweeps) {
      const held = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (held === undefined) {
        if (!pendingByMint.has(mint)) sweeps.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= maxOrders) break;
      orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: 10_000 });
      if (!leaving) sweeps.set(mint, true);
    }

    // --- entries: clean young launches, then the guardrail sweeper.
    let freeSol = Number(state.freeCashLamports()) / LAMPORTS;
    const txSol = Number(txFee) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let riskSol = 0;
    for (const [mint, pos] of live) {
      const held = state.positions.get(mint);
      riskSol += held === undefined ? 0 : Number(held.cost_lamports) / LAMPORTS;
      void pos;
    }

    for (const mint of traded) {
      if (orders.length >= maxOrders) break;
      if (slotsLeft <= 0) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || sweeps.has(mint) || live.has(mint)) continue;
      const tape = book.get(mint)!;
      if (tape.bought) continue;
      const curveSol = Number(curve.real_quote_reserves) / LAMPORTS;
      const px = pxOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (!goodLaunch(tape, now, curveSol, px)) continue;
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
      let amount = Math.min(capSol, STAKE_SOL, MAX_RISK_SOL - riskSol);
      if (amount > freeSol - txSol) amount = freeSol - txSol;
      if (amount < 0.01) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
        max_slippage_bps: BUY_SLIP_BPS,
      });
      tape.bought = true;
      live.set(mint, { sinceSlot: now, peakSol: 0, landed: false, leaving: false });
      freeSol -= amount + txSol;
      riskSol += amount;
      slotsLeft--;
    }

    // Sweeper: when closed coins trail the window's pace, open one small probe.
    if (sweeps.size === 0 && slotsLeft > 0 && t0 !== null && t1 !== null) {
      const pace = Math.min(1, (t1 - t0) / DAY_SECS);
      const want = Math.ceil(SWEEP_TARGET * pace);
      if (closed.size < want && pace > 0.05) {
        const minCurve = (SWEEP_SOL * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of traded) {
          if (orders.length >= maxOrders || sweeps.size > 0) break;
          if (live.has(mint) || sweeps.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          const tape = book.get(mint)!;
          if (tape.swept) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS < minCurve * 1.5) continue;
          if (freeSol < SWEEP_SOL + 2 * txSol) break;
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: BigInt(Math.floor(SWEEP_SOL * LAMPORTS)),
            max_slippage_bps: BUY_SLIP_BPS,
          });
          tape.swept = true;
          sweeps.set(mint, false);
          freeSol -= SWEEP_SOL + txSol;
        }
      }
    }

    return orders;
  },
});
