-- ═══════════════════════════════════════════════════════════════════════════
-- 0005 — Policy helpers: rake, fee grossing, holds, loader work, receipts
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Rake ───────────────────────────────────────────────────────────────────
-- Integer division truncates, so the rounding remainder always falls to the
-- PLAYER, never the house. Deliberate: a house that rounds in its own favour on
-- every transaction is skimming, and those half-cents are exactly what makes
-- reconciliation start lying.
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

  -- A rake that eats the whole transaction is always a misconfiguration and
  -- would produce a zero/negative credit downstream. Fail at the source rather
  -- than let a check constraint fail somewhere confusing.
  if v >= p_amount then
    raise exception
      '% rake of % would consume the entire amount of % — check rake config',
      p_direction, v, p_amount
      using errcode = 'check_violation';
  end if;
  return greatest(v, 0);
end $$;

-- ─── Processor fee grossing ─────────────────────────────────────────────────
-- "The payee must NET p_net — what do we tell the payer to send?"
-- Solves  net = gross − gross·bps/10000 − flat  for gross.
--
-- Rounds UP: if we must be off by a minor unit, be off where the payee is made
-- whole and the payer overpays a cent — not where a withdrawal lands short.
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

  if cfg.fee_bearer = 'withdrawer' then
    return p_net;
  end if;

  return ceil(
    ((p_net + m.processor_fee_flat)::numeric * 10000) / (10000 - m.processor_fee_bps)
  )::bigint;
end $$;

-- ─── Hold deadline ──────────────────────────────────────────────────────────
-- Irreversible methods cannot be clawed back by the sender, so there is nothing
-- to defend against and no hold.
create or replace function hold_deadline(p_method_id uuid)
returns timestamptz
language plpgsql stable as $$
declare
  m   payment_methods;
  cfg config;
begin
  select * into m from payment_methods where id = p_method_id;
  select * into cfg from config where id;

  if m.reversibility = 'irreversible' then
    return null;
  end if;
  return now() + make_interval(secs => coalesce(m.hold_seconds, cfg.reversible_hold_seconds));
end $$;

-- ─── The sole club on a platform ────────────────────────────────────────────
-- When a platform has exactly one enabled club, "which club?" is not a real
-- question — answer it automatically. With several it IS a real question, and
-- guessing which loader's hands should touch a stranger's account is not a
-- thing software should do.
create or replace function sole_club_id(p_platform_id uuid)
returns uuid
language plpgsql stable as $$
declare
  v_count int;
  v_id    uuid;
begin
  select count(*) into v_count from clubs
   where enabled and platform_id = p_platform_id;
  if v_count <> 1 then
    return null;
  end if;
  select id into v_id from clubs
   where enabled and platform_id = p_platform_id
   order by created_at limit 1;
  return v_id;
end $$;

-- ─── Raise loader work ──────────────────────────────────────────────────────
-- The ONLY sanctioned way to queue work for a human loader. Resolves the club,
-- snapshots the identifying triple, and refuses to queue work nobody could do.
create or replace function loader_order_create(
  p_player_id   uuid,
  p_platform_id uuid,
  p_delta       bigint,
  p_currency    char(3),
  p_reason      text,
  p_ref_type    text default null,
  p_ref_id      uuid default null,
  p_note        text default null
) returns loader_orders
language plpgsql as $$
declare
  pl     players;
  pp     player_platforms;
  cl     clubs;
  o      loader_orders;
  v_club uuid;
begin
  select * into pl from players where id = p_player_id;
  if not found then
    raise exception 'loader_order_create: player % not found', p_player_id;
  end if;

  select * into pp from player_platforms
   where player_id = p_player_id and platform_id = p_platform_id for update;
  if not found or pp.platform_uid is null then
    raise exception
      'this player has no confirmed account on that platform — an admin must link it first'
      using errcode = 'invalid_parameter_value';
  end if;

  -- An order with no club is one no loader will ever pick up: it would sit
  -- pending forever while the ledger insisted value was owed.
  v_club := coalesce(pp.club_id, sole_club_id(p_platform_id));
  if v_club is null then
    raise exception
      'this player is not assigned to a club on that platform — assign one in the panel'
      using errcode = 'invalid_parameter_value';
  end if;
  if pp.club_id is null then
    update player_platforms set club_id = v_club where id = pp.id;
  end if;

  select * into cl from clubs where id = v_club;
  if not cl.enabled then
    raise exception 'club % is disabled — work cannot be routed to it', cl.name
      using errcode = 'invalid_parameter_value';
  end if;

  insert into loader_orders (
    player_id, platform_id, club_id, platform_uid, player_name,
    delta, currency, reason, ref_type, ref_id, note
  ) values (
    p_player_id, p_platform_id, v_club, pp.platform_uid, coalesce(pl.display_name, 'unnamed'),
    p_delta, p_currency, p_reason, p_ref_type, p_ref_id, p_note
  ) returning * into o;

  perform notify_admins('loader.work', 'loader_order', o.id,
    jsonb_build_object('player_name', o.player_name, 'platform_uid', o.platform_uid,
                       'club', cl.name, 'delta', o.delta, 'currency', o.currency,
                       'reason', o.reason));
  return o;
end $$;

-- ─── Receipts ───────────────────────────────────────────────────────────────
-- A short, quotable reference. Crockford-ish alphabet: no I/L/O/U, so a human
-- reading one aloud in the admin group can't turn it into a different receipt.
create or replace function generate_receipt_ref()
returns text
language plpgsql as $$
declare
  alphabet text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v text;
  i int;
begin
  loop
    v := 'RCP-';
    for i in 1..6 loop
      v := v || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from receipts where reference = v);
  end loop;
  return v;
end $$;

-- Record an uploaded receipt image.
--
-- Snapshots the player's name and platform uid at upload time, because this row
-- is EVIDENCE: an admin opening it six months later must see who it was, not
-- who the joins say it is today.
create or replace function receipt_add(
  p_player_id    uuid,
  p_ref_type     text,
  p_ref_id       uuid,
  p_storage_path text,
  p_url          text,
  p_platform_id  uuid default null,
  p_content_type text default null,
  p_bytes        bigint default null,
  p_telegram_file_id text default null,
  p_by_player    uuid default null,
  p_by_admin     uuid default null
) returns receipts
language plpgsql as $$
declare
  pl players;
  pp player_platforms;
  r  receipts;
begin
  select * into pl from players where id = p_player_id;
  if not found then
    raise exception 'receipt_add: player % not found', p_player_id;
  end if;

  if p_platform_id is not null then
    select * into pp from player_platforms
     where player_id = p_player_id and platform_id = p_platform_id;
  end if;

  insert into receipts (
    reference, player_id, player_name, platform_uid, platform_id,
    ref_type, ref_id, storage_path, url, content_type, bytes,
    telegram_file_id, uploaded_by_player, uploaded_by_admin
  ) values (
    generate_receipt_ref(), p_player_id, coalesce(pl.display_name, 'unnamed'),
    pp.platform_uid, p_platform_id,
    p_ref_type, p_ref_id, p_storage_path, p_url, p_content_type, p_bytes,
    p_telegram_file_id, p_by_player, p_by_admin
  ) returning * into r;

  return r;
end $$;

-- ─── Saved payout handles ───────────────────────────────────────────────────
-- Using a handle is what saves it — no "would you like to save this?" step to
-- forget.
create or replace function payout_handle_remember(
  p_player_id uuid,
  p_method_id uuid,
  p_handle    text,
  p_label     text default null
) returns payout_handles
language plpgsql as $$
declare
  h payout_handles;
begin
  insert into payout_handles (player_id, method_id, handle, label, use_count, last_used_at)
  values (p_player_id, p_method_id, trim(p_handle), p_label, 1, now())
  on conflict (player_id, method_id, handle) do update
    set use_count    = payout_handles.use_count + 1,
        last_used_at = now(),
        label        = coalesce(excluded.label, payout_handles.label)
  returning * into h;
  return h;
end $$;

create or replace function payout_handles_for(p_player_id uuid, p_method_id uuid)
returns setof payout_handles
language sql stable as $$
  select * from payout_handles
   where player_id = p_player_id and method_id = p_method_id
   order by last_used_at desc nulls last, use_count desc
   limit 5;
$$;
