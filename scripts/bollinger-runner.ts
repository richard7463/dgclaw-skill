import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { privateKeyToAccount } from 'viem/accounts';
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const STATE_DIR = join(ROOT, '.runtime');
const STATE_PATH = join(STATE_DIR, 'bollinger-runner-state.json');
const HL_API_URL = 'https://api.hyperliquid.xyz';
const transport = new HttpTransport({ url: HL_API_URL });

const PAIR = process.env.BOLLINGER_PAIR ?? 'ETH';
const POLL_SECONDS = parseInt(process.env.BOLLINGER_POLL_SECONDS ?? '60', 10);
const PERIOD = parseInt(process.env.BOLLINGER_PERIOD ?? '18', 10);
const STDDEV = parseFloat(process.env.BOLLINGER_STDDEV ?? '2');
const MARGIN_FRACTION = parseFloat(process.env.BOLLINGER_MARGIN_FRACTION ?? '0.35');
const MAX_MARGIN_USDC = parseFloat(process.env.BOLLINGER_MAX_MARGIN_USDC ?? '10');
const MIN_NOTIONAL = parseFloat(process.env.BOLLINGER_MIN_NOTIONAL ?? '8');
const MAX_NOTIONAL_USDC = parseFloat(process.env.BOLLINGER_MAX_NOTIONAL_USDC ?? '180');
const BASE_LEVERAGE = parseFloat(process.env.BOLLINGER_BASE_LEVERAGE ?? '4');
const STOP_BUFFER = parseFloat(process.env.BOLLINGER_STOP_BUFFER ?? '0.0025');
const TARGET_BUFFER = parseFloat(process.env.BOLLINGER_TARGET_BUFFER ?? '0.0025');
const VOLUME_MULTIPLIER = parseFloat(process.env.BOLLINGER_VOLUME_MULTIPLIER ?? '0.6');
const REENTRY_TOLERANCE = parseFloat(process.env.BOLLINGER_REENTRY_TOLERANCE ?? '0.0015');
const BREAK_EVEN_ROE = parseFloat(process.env.BOLLINGER_BREAK_EVEN_ROE ?? '0.002');
const TIMEOUT_MS = parseInt(process.env.BOLLINGER_TIMEOUT_MS ?? String(30 * 60 * 1000), 10);
const COOLDOWN_AFTER_LOSS_MINUTES = parseInt(process.env.BOLLINGER_COOLDOWN_AFTER_LOSS_MINUTES ?? '30', 10);
const DAILY_LOSS_LIMIT = parseFloat(process.env.BOLLINGER_DAILY_LOSS_LIMIT ?? '0.05');
const DGCLAW_AGENT_ID = process.env.DGCLAW_AGENT_ID ?? '993';
const DGCLAW_SIGNALS_THREAD_ID = process.env.DGCLAW_SIGNALS_THREAD_ID ?? '991';
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
  basis: number;
  outerBand: number;
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

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values: number[]) {
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function fmtPx(price: unknown): string {
  return typeof price === 'string' ? price : (Number(price) || 0).toFixed(2);
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
    console.error(`[bollinger] failed to post signal: ${error instanceof Error ? error.message : String(error)}`);
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

async function fetchCandles(info: InfoClient, bars: number) {
  const intervalMs = 300_000;
  const endTime = Date.now();
  const startTime = endTime - intervalMs * (bars + 4);
  const candles = await info.candleSnapshot({ coin: PAIR, interval: '5m', startTime, endTime });
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

async function closePosition(exchange: ExchangeClient, info: InfoClient, user: `0x${string}`, assetId: number) {
  const position = await getCurrentPosition(info, user);
  if (!position) return null;
  const mids = await info.allMids();
  const midPrice = parseFloat(mids[PAIR]);
  const posSize = parseFloat(position.position.szi);
  const orderPrice = posSize > 0 ? (midPrice * 0.99).toFixed(2) : (midPrice * 1.01).toFixed(2);
  const size = Math.abs(posSize).toString();
  const closeIsBuy = posSize < 0;
  const result = await exchange.order({
    orders: [{ a: assetId, b: closeIsBuy, r: true, p: orderPrice, s: size, t: { limit: { tif: 'Ioc' } } }],
    grouping: 'na',
  });
  return { result, midPrice, size };
}

async function getMidPrice(info: InfoClient) {
  const mids = await info.allMids();
  return parseFloat(mids[PAIR]);
}

async function buildSignal(info: InfoClient) {
  const candles = await fetchCandles(info, PERIOD + 25);
  if (candles.length < PERIOD + 5) {
    return { ok: false as const, reason: 'not enough candles' };
  }

  const closes = candles.map((c) => parseFloat(c.c));
  const prevClose = closes[closes.length - 2];
  const close = closes[closes.length - 1];
  const window = closes.slice(-(PERIOD + 1), -1);
  const basis = average(window);
  const sigma = stddev(window);
  const upper = basis + sigma * STDDEV;
  const lower = basis - sigma * STDDEV;
  const currentVolume = parseFloat(candles[candles.length - 1].v);
  const avgVolume = average(candles.slice(-10, -1).map((c) => parseFloat(c.v)));

  if (currentVolume < avgVolume * VOLUME_MULTIPLIER) {
    return { ok: false as const, reason: 'thin confirmation volume' };
  }

  if (prevClose <= lower * (1 + REENTRY_TOLERANCE) && close >= lower * (1 - REENTRY_TOLERANCE)) {
    return {
      ok: true as const,
      side: 'long' as const,
      basis,
      outerBand: lower,
      stopLoss: Math.min(lower * (1 - STOP_BUFFER), close * (1 - STOP_BUFFER)).toFixed(2),
      takeProfit: Math.max(basis, close * (1 + TARGET_BUFFER)).toFixed(2),
    };
  }

  if (prevClose >= upper * (1 - REENTRY_TOLERANCE) && close <= upper * (1 + REENTRY_TOLERANCE)) {
    return {
      ok: true as const,
      side: 'short' as const,
      basis,
      outerBand: upper,
      stopLoss: Math.max(upper * (1 + STOP_BUFFER), close * (1 + STOP_BUFFER)).toFixed(2),
      takeProfit: Math.min(basis, close * (1 - TARGET_BUFFER)).toFixed(2),
    };
  }

  return { ok: false as const, reason: 'no band re-entry' };
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
        stopLoss: (side === 'long' ? entryPx * (1 - STOP_BUFFER) : entryPx * (1 + STOP_BUFFER)).toFixed(2),
        takeProfit: (side === 'long' ? entryPx * (1 + TARGET_BUFFER) : entryPx * (1 - TARGET_BUFFER)).toFixed(2),
        stopMovedToBreakeven: false,
        basis: entryPx,
        outerBand: entryPx,
      };
      saveState(state);
      console.log(JSON.stringify({ action: 'manage', adopted: true, pair: PAIR, side }, null, 2));
      return;
    }

    const openTrade = state.openTrade;
    const midPrice = await getMidPrice(info);
    if (!openTrade.stopMovedToBreakeven && roe >= BREAK_EVEN_ROE) {
      openTrade.stopLoss = parseFloat(String(openTrade.entryPx)).toFixed(2);
      openTrade.stopMovedToBreakeven = true;
      await postSignal(
        `Moved ${PAIR} ${openTrade.side} stop to breakeven`,
        `Trade moved in favor. ${PAIR} ${openTrade.side} stop moved to breakeven at ${openTrade.entryPx.toFixed(2)}.`,
      );
    }

    const hitTakeProfit = openTrade.side === 'long' ? midPrice >= parseFloat(String(openTrade.takeProfit)) : midPrice <= parseFloat(String(openTrade.takeProfit));
    const hitStopLoss = openTrade.side === 'long' ? midPrice <= parseFloat(String(openTrade.stopLoss)) : midPrice >= parseFloat(String(openTrade.stopLoss));

    if (hitTakeProfit || hitStopLoss || Date.now() - openTrade.openedAt >= TIMEOUT_MS) {
      const closeResult = await closePosition(exchange, info, user, assetId);
      const reason = hitTakeProfit ? 'tp' : hitStopLoss ? 'sl' : 'timeout';
      await postSignal(
        `Closed ${PAIR} ${openTrade.side} (${reason})`,
        `Closed ${PAIR} ${openTrade.side}. Entry ${openTrade.entryPx.toFixed(2)}. Size ${openTrade.size}. Reason: ${reason}.`,
      );
      state.lastProcessedFillTime = Date.now();
      console.log(JSON.stringify({ action: 'software-close', reason, midPrice, closeResult }, null, 2));
    } else {
      saveState(state);
      console.log(JSON.stringify({ action: 'manage', pair: PAIR, side: openTrade.side, roe, midPrice }, null, 2));
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
  const orderPrice = isLong ? (midPrice * 1.01).toFixed(2) : (midPrice * 0.99).toFixed(2);
  await exchange.updateLeverage({ asset: assetId, isCross: true, leverage });

  const result = await exchange.order({
    orders: [{ a: assetId, b: isLong, r: false, p: orderPrice, s: size, t: { limit: { tif: 'Ioc' } } }],
    grouping: 'na',
  });

  const filled = result?.response?.data?.statuses?.find((status: any) => status.filled)?.filled;
  const entryPx = parseFloat(filled?.avgPx ?? midPrice.toString());
  const filledSize = filled?.totalSz ?? size;

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
    basis: signal.basis,
    outerBand: signal.outerBand,
  };

  await postSignal(
    `Opened ${PAIR} ${signal.side}`,
    `Opened ${PAIR} ${signal.side}. Entry ${entryPx.toFixed(2)}. Size ${filledSize}. Leverage ${leverage}x. Basis ${signal.basis.toFixed(2)}. Outer band ${signal.outerBand.toFixed(2)}. TP ${signal.takeProfit}. SL ${signal.stopLoss}.`,
  );

  console.log(JSON.stringify({ action: 'open', pair: PAIR, side: signal.side, entryPx, size: filledSize, result }, null, 2));
  saveState(state);
}

async function main() {
  const mode = (process.argv[2] ?? 'once').toLowerCase();
  if (mode === 'daemon') {
    console.log(`Bollinger runner started in daemon mode. Polling every ${POLL_SECONDS}s.`);
    while (true) {
      try {
        await evaluateOnce();
      } catch (error) {
        console.error(`[bollinger] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
      await sleep(POLL_SECONDS * 1000);
    }
  } else {
    await evaluateOnce();
  }
}

await main();
