-- ═══════════════════════════════════════════════════════════════════════════
-- 0031 — Venmo/Zelle: toggle "pay our handle" vs "wait for a withdrawal"
-- ═══════════════════════════════════════════════════════════════════════════
--
-- For a P2P method, club_handle is the backstop a depositor pays when nobody is
-- queued. Admins want to switch that off from time to time (accept only real P2P
-- matches). Turning it off just nulls club_handle; backstop_handle remembers the
-- value so it can be turned back on without re-typing. And when it's off, an
-- unmatched P2P deposit gets a friendly "please wait for a withdrawal" message
-- instead of a blunt error.

alter table payment_methods add column if not exists backstop_handle text;
-- Seed backstop_handle from any handle already set.
update payment_methods set backstop_handle = club_handle where backstop_handle is null and club_handle is not null;

create or replace function deposit_match(p_deposit_id uuid)
returns setof fills
language plpgsql as $$
declare
  cfg config;
  d   deposit_requests;
  m   payment_methods;
  w   record;
  f   fills;
  v_remaining bigint;
  v_slice     bigint;
  v_rake      bigint;
  v_lock_exp  timestamptz;
begin
  select * into cfg from config where id;

  select * into d from deposit_requests where id = p_deposit_id for update;
  if not found then
    raise exception 'deposit % not found', p_deposit_id;
  end if;
  if d.status <> 'matching' then
    raise exception 'deposit % is % — matching has already run', d.id, d.status
      using errcode = 'invalid_parameter_value';
  end if;

  select * into m from payment_methods where id = d.method_id;

  v_lock_exp  := now() + make_interval(secs => cfg.match_timeout_seconds);
  v_remaining := d.amount;

  if m.settlement = 'p2p' then
    loop
      exit when v_remaining <= 0;

      select id, player_id, payout_handle, amount_remaining
        into w
        from withdraw_requests
       where method_id = d.method_id
         and currency  = d.currency
         and status in ('queued', 'partially_filled')
         and amount_remaining > 0
         and player_id <> d.player_id
       order by created_at, id
         for update skip locked
       limit 1;

      exit when not found;

      v_slice := least(v_remaining, w.amount_remaining);
      v_rake  := calc_rake(v_slice, 'deposit');

      insert into fills (
        deposit_id, withdraw_id, method_id, currency,
        amount, rake_amount, credit_amount, gross_to_send,
        payout_handle, status, lock_expires_at
      ) values (
        d.id, w.id, d.method_id, d.currency,
        v_slice, v_rake, v_slice - v_rake, calc_gross_to_send(v_slice, d.method_id),
        w.payout_handle,
        'locked', v_lock_exp
      ) returning * into f;

      update withdraw_requests
         set amount_remaining = amount_remaining - v_slice,
             status = (case when amount_remaining - v_slice = 0 then 'filled'
                            else 'partially_filled' end)::withdraw_status
       where id = w.id;

      v_remaining := v_remaining - v_slice;
      return next f;
    end loop;
  end if;

  -- ── The club takes the rest ──
  if v_remaining > 0 then
    if m.club_handle is null then
      if m.settlement = 'p2p' then
        raise exception
          'no one''s available to take a % payment right now — please wait until someone requests a cash out, then try again, or use another method.',
          m.name using errcode = 'invalid_parameter_value';
      else
        raise exception
          'we can''t take that right now — % isn''t set up to receive it. Try another method or a smaller amount.',
          m.name using errcode = 'invalid_parameter_value';
      end if;
    end if;

    v_rake := calc_rake(v_remaining, 'deposit');

    insert into fills (
      deposit_id, withdraw_id, method_id, currency,
      amount, rake_amount, credit_amount, gross_to_send,
      payout_handle, status, lock_expires_at
    ) values (
      d.id, null, d.method_id, d.currency,
      v_remaining, v_rake, v_remaining - v_rake,
      calc_gross_to_send(v_remaining, d.method_id),
      m.club_handle, 'locked', v_lock_exp
    ) returning * into f;

    v_remaining := 0;
    return next f;
  end if;

  update deposit_requests set status = 'awaiting_payment' where id = d.id;
  return;
end $$;

-- ─── Admin toggle: set the handle, or switch to "wait for a withdrawal" ──────
create or replace function p2p_set_backstop(
  p_code   text,
  p_handle text,   -- null/empty = wait mode (no direct deposits)
  p_admin  uuid
) returns payment_methods
language plpgsql as $$
declare m payment_methods;
begin
  update payment_methods
     set backstop_handle = coalesce(nullif(trim(p_handle), ''), backstop_handle),
         club_handle     = nullif(trim(p_handle), '')
   where code = p_code
  returning * into m;
  perform audit(p_admin, 'method.backstop', 'payment_method', m.id,
    jsonb_build_object('code', p_code, 'direct', p_handle is not null and trim(p_handle) <> ''));
  return m;
end $$;
