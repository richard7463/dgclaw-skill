import 'dotenv/config';
import { privateKeyToAccount } from 'viem/accounts';
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';

const HL_API_URL = 'https://api.hyperliquid.xyz';
const transport = new HttpTransport({ url: HL_API_URL });

type Pair = 'BTC' | 'ETH';
type Side = 'long' | 'short';

type RunnerConfig = {
  pairs: Pair[];
  interval: '15m' | '30m' | '1h';
  breakoutBars: number;
  compressionBars: number;
  baselineBars: number;
  compressionThreshold: number;
  leverage: number;
  riskFraction: number;
  minNotional: number;
  maxNotional: number;
  stopAtr: number;
  takeProfitR: number;
  pollSeconds: number;
};

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

type AssetMeta = {
  name: string;
  szDecimals: number;
  maxLeverage: number;
};

type Signal = {
  pair: Pair;
  side: Side;
  breakoutLevel: number;
  lastClose: number;
  atr: number;
  strength: number;
  meta: AssetMeta;
};

const config: RunnerConfig = {
  pairs: ((process.env.APEX_PAIRS ?? 'BTC,ETH')
    .split(',')
    .map((pair) => pair.trim().toUpperCase())
    .filter(Boolean) as Pair[]),
  interval: (process.env.APEX_INTERVAL as RunnerConfig['interval']) ?? '15m',
  breakoutBars: parseInt(process.env.APEX_BREAKOUT_BARS ?? '8', 10),
  compressionBars: parseInt(process.env.APEX_COMPRESSION_BARS ?? '4', 10),
  baselineBars: parseInt(process.env.APEX_BASELINE_BARS ?? '12', 10),
  compressionThreshold: parseFloat(
    process.env.APEX_COMPRESSION_THRESHOLD ?? '0.8',
  ),
  leverage: parseInt(process.env.APEX_LEVERAGE ?? '3', 10),
  riskFraction: parseFloat(process.env.APEX_RISK_FRACTION ?? '0.5'),
  minNotional: parseFloat(process.env.APEX_MIN_NOTIONAL ?? '12'),
  maxNotional: parseFloat(process.env.APEX_MAX_NOTIONAL ?? '50'),
  stopAtr: parseFloat(process.env.APEX_STOP_ATR ?? '1.2'),
  takeProfitR: parseFloat(process.env.APEX_TAKE_PROFIT_R ?? '2'),
  pollSeconds: parseInt(process.env.APEX_POLL_SECONDS ?? '300', 10),
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePrice(value: string): number {
  return parseFloat(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatPrice(price: number, significantFigures = 5): string {
  return price.toPrecision(significantFigures);
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function candleRange(candle: Candle): number {
  return parsePrice(candle.h) - parsePrice(candle.l);
}

async function createClients() {
  const apiWalletKey = process.env.HL_API_WALLET_KEY as `0x${string}` | undefined;
  const masterAddress = process.env.HL_MASTER_ADDRESS as `0x${string}` | undefined;

  if (!apiWalletKey) {
    throw new Error(
      'HL_API_WALLET_KEY not set. Run scripts/add-api-wallet.ts first.',
    );
  }
  if (!masterAddress) {
    throw new Error(
      'HL_MASTER_ADDRESS not set. Set it to your ACP agent wallet address.',
    );
  }

  const account = privateKeyToAccount(apiWalletKey);
  return {
    info: new InfoClient({ transport }),
    exchange: new ExchangeClient({ wallet: account, transport }),
    masterAddress,
  };
}

async function getAssetMeta(
  info: InfoClient,
  pair: Pair,
): Promise<{ assetId: number; meta: AssetMeta }> {
  const metaResponse = await info.meta();
  const universe = metaResponse.universe as AssetMeta[];
  const assetId = universe.findIndex((asset) => asset.name === pair);
  if (assetId === -1) {
    throw new Error(`Unknown pair: ${pair}`);
  }
  return { assetId, meta: universe[assetId] };
}

async function getAvailableEquity(info: InfoClient, user: `0x${string}`) {
  const spotState = await info.spotClearinghouseState({ user });
  const usdc = spotState.balances.find((balance: any) => balance.coin === 'USDC');
  return parseFloat(usdc?.total ?? '0');
}

async function getOpenTrackedPositions(info: InfoClient, user: `0x${string}`) {
  const state = await info.clearinghouseState({ user });
  return state.assetPositions.filter((position: any) => {
    const coin = position.position.coin?.toUpperCase();
    return config.pairs.includes(coin) && parseFloat(position.position.szi) !== 0;
  });
}

async function getOpenOrdersForPair(
  info: InfoClient,
  user: `0x${string}`,
  pair: Pair,
) {
  const orders = await info.openOrders({ user });
  return orders.filter(
    (order: any) =>
      order.coin?.toUpperCase() === pair &&
      typeof order.orderType === 'string' &&
      order.orderType.includes('trigger'),
  );
}

async function fetchCompletedCandles(info: InfoClient, pair: Pair) {
  const barsNeeded =
    config.breakoutBars + config.compressionBars + config.baselineBars + 3;
  const intervalMs =
    config.interval === '15m'
      ? 15 * 60 * 1000
      : config.interval === '30m'
        ? 30 * 60 * 1000
        : 60 * 60 * 1000;

  const endTime = Date.now();
  const startTime = endTime - barsNeeded * intervalMs;
  const candles = await info.candleSnapshot({
    coin: pair,
    interval: config.interval,
    startTime,
    endTime,
  });

  return candles.filter((candle) => candle.T < Date.now()) as Candle[];
}

async function buildSignal(info: InfoClient, pair: Pair): Promise<Signal | null> {
  const candles = await fetchCompletedCandles(info, pair);
  const needed =
    config.breakoutBars + config.compressionBars + config.baselineBars + 1;
  if (candles.length < needed) {
    return null;
  }

  const signalBar = candles[candles.length - 1];
  const breakoutWindow = candles.slice(
    candles.length - 1 - config.breakoutBars,
    candles.length - 1,
  );
  const compressionWindow = candles.slice(
    candles.length - 1 - config.compressionBars,
    candles.length - 1,
  );
  const baselineWindow = candles.slice(
    candles.length - 1 - config.compressionBars - config.baselineBars,
    candles.length - 1 - config.compressionBars,
  );
  const atrWindow = candles.slice(-15, -1);

  const compressionAvg = average(compressionWindow.map(candleRange));
  const baselineAvg = average(baselineWindow.map(candleRange));
  const atr = average(atrWindow.map(candleRange));
  const compressionRatio = compressionAvg / baselineAvg;

  if (!Number.isFinite(compressionRatio) || compressionRatio > config.compressionThreshold) {
    return null;
  }

  const breakoutHigh = Math.max(...breakoutWindow.map((c) => parsePrice(c.h)));
  const breakoutLow = Math.min(...breakoutWindow.map((c) => parsePrice(c.l)));
  const lastClose = parsePrice(signalBar.c);
  const lastOpen = parsePrice(signalBar.o);

  const { meta } = await getAssetMeta(info, pair);

  if (lastClose > breakoutHigh && lastClose > lastOpen) {
    return {
      pair,
      side: 'long',
      breakoutLevel: breakoutHigh,
      lastClose,
      atr,
      strength: (lastClose - breakoutHigh) / atr,
      meta,
    };
  }

  if (lastClose < breakoutLow && lastClose < lastOpen) {
    return {
      pair,
      side: 'short',
      breakoutLevel: breakoutLow,
      lastClose,
      atr,
      strength: (breakoutLow - lastClose) / atr,
      meta,
    };
  }

  return null;
}

function getNotional(availableEquity: number): number | null {
  const maxByEquity = availableEquity * config.leverage * 0.85;
  if (maxByEquity < config.minNotional) {
    return null;
  }

  const target = availableEquity * config.leverage * config.riskFraction;
  return clamp(target, config.minNotional, Math.min(config.maxNotional, maxByEquity));
}

async function placeBracketOrders(
  exchange: ExchangeClient,
  info: InfoClient,
  user: `0x${string}`,
  pair: Pair,
  side: Side,
  size: string,
  stopLoss: number,
  takeProfit: number,
) {
  const { assetId } = await getAssetMeta(info, pair);
  const isLong = side === 'long';

  const existingOrders = await getOpenOrdersForPair(info, user, pair);
  for (const order of existingOrders) {
    try {
      await exchange.cancel({ cancels: [{ a: assetId, o: order.oid }] });
    } catch {
      // Ignore stale orders already filled or cancelled.
    }
  }

  await exchange.order({
    orders: [
      {
        a: assetId,
        b: !isLong,
        r: true,
        p: formatPrice(takeProfit),
        s: size,
        t: {
          trigger: {
            triggerPx: formatPrice(takeProfit),
            isMarket: true,
            tpsl: 'tp',
          },
        },
      },
    ],
    grouping: 'na',
  });

  await exchange.order({
    orders: [
      {
        a: assetId,
        b: !isLong,
        r: true,
        p: formatPrice(stopLoss),
        s: size,
        t: {
          trigger: {
            triggerPx: formatPrice(stopLoss),
            isMarket: true,
            tpsl: 'sl',
          },
        },
      },
    ],
    grouping: 'na',
  });
}

async function ensureRiskForOpenPosition(
  info: InfoClient,
  exchange: ExchangeClient,
  user: `0x${string}`,
  position: any,
) {
  const pair = position.position.coin.toUpperCase() as Pair;
  const existingOrders = await getOpenOrdersForPair(info, user, pair);
  if (existingOrders.length >= 2) {
    console.log(
      `[${pair}] existing trigger orders found (${existingOrders.length}), leaving position unchanged.`,
    );
    return;
  }

  const candles = await fetchCompletedCandles(info, pair);
  const atrWindow = candles.slice(-15, -1);
  const atr = average(atrWindow.map(candleRange));
  const entryPx = parseFloat(position.position.entryPx);
  const size = Math.abs(parseFloat(position.position.szi)).toString();
  const side: Side = parseFloat(position.position.szi) > 0 ? 'long' : 'short';
  const riskDistance = Math.max(atr * config.stopAtr, entryPx * 0.003);
  const stopLoss =
    side === 'long' ? entryPx - riskDistance : entryPx + riskDistance;
  const takeProfit =
    side === 'long'
      ? entryPx + riskDistance * config.takeProfitR
      : entryPx - riskDistance * config.takeProfitR;

  await placeBracketOrders(
    exchange,
    info,
    user,
    pair,
    side,
    size,
    stopLoss,
    takeProfit,
  );

  console.log(
    `[${pair}] attached risk orders for inherited ${side} position: SL ${stopLoss.toFixed(
      2,
    )}, TP ${takeProfit.toFixed(2)}`,
  );
}

async function openSignalPosition(
  info: InfoClient,
  exchange: ExchangeClient,
  user: `0x${string}`,
  signal: Signal,
  notional: number,
) {
  const { assetId } = await getAssetMeta(info, signal.pair);
  const mids = await info.allMids();
  const midPrice = parseFloat(mids[signal.pair]);
  const isBuy = signal.side === 'long';
  const slippage = isBuy ? 1.01 : 0.99;
  const orderPrice = formatPrice(midPrice * slippage);
  const rawSize = notional / midPrice;
  const size = rawSize.toFixed(signal.meta.szDecimals);
  const riskDistance = Math.max(signal.atr * config.stopAtr, midPrice * 0.003);
  const stopLoss =
    signal.side === 'long' ? midPrice - riskDistance : midPrice + riskDistance;
  const takeProfit =
    signal.side === 'long'
      ? midPrice + riskDistance * config.takeProfitR
      : midPrice - riskDistance * config.takeProfitR;

  await exchange.updateLeverage({
    asset: assetId,
    isCross: true,
    leverage: Math.min(config.leverage, signal.meta.maxLeverage),
  });

  const result = await exchange.order({
    orders: [
      {
        a: assetId,
        b: isBuy,
        r: false,
        p: orderPrice,
        s: size,
        t: { limit: { tif: 'Ioc' } },
      },
    ],
    grouping: 'na',
  });

  console.log(
    JSON.stringify(
      {
        action: 'open',
        pair: signal.pair,
        side: signal.side,
        notional,
        orderPrice,
        size,
        stopLoss,
        takeProfit,
        breakoutLevel: signal.breakoutLevel,
        strength: signal.strength,
        result,
      },
      null,
      2,
    ),
  );

  await placeBracketOrders(
    exchange,
    info,
    user,
    signal.pair,
    signal.side,
    size,
    stopLoss,
    takeProfit,
  );
}

async function evaluateOnce() {
  const { info, exchange, masterAddress } = await createClients();
  const user = masterAddress;
  const openPositions = await getOpenTrackedPositions(info, user);

  if (openPositions.length > 0) {
    for (const position of openPositions) {
      await ensureRiskForOpenPosition(info, exchange, user, position);
    }
    return;
  }

  const signals = (
    await Promise.all(config.pairs.map((pair) => buildSignal(info, pair)))
  ).filter(Boolean) as Signal[];

  if (signals.length === 0) {
    console.log(
      JSON.stringify(
        {
          action: 'idle',
          reason: 'no breakout continuation signal',
          pairs: config.pairs,
          interval: config.interval,
        },
        null,
        2,
      ),
    );
    return;
  }

  signals.sort((a, b) => b.strength - a.strength);
  const bestSignal = signals[0];

  const availableEquity = await getAvailableEquity(info, user);
  const notional = getNotional(availableEquity);
  if (!notional) {
    console.log(
      JSON.stringify(
        {
          action: 'idle',
          reason: 'insufficient equity for minimum real trade',
          availableEquity,
          minNotional: config.minNotional,
        },
        null,
        2,
      ),
    );
    return;
  }

  await openSignalPosition(info, exchange, user, bestSignal, notional);
}

async function main() {
  const mode = (process.argv[2] ?? 'once').toLowerCase();

  if (mode === 'daemon') {
    console.log(
      `Apex Liquid runner started in daemon mode. Polling every ${config.pollSeconds}s.`,
    );
    while (true) {
      try {
        await evaluateOnce();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[apex-liquid] ${message}`);
      }
      await sleep(config.pollSeconds * 1000);
    }
  }

  if (mode !== 'once') {
    console.error('Usage: tsx scripts/apex-liquid-runner.ts [once|daemon]');
    process.exit(1);
  }

  await evaluateOnce();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
