-- ═══════════════════════════════════════════════════════════════════════════
-- 0072 — 'Staff Provide' deposit handles + Stripe as a tier target
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Deposit handle-tiers gain two more sentinel targets alongside a plain handle
-- and 'PEERPAY':
--   'STRIPE' — divert to the fixed Stripe link (un-hardcodes the old Cash App
--              < $250 rule; now any method/amount band can route to Stripe).
--   'STAFF'  — a human hands over the handle: the player is told to hold on, the
--              admin group gets a request, a staff member REPLIES with a tag/link,
--              and the bot relays it to the player. Also usable as a PeerPay
--              backup (handle_tiers[].backup = 'STAFF').
--
-- staff_handle_req tracks one open request so the bot (serverless — no memory
-- between updates) can match a staff reply in the admin group back to the fill
-- and know where to relay the handle. App-managed: the bot posts the request
-- directly (capturing the message id) and updates the row on reply.

create table if not exists staff_handle_req (
  id               uuid primary key default gen_random_uuid(),
  fill_id          uuid not null references fills(id) on delete cascade,
  platform         text not null,                 -- 'telegram' | 'discord'
  admin_chat_id    text not null,                 -- where the request was posted
  admin_message_id text not null,                 -- the message staff reply to
  player_chat_id   text not null,                 -- where to relay the handle
  amount           bigint not null,
  currency         text not null default 'USD',
  method_name      text,
  player_name      text,
  status           text not null default 'pending',  -- pending | provided | cancelled
  provided_handle  text,
  created_at       timestamptz not null default now()
);

-- One open request per posted message; the reply handler looks up by this.
create unique index if not exists staff_handle_req_msg_uniq
  on staff_handle_req (platform, admin_chat_id, admin_message_id);
create index if not exists staff_handle_req_fill_idx on staff_handle_req (fill_id);

-- Preconfigure Cash App so removing the hardcoded "< $250 → Stripe" rule doesn't
-- change behaviour: up to $250 → Stripe (Cash App Pay on the page), above → the
-- existing cashtag. Replaces earlier test tiers. Fully editable in the panel.
update payment_methods
   set handle_tiers = jsonb_build_array(
         jsonb_build_object('up_to', 25000, 'handle', 'STRIPE'),
         jsonb_build_object('up_to', null,  'handle', club_handle))
 where code = 'cashapp';
