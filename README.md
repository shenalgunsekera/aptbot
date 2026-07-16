# ClubGG Union Settlement

Peer-to-peer settlement for a ClubGG poker union: a Telegram bot for players, a
web admin panel for admins/owner, backed by Postgres.

**Real money never touches the system.** A depositor pays a withdrawer directly,
using that withdrawer's own payout handle. The system moves internal credits and
issues chip work orders. Money only reaches the owner when a deposit can't be
matched — then the owner is the counterparty (backstop).

---

## The one thing to understand

**The ledger is the product.** Everything else is a client of it.

Every money movement is double-entry, append-only, and sums to exactly zero —
enforced by the *database*, not by application code:

| Guarantee | How it's enforced |
|---|---|
| `sum(ledger_entries) = 0`, per currency | Deferred constraint trigger, checked at COMMIT |
| No edits to history | `BEFORE UPDATE OR DELETE` trigger raises |
| No negative player balances | Deferred constraint trigger |
| No double-match under concurrency | `SELECT … FOR UPDATE SKIP LOCKED` + committed lock rows |
| Two admins can't approve the same thing | Row locks / atomic `UPDATE … WHERE status = …` |

The bot and the panel cannot corrupt the ledger even if they try. They call
vetted plpgsql functions; they never write to `ledger_entries`.

> `select * from ledger_verify();` returns zero rows when healthy. Non-empty
> means stop the world. The panel shows this on every page load.

---

## Quick start (local)

```bash
pnpm install
cp .env.example .env          # fill in TELEGRAM_BOT_TOKEN + Firebase later
pnpm db:up                    # Postgres 16 in Docker on port 54329
pnpm db:migrate
pnpm db:seed
pnpm test:db                  # 43 tests — run these, they prove the invariant
```

Then:

```bash
pnpm --filter @union/bot dev      # Telegram bot
pnpm --filter @union/panel dev    # admin panel → http://localhost:3100
```

---

## Layout

```
db/migrations/     The system. Schema + all money logic in plpgsql.
db/tests/          43 tests: invariant, FIFO, partial fills, disputes, races.
packages/core/     Typed DB client, money helpers, CHIP ADAPTER (your seam).
apps/bot/          grammY Telegram bot + notification drainer + sweepers.
apps/panel/        Next.js admin panel, Firebase Auth.
scripts/           migrate / seed / wait-for-db.
```

Read the migrations in order — they're written to be read, and the comments
explain *why*, not what.

---

## The accounts

Balance = `SUM(entries.amount)`. All accounts, all currencies, sum to zero.

| Account | Positive means |
|---|---|
| `player_chips` | we owe the player this many chips in ClubGG |
| `player_wallet` | we owe the player this much internal credit |
| `player_escrow` | credit locked against a pending withdrawal |
| `house_rake` | rake earned |
| `house_loss` | *(negative)* money the union ate — reversals, splits |
| `house_gameplay` | contra account for chips won/lost **at the tables** |
| `owner_float` | *(negative)* owner is **holding** cash; positive = owner **paid out** |

There is deliberately **no** "external world" account. In a matched fill, real
cash moves player→player entirely outside the system, so the ledger records only
the internal transfer: **the withdrawer's escrow becomes the depositor's chips.**

```
Matched fill:   escrow:W  −amount
                chips:D   +chips
                rake      +rake      → sums to 0
```

Cash only enters the ledger when the owner is a counterparty — which is exactly
what `owner_float` is.

### Why `house_gameplay` exists

**Players gamble.** The instant someone plays a hand their real ClubGG stack
stops matching what we issued them, and it never matches again.

So `player_chips` is **synced** from ClubGG (`chips_sync()`), and the difference
is booked to `house_gameplay`. That keeps balances true to the tables while
preserving the invariant.

It's also the fraud alarm. Poker is zero-sum — every chip won was lost by someone
else — so once players are synced this account should **hover near zero**,
drifting slowly negative by whatever rake the club takes in-game. A steady walk
in any other direction means chips are entering or leaving through a door this
system doesn't know about.

**Per-player drift is just poker. Aggregate drift is theft.**

---

## Setup

### 1. Telegram bot

1. Open Telegram, message **@BotFather** → `/newbot`.
2. Give it a name and a username ending in `bot`.
3. Copy the token into `.env`:
   ```
   TELEGRAM_BOT_TOKEN=8123456789:AAH...
   ```
   This token is *full control of the bot*. It's gitignored. Keep it that way.
4. Optional but recommended, in @BotFather:
   - `/setprivacy` → **Enable** (bot only sees commands, not all group chat)
   - `/setdescription`, `/setuserpic`
5. Run it: `pnpm --filter @union/bot dev`

The bot registers its own command list on boot. Commands work as both
`/club_info` and `/club-info` (Telegram's own command menu can't contain `-`,
so both are wired).

**The bot process also runs the sweepers and the notification drainer.** If it's
down, expired locks don't return to the queue and holds don't release. Run it
under a supervisor (systemd / Docker restart policy / Cloud Run min-instances=1).

### 2. Firebase (admin panel auth)

1. [console.firebase.google.com](https://console.firebase.google.com) → new project.
2. **Authentication** → Get started → enable **Google** and/or **Email/Password**.
3. **Authentication → Settings → Multi-factor** → enable if you want 2FA
   (recommended — this panel moves money).
4. Project settings → **Your apps** → add a **Web app**. Copy the config into `.env`:
   ```
   NEXT_PUBLIC_FIREBASE_API_KEY=...
   NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
   NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project
   NEXT_PUBLIC_FIREBASE_APP_ID=1:123:web:abc
   ```
   These are public by design — they identify the project, they authorise nothing.
5. Project settings → **Service accounts** → *Generate new private key*. From that
   JSON:
   ```
   FIREBASE_PROJECT_ID=your-project
   FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxx@your-project.iam.gserviceaccount.com
   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"
   ```
   Keep the quotes and the literal `\n`. **This key is admin access — never commit it.**
6. Enforce 2FA once your admins have enrolled:
   ```
   REQUIRE_MFA=true
   ```

**Being a Firebase user is not being an admin.** Anyone can create a Firebase
account; only rows in the `admins` table get in. Sign in once to create your
Firebase user, then claim it:

```bash
# 1. Find your uid: sign in at /login (you'll be rejected), then check the panel log
#    for: rejected sign-in for uid=xxxx
# 2. Claim the seeded owner row:
pnpm db:psql -c "update admins set firebase_uid = 'YOUR_UID', email = 'you@example.com'
                 where firebase_uid = 'seed-owner-placeholder'"
```

Add more admins the same way (`insert into admins (firebase_uid, email, role) values (…, 'admin')`).

Role lives in Postgres, not in a Firebase custom claim — deliberately. A claim is
a snapshot that keeps working after you revoke someone. Disabling an `admins` row
takes effect on their **next request**.

### 3. Owner config (do this before taking real money)

Sign in → **Config**:

- **Payment methods** — for each: currency, min/max, and the two that matter:
  - **Reversibility tier.** Crypto/cash = `irreversible` (no hold, instant
    release). Card/PayPal/bank = `reversible` (holds before release). Getting
    this wrong removes your only chargeback defence.
  - **Backstop handle.** Where a depositor pays *you* when the queue is empty.
    **Triple-check it** — real money gets sent to this string. Blank = refuse
    unmatched deposits on that method.
- **Rake** per direction, **processor fee bearer**, **limits**, **match timeout**
  (default 30 min), **hold window** (default 72h), **owner sign-off threshold**.

The seed ships placeholder backstop handles (`TXXXX…`). Replace them.

### 4. Onboarding a player

1. Player sends `/start` to the bot and types their **exact ClubGG ID**.
2. It lands in `clubgg_id_claimed` — *untrusted*.
3. An admin approves it in **Players** → the id moves to `clubgg_id` and the
   account activates.

That gate is load-bearing. A typo'd ClubGG id doesn't bounce — an automated
loader will happily send chips to a stranger, and they're not coming back. A
human confirming the string once is the only thing between a fat finger and an
unrecoverable transfer.

### 5. Production database

Local dev is Docker. For production use **Cloud SQL for PostgreSQL** (or Neon):

```
DATABASE_URL=postgres://union:PASSWORD@/union?host=/cloudsql/PROJECT:REGION:INSTANCE
```

Then `pnpm db:migrate` against it. Never expose 5432 publicly; use the Cloud SQL
connector or private IP.

---

## The ClubGG overlay / auto-loader

**The system does not care how chips physically move.** That's the entire point
of the adapter boundary. Implement one interface; nothing else changes.

### Where it plugs in

```
packages/core/src/chips/
  adapter.ts       ← the interface + the contract (read this first)
  manual.ts        ← default: humans do it in the panel
  clubgg-auto.ts   ← YOUR OVERLAY GOES HERE (stub, refuses everything)
  worker.ts        ← drives the adapter; owns crash safety
```

Turn it on:
```
CHIP_ADAPTER=clubgg-auto
```

### Three methods

```ts
load(order):    Promise<ChipResult>   // put order.delta chips on order.clubggId
unload(order):  Promise<ChipResult>   // take -order.delta chips off
readBalance(clubggId, currency): Promise<number | null>   // live stack, in cents
```

`order.clubggId` is the **confirmed** id, snapshotted when the order was raised.
Act on it verbatim.

### The protocol, and why it's shaped this way

```
claim  →  execute  →  report
```

The claim is committed to the DB **before** your code touches ClubGG. That
ordering is the whole design.

**The failure that will cost you real money:** your overlay loads 500 chips, then
dies before it can report back. On restart the order is still there. A naive
retry loads 500 *more*. Gone.

You cannot distinguish "the click never landed" from "the click landed and the
reply was lost." So:

- A crashed worker leaves the order **`claimed`** — visibly stuck, attributable,
  and **never auto-retried**.
- The panel flags claims older than 15 minutes as **STALE** and tells the admin
  to check the real table before doing anything.
- The only safe auto-release is `certainNothingMoved: true` — your adapter
  asserting it *provably* did nothing.

Slow beats wrong, when wrong is unrecoverable.

### Report the truth, not the request

- Asked to unload 500, player only had 300 (they lost the rest)?
  → `{ ok: true, actualDelta: -300 }`. The system handles this: it cancels the
  withdrawal and keeps the 300. It cannot handle being lied to.
- Timeout / ambiguous?
  → `certainNothingMoved: false`. Costs an admin two minutes. The wrong answer
  costs real money.
- Can't read a balance?
  → `return null`. **Never 0** — zero is a real balance, and `chips_sync` will
  book it as the player losing their entire stack.

### Live balance checks

Once `readBalance` works, set `canReadBalance = true` and enable **Config →
require live ClubGG balance**. Then `/club-withdraw` validates against the
player's *real* stack before accepting — instead of finding out at unload time,
after you already told them yes.

This is enforced in `withdraw_create()`, not in the bot. Money rules that live in
a client are suggestions.

### Honest warnings

- **ClubGG has no public API.** An overlay means UI automation — fragile, breaks
  on any layout change.
- **It's very likely against ClubGG's ToS.** Loading chips for your own union
  members is normal club-owner admin, not cheating at poker — but if they take a
  different view, the downside is your club. That's a business call, and it's
  yours.
- **It needs a machine running ClubGG 24/7.** Orders arrive whenever players do.
- The adapter runs as a real admin row (`system:chip-adapter`, seeded), so every
  action it takes is audited exactly like a human's. The panel shows
  "ClubGG Auto Loader" in the trail rather than work appearing from nowhere.

---

## Operations

```bash
pnpm test:db          # 43 tests. Run before every deploy.
pnpm db:psql          # psql into the local DB
pnpm db:reset         # nuke + migrate + seed (local only!)
```

Health checks, in order of severity:

```sql
select * from ledger_verify();      -- MUST be empty. Non-empty = stop the world.
select * from reconcile_summary();  -- float, net position, live invariant check
select * from reconcile_report();   -- per-player chip drift
select * from v_admin_inbox;        -- everything waiting on a human
```

The bot process runs `sweep_all()` every 60s (`SWEEP_INTERVAL_MS`):
- `sweep_expired_locks()` — depositor took a handle and never paid → slice returns
  to the **front** of the queue (its `created_at` is never touched, so the
  withdrawer loses nothing but time)
- `sweep_holds()` — reversible fills past their hold → release or escalate
- `sweep_escalations()` — withdrawer never answered / blocked the bot → admin review

---

## Notes on things that look wrong but aren't

- **`owner_float` is negative when the owner holds cash.** It's the only account
  tracking real money rather than internal credit. The panel shows
  `-balance` as "owner cash held".
- **A refund books no ledger entries.** Nothing was ever released — the escrow
  never moved. Only the slice returns.
- **Deposit rake is taken at release; withdraw rake at escrow.** So the FIFO
  queue trades in *net* — `withdraw_requests.amount` is what a depositor actually
  pays, `gross_amount` is what left the wallet.
- **The processor fee never enters the ledger.** It's taken outside our
  perimeter. It only changes the number quoted to the depositor (`gross_to_send`).
- **Rounding always favours the player.** Integer division truncates rake down;
  fee grossing rounds up so the withdrawer is made whole.
- **A clawback beyond a player's balance becomes a `house_loss`, not a negative
  balance.** If they gambled it away, the union ate it. Recording a debt the
  player never agreed to, dressed as an asset, is how ledgers start lying.

---

## Deviations from the original spec

Two, both deliberate:

1. **`flag_account` is not a dispute resolution.** The spec listed it alongside
   release/refund/split "each booked as explicit ledger entries" — but it books
   none, because it isn't a money outcome. It's now an orthogonal flag on either
   party, so an admin can *refund the victim **and** flag the scammer* in one
   call. That's the most common real outcome and the original enum couldn't
   express it.

2. **Reconciliation compares against expected-on-table, not raw ledger, and
   gameplay is booked.** The spec's "compare ledger chip totals vs actual ClubGG
   counts and flag drift" would fire on every active player forever, because
   players gamble. See `house_gameplay` above.
