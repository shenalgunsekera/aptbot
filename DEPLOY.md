# Deploying — everything on the net

One Vercel project runs it all: the admin panel, the Telegram bot (as a webhook),
and the sweepers (as cron). Neon holds the data. Firebase holds auth + receipt
images. Nothing runs on your machine.

```
Vercel        panel + /api/telegram (bot webhook) + /api/cron (sweepers)
Neon          the money (Postgres)
Firebase Auth panel login
Firebase Storage  receipt images
```

## 1. Neon — already done

Your database is live and the v2 schema is applied. The connection strings are in
`.env`:
- `DATABASE_URL` — direct host, for migrations
- `DATABASE_URL_POOLED` — pooled host, for the app (Vercel uses this)

## 2. Push to GitHub

```bash
cd "d:/Poker Bot Telegram"
git init && git add -A && git commit -m "v2"
gh repo create --private --source=. --push   # or push to a repo you made
```

`.env` is gitignored — your secrets don't go to GitHub.

## 3. Vercel

Import the repo → **Root Directory: `apps/panel`**. It's a monorepo; `vercel.json`
handles the workspace install and registers the cron.

Environment variables (Settings → Environment Variables) — paste all of these:

```
DATABASE_URL              <your Neon POOLED url>   ← use the -pooler host here
PG_POOL_MAX               1

TELEGRAM_BOT_TOKEN        <from BotFather>
TELEGRAM_WEBHOOK_SECRET   <make up a long random string>
CRON_SECRET               <make up another long random string>

NEXT_PUBLIC_FIREBASE_API_KEY        AIzaSyDBIJuIwuy9dzI_wlh-kdhZOJBUQZFCzwM
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN    poker-bot-bfb4e.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID     poker-bot-bfb4e
NEXT_PUBLIC_FIREBASE_APP_ID         1:1044582935125:web:ef18d71e9fc69d19a8c2dc

FIREBASE_PROJECT_ID       poker-bot-bfb4e
FIREBASE_STORAGE_BUCKET   poker-bot-bfb4e.firebasestorage.app
FIREBASE_CLIENT_EMAIL     firebase-adminsdk-fbsvc@poker-bot-bfb4e.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY      "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n"

REQUIRE_MFA               true
NODE_ENV                  production
```

- **`PG_POOL_MAX=1`** is not optional — every warm Vercel function holds its own
  pool, and the default of 10 would exhaust Neon under load.
- **`FIREBASE_PRIVATE_KEY`** — paste with the quotes and the literal `\n`. Mangled
  newlines are the #1 cause of "Firebase Admin is not configured".

Deploy. Note your URL, e.g. `https://union.vercel.app`.

## 4. Point Telegram at the webhook

One curl, once, after deploy:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-app>.vercel.app/api/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

The bot is now live. No process to keep running — Telegram POSTs each message to
Vercel.

## 5. The cron is automatic

`vercel.json` registers `/api/cron` to run every minute. It runs the sweepers
(expired locks, holds, escalations) and drains the notification outbox. **Vercel
Cron needs the Pro plan** for per-minute; on Hobby it runs daily, which is too
slow for a 30-minute match timeout. If you're on Hobby, either upgrade or set the
match timeout much longer in Settings.

## 6. Firebase — authorise your domain

Firebase Console → Authentication → Settings → **Authorized domains** → add your
Vercel domain, or Google sign-in fails.

## 7. Make yourself the owner

First sign-in is rejected (you're not in `admins` yet). Then:

```bash
DATABASE_URL="<neon direct url>" pnpm db:psql -c \
  "update admins set firebase_uid='<your-uid>', email='<you>' where firebase_uid='seed-owner-placeholder'"
```

Your uid is in the Firebase console (Authentication → Users) or the Vercel logs
after a rejected sign-in.

## 8. Before real money

- **Settings → Payment methods**: PayPal and Cash App are seeded *disabled* with
  no club account. Set the receiving account and enable them. Every deposit on a
  club-mediated method goes to that account.
- **Verify the crypto addresses** in Settings against your own wallets. They're
  seeded from what you provided, but a wrong address sends money into the void.
- **Set up the admin group**: add the bot to your admin Telegram group, then run
  `/setadmingroup` in it (only an admin's telegram_id is accepted). All jobs and
  alerts land there with inline buttons.
- **Link your admins**: `update admins set telegram_id=… where email=…` so they
  can act from the group.

## Local development (optional)

Everything still runs locally against Neon:
```bash
pnpm --filter @union/bot dev      # bot via long polling (not webhook)
pnpm --filter @union/panel dev    # panel on :3100
```
