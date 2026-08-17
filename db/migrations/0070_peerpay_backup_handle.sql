-- ═══════════════════════════════════════════════════════════════════════════
-- 0070 — PeerPay deposit tiers: backup handle lookup
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A deposit handle-tier can now target PeerPay: its `handle` is the sentinel
-- 'PEERPAY' (so club_handle_for returns 'PEERPAY' and the fill's payout_handle
-- becomes 'PEERPAY', which the bots render as a generated checkout link). Each
-- such tier also carries a `backup` handle — a normal direct tag shown when a
-- rail is unavailable inside PeerPay. Shape, extending 0068:
--   handle_tiers = [ {"up_to": 30000, "handle": "@dvbdvb77"},
--                    {"up_to": null,  "handle": "PEERPAY", "backup": "@dvbdvb77"} ]
--
-- club_backup_for picks the SAME tier club_handle_for would (first tier whose
-- up_to >= amount, null last) and returns its backup, or null if none.

create or replace function club_backup_for(p_method uuid, p_amount bigint) returns text
language plpgsql stable as $$
declare
  m payment_methods;
  t jsonb;
begin
  select * into m from payment_methods where id = p_method;
  if m.handle_tiers is null or jsonb_array_length(coalesce(m.handle_tiers, '[]'::jsonb)) = 0 then
    return null;
  end if;
  for t in
    select value from jsonb_array_elements(m.handle_tiers) value
    order by (case when nullif(value->>'up_to', '') is null then null else (value->>'up_to')::bigint end) asc nulls last
  loop
    if (nullif(t->>'up_to', '') is null or p_amount <= (t->>'up_to')::bigint)
       and coalesce(nullif(trim(t->>'handle'), ''), '') <> '' then
      -- this is the tier club_handle_for selects; return its backup if any
      return nullif(trim(t->>'backup'), '');
    end if;
  end loop;
  return null;
end $$;
