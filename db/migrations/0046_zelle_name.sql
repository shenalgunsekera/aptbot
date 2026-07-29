-- ═══════════════════════════════════════════════════════════════════════════
-- 0046 — Zelle needs the recipient's NAME, not just the handle
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Zelle transfers are addressed by phone/email AND the account holder's name, so
-- we collect the name when a player sets up (or edits) a Zelle payout, store it
-- on the payout handle, and snapshot it onto every fill that pays that handle so
-- the sender and admins always see both.

alter table payout_handles add column if not exists holder_name text;
alter table fills          add column if not exists payout_name text;

-- Remember a payout destination, now optionally with the holder's name (Zelle).
create or replace function payout_handle_remember(
  p_player_id uuid,
  p_method_id uuid,
  p_handle    text,
  p_label     text default null,
  p_name      text default null
) returns payout_handles
language plpgsql as $$
declare h payout_handles;
begin
  insert into payout_handles (player_id, method_id, handle, label, holder_name, use_count, last_used_at)
  values (p_player_id, p_method_id, trim(p_handle), p_label, nullif(trim(p_name), ''), 1, now())
  on conflict (player_id, method_id, handle) do update
    set use_count    = payout_handles.use_count + 1,
        last_used_at = now(),
        label        = coalesce(excluded.label, payout_handles.label),
        holder_name  = coalesce(excluded.holder_name, payout_handles.holder_name)
  returning * into h;
  return h;
end $$;

-- Snapshot the holder name onto each fill at creation, from the saved handle.
-- A trigger keeps the sensitive matching function (deposit_create) untouched.
create or replace function fill_set_payout_name() returns trigger
language plpgsql as $$
begin
  if new.payout_name is null and new.payout_handle is not null then
    new.payout_name := (
      select holder_name from payout_handles
       where handle = new.payout_handle and method_id = new.method_id and holder_name is not null
       order by last_used_at desc nulls last limit 1);
  end if;
  return new;
end $$;

drop trigger if exists fill_payout_name on fills;
create trigger fill_payout_name before insert on fills
  for each row execute function fill_set_payout_name();
