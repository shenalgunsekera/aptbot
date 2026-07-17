import 'server-only';
import { recordDetection } from './detect';

/**
 * Crypto payment detection for ALL coins.
 *
 *   Stablecoins (USDT/USDC): 1 token ≈ $1, so we match the dollar amount EXACTLY.
 *   Volatile coins (BTC/ETH/LTC/SOL/XRP): we pull a live USD price, convert the
 *     on-chain amount, and match WITHIN A TOLERANCE (default ±3%, CRYPTO_TOLERANCE_BPS)
 *     to the nearest pending request. Never releases — an admin still verifies.
 *
 * No chain has a push webhook, so this polls each club address every cron cycle.
 * payment_detect dedupes on the tx hash, so re-seeing a transfer is a no-op.
 * Everything is env-gated; with nothing configured it does nothing.
 */

const TOL = Number(process.env.CRYPTO_TOLERANCE_BPS ?? 300);   // ±3%
const cents = (coinAmount: number, priceUsd: number) => Math.round(coinAmount * priceUsd * 100);

// ─── Stablecoins — exact match (no price needed) ─────────────────────────────

async function tronUsdt(address: string): Promise<void> {
  const contract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const url = `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?only_to=true&limit=20&contract_address=${contract}`;
  const headers: Record<string, string> = {};
  if (process.env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
  const res = await fetch(url, { headers }).then((r) => r.json());
  for (const t of res?.data ?? []) {
    if ((t.to ?? '').toLowerCase() !== address.toLowerCase()) continue;
    const usd = Math.round(Number(t.value ?? 0) / 10 ** Number(t.token_info?.decimals ?? 6) * 100);
    await recordDetection({ source: 'crypto', externalId: `usdt_trc20:${t.transaction_id}`, methodCode: 'usdt_trc20', amount: usd, currency: 'USD', raw: { hash: t.transaction_id } });
  }
}

async function evmToken(chainId: number, contract: string, code: string, address: string): Promise<void> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return;
  const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=tokentx&contractaddress=${contract}&address=${address}&page=1&offset=20&sort=desc&apikey=${key}`;
  const res = await fetch(url).then((r) => r.json());
  if (!Array.isArray(res?.result)) return;
  for (const t of res.result) {
    if ((t.to ?? '').toLowerCase() !== address.toLowerCase()) continue;
    const usd = Math.round(Number(t.value ?? 0) / 10 ** Number(t.tokenDecimal ?? 6) * 100);
    await recordDetection({ source: 'crypto', externalId: `${code}:${t.hash}`, methodCode: code, amount: usd, currency: 'USD', raw: { hash: t.hash } });
  }
}

// ─── Volatile coins — live price + tolerance ─────────────────────────────────

async function btc(address: string, price: number): Promise<void> {
  const txs = await fetch(`https://blockstream.info/api/address/${address}/txs`).then((r) => r.json());
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
  const res = await fetch(url).then((r) => r.json());
  for (const t of Array.isArray(res?.result) ? res.result : []) {
    if ((t.to ?? '').toLowerCase() !== address.toLowerCase() || t.isError !== '0' || Number(t.value) <= 0) continue;
    await recordDetection({ source: 'crypto', externalId: `eth:${t.hash}`, methodCode: 'eth', amount: cents(Number(t.value) / 1e18, price), currency: 'USD', toleranceBps: TOL, raw: { hash: t.hash } });
  }
}

async function ltc(address: string, price: number): Promise<void> {
  const res = await fetch(`https://api.blockcypher.com/v1/ltc/main/addrs/${address}?limit=25`).then((r) => r.json());
  for (const ref of res?.txrefs ?? []) {
    if (ref.tx_input_n !== -1 || Number(ref.value) <= 0) continue;   // -1 => a received output
    await recordDetection({ source: 'crypto', externalId: `ltc:${ref.tx_hash}:${ref.tx_output_n}`, methodCode: 'ltc', amount: cents(Number(ref.value) / 1e8, price), currency: 'USD', toleranceBps: TOL, raw: { hash: ref.tx_hash } });
  }
}

async function sol(address: string, price: number): Promise<void> {
  const rpc = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
  const call = (method: string, params: unknown[]) =>
    fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
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
  const list = await fetch(`https://api.xrpscan.com/api/v1/account/${address}/transactions`).then((r) => r.json());
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
  const res = await fetch(url).then((r) => r.json());
  const out: Record<string, number> = {};
  for (const id of ids) if (res?.[id]?.usd) out[id] = Number(res[id].usd);
  return out;
}

export async function detectCryptoPayments(): Promise<number> {
  const { db } = await import('@union/core');
  const methods = await db()<{ code: string; club_handle: string | null }[]>`
    select code, club_handle from payment_methods where enabled and settlement = 'club'`;
  const addr = new Map(methods.map((m) => [m.code, m.club_handle]));

  let polled = 0;

  // Stablecoins — exact match, no price.
  const stable: [string, (a: string) => Promise<void>][] = [
    ['usdt_trc20', tronUsdt],
    ['usdt_erc20', (a) => evmToken(1, '0xdAC17F958D2ee523a2206206994597C13D831ec7', 'usdt_erc20', a)],
    ['usdc_base',  (a) => evmToken(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'usdc_base', a)],
  ];
  for (const [code, run] of stable) {
    const a = addr.get(code);
    if (!a) continue;
    try { await run(a); polled++; } catch (err) { console.error(`[crypto] ${code} poll failed:`, err); }
  }

  // Volatile coins — need a live price first.
  const active = Object.keys(PRICED).filter((code) => addr.get(code));
  if (active.length) {
    let prices: Record<string, number> = {};
    try { prices = await getPrices(active.map((c) => PRICED[c]!.cg)); }
    catch (err) { console.error('[crypto] price fetch failed:', err); }
    for (const code of active) {
      const a = addr.get(code)!;
      const price = prices[PRICED[code]!.cg];
      if (!price) continue;   // no price → skip this cycle rather than mis-match
      try { await PRICED[code]!.run(a, price); polled++; } catch (err) { console.error(`[crypto] ${code} poll failed:`, err); }
    }
  }
  return polled;
}
