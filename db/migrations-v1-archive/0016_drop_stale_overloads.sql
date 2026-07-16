-- ═══════════════════════════════════════════════════════════════════════════
-- 0016 — Drop the stale player_link overload
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0015 added a p_club_id parameter to player_link. CREATE OR REPLACE FUNCTION
-- only replaces a function whose signature matches EXACTLY, so adding an
-- argument did not replace anything — it created a second overload alongside
-- the old one:
--
--     player_link(uuid, uuid, text)          ← 0010, does NOT assign a club
--     player_link(uuid, uuid, text, uuid)    ← 0015, does
--
-- The panel calls it with three arguments. Both candidates match, because the
-- new one's fourth parameter has a default. Postgres cannot choose:
--
--     ERROR: function player_link(uuid, uuid, text) is not unique
--
-- which surfaced in the panel as "Something went wrong. Nothing was changed."
--
-- The failure was loud, which is why it was cheap. The dangerous version of this
-- bug is the one where the old overload WINS instead of erroring — silently
-- linking players with no club, and putting back the exact registration break
-- 0014/0015 existed to fix.
--
-- Dropping by full signature so it can only ever hit the stale one.
drop function if exists player_link(uuid, uuid, text);

-- Same trap, checked: these were replaced in-place because their signatures
-- never changed, so there is nothing stale to remove. Asserted rather than
-- assumed — an unnoticed duplicate here is a money function chosen at random.
do $$
declare
  n int;
begin
  for n in
    select count(*) from pg_proc p
     where p.proname in ('player_link', 'player_register', 'chip_order_create',
                         'deposit_create', 'withdraw_create', 'fill_release')
     group by p.proname
    having count(*) > 1
  loop
    raise exception 'a money function still has % overloads — resolve before proceeding', n;
  end loop;
end $$;
