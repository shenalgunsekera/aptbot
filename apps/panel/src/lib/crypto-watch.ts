import 'server-only';
import { recordDetection } from './detect';

/**
 * Crypto payment detection — STABLECOINS ONLY.
 *
 * We match a payment to a request by EXACT amount. That only works when the coin
 * is worth ~$1 (USDT, USDC): the on-chain token amount equals the USD amount. For
 * BTC/ETH/etc the USD value floats, so an exact match is impossible — those keep
 * the receipt + admin-confirm path, no auto-detect.
 *
 * There is no push webhook for a chain, so this polls each club address every
 * cron cycle. Idempotency is free: payment_detect dedupes on the tx hash, so
 * re-seeing the same transfer is a no-op.
 *
 * Everything is env-gated — with no keys/addresses set, this does nothing.
 */

type Watcher = { code: string; run: (address: string) => Promise<void> };

const USD = (rawValue: string, decimals: number) =>
  Math.round((Number(rawValue) / 10 ** decimals) * 100);   // token units → USD cents

async function tronUsdt(address: string): Promise<void> {
  // USDT-TRC20 via TronGrid. Key optional (higher rate limit with one).
  const contract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const url = `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20`
    + `?only_to=true&limit=20&contract_address=${contract}`;
  const headers: Record<string, string> = {};
  if (process.env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
  const res = await fetch(url, { headers }).then((r) => r.json());
  for (const t of res?.data ?? []) {
    if ((t.to ?? '').toLowerCase() !== address.toLowerCase()) continue;
    await recordDetection({
      source: 'crypto', externalId: `usdt_trc20:${t.transaction_id}`, methodCode: 'usdt_trc20',
      amount: USD(String(t.value ?? '0'), Number(t.token_info?.decimals ?? 6)), currency: 'USD',
      raw: { hash: t.transaction_id },
    });
  }
}

/** Etherscan V2 covers every EVM chain with one key via chainid. */
async function evmToken(chainId: number, contract: string, decimals: number, code: string, address: string): Promise<void> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return;
  const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=tokentx`
    + `&contractaddress=${contract}&address=${address}&page=1&offset=20&sort=desc&apikey=${key}`;
  const res = await fetch(url).then((r) => r.json());
  if (!Array.isArray(res?.result)) return;
  for (const t of res.result) {
    if ((t.to ?? '').toLowerCase() !== address.toLowerCase()) continue;
    await recordDetection({
      source: 'crypto', externalId: `${code}:${t.hash}`, methodCode: code,
      amount: USD(String(t.value ?? '0'), Number(t.tokenDecimal ?? decimals)), currency: 'USD',
      raw: { hash: t.hash },
    });
  }
}

const WATCHERS: Watcher[] = [
  { code: 'usdt_trc20', run: (a) => tronUsdt(a) },
  { code: 'usdt_erc20', run: (a) => evmToken(1, '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6, 'usdt_erc20', a) },
  { code: 'usdc_base',  run: (a) => evmToken(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6, 'usdc_base', a) },
];

/** Poll every configured stablecoin address once. Called from the cron. */
export async function detectCryptoPayments(): Promise<number> {
  const { db } = await import('@union/core');
  const methods = await db()<{ code: string; club_handle: string | null }[]>`
    select code, club_handle from payment_methods where enabled and settlement = 'club'`;
  const byCode = new Map(methods.map((m) => [m.code, m.club_handle]));

  let polled = 0;
  for (const w of WATCHERS) {
    const address = byCode.get(w.code);
    if (!address) continue;
    try { await w.run(address); polled++; } catch (err) { console.error(`[crypto] ${w.code} poll failed:`, err); }
  }
  return polled;
}
