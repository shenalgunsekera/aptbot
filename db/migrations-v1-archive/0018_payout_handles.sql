-- ═══════════════════════════════════════════════════════════════════════════
-- 0018 — Saved payout handles
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Until now /club-withdraw asked for the payout handle every single time. That
-- is not just tedious — it is a safety problem. A USDT address is 34 characters
-- and every retype is a fresh chance to fat-finger one, and a wrong handle sends
-- real money to a stranger with no reversal. The safest handle is the one the
-- player typed once, checked once, and never has to touch again.
--
-- NOTE ON IN-FLIGHT MONEY: fills.payout_handle is a SNAPSHOT taken at reveal
-- time (see 0004), and withdraw_requests.payout_handle is copied at creation.
-- Neither reads from this table. So editing a saved handle can never re-target
-- a payment a depositor is already making — which would otherwise be a tidy way
-- to steal a disputed transfer.

create table payout_handles (
  id         uuid primary key default gen_random_uuid(),
  player_id  uuid not null references players (id),
  method_id  uuid not null references payment_methods (id),

  handle     text not null,
  -- Optional nickname, e.g. "main paypal". The player may have two.
  label      text,

  -- Ordering: the one they reach for most is the one to offer first.
  use_count    int not null default 0,
  last_used_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payout_handles_not_blank check (length(trim(handle)) > 0),
  -- Same handle twice on one method is the same handle.
  unique (player_id, method_id, handle)
);

create index payout_handles_lookup_idx
  on payout_handles (player_id, method_id, last_used_at desc nulls last);

create trigger payout_handles_touch before update on payout_handles
  for each row execute function touch_updated_at();

-- ─── Remember a handle ──────────────────────────────────────────────────────
-- Called automatically by withdraw_create, so using a handle is what saves it.
-- No "would you like to save this?" step to forget.
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

-- ─── Offer them back ────────────────────────────────────────────────────────
create or replace function payout_handles_for(
  p_player_id uuid,
  p_method_id uuid
) returns setof payout_handles
language sql stable as $$
  select * from payout_handles
   where player_id = p_player_id and method_id = p_method_id
   order by last_used_at desc nulls last, use_count desc
   limit 5;
$$;

-- ─── Forget one ─────────────────────────────────────────────────────────────
-- Only removes the saved shortcut. Any withdrawal already using it keeps its own
-- snapshot and is untouched.
create or replace function payout_handle_forget(
  p_handle_id uuid,
  p_player_id uuid
) returns boolean
language plpgsql as $$
declare
  n int;
begin
  delete from payout_handles where id = p_handle_id and player_id = p_player_id;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- ─── withdraw_create remembers ──────────────────────────────────────────────
-- Same function as 0006 plus the remember call. Reproduced whole rather than
-- patched, because it is the money path and it should be readable in one place.
create or replace function withdraw_create(
  p_player_id     uuid,
  p_method_id     uuid,
  p_gross         bigint,
  p_payout_handle text
) returns withdraw_requests
language plpgsql as $$
declare
  cfg config;
  pl  players;
  m   payment_methods;
  w   withdraw_requests;
  v_rake      bigint;
  v_net       bigint;
  v_wallet    bigint;
  v_chips     bigint;
  v_shortfall bigint;
  v_open      int;
  v_today     bigint;
  v_order     chip_orders;
  v_snap_at   timestamptz;
begin
  select * into cfg from config where id;

  select * into pl from players where id = p_player_id for update;
  if not found then
    raise exception 'player % not found', p_player_id;
  end if;
  if pl.status <> 'active' then
    raise exception 'account is % — withdrawals are not available', pl.status
      using errcode = 'insufficient_privilege';
  end if;

  select * into m from payment_methods where id = p_method_id;
  if not found or not m.enabled then
    raise exception 'that payment method is not available'
      using errcode = 'invalid_parameter_value';
  end if;
  if m.reversibility = 'reversible' and not cfg.allow_reversible then
    raise exception 'reversible payment methods are currently disabled'
      using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(trim(p_payout_handle), '') = '' then
    raise exception 'a payout handle is required — that is where you get paid'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_gross < coalesce(m.min_amount, cfg.min_amount) then
    raise exception 'minimum withdrawal for % is %', m.name, coalesce(m.min_amount, cfg.min_amount)
      using errcode = 'invalid_parameter_value';
  end if;
  if p_gross > coalesce(m.max_amount, cfg.max_amount) then
    raise exception 'maximum withdrawal for % is %', m.name, coalesce(m.max_amount, cfg.max_amount)
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_open
    from withdraw_requests
   where player_id = p_player_id
     and status in ('pending_unload', 'queued', 'partially_filled', 'filled');
  if v_open >= cfg.max_open_withdraws_per_player then
    raise exception 'you already have % open withdrawals (limit %)', v_open, cfg.max_open_withdraws_per_player
      using errcode = 'invalid_parameter_value';
  end if;

  if cfg.daily_cap_per_player is not null then
    select coalesce(sum(gross_amount), 0) into v_today
      from withdraw_requests
     where player_id = p_player_id
       and status <> 'cancelled'
       and created_at > now() - interval '24 hours';
    if v_today + p_gross > cfg.daily_cap_per_player then
      raise exception 'daily withdrawal cap of % would be exceeded (% used in the last 24h)',
        cfg.daily_cap_per_player, v_today
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  if cfg.require_live_chip_check then
    select taken_at into v_snap_at
      from clubgg_snapshots
     where player_id = p_player_id and currency = m.currency
     order by taken_at desc limit 1;
    if v_snap_at is null
       or v_snap_at < now() - make_interval(secs => cfg.live_chip_check_max_age_seconds) then
      raise exception
        'live ClubGG balance check required: no reading newer than %s. Sync the player''s stack and retry.',
        cfg.live_chip_check_max_age_seconds
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  v_rake := calc_rake(p_gross, 'withdraw');
  v_net  := p_gross - v_rake;

  insert into withdraw_requests (
    player_id, method_id, currency, gross_amount, rake_amount,
    amount, amount_remaining, payout_handle, status, terms
  ) values (
    p_player_id, p_method_id, m.currency, p_gross, v_rake,
    v_net, v_net, trim(p_payout_handle), 'pending_unload',
    jsonb_build_object(
      'rake_withdraw_bps',  cfg.rake_withdraw_bps,
      'rake_withdraw_flat', cfg.rake_withdraw_flat,
      'method_code',        m.code,
      'reversibility',      m.reversibility
    )
  ) returning * into w;

  -- Using a handle is what saves it. Note the withdrawal above already has its
  -- own copy, so this is a convenience record and nothing depends on it.
  perform payout_handle_remember(p_player_id, p_method_id, p_payout_handle);

  v_wallet := balance_of('player_wallet', p_player_id, m.currency);

  if v_wallet >= p_gross then
    w := withdraw_escrow(w.id);
  else
    v_shortfall := p_gross - v_wallet;
    v_chips     := balance_of('player_chips', p_player_id, m.currency);

    if v_chips < v_shortfall then
      raise exception
        'insufficient funds: wallet % + chips % = %, but you asked for %',
        v_wallet, v_chips, v_wallet + v_chips, p_gross
        using errcode = 'insufficient_privilege';
    end if;

    v_order := chip_order_create(
      p_player_id, -v_shortfall, m.currency,
      'withdraw.unload', 'withdraw_request', w.id
    );

    update withdraw_requests set unload_order_id = v_order.id where id = w.id
    returning * into w;
  end if;

  return w;
end $$;
