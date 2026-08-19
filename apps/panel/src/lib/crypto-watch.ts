import 'server-only';
import { recordDetection } from './detect';

/**
 * Crypto payment detection for ALL coins.
 *
 *   Stablecoins (USDT/USDC): 1 token ≈ $1, so we match the dollar amount EXACTLY.
 *   Volatile coins (BTC/ETH/LTC/SOL/XRP): we pull a live USD price, convert the
 *     on-chain amount, and match WITHIN A TOLERANCE to the nearest pending request.
 *     Never releases — an admin still verifies.
 *
 * No chain has a push webhook, so this polls each club address every cron cycle.
 * payment_detect dedupes on the tx hash, so re-seeing a transfer is a no-op.
 *
 * SPEED: every network call is bounded by a timeout, and all coins are polled in
 * PARALLEL — one slow/hanging chain API can't stall the whole cron (which was
 * timing the endpoint out at 60s → 504).
 */

const TOL = Number(process.env.CRYPTO_TOLERANCE_BPS ?? 500);   // ±5%
const cents = (coinAmount: number, priceUsd: number) => Math.round(coinAmount * priceUsd * 100);

// A fetch that ALWAYS gives up after `ms` — a hung chain API aborts instead of
// blocking the serverless function until Vercel kills it. (Capital-F name so it
// never collides with the global `fetch`.)
const nativeFetch = globalThis.fetch;
async function tfetch(url: string, init?: RequestInit, ms = 7000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { return await nativeFetch(url, { ...init, signal: ac.signal }); }
  finally { clearTimeout(timer); }
}

// ─── Stablecoins — exact match (no price needed) ─────────────────────────────

async function tronUsdt(address: string): Promise<void> {
  const contract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const url = `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?only_to=true&limit=20&contract_address=${contract}`;
  const headers: Record<string, string> = {};
  if (process.env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
  const res = await tfetch(url, { headers }).then((r) => r.json());
  for (const t of res?.data ?? []) {
    if ((t.to ?? '').toLowerCase() !== address.toLowerCase()) continue;
    const usd = Math.round(Number(t.value ?? 0) / 10 ** Number(t.token_info?.decimals ?? 6) * 100);
    await recordDetection({ source: 'crypto', externalId: `usdt_trc20:${t.transaction_id}`, methodCode: 'usdt_trc20', amount: usd, currency: 'USD', raw: { hash: t.transaction_id } });
  }
}

// extId = the dedup prefix (chain-specific); methodCode = which method's deposit
// this matches. USDC is USDC regardless of chain, so several chains map to the
// same method with different extId prefixes.
async function evmToken(chainId: number, contract: string, extId: string, methodCode: string, address: string, label?: string): Promise<void> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return;
  const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=tokentx&contractaddress=${contract}&address=${address}&page=1&offset=20&sort=desc&apikey=${key}`;
  const res = await tfetch(url).then((r) => r.json());
  if (!Array.isArray(res?.result)) return;
  for (const t of res.result) {
    if ((t.to ?? '').toLowerCase() !== address.toLowerCase()) continue;
    const usd = Math.round(Number(t.value ?? 0) / 10 ** Number(t.tokenDecimal ?? 6) * 100);
    await recordDetection({ source: 'crypto', externalId: `${extId}:${t.hash}`, methodCode, amount: usd, currency: 'USD', raw: { hash: t.hash, ...(label ? { source_detail: label } : {}) } });
  }
}

// ─── Volatile coins — live price + tolerance ─────────────────────────────────

async function btc(address: string, price: number): Promise<void> {
  const txs = await tfetch(`https://blockstream.info/api/address/${address}/txs`).then((r) => r.json());
  for (const t of Array.isArray(txs) ? txs : []) {
    const sats = (t.vout ?? []).filter((o: any) => o.scriptpubkey_address === address).reduce((s: number, o: any) => s + Number(o.value ?? 0), 0);
    if (sats <= 0) continue;
    await recordDetection({ source: 'crypto', externalId: `btc:${t.txid}`, methodCode: 'btc', amount: cents(sats / 1e8, price), currency: 'USD', toleranceBps: TOL, raw: { hash: t.txid } });
  }
}

async function ethNative(address: string, price: number): Promise<void> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return;
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=txlist&address=${address}&page=1&offset=20&sort=desc&apikey=${key}`;
  const res = await tfetch(url).then((r) => r.json());
  for (const t of Array.isArray(res?.result) ? res.result : []) {
    if ((t.to ?? '').toLowerCase() !== address.toLowerCase() || t.isError !== '0' || Number(t.value) <= 0) continue;
    await recordDetection({ source: 'crypto', externalId: `eth:${t.hash}`, methodCode: 'eth', amount: cents(Number(t.value) / 1e18, price), currency: 'USD', toleranceBps: TOL, raw: { hash: t.hash } });
  }
}

async function ltc(address: string, price: number): Promise<void> {
  const res = await tfetch(`https://api.blockcypher.com/v1/ltc/main/addrs/${address}?limit=25`).then((r) => r.json());
  for (const ref of res?.txrefs ?? []) {
    if (ref.tx_input_n !== -1 || Number(ref.value) <= 0) continue;   // -1 => a received output
    await recordDetection({ source: 'crypto', externalId: `ltc:${ref.tx_hash}:${ref.tx_output_n}`, methodCode: 'ltc', amount: cents(Number(ref.value) / 1e8, price), currency: 'USD', toleranceBps: TOL, raw: { hash: ref.tx_hash } });
  }
}

async function sol(address: string, price: number): Promise<void> {
  const rpc = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
  const call = (method: string, params: unknown[]) =>
    tfetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
  const sigs = await call('getSignaturesForAddress', [address, { limit: 8 }]);
  for (const s of sigs?.result ?? []) {
    const tx = await call('getTransaction', [s.signature, { maxSupportedTransactionVersion: 0 }]);
    const keys = tx?.result?.transaction?.message?.accountKeys ?? [];
    const idx = keys.findIndex((k: any) => (typeof k === 'string' ? k : k.pubkey) === address);
    if (idx < 0) continue;
    const delta = Number(tx.result.meta?.postBalances?.[idx] ?? 0) - Number(tx.result.meta?.preBalances?.[idx] ?? 0);
    if (delta <= 0) continue;
    await recordDetection({ source: 'crypto', externalId: `sol:${s.signature}`, methodCode: 'sol', amount: cents(delta / 1e9, price), currency: 'USD', toleranceBps: TOL, raw: { hash: s.signature } });
  }
}

async function xrp(address: string, price: number): Promise<void> {
  const list = await tfetch(`https://api.xrpscan.com/api/v1/account/${address}/transactions`).then((r) => r.json());
  for (const t of Array.isArray(list) ? list : []) {
    if (t.TransactionType !== 'Payment' || t.Destination !== address || typeof t.Amount !== 'string') continue;   // string Amount = drops of XRP
    await recordDetection({ source: 'crypto', externalId: `xrp:${t.hash}`, methodCode: 'xrp', amount: cents(Number(t.Amount) / 1e6, price), currency: 'USD', toleranceBps: TOL, raw: { hash: t.hash } });
  }
}

// coingecko id per coin, for the live price
const PRICED: Record<string, { cg: string; run: (addr: string, price: number) => Promise<void> }> = {
  btc: { cg: 'bitcoin',  run: btc },
  eth: { cg: 'ethereum', run: ethNative },
  ltc: { cg: 'litecoin', run: ltc },
  sol: { cg: 'solana',   run: sol },
  xrp: { cg: 'ripple',   run: xrp },
};

async function getPrices(ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
  const res = await tfetch(url).then((r) => r.json());
  const out: Record<string, number> = {};
  for (const id of ids) if (res?.[id]?.usd) out[id] = Number(res[id].usd);
  return out;
}

/** USDC lives at the SAME EVM address on every EVM chain, so watch the club's USDC
 *  address across the common ones — a player who sent USDC over Polygon/Arbitrum/
 *  Optimism/Ethereum to it used to go undetected (we only watched Base). Each is a
 *  distinct dedup prefix; all map to the usdc_base method (USDC ≈ $1 everywhere). */
const USDC_CHAINS: [number, string, string, string][] = [
  [8453,  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'usdc_base',     'USDC (Base)'],
  [1,     '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'usdc_erc20',    'USDC (Ethereum)'],
  [137,   '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 'usdc_polygon',  'USDC (Polygon)'],
  [42161, '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 'usdc_arbitrum', 'USDC (Arbitrum)'],
  [10,    '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 'usdc_optimism', 'USDC (Optimism)'],
];

export async function detectCryptoPayments(): Promise<{ polled: number; disabled: string[] }> {
  const { db } = await import('@union/core');
  const methods = await db()<{ code: string; club_handle: string | null }[]>`
    select code, club_handle from payment_methods where enabled and settlement = 'club'`;
  const addr = new Map(methods.map((m) => [m.code, m.club_handle]));

  const jobs: Promise<unknown>[] = [];
  // Methods that are enabled + have an address but CANNOT be watched because their
  // chain API key is missing — surfaced so a silent misconfig becomes a loud alert.
  const disabled: string[] = [];
  const evmKey = !!process.env.ETHERSCAN_API_KEY;

  // USDT tron — keyless (TronGrid). USDT/USDC on EVM chains — need ETHERSCAN_API_KEY.
  const usdtTron = addr.get('usdt_trc20');
  if (usdtTron) jobs.push(tronUsdt(usdtTron).catch((err) => console.error('[crypto] usdt_trc20 poll failed:', err)));

  const usdtEvm = addr.get('usdt_erc20');
  if (usdtEvm) {
    if (evmKey) jobs.push(evmToken(1, '0xdAC17F958D2ee523a2206206994597C13D831ec7', 'usdt_erc20', 'usdt_erc20', usdtEvm).catch((err) => console.error('[crypto] usdt_erc20 poll failed:', err)));
    else disabled.push('usdt_erc20');
  }

  const usdcAddr = addr.get('usdc_base');
  if (usdcAddr) {
    if (evmKey) for (const [chain, contract, extId, label] of USDC_CHAINS) {
      jobs.push(evmToken(chain, contract, extId, 'usdc_base', usdcAddr, label).catch((err) => console.error(`[crypto] ${extId} poll failed:`, err)));
    } else disabled.push('usdc_base');
  }

  const active = Object.keys(PRICED).filter((code) => addr.get(code));
  if (active.length) {
    // eth needs the etherscan key; btc/ltc/sol/xrp are keyless.
    if (!evmKey && addr.get('eth')) disabled.push('eth');
    let prices: Record<string, number> = {};
    try { prices = await getPrices(active.map((c) => PRICED[c]!.cg)); }
    catch (err) { console.error('[crypto] price fetch failed:', err); }
    for (const code of active) {
      if (code === 'eth' && !evmKey) continue;
      const a = addr.get(code)!;
      const price = prices[PRICED[code]!.cg];
      if (!price) continue;   // no price → skip this cycle rather than mis-match
      jobs.push(PRICED[code]!.run(a, price).catch((err) => console.error(`[crypto] ${code} poll failed:`, err)));
    }
  }

  await Promise.allSettled(jobs);
  return { polled: jobs.length, disabled };
}
