/**
 * INSTANT PayPal / Cash App → admin group
 * ═══════════════════════════════════════
 *
 * Google Apps Script that lives inside the Gmail inbox and pushes every new
 * PayPal / Cash App "you got money" email to the bot the moment it lands —
 * instead of waiting for a polling cron. Google runs this reliably; the admin
 * group gets the alert within seconds.
 *
 * ── SET UP (about 3 minutes, one time) ──
 * 1. Sign in to the Gmail account that receives the payment emails
 *    (aptupdates1@gmail.com).
 * 2. Go to https://script.google.com  →  New project.
 * 3. Delete the sample code, paste THIS whole file in.
 * 4. Set the two values below:
 *      WEBHOOK — https://aptbot-panel-virid.vercel.app/api/webhooks/email
 *      SECRET  — must equal EMAIL_WEBHOOK_SECRET in your Vercel env (pick any
 *                long random string and set it in BOTH places).
 * 5. Run the function `installTrigger` once (pick it in the toolbar → Run).
 *    Approve the Gmail permission prompt. That schedules it to check every
 *    minute — the tightest interval Apps Script allows, and it fires within
 *    seconds of an email inside that window.
 * 6. Done. New payment emails now reach the admin group on their own.
 *
 * To stop it: run `removeTriggers`.
 */

var WEBHOOK = 'https://aptbot-panel-virid.vercel.app/api/webhooks/email';
var SECRET  = 'CHANGE-ME-to-match-EMAIL_WEBHOOK_SECRET';
var LABEL   = 'apt-forwarded';   // emails we've already pushed get this label

function forwardNewPayments() {
  var label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  // Money-in emails from the two rails, not yet forwarded, last day only.
  var query = '(from:paypal.com OR from:cash@square.com OR from:cash.app) ' +
              '-label:' + LABEL + ' newer_than:1d';
  var threads = GmailApp.search(query, 0, 25);

  for (var i = 0; i < threads.length; i++) {
    var messages = threads[i].getMessages();
    for (var j = 0; j < messages.length; j++) {
      var m = messages[j];
      try {
        UrlFetchApp.fetch(WEBHOOK, {
          method: 'post',
          contentType: 'application/json',
          muteHttpExceptions: true,
          payload: JSON.stringify({
            secret: SECRET,
            from: m.getFrom(),
            subject: m.getSubject(),
            text: m.getPlainBody(),
            messageId: m.getId(),
            date: m.getDate().toISOString(),
          }),
        });
      } catch (e) {
        // Leave it unlabeled so the next run retries it.
        continue;
      }
    }
    threads[i].addLabel(label);   // mark the whole thread pushed
  }
}

function installTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('forwardNewPayments').timeBased().everyMinutes(1).create();
  forwardNewPayments();   // run once now so setup is verified immediately
}

function removeTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'forwardNewPayments') ScriptApp.deleteTrigger(triggers[i]);
  }
}
