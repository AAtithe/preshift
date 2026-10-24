// Password reset email through Resend's HTTP API. The key, the from address and the app's address
// are saved by an admin under Settings, per organisation, so nothing is configured outside the app.

export interface EmailSettings {
  resendApiKey: string;
  /** An address on a domain verified in Resend, optionally with a name: Preshift <rota@example.co.uk>. */
  from: string;
  /** Where people open the app, such as https://rota.example.co.uk. Reset links are built from this, never the request. */
  appUrl: string;
  /** Resend's webhook signing secret (whsec_...), once the webhook is set up there. Reports are refused without it. */
  webhookSecret?: string;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export const emailSetting = (orgId: string) => `email:${orgId}`;

export function parseEmailSettings(value: string | null): EmailSettings | null {
  if (!value) return null;
  try {
    const s = JSON.parse(value);
    return typeof s?.resendApiKey === 'string' && typeof s.from === 'string' && typeof s.appUrl === 'string' ? s : null;
  } catch {
    return null;
  }
}

/**
 * Resend's id for the email when Resend accepted it (an empty string if it gave none), else null.
 * Failures are logged, never shown to the person asking.
 */
export async function sendMail(settings: EmailSettings, mail: Mail): Promise<string | null> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.resendApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: settings.from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
    });
    if (!res.ok) {
      console.error(`Email not sent: Resend returned ${res.status} ${await res.text()}`);
      return null;
    }
    const body = (await res.json().catch(() => ({}))) as { id?: unknown };
    return typeof body.id === 'string' ? body.id : '';
  } catch (err) {
    console.error('Email not sent:', err);
    return null;
  }
}

/** Names typed by people go into subject lines: never with a line break in them. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function resetEmail(to: string, link: string, minutes: number): Mail {
  const text = [
    'Someone asked to reset the password for your Preshift account. If it was you, use this link to choose a new one:',
    '',
    link,
    '',
    `The link works once and expires in ${minutes} minutes. Using it signs out every device signed in to your account.`,
    '',
    'If you did not ask for this, ignore this email. Your password has not changed.',
    '',
    'Preshift, by Preshift and Williams, Stanley & Co.',
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1c1b19;line-height:1.5;max-width:520px;margin:0 auto;padding:24px">
<p>Someone asked to reset the password for your Preshift account. If it was you, choose a new one here:</p>
<p><a href="${escape(link)}" style="display:inline-block;background:#1f4d3a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Choose a new password</a></p>
<p style="color:#6d6a63;font-size:14px">The link works once and expires in ${minutes} minutes. Using it signs out every device signed in to your account.</p>
<p style="color:#6d6a63;font-size:14px">If you did not ask for this, ignore this email. Your password has not changed.</p>
<p style="color:#6d6a63;font-size:12px">Preshift, by Preshift and Williams, Stanley &amp; Co.</p>
</body></html>`;
  return { to, subject: 'Reset your Preshift password', text, html };
}

/** A link into the app: on the address saved under Settings, else relative, for the person handing it over. */
export const linkFor = (settings: EmailSettings | null, path: string) => (settings ? `${settings.appUrl}${path}` : path);

function letter(paragraphs: string[], button: { label: string; link: string } | null, notes: string[]): string {
  const p = (t: string, muted = false) => `<p${muted ? ' style="color:#6d6a63;font-size:14px"' : ''}>${escape(t)}</p>`;
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1c1b19;line-height:1.5;max-width:520px;margin:0 auto;padding:24px">
${paragraphs.map((t) => p(t)).join('\n')}
${button ? `<p><a href="${escape(button.link)}" style="display:inline-block;background:#1f4d3a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${escape(button.label)}</a></p>` : ''}
${notes.map((t) => p(t, true)).join('\n')}
<p style="color:#6d6a63;font-size:12px">Preshift, by Preshift and Williams, Stanley &amp; Co.</p>
</body></html>`;
}

/**
 * An invitation: the person sets their own password from the link; nobody else ever knows it.
 * Someone who already signs in to Preshift elsewhere accepts with the password they have.
 */
export function inviteEmail(to: string, name: string, invitedBy: string, role: string, link: string, days: number, existing = false): Mail {
  const opening = `${invitedBy} has invited you to their organisation on Preshift as ${role}.`;
  const setUp = existing
    ? 'You already sign in to Preshift with this email. Use this link and sign in with your usual password to accept; nothing about your other access changes.'
    : 'Use this link to choose your password and sign in. Choose one only you know: nobody else, not even whoever invited you, will see it.';
  const notes = [
    `The link works once and expires in ${days} days.`,
    'If you were not expecting this, ignore it: nothing happens unless the link is used.',
  ];
  const text = [`Hello ${name},`, '', opening, setUp, '', link, '', ...notes, '', 'Preshift, by Preshift and Williams, Stanley & Co.'].join('\n');
  return {
    to,
    subject: `${oneLine(invitedBy)} invited you to Preshift`,
    text,
    html: letter([`Hello ${name},`, opening, setUp], { label: existing ? 'Accept the invitation' : 'Choose your password', link }, notes),
  };
}

/**
 * A staff app invitation: the person sets up their own login on their phone, to clock in at the
 * site and see their own shifts. A new one is also how a forgotten password is reset.
 */
export function staffInviteEmail(to: string, name: string, invitedBy: string, site: string, link: string, days: number, reset = false): Mail {
  const opening = reset
    ? `${invitedBy} has sent you a new link for the Preshift staff app at ${site}. Your old password stops working once you use it.`
    : `${invitedBy} has invited you to the Preshift staff app at ${site}. It is where you clock in and out on your phone, and see your shifts and hours.`;
  const setUp = 'Open this link on your phone and choose a password only you know: nobody else, not even your manager, will see it.';
  const notes = [
    `The link works once and expires in ${days} days.`,
    `If you were not expecting this, ignore it: nothing happens unless the link is used.`,
  ];
  const text = [`Hello ${name},`, '', opening, setUp, '', link, '', ...notes, '', 'Preshift, by Preshift and Williams, Stanley & Co.'].join('\n');
  return {
    to,
    subject: reset ? 'Your new Preshift staff app link' : `${oneLine(invitedBy)} invited you to the Preshift staff app`,
    text,
    html: letter([`Hello ${name},`, opening, setUp], { label: reset ? 'Choose a new password' : 'Set up the staff app', link }, notes),
  };
}

/** A reset made by someone who manages access, rather than asked for by the person. */
export function accessResetEmail(to: string, resetBy: string, link: string, hours: number): Mail {
  const opening = `${resetBy} has reset your Preshift password. Your old password no longer works and every device signed in to your account has been signed out.`;
  const setUp = 'Use this link to choose a new password:';
  const notes = [
    `The link works once and expires in ${hours} hours.`,
    `If you did not expect this, tell ${resetBy} or whoever manages access at your organisation.`,
  ];
  const text = [opening, '', setUp, '', link, '', ...notes, '', 'Preshift, by Preshift and Williams, Stanley & Co.'].join('\n');
  return { to, subject: 'Your Preshift password has been reset', text, html: letter([opening, setUp], { label: 'Choose a new password', link }, notes) };
}

/**
 * News for a member of staff from the staff app: their rota is out, a shift moved, a request was
 * decided. Several from one save arrive as one email. Names and times only: never pay, never a
 * reason for absence, so a shared or forwarded inbox gives nothing away.
 */
export function staffNoticeEmail(to: string, name: string, notices: { title: string; body: string }[], link: string): Mail {
  const lines = notices.flatMap((n) => [n.title, n.body]);
  const subject = notices.length === 1 ? oneLine(notices[0].title) : `${notices.length} updates from your rota`;
  const notes = ['Open the staff app to see your shifts, swap a shift, or ask for time off.'];
  const text = [`Hello ${name},`, '', ...notices.flatMap((n) => [n.title, n.body, '']), link, '', ...notes, '', 'Preshift, by Preshift and Williams, Stanley & Co.'].join('\n');
  return { to, subject, text, html: letter([`Hello ${name},`, ...lines], { label: 'Open the staff app', link }, notes) };
}

/**
 * A manager's morning: what staff have asked for that is theirs to decide, sickness to cover and
 * open shifts still unfilled. Names, dates and times only, never a reason for absence or pay.
 */
export function managerDigestEmail(to: string, name: string, count: number, sections: { heading: string; lines: string[] }[], link: string): Mail {
  const opening = `${count} thing${count === 1 ? '' : 's'} from your team need${count === 1 ? 's' : ''} you today.`;
  const notes = ['Each is checked again against the rota rules when you decide it, and the person is told straight away.', 'Turn this email off on the Staff requests screen.'];
  const text = [
    `Good morning ${name},`, '', opening, '',
    ...sections.flatMap((s) => [s.heading, ...s.lines.map((l) => `- ${l}`), '']),
    link, '', ...notes, '', 'Preshift, by Preshift and Williams, Stanley & Co.',
  ].join('\n');
  const body = sections.flatMap((s) => [s.heading, ...s.lines]);
  return {
    to,
    subject: `Staff requests: ${count} waiting for you`,
    text,
    html: letter([`Good morning ${name},`, opening, ...body], { label: 'Open Staff requests', link }, notes),
  };
}

/** The link that confirms a self sign-up: the person proves the inbox is theirs before any account exists. */
export function signupEmail(to: string, name: string, business: string, link: string, hours: number): Mail {
  const opening = `Thank you for starting a Preshift trial for ${business}.`;
  const setUp = 'Use this link to confirm this is your email, choose your password and open your new organisation. Choose one only you know.';
  const notes = [
    `The link works once and expires in ${hours} hours.`,
    'If you did not ask for this, ignore it: nothing is set up unless the link is used.',
  ];
  const text = [`Hello ${name},`, '', opening, setUp, '', link, '', ...notes, '', 'Preshift, by Preshift and Williams, Stanley & Co.'].join('\n');
  return { to, subject: 'Confirm your email to start Preshift', text, html: letter([`Hello ${name},`, opening, setUp], { label: 'Confirm and choose a password', link }, notes) };
}

/**
 * Someone asked to sign up with an email that already has an account. Told to the inbox, never to
 * the page, so the sign-up form cannot be used to find out who has one.
 */
export function signupExistingEmail(to: string, link: string): Mail {
  const opening = 'Someone asked to start a Preshift trial with this email, which already signs in to Preshift.';
  const setUp = 'If it was you, sign in with your usual password. Forgotten it? Use "Forgot your password?" on the sign-in page.';
  const notes = ['If it was not you, ignore this email. Nothing has changed.'];
  const text = [opening, setUp, '', link, '', ...notes, '', 'Preshift, by Preshift and Williams, Stanley & Co.'].join('\n');
  return { to, subject: 'You already have a Preshift account', text, html: letter([opening, setUp], { label: 'Sign in to Preshift', link }, notes) };
}

/**
 * A message or rota notice from work, for someone who chose email. The text is the message itself,
 * as the app shows it; the button opens the staff app, where the whole thread is and they can reply.
 */
export function noticeEmail(to: string, subject: string, body: string, link: string | null): Mail {
  const paragraphs = body.split('\n').filter((l) => l.trim());
  const notes = ['Choose how messages from work reach you, or turn email off, in the Preshift staff app.'];
  const text = [...paragraphs, '', ...(link ? [link, ''] : []), ...notes, '', 'Preshift, by Preshift and Williams, Stanley & Co.'].join('\n');
  const html = letter(paragraphs, link ? { label: 'Open the staff app', link } : null, notes);
  return { to, subject: oneLine(subject), text, html };
}

/**
 * The daily reminder of pay changes waiting for finance. Carries counts and dates only, never a name
 * or a rate: pay is not for an inbox anyone might glance at. An escalation goes to the owner too.
 */
export function payApprovalEmail(
  to: string,
  name: string,
  digest: { waiting: number; overdue: number; nearCutoff: number; oldestDays: number; cutoff: string },
  link: string,
  escalated: boolean,
): Mail {
  const changes = (n: number) => `${n} pay change${n === 1 ? '' : 's'}`;
  const opening = `${changes(digest.waiting)} ${digest.waiting === 1 ? 'is' : 'are'} waiting for finance to approve. The oldest has waited ${digest.oldestDays} day${digest.oldestDays === 1 ? '' : 's'}.`;
  const points = [
    digest.overdue ? `${changes(digest.overdue)} ${digest.overdue === 1 ? 'is' : 'are'} past the turnaround your organisation set.` : '',
    digest.nearCutoff ? `Hours go to payroll on ${digest.cutoff}. Anything not decided by then misses that pay run, and people are paid on their old rate.` : '',
    escalated ? 'You are copied in as the owner because this has gone past the rule for pay approvals.' : '',
  ].filter(Boolean);
  const notes = ['Pay stays as it is until a change is approved. Nobody approves their own proposal or their own pay.'];
  const text = [`Hello ${name},`, '', opening, ...points, '', link, '', ...notes, '', 'Preshift, by Preshift and Williams, Stanley & Co.'].join('\n');
  return {
    to,
    subject: escalated ? `Overdue: ${changes(digest.waiting)} waiting for approval` : `${changes(digest.waiting)} waiting for approval`,
    text,
    html: letter([`Hello ${name},`, opening, ...points], { label: 'Open pay approvals', link }, notes),
  };
}

/**
 * Someone has not clocked in for a shift that started more than ten minutes ago. Sent to whoever
 * publishes that site's rota, at once, so cover can be found while the shift is still running.
 */
/** The cut call, sent to whoever publishes a site's rota when trading falls behind and early finishes would save real money. */
export function cutCallEmail(to: string, name: string, site: string, opening: string, lines: string[], link: string): Mail {
  const next = 'Open the cut call to see each early finish with what it saves on the week, and apply them in one go. Each person is told at once.';
  const notes = ['Savings are worked on each person\'s whole week, after guaranteed hours. Turn these emails off on the Staff requests screen.'];
  const text = [`Hello ${name},`, '', opening, '', ...lines.map((l) => `- ${l}`), '', next, '', link, '', ...notes, '', 'Preshift, by Preshift and Williams, Stanley & Co.'].join('\n');
  return { to, subject: `Cut call: ${oneLine(site)}`, text, html: letter([`Hello ${name},`, opening, ...lines, next], { label: 'Open the cut call', link }, notes) };
}

/** Trading well ahead of forecast with hours still short on the reforecast: call someone in. */
export function callInEmail(to: string, name: string, site: string, opening: string, link: string): Mail {
  const next = 'Open the cut call to see the short hours by role, then put out an open shift: everyone trained, free and legal to work it is told at once.';
  const notes = ['Turn these emails off on the Staff requests screen.'];
  const text = [`Hello ${name},`, '', opening, next, '', link, '', ...notes, '', 'Preshift, by Preshift and Williams, Stanley & Co.'].join('\n');
  return { to, subject: `Trading ahead: ${oneLine(site)}`, text, html: letter([`Hello ${name},`, opening, next], { label: 'Open the cut call', link }, notes) };
}

export function lateAlertEmail(to: string, name: string, person: string, line: string, minutesLate: number, link: string): Mail {
  const opening = `${person} has not clocked in for ${line}. The shift started ${minutesLate} minutes ago.`;
  const next = 'They have been sent a reminder. If they are not coming, put the rest of the shift out as an open shift from Staff requests: everyone trained, free and legal to work it is told at once.';
  const notes = ['Turn these emails off on the Staff requests screen.'];
  const text = [`Hello ${name},`, '', opening, next, '', link, '', ...notes, '', 'Preshift, by Preshift and Williams, Stanley & Co.'].join('\n');
  return { to, subject: `Not clocked in: ${oneLine(person)}`, text, html: letter([`Hello ${name},`, opening, next], { label: 'Find cover', link }, notes) };
}
