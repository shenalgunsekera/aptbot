import { connect } from './db.mjs';

const sql = connect({ max: 1 });

// ─── Payment methods ─────────────────────────────────────────────────────────
//
// club_handle is where the club RECEIVES (deposits) and PAYS FROM (withdrawals).
//
//   Crypto (p2p): club_handle is the FALLBACK a depositor pays only when nobody
//     is queued. These are the real receiving addresses you provided. A wrong
//     address here sends real money into the void — verify each one against your
//     wallet before going live.
//
//   PayPal/CashApp (club): club_handle is REQUIRED — every deposit goes to it
//     and every withdrawal is paid from it. Left blank on purpose: set it in the
//     panel once, deliberately, rather than have it pasted here on a guess.
//
const methods = [
  // ── Crypto — irreversible, peer-to-peer ──
  { code: 'usdt_trc20', name: 'USDT (TRC-20)', currency: 'USD',
    reversibility: 'irreversible', settlement: 'p2p',
    club_handle: 'TCa6pw8PGp7X8WtVGhA24yupHPfnjcm531',
    handle_hint: 'your USDT TRC-20 address (starts with T)',
    handle_pattern: '^T[A-Za-z0-9]{33}$', min_amount: 1000, sort_order: 1 },

  { code: 'usdt_erc20', name: 'USDT/USDC (ERC-20)', currency: 'USD',
    reversibility: 'irreversible', settlement: 'p2p',
    club_handle: '0x2f26912DA941a7CdF7585eF67c1Dbdef0f019b20',
    handle_hint: 'your ERC-20 address (starts with 0x)',
    handle_pattern: '^0x[a-fA-F0-9]{40}$', min_amount: 2000, sort_order: 2 },

  { code: 'usdc_base', name: 'USDC (Base)', currency: 'USD',
    reversibility: 'irreversible', settlement: 'p2p',
    club_handle: '0x20A32Cf623752bedA87744d00f26D7940C217970',
    handle_hint: 'your Base address (starts with 0x)',
    handle_pattern: '^0x[a-fA-F0-9]{40}$', min_amount: 1000, sort_order: 3 },

  { code: 'btc', name: 'Bitcoin', currency: 'USD',
    reversibility: 'irreversible', settlement: 'p2p',
    club_handle: 'bc1q3wmkvmfwdpj06se9qq6sjv7ppnn4pzq7ttmrsm',
    handle_hint: 'your BTC address', min_amount: 2000, sort_order: 4 },

  { code: 'eth', name: 'Ethereum', currency: 'USD',
    reversibility: 'irreversible', settlement: 'p2p',
    club_handle: '0x2f26912DA941a7CdF7585eF67c1Dbdef0f019b20',
    handle_hint: 'your ETH address (starts with 0x)',
    handle_pattern: '^0x[a-fA-F0-9]{40}$', min_amount: 2000, sort_order: 5 },

  { code: 'ltc', name: 'Litecoin', currency: 'USD',
    reversibility: 'irreversible', settlement: 'p2p',
    club_handle: 'ltc1q6qf6q36ceecdajaql3jjtv7j0u900ak9z6s43j',
    handle_hint: 'your LTC address', min_amount: 1000, sort_order: 6 },

  { code: 'sol', name: 'Solana', currency: 'USD',
    reversibility: 'irreversible', settlement: 'p2p',
    club_handle: 'Djw27e3keT24AZ6fgWwMyMCYobacHk9fuwxPyHyq8k2a',
    handle_hint: 'your SOL address', min_amount: 1000, sort_order: 7 },

  { code: 'xrp', name: 'XRP', currency: 'USD',
    reversibility: 'irreversible', settlement: 'p2p',
    club_handle: 'rNohTzcnJRVzBNDMKU3WM722cVwp2JwMYQ',
    handle_hint: 'your XRP address (and destination tag if any)', min_amount: 1000, sort_order: 8 },

  // ── Reversible — CLUB MEDIATED. Set club_handle in the panel before enabling. ──
  { code: 'paypal', name: 'PayPal', currency: 'USD',
    reversibility: 'reversible', settlement: 'club',
    club_handle: null, enabled: false,   // enable once the receiving account is set
    handle_hint: 'your PayPal email or @username',
    processor_fee_bps: 349, processor_fee_flat: 49, min_amount: 500, sort_order: 20 },

  { code: 'cashapp', name: 'Cash App', currency: 'USD',
    reversibility: 'reversible', settlement: 'club',
    club_handle: null, enabled: false,
    handle_hint: 'your $cashtag', min_amount: 500, sort_order: 21 },
];

for (const m of methods) {
  await sql`
    insert into payment_methods ${sql(m)}
    on conflict (code) do update set
      name = excluded.name, settlement = excluded.settlement,
      handle_hint = excluded.handle_hint, sort_order = excluded.sort_order
  `;
}
console.log(`  ✓ ${methods.length} payment methods (crypto live, PayPal/CashApp need a club account set)`);

// ─── Owner ───────────────────────────────────────────────────────────────────
let owner;
const [existing] = await sql`select * from admins where role='owner' and not disabled limit 1`;
if (existing) {
  owner = existing;
  console.log(`  ✓ owner already set up: ${existing.email}`);
} else {
  [owner] = await sql`
    insert into admins (firebase_uid, email, display_name, role)
    values ('seed-owner-placeholder', ${process.env.OWNER_EMAIL || 'owner@example.com'}, 'Owner', 'owner')
    on conflict (firebase_uid) do update set email = excluded.email
    returning *`;
  console.log(`  ✓ owner placeholder — claim it with your Firebase uid`);
}

// ─── A club per platform ──────────────────────────────────────────────────────
for (const code of ['clubgg', 'sportsbook']) {
  const [pf] = await sql`select * from platforms where code = ${code}`;
  const [c] = await sql`
    insert into clubs (platform_id, code, name, platform_club_id, owner_admin_id)
    values (${pf.id}, ${'main_' + code}, ${pf.name + ' Club'}, ${'SET-ME-' + code}, ${owner.id})
    on conflict (code) do nothing
    returning *`;
  console.log(c ? `  ✓ club for ${pf.name}` : `  ✓ club for ${pf.name} (exists)`);
}

// ─── Config ────────────────────────────────────────────────────────────────────
await sql`
  update config set
    base_currency = 'USD', match_timeout_seconds = 1800,
    reversible_hold_seconds = 259200, auto_release_on_expiry = false,
    fee_bearer = 'depositor', min_amount = 500, max_amount = 500000
  where id`;
console.log('  ✓ config defaults');

console.log('\nseed: done');
await sql.end();
