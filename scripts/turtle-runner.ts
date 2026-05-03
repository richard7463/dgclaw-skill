import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { privateKeyToAccount } from 'viem/accounts';
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const STATE_DIR = join(ROOT, '.runtime');
const STATE_PATH = join(STATE_DIR, 'turtle-runner-state.json');
const HL_API_URL = 'https://api.hyperliquid.xyz';
const transport = new HttpTransport({ url: HL_API_URL });

const PAIR = process.env.TURTLE_PAIR ?? 'ETH';
const POLL_SECONDS = parseInt(process.env.TURTLE_POLL_SECONDS ?? '60', 10);
const ENTRY_LOOKBACK = parseInt(process.env.TURTLE_ENTRY_LOOKBACK ?? '20', 10);
const EXIT_LOOKBACK = parseInt(process.env.TURTLE_EXIT_LOOKBACK ?? '10', 10);
const TREND_LOOKBACK = parseInt(process.env.TURTLE_TREND_LOOKBACK ?? '55', 10);
const MARGIN_FRACTION = parseFloat(process.env.TURTLE_MARGIN_FRACTION ?? '0.35');
const MAX_MARGIN_USDC = parseFloat(process.env.TURTLE_MAX_MARGIN_USDC ?? '12');
const MIN_NOTIONAL = parseFloat(process.env.TURTLE_MIN_NOTIONAL ?? '15');
const MAX_NOTIONAL_USDC = parseFloat(process.env.TURTLE_MAX_NOTIONAL_USDC ?? '250');
const BASE_LEVERAGE = parseFloat(process.env.TURTLE_BASE_LEVERAGE ?? '4');
const STOP_BUFFER = parseFloat(process.env.TURTLE_STOP_BUFFER ?? '0.0025');
const TARGET_BUFFER = parseFloat(process.env.TURTLE_TARGET_BUFFER ?? '0.008');
const BREAK_EVEN_ROE = parseFloat(process.env.TURTLE_BREAK_EVEN_ROE ?? '0.0035');
const TIMEOUT_MS = parseInt(process.env.TURTLE_TIMEOUT_MS ?? String(45 * 60 * 1000), 10);
const COOLDOWN_AFTER_LOSS_MINUTES = parseInt(process.env.TURTLE_COOLDOWN_AFTER_LOSS_MINUTES ?? '60', 10);
const DAILY_LOSS_LIMIT = parseFloat(process.env.TURTLE_DAILY_LOSS_LIMIT ?? '0.05');
const DGCLAW_AGENT_ID = process.env.DGCLAW_AGENT_ID ?? '992';
const DGCLAW_SIGNALS_THREAD_ID = process.env.DGCLAW_SIGNALS_THREAD_ID ?? '990';
const DGCLAW_API_KEY = process.env.DGCLAW_API_KEY;

type Candle = {
  t: number;
  T: number;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
};

type RunnerState = {
  pausedUntil: number | null;
  dailyDate: string;
  dailyStartEquity: number;
  dailyRealizedPnl: number;
  consecutiveLosses: number;
  lastProcessedFillTime: number;
  openTrade: OpenTradeState | null;
};

type OpenTradeState = {
  pair: string;
  side: 'long' | 'short';
  openedAt: number;
  entryPx: number;
  size: string;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  stopMovedToBreakeven: boolean;
  breakoutLevel: number;
  exitLevel: number;
};

function defaultState(): RunnerState {
  return {
    pausedUntil: null,
    dailyDate: new Date().toISOString().slice(0, 10),
    dailyStartEquity: 0,
    dailyRealizedPnl: 0,
    consecutiveLosses: 0,
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

function getDayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
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
    console.error(`[turtle] failed to post signal: ${error instanceof Error ? error.message : String(error)}`);
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

async function fetchCandles(info: InfoClient, interval: '15m' | '1h', bars: number) {
  const intervalMs = interval === '15m' ? 900_000 : 3_600_000;
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
  return orders.filter((order: any) => order.coin?.toUpperCase() === PAIR && order.reduceOnly === true);
}

async function cancelOpenTriggerOrders(exchange: ExchangeClient, info: InfoClient, user: `0x${string}`, assetId: number) {
  const orders = await getOpenTriggerOrders(info, user);
  for (const order of orders) {
    try {
      await exchange.cancel({ cancels: [{ a: assetId, o: order.oid }] });
    } catch {
      // ignore stale orders
    }
  }
}

async function placeBrackets(
  exchange: ExchangeClient,
  info: InfoClient,
  user: `0x${string}`,
  assetId: number,
  side: 'long' | 'short',
  size: string,
  stopLoss: number,
  takeProfit: number,
) {
  await cancelOpenTriggerOrders(exchange, info, user, assetId);
  const closeIsBuy = side === 'short';
  await exchange.order({
    orders: [{
      a: assetId,
      b: closeIsBuy,
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
      b: closeIsBuy,
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
  const orderPrice = posSize > 0 ? (midPrice * 0.99).toPrecision(6) : (midPrice * 1.01).toPrecision(6);
  const size = Math.abs(posSize).toString();
  const closeIsBuy = posSize < 0;
  const result = await exchange.order({
    orders: [{ a: assetId, b: closeIsBuy, r: true, p: orderPrice, s: size, t: { limit: { tif: 'Ioc' } } }],
    grouping: 'na',
  });
  return { result, midPrice, size };
}

async function buildSignal(info: InfoClient) {
  const [candles1h, candles15m] = await Promise.all([
    fetchCandles(info, '1h', TREND_LOOKBACK + 10),
    fetchCandles(info, '15m', ENTRY_LOOKBACK + EXIT_LOOKBACK + 20),
  ]);
  if (candles1h.length < TREND_LOOKBACK + 2 || candles15m.length < ENTRY_LOOKBACK + 2) {
    return { ok: false as const, reason: 'not enough candles' };
  }

  const trendWindow = candles1h.slice(-(TREND_LOOKBACK + 1), -1);
  const trendHigh = Math.max(...trendWindow.map((c) => parseFloat(c.h)));
  const trendLow = Math.min(...trendWindow.map((c) => parseFloat(c.l)));
  const signalBar = candles15m[candles15m.length - 1];
  const prevBar = candles15m[candles15m.length - 2];
  const breakoutWindow = candles15m.slice(-(ENTRY_LOOKBACK + 1), -1);
  const exitWindow = candles15m.slice(-(EXIT_LOOKBACK + 1), -1);
  const breakoutHigh = Math.max(...breakoutWindow.map((c) => parseFloat(c.h)));
  const breakoutLow = Math.min(...breakoutWindow.map((c) => parseFloat(c.l)));
  const trailingHigh = Math.max(...exitWindow.map((c) => parseFloat(c.h)));
  const trailingLow = Math.min(...exitWindow.map((c) => parseFloat(c.l)));
  const close = parseFloat(signalBar.c);
  const prevClose = parseFloat(prevBar.c);
  const volume = parseFloat(signalBar.v);
  const avgVolume = average(candles15m.slice(-10, -1).map((c) => parseFloat(c.v)));

  if (volume < avgVolume * 1.05) {
    return { ok: false as const, reason: 'weak breakout volume' };
  }

  if (close > breakoutHigh && prevClose <= breakoutHigh && close > trendLow + (trendHigh - trendLow) * 0.55) {
    return {
      ok: true as const,
      side: 'long' as const,
      breakoutLevel: breakoutHigh,
      exitLevel: trailingLow,
      trigger: close,
      stopLoss: Math.min(trailingLow, close * (1 - STOP_BUFFER)),
      takeProfit: close * (1 + TARGET_BUFFER),
    };
  }

  if (close < breakoutLow && prevClose >= breakoutLow && close < trendLow + (trendHigh - trendLow) * 0.45) {
    return {
      ok: true as const,
      side: 'short' as const,
      breakoutLevel: breakoutLow,
      exitLevel: trailingHigh,
      trigger: close,
      stopLoss: Math.max(trailingHigh, close * (1 + STOP_BUFFER)),
      takeProfit: close * (1 - TARGET_BUFFER),
    };
  }

  return { ok: false as const, reason: 'no donchian breakout' };
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
    state.pausedUntil = Date.now() + COOLDOWN_AFTER_LOSS_MINUTES * 60 * 1000;
  } else {
    state.consecutiveLosses = 0;
  }

  if (state.dailyStartEquity > 0 && Math.abs(Math.min(state.dailyRealizedPnl, 0)) >= state.dailyStartEquity * DAILY_LOSS_LIMIT) {
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 0, 0);
    state.pausedUntil = tomorrow.getTime();
  }

  await postSignal(
    `Closed ${openTrade.pair} ${openTrade.side}`,
    `Closed ${openTrade.pair} ${openTrade.side}. Entry ${openTrade.entryPx.toFixed(2)}. Size ${openTrade.size}. Leverage ${openTrade.leverage}x. Realized PnL ${realizedPnl.toFixed(4)} USDC.`,
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
  if (!position && state.openTrade) {
    await processClosedTrade(info, state, user);
    saveState(state);
  }

  if (position) {
    const pos = position.position;
    const side = parseFloat(pos.szi) > 0 ? 'long' : 'short';
    const entryPx = parseFloat(pos.entryPx);
    const size = Math.abs(parseFloat(pos.szi)).toString();
    const roe = parseFloat(pos.returnOnEquity ?? '0');

    if (!state.openTrade) {
      state.openTrade = {
        pair: PAIR,
        side,
        openedAt: Date.now(),
        entryPx,
        size,
        leverage: parseFloat(pos.leverage?.value ?? '0'),
        stopLoss: side === 'long' ? entryPx * (1 - STOP_BUFFER) : entryPx * (1 + STOP_BUFFER),
        takeProfit: side === 'long' ? entryPx * (1 + TARGET_BUFFER) : entryPx * (1 - TARGET_BUFFER),
        stopMovedToBreakeven: false,
        breakoutLevel: entryPx,
        exitLevel: entryPx,
      };
      const existingOrders = await getOpenTriggerOrders(info, user);
      if (existingOrders.length < 2) {
        await placeBrackets(exchange, info, user, assetId, side, size, state.openTrade.stopLoss, state.openTrade.takeProfit);
      }
      saveState(state);
      return;
    }

    const openTrade = state.openTrade;
    if (!openTrade.stopMovedToBreakeven && roe >= BREAK_EVEN_ROE) {
      openTrade.stopLoss = openTrade.entryPx;
      openTrade.stopMovedToBreakeven = true;
      await placeBrackets(exchange, info, user, assetId, openTrade.side, size, openTrade.stopLoss, openTrade.takeProfit);
      await postSignal(
        `Moved ${PAIR} ${openTrade.side} stop to breakeven`,
        `Trade moved in favor. ${PAIR} ${openTrade.side} stop moved to breakeven at ${openTrade.entryPx.toFixed(2)}.`,
      );
    }

    if (Date.now() - openTrade.openedAt >= TIMEOUT_MS) {
      const closeResult = await closePosition(exchange, info, user, assetId);
      await postSignal(
        `Closed ${PAIR} ${openTrade.side} (timeout)`,
        `Closed ${PAIR} ${openTrade.side} after timeout. Entry ${openTrade.entryPx.toFixed(2)}. Size ${openTrade.size}.`,
      );
      state.lastProcessedFillTime = Date.now();
      console.log(JSON.stringify({ action: 'timeout-close', closeResult }, null, 2));
    } else {
      const openOrders = await getOpenTriggerOrders(info, user);
      if (openOrders.length < 2) {
        await placeBrackets(exchange, info, user, assetId, openTrade.side, size, openTrade.stopLoss, openTrade.takeProfit);
      }
      saveState(state);
      console.log(JSON.stringify({ action: 'manage', pair: PAIR, side: openTrade.side, roe }, null, 2));
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

  const leverage = Math.min(BASE_LEVERAGE, meta.maxLeverage);
  const margin = Math.min(spotEquity * MARGIN_FRACTION, MAX_MARGIN_USDC);
  const notional = Math.min(margin * leverage, MAX_NOTIONAL_USDC);
  if (notional < MIN_NOTIONAL) {
    console.log(JSON.stringify({ action: 'idle', reason: 'waiting_for_funds', notional, spotEquity }, null, 2));
    saveState(state);
    return;
  }

  const mids = await info.allMids();
  const midPrice = parseFloat(mids[PAIR]);
  const sizeNum = notional / midPrice;
  const size = sizeNum.toFixed(meta.szDecimals);
  const isLong = signal.side === 'long';
  const orderPrice = isLong ? (midPrice * 1.01).toPrecision(6) : (midPrice * 0.99).toPrecision(6);
  await exchange.updateLeverage({ asset: assetId, isCross: true, leverage });

  const result = await exchange.order({
    orders: [{ a: assetId, b: isLong, r: false, p: orderPrice, s: size, t: { limit: { tif: 'Ioc' } } }],
    grouping: 'na',
  });

  const filled = result?.response?.data?.statuses?.find((status: any) => status.filled)?.filled;
  const entryPx = parseFloat(filled?.avgPx ?? midPrice.toString());
  const filledSize = filled?.totalSz ?? size;

  await placeBrackets(exchange, info, user, assetId, signal.side, filledSize, signal.stopLoss, signal.takeProfit);

  state.openTrade = {
    pair: PAIR,
    side: signal.side,
    openedAt: Date.now(),
    entryPx,
    size: filledSize,
    leverage,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    stopMovedToBreakeven: false,
    breakoutLevel: signal.breakoutLevel,
    exitLevel: signal.exitLevel,
  };

  await postSignal(
    `Opened ${PAIR} ${signal.side}`,
    `Opened ${PAIR} ${signal.side}. Entry ${entryPx.toFixed(2)}. Size ${filledSize}. Leverage ${leverage}x. Breakout ${signal.breakoutLevel.toFixed(2)}. Exit ${signal.exitLevel.toFixed(2)}. TP ${signal.takeProfit.toFixed(2)}. SL ${signal.stopLoss.toFixed(2)}.`,
  );

  console.log(JSON.stringify({ action: 'open', pair: PAIR, side: signal.side, entryPx, size: filledSize, result }, null, 2));
  saveState(state);
}

async function main() {
  const mode = (process.argv[2] ?? 'once').toLowerCase();
  if (mode === 'daemon') {
    console.log(`Turtle runner started in daemon mode. Polling every ${POLL_SECONDS}s.`);
    while (true) {
      try {
        await evaluateOnce();
      } catch (error) {
        console.error(`[turtle] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
      await sleep(POLL_SECONDS * 1000);
    }
  } else {
    await evaluateOnce();
  }
}

await main();
