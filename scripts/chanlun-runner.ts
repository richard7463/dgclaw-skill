import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { privateKeyToAccount } from 'viem/accounts';
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const STATE_DIR = join(ROOT, '.runtime');
const STATE_PATH = join(STATE_DIR, 'chanlun-runner-state.json');
const HL_API_URL = 'https://api.hyperliquid.xyz';
const transport = new HttpTransport({ url: HL_API_URL });

const PAIR = process.env.CHANLUN_PAIR ?? 'ETH';
const POLL_SECONDS = parseInt(process.env.CHANLUN_POLL_SECONDS ?? '60', 10);
const MARGIN_FRACTION = parseFloat(process.env.CHANLUN_MARGIN_FRACTION ?? '0.3');
const MAX_MARGIN_USDC = parseFloat(process.env.CHANLUN_MAX_MARGIN_USDC ?? '10');
const MIN_NOTIONAL = parseFloat(process.env.CHANLUN_MIN_NOTIONAL ?? '15');
const MAX_NOTIONAL_USDC = parseFloat(process.env.CHANLUN_MAX_NOTIONAL_USDC ?? '300');
const BASE_LEVERAGE = parseFloat(process.env.CHANLUN_BASE_LEVERAGE ?? '4');
const BREAK_EVEN_ROE = parseFloat(process.env.CHANLUN_BREAK_EVEN_ROE ?? '0.003');
const TIMEOUT_MS = parseInt(process.env.CHANLUN_TIMEOUT_MS ?? String(45 * 60 * 1000), 10);
const STOP_BUFFER = parseFloat(process.env.CHANLUN_STOP_BUFFER ?? '0.0018');
const TARGET_BUFFER = parseFloat(process.env.CHANLUN_TARGET_BUFFER ?? '0.0045');
const VOLUME_MULTIPLIER = parseFloat(process.env.CHANLUN_VOLUME_MULTIPLIER ?? '0.85');
const PIVOT_FALLBACK_LOOKBACK = parseInt(process.env.CHANLUN_PIVOT_FALLBACK_LOOKBACK ?? '12', 10);
const COOLDOWN_AFTER_LOSS_MINUTES = parseInt(process.env.CHANLUN_COOLDOWN_AFTER_LOSS_MINUTES ?? '45', 10);
const DAILY_LOSS_LIMIT = parseFloat(process.env.CHANLUN_DAILY_LOSS_LIMIT ?? '0.05');
const DGCLAW_AGENT_ID = process.env.DGCLAW_AGENT_ID ?? '990';
const DGCLAW_SIGNALS_THREAD_ID = process.env.DGCLAW_SIGNALS_THREAD_ID ?? '986';
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

type Swing = {
  index: number;
  price: number;
  kind: 'high' | 'low';
};

type StructureSignal =
  | { ok: false; reason: string }
  | {
      ok: true;
      side: 'long' | 'short';
      trigger: number;
      invalidation: number;
      target: number;
      zoneHigh: number;
      zoneLow: number;
      trend: 'bull' | 'bear';
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

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function findSwings(candles: Candle[]) {
  const swings: Swing[] = [];
  for (let i = 2; i < candles.length - 2; i += 1) {
    const h = parseFloat(candles[i].h);
    const l = parseFloat(candles[i].l);
    const prevHs = [parseFloat(candles[i - 1].h), parseFloat(candles[i - 2].h)];
    const nextHs = [parseFloat(candles[i + 1].h), parseFloat(candles[i + 2].h)];
    const prevLs = [parseFloat(candles[i - 1].l), parseFloat(candles[i - 2].l)];
    const nextLs = [parseFloat(candles[i + 1].l), parseFloat(candles[i + 2].l)];
    if (h > Math.max(...prevHs, ...nextHs)) {
      swings.push({ index: i, price: h, kind: 'high' });
    }
    if (l < Math.min(...prevLs, ...nextLs)) {
      swings.push({ index: i, price: l, kind: 'low' });
    }
  }
  return swings;
}

function lastN<T>(items: T[], n: number) {
  return items.slice(Math.max(0, items.length - n));
}

function detectTrend(swings30m: Swing[]) {
  const highs = lastN(swings30m.filter((s) => s.kind === 'high'), 2);
  const lows = lastN(swings30m.filter((s) => s.kind === 'low'), 2);
  if (highs.length < 2 || lows.length < 2) return null;
  if (highs[1].price > highs[0].price && lows[1].price > lows[0].price) return 'bull' as const;
  if (highs[1].price < highs[0].price && lows[1].price < lows[0].price) return 'bear' as const;
  return null;
}

function derivePivotZone(swings5m: Swing[], candles5m: Candle[]) {
  const highs = lastN(swings5m.filter((s) => s.kind === 'high'), 3);
  const lows = lastN(swings5m.filter((s) => s.kind === 'low'), 3);
  if (highs.length >= 3 && lows.length >= 3) {
    const zoneHigh = Math.min(...highs.map((s) => s.price));
    const zoneLow = Math.max(...lows.map((s) => s.price));
    if (zoneLow < zoneHigh) {
      return { zoneHigh, zoneLow, lastHigh: highs[2].price, lastLow: lows[2].price };
    }
  }

  const recent = candles5m.slice(-PIVOT_FALLBACK_LOOKBACK);
  if (recent.length < 6) return null;
  const recentHigh = Math.max(...recent.map((c) => parseFloat(c.h)));
  const recentLow = Math.min(...recent.map((c) => parseFloat(c.l)));
  const width = recentHigh - recentLow;
  if (width <= 0) return null;
  return {
    zoneLow: recentLow + width * 0.35,
    zoneHigh: recentLow + width * 0.65,
    lastHigh: recentHigh,
    lastLow: recentLow,
  };
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
    console.error(`[chanlun] failed to post signal: ${error instanceof Error ? error.message : String(error)}`);
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

async function fetchCandles(info: InfoClient, interval: '5m' | '30m', bars: number) {
  const intervalMs = interval === '5m' ? 300_000 : 1_800_000;
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
      // ignore stale order
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

async function buildSignal(info: InfoClient): Promise<StructureSignal> {
  const [candles30m, candles5m] = await Promise.all([
    fetchCandles(info, '30m', 90),
    fetchCandles(info, '5m', 120),
  ]);
  if (candles30m.length < 50 || candles5m.length < 60) {
    return { ok: false, reason: 'not enough candles' };
  }

  const trend = detectTrend(findSwings(candles30m));
  if (!trend) return { ok: false, reason: 'no clear 30m structure trend' };

  const swings5m = findSwings(candles5m);
  const pivot = derivePivotZone(swings5m, candles5m);
  if (!pivot) return { ok: false, reason: 'no valid 5m pivot zone' };

  const recentCandles = candles5m.slice(-6);
  const current = candles5m[candles5m.length - 1];
  const currentClose = parseFloat(current.c);
  const avgVolume = average(recentCandles.map((c) => parseFloat(c.v)));
  const currentVolume = parseFloat(current.v);
  if (currentVolume < avgVolume * VOLUME_MULTIPLIER) {
    return { ok: false, reason: 'weak confirmation volume' };
  }

  if (trend === 'bull') {
    const reclaim = currentClose > pivot.zoneHigh && recentCandles.slice(0, -1).some((c) => parseFloat(c.l) <= pivot.zoneHigh);
    if (!reclaim) return { ok: false, reason: 'bull trend without reclaim from pivot' };
    const invalidation = pivot.zoneLow * (1 - STOP_BUFFER);
    const target = currentClose * (1 + TARGET_BUFFER);
    return {
      ok: true,
      side: 'long',
      trigger: currentClose,
      invalidation,
      target,
      zoneHigh: pivot.zoneHigh,
      zoneLow: pivot.zoneLow,
      trend,
    };
  }

  const breakdown = currentClose < pivot.zoneLow && recentCandles.slice(0, -1).some((c) => parseFloat(c.h) >= pivot.zoneLow);
  if (!breakdown) return { ok: false, reason: 'bear trend without breakdown from pivot' };
  const invalidation = pivot.zoneHigh * (1 + STOP_BUFFER);
  const target = currentClose * (1 - TARGET_BUFFER);
  return {
    ok: true,
    side: 'short',
    trigger: currentClose,
    invalidation,
    target,
    zoneHigh: pivot.zoneHigh,
    zoneLow: pivot.zoneLow,
    trend,
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
        `Trade moved in favor. ${PAIR} ${openTrade.side} stop loss raised to breakeven at ${openTrade.entryPx.toFixed(2)}.`,
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

  await placeBrackets(exchange, info, user, assetId, signal.side, filledSize, signal.invalidation, signal.target);

  state.openTrade = {
    pair: PAIR,
    side: signal.side,
    openedAt: Date.now(),
    entryPx,
    size: filledSize,
    leverage,
    stopLoss: signal.invalidation,
    takeProfit: signal.target,
    stopMovedToBreakeven: false,
  };

  await postSignal(
    `Opened ${PAIR} ${signal.side}`,
    `Opened ${PAIR} ${signal.side}. Entry ${entryPx.toFixed(2)}. Size ${filledSize}. Leverage ${leverage}x. Pivot zone ${signal.zoneLow.toFixed(2)} - ${signal.zoneHigh.toFixed(2)}. TP ${signal.target.toFixed(2)}. SL ${signal.invalidation.toFixed(2)}.`,
  );

  console.log(JSON.stringify({ action: 'open', side: signal.side, leverage, notional, entryPx, result }, null, 2));
  saveState(state);
}

async function main() {
  const mode = (process.argv[2] ?? 'once').toLowerCase();
  if (mode === 'daemon') {
    console.log(`ChanLun runner started in daemon mode. Polling every ${POLL_SECONDS}s.`);
    while (true) {
      try {
        await evaluateOnce();
      } catch (error) {
        console.error(`[chanlun] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
      await sleep(POLL_SECONDS * 1000);
    }
  }
  await evaluateOnce();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
