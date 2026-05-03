import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { privateKeyToAccount } from 'viem/accounts';
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const STATE_DIR = join(ROOT, '.runtime');
const STATE_PATH = join(STATE_DIR, '100xmira-runner-state.json');
const HL_API_URL = 'https://api.hyperliquid.xyz';
const transport = new HttpTransport({ url: HL_API_URL });

const PAIR = 'ETH';
const POLL_SECONDS = parseInt(process.env.MIRAIX_100X_POLL_SECONDS ?? '30', 10);
const MIN_NOTIONAL = parseFloat(process.env.MIRAIX_100X_MIN_NOTIONAL ?? '12');
const MAX_MARGIN_USDC = parseFloat(process.env.MIRAIX_100X_MAX_MARGIN_USDC ?? '8');
const MARGIN_FRACTION = parseFloat(process.env.MIRAIX_100X_MARGIN_FRACTION ?? '0.2');
const MAX_NOTIONAL_USDC = parseFloat(process.env.MIRAIX_100X_MAX_NOTIONAL_USDC ?? '800');
const BREAKOUT_LOOKBACK = parseInt(process.env.MIRAIX_100X_BREAKOUT_LOOKBACK ?? '20', 10);
const VOLUME_MULTIPLIER = parseFloat(process.env.MIRAIX_100X_VOLUME_MULTIPLIER ?? '1.5');
const RANGE_MULTIPLIER = parseFloat(process.env.MIRAIX_100X_RANGE_MULTIPLIER ?? '1.3');
const BREAK_EVEN_ROE = parseFloat(process.env.MIRAIX_100X_BREAK_EVEN_ROE ?? '0.0022');
const STOP_LOSS_MULTIPLIER = parseFloat(process.env.MIRAIX_100X_STOP_LOSS_MULTIPLIER ?? '0.9982');
const TAKE_PROFIT_MULTIPLIER = parseFloat(process.env.MIRAIX_100X_TAKE_PROFIT_MULTIPLIER ?? '1.004');
const TIMEOUT_MS = parseInt(process.env.MIRAIX_100X_TIMEOUT_MS ?? String(8 * 60 * 1000), 10);
const PAUSE_HOURS = parseInt(process.env.MIRAIX_100X_LOSS_PAUSE_HOURS ?? '12', 10);
const DAILY_LOSS_LIMIT = parseFloat(process.env.MIRAIX_100X_DAILY_LOSS_LIMIT ?? '0.06');
const DGCLAW_AGENT_ID = process.env.DGCLAW_AGENT_ID ?? '989';
const DGCLAW_SIGNALS_THREAD_ID = process.env.DGCLAW_SIGNALS_THREAD_ID ?? '984';
const DGCLAW_API_KEY = process.env.DGCLAW_API_KEY;

type Candle = {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
};

type OpenTradeState = {
  pair: string;
  side: 'long';
  openedAt: number;
  entryPx: number;
  size: string;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  stopMovedToBreakeven: boolean;
  signalHigh: number;
  notional: number;
};

type RunnerState = {
  consecutiveLosses: number;
  pausedUntil: number | null;
  dailyDate: string;
  dailyStartEquity: number;
  dailyRealizedPnl: number;
  lastProcessedFillTime: number;
  openTrade: OpenTradeState | null;
};

function defaultState(): RunnerState {
  return {
    consecutiveLosses: 0,
    pausedUntil: null,
    dailyDate: new Date().toISOString().slice(0, 10),
    dailyStartEquity: 0,
    dailyRealizedPnl: 0,
    lastProcessedFillTime: 0,
    openTrade: null,
  };
}

function loadState(): RunnerState {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as RunnerState;
  } catch {
    return defaultState();
  }
}

function saveState(state: RunnerState) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function ema(values: number[], period: number) {
  const k = 2 / (period + 1);
  let current = values[0];
  for (let i = 1; i < values.length; i += 1) {
    current = values[i] * k + current * (1 - k);
  }
  return current;
}

function vwap(candles: Candle[]) {
  let pv = 0;
  let volume = 0;
  for (const candle of candles) {
    const high = parseFloat(candle.h);
    const low = parseFloat(candle.l);
    const close = parseFloat(candle.c);
    const typical = (high + low + close) / 3;
    const v = parseFloat(candle.v);
    pv += typical * v;
    volume += v;
  }
  return volume === 0 ? 0 : pv / volume;
}

function getDayKey(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function resetDailyStateIfNeeded(state: RunnerState, equity: number) {
  const today = getDayKey();
  if (state.dailyDate !== today) {
    state.dailyDate = today;
    state.dailyStartEquity = equity;
    state.dailyRealizedPnl = 0;
  }
  if (state.dailyStartEquity === 0) {
    state.dailyStartEquity = equity;
  }
}

async function postSignal(title: string, content: string) {
  if (!DGCLAW_API_KEY) return;
  try {
    await fetch(`https://degen.virtuals.io/api/forums/${DGCLAW_AGENT_ID}/threads/${DGCLAW_SIGNALS_THREAD_ID}/posts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DGCLAW_API_KEY}`,
      },
      body: JSON.stringify({ title, content }),
    });
  } catch (error) {
    console.error(`[100xmira] failed to post signal: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function createClients() {
  const apiWalletKey = process.env.HL_API_WALLET_KEY as `0x${string}` | undefined;
  const masterAddress = process.env.HL_MASTER_ADDRESS as `0x${string}` | undefined;
  if (!apiWalletKey) throw new Error('HL_API_WALLET_KEY not set.');
  if (!masterAddress) throw new Error('HL_MASTER_ADDRESS not set.');
  const account = privateKeyToAccount(apiWalletKey);
  return {
    info: new InfoClient({ transport }),
    exchange: new ExchangeClient({ wallet: account, transport }),
    masterAddress,
  };
}

async function getAssetMeta(info: InfoClient) {
  const metaResponse = await info.meta();
  const universe = metaResponse.universe as Array<{ name: string; szDecimals: number; maxLeverage: number }>;
  const assetId = universe.findIndex((asset) => asset.name === PAIR);
  if (assetId === -1) throw new Error(`Unknown pair: ${PAIR}`);
  return { assetId, meta: universe[assetId] };
}

async function fetchCandles(info: InfoClient, interval: '1m' | '5m', bars: number) {
  const intervalMs = interval === '1m' ? 60_000 : 300_000;
  const endTime = Date.now();
  const startTime = endTime - intervalMs * (bars + 4);
  const candles = await info.candleSnapshot({ coin: PAIR, interval, startTime, endTime });
  return (candles as Candle[]).filter((c) => c.T < Date.now());
}

async function getSpotEquity(info: InfoClient, user: `0x${string}`) {
  const spotState = await info.spotClearinghouseState({ user });
  const usdc = spotState.balances.find((balance: any) => balance.coin === 'USDC');
  return parseFloat(usdc?.total ?? '0');
}

async function getCurrentPosition(info: InfoClient, user: `0x${string}`) {
  const state = await info.clearinghouseState({ user });
  return state.assetPositions.find((p: any) => p.position.coin?.toUpperCase() === PAIR && parseFloat(p.position.szi) !== 0) ?? null;
}

async function getOpenTriggerOrders(info: InfoClient, user: `0x${string}`) {
  const orders = await info.openOrders({ user });
  return orders.filter(
    (order: any) => order.coin?.toUpperCase() === PAIR && order.reduceOnly === true,
  );
}

async function cancelOpenTriggerOrders(exchange: ExchangeClient, info: InfoClient, user: `0x${string}`, assetId: number) {
  const orders = await getOpenTriggerOrders(info, user);
  for (const order of orders) {
    try {
      await exchange.cancel({ cancels: [{ a: assetId, o: order.oid }] });
    } catch {
      // ignore stale order
    }
  }
}

async function placeBrackets(
  exchange: ExchangeClient,
  info: InfoClient,
  user: `0x${string}`,
  assetId: number,
  size: string,
  stopLoss: number,
  takeProfit: number,
) {
  await cancelOpenTriggerOrders(exchange, info, user, assetId);
  await exchange.order({
    orders: [{
      a: assetId,
      b: false,
      r: true,
      p: takeProfit.toFixed(2),
      s: size,
      t: { trigger: { triggerPx: takeProfit.toFixed(2), isMarket: true, tpsl: 'tp' } },
    }],
    grouping: 'na',
  });
  await exchange.order({
    orders: [{
      a: assetId,
      b: false,
      r: true,
      p: stopLoss.toFixed(2),
      s: size,
      t: { trigger: { triggerPx: stopLoss.toFixed(2), isMarket: true, tpsl: 'sl' } },
    }],
    grouping: 'na',
  });
}

async function closePosition(exchange: ExchangeClient, info: InfoClient, user: `0x${string}`, assetId: number) {
  const position = await getCurrentPosition(info, user);
  if (!position) return null;
  const mids = await info.allMids();
  const midPrice = parseFloat(mids[PAIR]);
  const posSize = parseFloat(position.position.szi);
  const orderPrice = (midPrice * 0.99).toPrecision(6);
  const size = Math.abs(posSize).toString();
  const result = await exchange.order({
    orders: [{ a: assetId, b: false, r: true, p: orderPrice, s: size, t: { limit: { tif: 'Ioc' } } }],
    grouping: 'na',
  });
  return { result, midPrice, size };
}

function leverageForEquity(equity: number) {
  if (equity < 8) return 0;
  if (equity < 25) return 50;
  if (equity < 50) return 75;
  return 100;
}

async function buildSignal(info: InfoClient) {
  const [candles5m, candles1m] = await Promise.all([
    fetchCandles(info, '5m', 80),
    fetchCandles(info, '1m', 80),
  ]);
  if (candles5m.length < 60 || candles1m.length < BREAKOUT_LOOKBACK + 25) {
    return { ok: false as const, reason: 'not enough candles' };
  }

  const closes5 = candles5m.map((c) => parseFloat(c.c));
  const ema20 = ema(closes5.slice(-30), 20);
  const ema50 = ema(closes5.slice(-60), 50);
  const current5mClose = closes5[closes5.length - 1];
  const vwap5 = vwap(candles5m.slice(-48));
  if (!(ema20 > ema50 && current5mClose > vwap5)) {
    return { ok: false as const, reason: 'trend filter not satisfied', ema20, ema50, vwap5, current5mClose };
  }

  const signalBar = candles1m[candles1m.length - 1];
  const history = candles1m.slice(-(BREAKOUT_LOOKBACK + 21), -1);
  const breakoutWindow = history.slice(-BREAKOUT_LOOKBACK);
  const recent20 = history.slice(-20);
  const breakoutHigh = Math.max(...breakoutWindow.map((c) => parseFloat(c.h)));
  const close = parseFloat(signalBar.c);
  const volume = parseFloat(signalBar.v);
  const avgVolume = average(recent20.map((c) => parseFloat(c.v)));
  const range = parseFloat(signalBar.h) - parseFloat(signalBar.l);
  const medianRange = median(recent20.map((c) => parseFloat(c.h) - parseFloat(c.l)));

  if (close <= breakoutHigh) return { ok: false as const, reason: 'breakout not triggered', breakoutHigh, close };
  if (volume <= avgVolume * VOLUME_MULTIPLIER) return { ok: false as const, reason: 'volume filter failed', volume, avgVolume };
  if (range <= medianRange * RANGE_MULTIPLIER) return { ok: false as const, reason: 'range filter failed', range, medianRange };

  return {
    ok: true as const,
    breakoutHigh,
    close,
    volume,
    avgVolume,
    range,
    medianRange,
  };
}

async function processClosedTrade(info: InfoClient, state: RunnerState, user: `0x${string}`) {
  const openTrade = state.openTrade;
  if (!openTrade) return;
  const fills = await info.userFillsByTime({ user, startTime: openTrade.openedAt - 60_000, aggregateByTime: true });
  const relevant = fills.filter((fill: any) => fill.coin?.toUpperCase() === openTrade.pair && fill.time > state.lastProcessedFillTime);
  if (relevant.length === 0) return;
  const closed = relevant.filter((fill: any) => parseFloat(fill.closedPnl ?? '0') !== 0 || String(fill.dir ?? '').toLowerCase().includes('close'));
  if (closed.length === 0) return;

  const realizedPnl = closed.reduce((sum: number, fill: any) => sum + parseFloat(fill.closedPnl ?? '0'), 0);
  const closeTime = Math.max(...closed.map((fill: any) => fill.time));
  state.lastProcessedFillTime = Math.max(state.lastProcessedFillTime, closeTime);
  state.dailyRealizedPnl += realizedPnl;

  if (realizedPnl < 0) {
    state.consecutiveLosses += 1;
    if (state.consecutiveLosses >= 3) {
      state.pausedUntil = Date.now() + PAUSE_HOURS * 60 * 60 * 1000;
    }
  } else {
    state.consecutiveLosses = 0;
  }

  if (state.dailyStartEquity > 0 && Math.abs(Math.min(state.dailyRealizedPnl, 0)) >= state.dailyStartEquity * DAILY_LOSS_LIMIT) {
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 0, 0);
    state.pausedUntil = tomorrow.getTime();
  }

  const reason = realizedPnl > 0 ? 'tp_or_profit_close' : realizedPnl < 0 ? 'sl_or_loss_close' : 'flat_close';
  await postSignal(
    `Closed ${openTrade.pair} long (${reason})`,
    `Closed ${openTrade.pair} long. Entry ${openTrade.entryPx.toFixed(2)}. Size ${openTrade.size}. Leverage ${openTrade.leverage}x. Realized PnL ${realizedPnl.toFixed(4)} USDC. Reason: ${reason}.`,
  );
  state.openTrade = null;
}

async function evaluateOnce() {
  const state = loadState();
  const { info, exchange, masterAddress } = await createClients();
  const user = masterAddress;
  const { assetId, meta } = await getAssetMeta(info);
  const spotEquity = await getSpotEquity(info, user);
  resetDailyStateIfNeeded(state, spotEquity);

  if (state.pausedUntil && Date.now() < state.pausedUntil) {
    console.log(JSON.stringify({ action: 'idle', reason: 'paused', pausedUntil: state.pausedUntil }, null, 2));
    saveState(state);
    return;
  }

  const position = await getCurrentPosition(info, user);
  if (!position) {
    if (state.openTrade) {
      await processClosedTrade(info, state, user);
      saveState(state);
    }
  }

  if (position) {
    const pos = position.position;
    const entryPx = parseFloat(pos.entryPx);
    const size = Math.abs(parseFloat(pos.szi)).toString();
    const roe = parseFloat(pos.returnOnEquity ?? '0');

    if (!state.openTrade) {
      state.openTrade = {
        pair: PAIR,
        side: 'long',
        openedAt: Date.now(),
        entryPx,
        size,
        leverage: parseFloat(pos.leverage?.value ?? '0'),
        stopLoss: entryPx * STOP_LOSS_MULTIPLIER,
        takeProfit: entryPx * TAKE_PROFIT_MULTIPLIER,
        stopMovedToBreakeven: false,
        signalHigh: entryPx,
        notional: parseFloat(pos.positionValue ?? '0'),
      };
      const existingOrders = await getOpenTriggerOrders(info, user);
      if (existingOrders.length < 2) {
        await placeBrackets(exchange, info, user, assetId, size, state.openTrade.stopLoss, state.openTrade.takeProfit);
        console.log(`[100xmira] adopted existing ${PAIR} long and attached brackets.`);
      } else {
        console.log(`[100xmira] adopted existing ${PAIR} long with ${existingOrders.length} existing reduce-only orders.`);
      }
      saveState(state);
      return;
    }

    const openTrade = state.openTrade;
    if (!openTrade.stopMovedToBreakeven && roe >= BREAK_EVEN_ROE) {
      openTrade.stopLoss = openTrade.entryPx;
      openTrade.stopMovedToBreakeven = true;
      await placeBrackets(exchange, info, user, assetId, size, openTrade.stopLoss, openTrade.takeProfit);
      await postSignal(
        `Moved ${PAIR} stop to breakeven`,
        `Trade moved in favor. ${PAIR} long stop loss raised to breakeven at ${openTrade.entryPx.toFixed(2)}. Leverage ${openTrade.leverage}x.`,
      );
    }

    if (Date.now() - openTrade.openedAt >= TIMEOUT_MS) {
      const closeResult = await closePosition(exchange, info, user, assetId);
      await postSignal(
        `Closed ${PAIR} long (timeout)`,
        `Closed ${PAIR} long after timeout. Entry ${openTrade.entryPx.toFixed(2)}. Size ${openTrade.size}. Leverage ${openTrade.leverage}x.`,
      );
      state.lastProcessedFillTime = Date.now();
      console.log(JSON.stringify({ action: 'timeout-close', closeResult }, null, 2));
    } else {
      const openOrders = await getOpenTriggerOrders(info, user);
      if (openOrders.length < 2) {
        await placeBrackets(exchange, info, user, assetId, size, openTrade.stopLoss, openTrade.takeProfit);
      }
      saveState(state);
      console.log(JSON.stringify({ action: 'manage', pair: PAIR, roe, stopMovedToBreakeven: openTrade.stopMovedToBreakeven }, null, 2));
      return;
    }

    saveState(state);
    return;
  }

  const signal = await buildSignal(info);
  if (!signal.ok) {
    console.log(JSON.stringify({ action: 'idle', reason: signal.reason }, null, 2));
    saveState(state);
    return;
  }

  const leverageTarget = leverageForEquity(spotEquity);
  if (leverageTarget === 0) {
    console.log(JSON.stringify({ action: 'idle', reason: 'waiting_for_funds', equity: spotEquity }, null, 2));
    saveState(state);
    return;
  }

  const actualLeverage = Math.min(leverageTarget, meta.maxLeverage);
  const margin = Math.min(spotEquity * MARGIN_FRACTION, MAX_MARGIN_USDC);
  const notional = Math.min(margin * actualLeverage, MAX_NOTIONAL_USDC);
  if (notional < MIN_NOTIONAL) {
    console.log(JSON.stringify({ action: 'idle', reason: 'notional_below_minimum', notional, spotEquity }, null, 2));
    saveState(state);
    return;
  }

  const mids = await info.allMids();
  const midPrice = parseFloat(mids[PAIR]);
  const sizeNum = notional / midPrice;
  const size = sizeNum.toFixed(meta.szDecimals);
  const orderPrice = (midPrice * 1.01).toPrecision(6);
  await exchange.updateLeverage({ asset: assetId, isCross: true, leverage: actualLeverage });

  const result = await exchange.order({
    orders: [{ a: assetId, b: true, r: false, p: orderPrice, s: size, t: { limit: { tif: 'Ioc' } } }],
    grouping: 'na',
  });

  const filled = result?.response?.data?.statuses?.find((status: any) => status.filled)?.filled;
  const entryPx = parseFloat(filled?.avgPx ?? midPrice.toString());
  const filledSize = filled?.totalSz ?? size;
  const stopLoss = entryPx * STOP_LOSS_MULTIPLIER;
  const takeProfit = entryPx * TAKE_PROFIT_MULTIPLIER;

  await placeBrackets(exchange, info, user, assetId, filledSize, stopLoss, takeProfit);

  state.openTrade = {
    pair: PAIR,
    side: 'long',
    openedAt: Date.now(),
    entryPx,
    size: filledSize,
    leverage: actualLeverage,
    stopLoss,
    takeProfit,
    stopMovedToBreakeven: false,
    signalHigh: signal.breakoutHigh,
    notional,
  };

  await postSignal(
    `Opened ${PAIR} long`,
    `Opened ${PAIR} long. Entry ${entryPx.toFixed(2)}. Size ${filledSize}. Leverage target ${leverageTarget}x, actual ${actualLeverage}x. Notional ${notional.toFixed(2)} USD. TP ${takeProfit.toFixed(2)}. SL ${stopLoss.toFixed(2)}.`,
  );

  console.log(JSON.stringify({ action: 'open', leverageTarget, actualLeverage, notional, entryPx, size: filledSize, result }, null, 2));
  saveState(state);
}

async function main() {
  const mode = (process.argv[2] ?? 'once').toLowerCase();
  if (mode === 'daemon') {
    console.log(`100XMIRA runner started in daemon mode. Polling every ${POLL_SECONDS}s.`);
    while (true) {
      try {
        await evaluateOnce();
      } catch (error) {
        console.error(`[100xmira] ${error instanceof Error ? error.message : String(error)}`);
      }
      await sleep(POLL_SECONDS * 1000);
    }
  }
  await evaluateOnce();
}

main().catch((error) => {
  console.error(`[100xmira] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
