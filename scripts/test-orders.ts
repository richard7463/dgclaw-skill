import 'dotenv/config';
import { privateKeyToAccount } from 'viem/accounts';
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';

const ACCOUNT_KEY = process.env.HL_API_WALLET_KEY!;
const ACCOUNT_ADDR = process.env.HL_API_WALLET_ADDRESS!;
const account = privateKeyToAccount(ACCOUNT_KEY as `0x${string}`);
const exchange = new ExchangeClient(new HttpTransport({ url: 'https://api.hyperliquid.xyz' }), { account });
const info = new InfoClient(new HttpTransport({ url: 'https://api.hyperliquid.xyz' }));

const state = await info.clearinghouseState({ user: ACCOUNT_ADDR });
const pos = state.assetPositions.find((p: any) => p.position.coin?.toUpperCase() === 'ETH');
console.log('Position:', JSON.stringify(pos?.position ?? null, null, 2));

const orders = await info.openOrders({ user: ACCOUNT_ADDR });
console.log('Open orders:', JSON.stringify(orders, null, 2));
