-- ═══════════════════════════════════════════════════════════════════════════
-- 0005 — Policy helpers: rake, processor-fee grossing, audit, notifications
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Rake ───────────────────────────────────────────────────────────────────
-- Booked to house_rake. bps + flat, configured per direction.
--
-- Integer division truncates, so the rounding remainder always falls to the
-- PLAYER, never the house. That is a deliberate choice: a house that rounds in
-- its own favour on every transaction is skimming, and at ledger scale those
-- half-cents are exactly the kind of thing that makes reconciliation lie.
create or replace function calc_rake(p_amount bigint, p_direction flow_direction)
returns bigint
language plpgsql stable as $$
declare
  cfg config;
  v   bigint;
begin
  select * into cfg from config where id;

  if p_direction = 'deposit' then
    v := (p_amount * cfg.rake_deposit_bps) / 10000 + cfg.rake_deposit_flat;
  else
    v := (p_amount * cfg.rake_withdraw_bps) / 10000 + cfg.rake_withdraw_flat;
  end if;

  -- A rake that eats the whole transaction is always a misconfiguration, and
  -- it would produce a zero/negative chips_amount downstream. Fail loudly at
  -- the source rather than let a check constraint fail somewhere confusing.
  if v >= p_amount then
    raise exception
      '% rake of % would consume the entire amount of % — check rake config',
      p_direction, v, p_amount
      using errcode = 'check_violation';
  end if;

  return greatest(v, 0);
end $$;

-- ─── Processor fee grossing ─────────────────────────────────────────────────
-- Answers: "the withdrawer must NET p_net — what do we tell the depositor to
-- send?"  Solves  net = gross − gross·bps/10000 − flat  for gross.
--
-- Rounds UP: if we must be off by a minor unit, be off in the direction where
-- the withdrawer is made whole and the depositor overpays by a cent, not the
-- direction where a withdrawal mysteriously lands short.
create or replace function calc_gross_to_send(p_net bigint, p_method_id uuid)
returns bigint
language plpgsql stable as $$
declare
  m   payment_methods;
  cfg config;
begin
  select * into m from payment_methods where id = p_method_id;
  if not found then
    raise exception 'calc_gross_to_send: no such payment method %', p_method_id;
  end if;
  select * into cfg from config where id;

  -- Withdrawer-pays: the depositor sends exactly the ask and the processor's
  -- cut comes out of what the withdrawer receives.
  if cfg.fee_bearer = 'withdrawer' then
    return p_net;
  end if;

  return ceil(
    ((p_net + m.processor_fee_flat)::numeric * 10000) / (10000 - m.processor_fee_bps)
  )::bigint;
end $$;

-- ─── Hold deadline ──────────────────────────────────────────────────────────
-- Irreversible methods (crypto, cash) cannot be clawed back by the sender, so
-- there is nothing to defend against and no hold. Reversible ones sit under a
-- hold so a chargeback has time to surface before we hand over chips.
create or replace function hold_deadline(p_method_id uuid)
returns timestamptz
language plpgsql stable as $$
declare
  m   payment_methods;
  cfg config;
  v_secs int;
begin
  select * into m from payment_methods where id = p_method_id;
  select * into cfg from config where id;

  if m.reversibility = 'irreversible' then
    return null;
  end if;

  v_secs := coalesce(m.hold_seconds, cfg.reversible_hold_seconds);
  return now() + make_interval(secs => v_secs);
end $$;

-- ─── Audit ──────────────────────────────────────────────────────────────────
-- p_admin null = an automated/system action (sweeper, auto-release). Those are
-- logged too: "nobody did it, the clock did" is still an answer the log owes.
create or replace function audit(
  p_admin    uuid,
  p_action   text,
  p_ref_type text,
  p_ref_id   uuid,
  p_detail   jsonb default '{}'::jsonb
) returns void
language sql as $$
  insert into audit_log (admin_id, action, ref_type, ref_id, detail)
  values (p_admin, p_action, p_ref_type, p_ref_id, coalesce(p_detail, '{}'::jsonb));
$$;

-- ─── Notification outbox ────────────────────────────────────────────────────
-- Enqueued inside the same transaction as the money move it describes, so the
-- two can never disagree. The bot drains this queue.
create or replace function notify_player(
  p_player   uuid,
  p_kind     text,
  p_ref_type text,
  p_ref_id   uuid,
  p_payload  jsonb default '{}'::jsonb
) returns bigint
language sql as $$
  insert into notifications (player_id, kind, ref_type, ref_id, payload)
  values (p_player, p_kind, p_ref_type, p_ref_id, coalesce(p_payload, '{}'::jsonb))
  returning id;
$$;

-- Fan out to every admin reachable on Telegram. The panel additionally
-- surfaces escalations directly from the fills table, so an admin with no
-- Telegram link still sees them — this is a nudge, not the system of record.
create or replace function notify_admins(
  p_kind     text,
  p_ref_type text,
  p_ref_id   uuid,
  p_payload  jsonb default '{}'::jsonb
) returns int
language plpgsql as $$
declare
  v_count int;
begin
  insert into notifications (admin_id, kind, ref_type, ref_id, payload)
  select a.id, p_kind, p_ref_type, p_ref_id, coalesce(p_payload, '{}'::jsonb)
    from admins a
   where not a.disabled and a.telegram_id is not null;

  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ─── Chip order constructor ─────────────────────────────────────────────────
-- The ONLY sanctioned way to raise chip work. Resolves and snapshots the
-- player's confirmed ClubGG id, and refuses to queue work against an unlinked
-- account — an automated loader handed a null target is a loader that either
-- crashes or, worse, guesses.
create or replace function chip_order_create(
  p_player_id uuid,
  p_delta     bigint,
  p_currency  char(3),
  p_reason    text,
  p_ref_type  text default null,
  p_ref_id    uuid default null,
  p_note      text default null
) returns chip_orders
language plpgsql as $$
declare
  pl players;
  o  chip_orders;
begin
  select * into pl from players where id = p_player_id;
  if not found then
    raise exception 'chip_order_create: player % not found', p_player_id;
  end if;
  if pl.clubgg_id is null then
    raise exception
      'player % has no confirmed ClubGG id — an admin must link the account before chips can move',
      p_player_id
      using errcode = 'invalid_parameter_value';
  end if;

  insert into chip_orders (player_id, clubgg_id, delta, currency, reason, ref_type, ref_id, note)
  values (p_player_id, pl.clubgg_id, p_delta, p_currency, p_reason, p_ref_type, p_ref_id, p_note)
  returning * into o;

  perform notify_admins('chip_order.pending', 'chip_order', o.id,
    jsonb_build_object('player_id', p_player_id, 'clubgg_id', pl.clubgg_id,
                       'delta', p_delta, 'currency', p_currency, 'reason', p_reason));
  return o;
end $$;

-- ─── Risk flags ─────────────────────────────────────────────────────────────
-- Advisory only. Flags never block money on their own — an admin decides.
-- Freezing on an automated signal would hand any griefer a denial-of-service
-- against honest players.
create or replace function flag_player(
  p_player uuid,
  p_code   text,
  p_note   text,
  p_admin  uuid default null
) returns void
language plpgsql as $$
begin
  update players
     set risk_flags = risk_flags || jsonb_build_object(
           'code', p_code,
           'note', p_note,
           'at',   now(),
           'by',   p_admin
         )
   where id = p_player;

  perform audit(p_admin, 'player.flag', 'player', p_player,
                jsonb_build_object('code', p_code, 'note', p_note));
end $$;
