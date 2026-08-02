-- ═══════════════════════════════════════════════════════════════════════════
-- 0054 — Remember which message each admin card became, so we can EDIT it
-- ═══════════════════════════════════════════════════════════════════════════
--
-- When a player cancels a cash-out we want to update the admin's Claim card in
-- place (→ "cancelled", or a lower amount) instead of posting a new message and
-- flooding the group. To edit a message you need its id; the notifier now writes
-- back the chat + message id of every card it delivers.
alter table notifications
  add column if not exists sent_chat_id    text,
  add column if not exists sent_message_id text;
