-- ═══════════════════════════════════════════════════════════════════════════
-- 0129 — alert staff when two accounts cash out to the same tag
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One person farming sign-up bonuses with several accounts tends to give the same
-- Zelle / Venmo / wallet every time (one player had 5 accounts on one Zelle). When
-- a cash-out (or a split cash-out's second method) names a tag already used by a
-- different account, post a `fraud.shared_tag` card to the admins listing every
-- account on it.
--
-- Tags are compared normalised (normalize_payout_handle): a phone number however
-- it's typed, and case / leading @ or $ / spaces ignored. shared_tag_alerts keeps
-- how many accounts we last reported per tag, so a card goes out only when a NEW
-- account joins a tag — not on every repeat cash-out. Tags already shared when this
-- shipped are seeded as known (reported to the owner separately), so turning it on
-- doesn't flood the group. Never blocks a cash-out: any error is swallowed.

create or replace function normalize_payout_handle(h text)
returns text language sql immutable as $$
  select case
    -- a phone number however it's written: (713) 960-2549, +1 713..., 713.960.2549
    when h !~ '[A-Za-z@]' and regexp_replace(h, '[^0-9]', '', 'g') ~ '^1?[0-9]{10}$'
      then right(regexp_replace(h, '[^0-9]', '', 'g'), 10)
    -- anything else: case, a leading @ / $, and spaces don't make a different tag
    else regexp_replace(regexp_replace(lower(btrim(h)), '^[@$]+', ''), '[[:space:]]', '', 'g')
  end
$$;

create index if not exists withdraw_requests_handle_key
  on withdraw_requests (normalize_payout_handle(payout_handle));
create index if not exists withdraw_split_methods_handle_key
  on withdraw_split_methods (normalize_payout_handle(payout_handle));

create table if not exists shared_tag_alerts (
  handle_key  text primary key,
  accounts    int not null,
  updated_at  timestamptz not null default now()
);

create index if not exists payout_handles_handle_key
  on payout_handles (normalize_payout_handle(handle));

-- Every (account, tag) a player has cashed out to or saved.
create or replace view v_player_payout_tags as
  select w.player_id, w.method_id, normalize_payout_handle(w.payout_handle) as handle_key, w.created_at
    from withdraw_requests w where w.payout_handle is not null
  union all
  select w.player_id, sm.method_id, normalize_payout_handle(sm.payout_handle), w.created_at
    from withdraw_split_methods sm join withdraw_requests w on w.id = sm.withdraw_id
   where sm.payout_handle is not null
  union all
  select ph.player_id, ph.method_id, normalize_payout_handle(ph.handle), ph.created_at
    from payout_handles ph where ph.handle is not null;

create or replace function shared_tag_check(p_withdraw_id uuid, p_method_id uuid, p_handle text)
returns void language plpgsql as $$
declare
  w        withdraw_requests;
  v_key    text := normalize_payout_handle(p_handle);
  v_count  int;
  v_seen   int;
  v_others text;
  v_name   text;
  v_method text;
  -- Telegram Markdown: escape what would break a name / tag
  esc constant text := '([_*`\[])';
begin
  if v_key is null or length(v_key) < 5 then return; end if;
  select * into w from withdraw_requests where id = p_withdraw_id;
  if not found then return; end if;
  if exists (select 1 from players where id = w.player_id and is_house) then return; end if;

  select count(distinct t.player_id) into v_count
    from v_player_payout_tags t join players p on p.id = t.player_id
   where t.handle_key = v_key and not coalesce(p.is_house, false);
  if v_count < 2 then return; end if;

  select accounts into v_seen from shared_tag_alerts where handle_key = v_key;
  if v_seen is not null and v_count <= v_seen then return; end if;
  insert into shared_tag_alerts (handle_key, accounts) values (v_key, v_count)
  on conflict (handle_key) do update set accounts = excluded.accounts, updated_at = now();

  select regexp_replace(coalesce(display_name, telegram_username, 'Unnamed'), esc, '\\\1', 'g')
    into v_name from players where id = w.player_id;
  select name into v_method from payment_methods where id = p_method_id;

  select string_agg(format('• %s — joined %s', regexp_replace(coalesce(p.display_name, p.telegram_username, 'Unnamed'), esc, '\\\1', 'g'),
                           to_char(p.created_at, 'FMDD Mon YYYY')), E'\n' order by p.created_at)
    into v_others
    from players p
   where p.id <> w.player_id and not coalesce(p.is_house, false)
     and p.id in (select player_id from v_player_payout_tags where handle_key = v_key);

  perform notify_admins('fraud.shared_tag', 'withdraw_request', w.id, jsonb_build_object(
    'handle', p_handle, 'handle_key', v_key, 'accounts', v_count, 'player_id', w.player_id,
    'text', format(E'🚩 *Same cash-out tag on %s accounts*\n*%s* just asked to cash out %s by %s to `%s`.\n\nThat tag is also on:\n%s\n\nCould be one person with several accounts (bonus abuse) — check before paying.',
                   v_count, v_name, to_char(w.amount / 100.0, 'FM$999,999,990.00'), coalesce(v_method, 'cash-out'),
                   replace(p_handle, '`', ''), v_others)));
exception when others then
  raise warning 'shared_tag_check failed for %: %', p_withdraw_id, sqlerrm;
end $$;

create or replace function trg_withdraw_shared_tag() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'withdraw_requests' then
    perform shared_tag_check(new.id, new.method_id, new.payout_handle);
  else
    perform shared_tag_check(new.withdraw_id, new.method_id, new.payout_handle);
  end if;
  return new;
end $$;

drop trigger if exists withdraw_shared_tag on withdraw_requests;
create trigger withdraw_shared_tag
  after insert or update of payout_handle on withdraw_requests
  for each row execute function trg_withdraw_shared_tag();

drop trigger if exists withdraw_split_shared_tag on withdraw_split_methods;
create trigger withdraw_split_shared_tag
  after insert or update of payout_handle on withdraw_split_methods
  for each row execute function trg_withdraw_shared_tag();

-- Tags already shared today are known — only NEW sharing alerts from here on.
insert into shared_tag_alerts (handle_key, accounts)
select t.handle_key, count(distinct t.player_id)
  from v_player_payout_tags t join players p on p.id = t.player_id
 where length(t.handle_key) >= 5 and not coalesce(p.is_house, false)
 group by t.handle_key having count(distinct t.player_id) > 1
on conflict (handle_key) do nothing;
