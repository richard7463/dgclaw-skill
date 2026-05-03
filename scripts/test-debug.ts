import 'dotenv/config';
import { InfoClient, HttpTransport } from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';

const ACCOUNT_KEY = process.env.HL_API_WALLET_KEY!;
const ACCOUNT_ADDR = process.env.HL_API_WALLET_ADDRESS!;
const account = privateKeyToAccount(ACCOUNT_KEY as `0x${string}`);
const info = new InfoClient(new HttpTransport({ url: 'https://api.hyperliquid.xyz' }));
const meta = await info.meta();
const asset = meta.universe.find((u: any) => u.name === 'ETH');
console.log('Asset:', JSON.stringify(asset, null, 2));
const state = await info.clearinghouseState({ user: ACCOUNT_ADDR });
const pos = state.assetPositions.find((p: any) => p.position.coin?.toUpperCase() === 'ETH');
if (pos) {
  const entryPx = parseFloat(pos.position.entryPx);
  const stopLoss = (entryPx * 0.9982).toFixed(2);
  const takeProfit = (entryPx * 1.004).toFixed(2);
  console.log('entryPx:', entryPx, typeof entryPx);
  console.log('stopLoss:', stopLoss, typeof stopLoss);
  console.log('takeProfit:', takeProfit, typeof takeProfit);
}
