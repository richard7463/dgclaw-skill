import 'dotenv/config';
import { privateKeyToAccount } from 'viem/accounts';
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';

const ACCOUNT_KEY = process.env.HL_API_WALLET_KEY!;
const exchange = new ExchangeClient(new HttpTransport({ url: 'https://api.hyperliquid.xyz' }), { accountType: { type: 'privateKey', privateKey: ACCOUNT_KEY as `0x${string}` } });
const info = new InfoClient(new HttpTransport({ url: 'https://api.hyperliquid.xyz' }));

async function main() {
  // Get meta for max leverage
  const meta = await info.meta();
  const asset = meta.universe.find((u: any) => u.name === 'ETH');
  console.log('Max leverage for ETH:', asset?.maxLeverage);
  
  // Update to 25x
  const res = await exchange.updateLeverage({ asset: 0, isCross: true, leverage: 25 });
  console.log('Update result:', JSON.stringify(res, null, 2));
}

main().catch(console.error);
