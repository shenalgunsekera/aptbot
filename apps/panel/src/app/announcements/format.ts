/**
 * Preview formatting for the announcement composer. Mirrors the bot's
 * announcementHtml (apps/bot/src/notifier.ts) so the preview shows exactly what
 * players get. Escapes FIRST, so typed text can never inject markup; links are
 * limited to http(s).
 *
 * Markup: **bold**  _italic_  __underline__  ~~strike~~  ||spoiler||  `code`  [text](https://link)
 */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function previewHtml(body: string): string {
  let t = esc(body);
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, txt: string, url: string) => `<a href="${url.replace(/"/g, '&quot;')}" target="_blank" rel="noreferrer">${txt}</a>`);
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*\n](?:[^*]*?[^*\n])?)\*\*/g, '<b>$1</b>');
  t = t.replace(/__([^_\n](?:[^_]*?[^_\n])?)__/g, '<u>$1</u>');
  t = t.replace(/~~([^~\n](?:[^~]*?[^~\n])?)~~/g, '<s>$1</s>');
  t = t.replace(/\|\|([^|\n](?:[^|]*?[^|\n])?)\|\|/g, '<span class="ann-spoiler">$1</span>');
  t = t.replace(/(^|[\s(>])_([^_\n]+?)_(?=$|[\s).,!?:;<])/gm, '$1<i>$2</i>');
  return t;
}

/** Visible character count (markup stripped) — what Telegram measures a caption by. */
export function plainLength(title: string, body: string): number {
  const strip = (s: string) => s
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/\*\*|__|~~|\|\||`/g, '')
    .replace(/(^|\s)_([^_\n]+?)_/g, '$1$2');
  return (title.trim() ? strip(title.trim()).length + 2 : 0) + strip(body).length;
}
