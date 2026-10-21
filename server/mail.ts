// Password reset email through Resend's HTTP API. The key, the from address and the app's address
// are saved by an admin under Settings, per organisation, so nothing is configured outside the app.

export interface EmailSettings {
  resendApiKey: string;
  /** An address on a domain verified in Resend, optionally with a name: Preshift <rota@example.co.uk>. */
  from: string;
  /** Where people open the app, such as https://rota.example.co.uk. Reset links are built from this, never the request. */
  appUrl: string;
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

/** True when Resend accepted the email. Failures are logged, never shown to the person asking. */
export async function sendMail(settings: EmailSettings, mail: Mail): Promise<boolean> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.resendApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: settings.from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
    });
    if (!res.ok) console.error(`Reset email not sent: Resend returned ${res.status} ${await res.text()}`);
    return res.ok;
  } catch (err) {
    console.error('Reset email not sent:', err);
    return false;
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

function letter(paragraphs: string[], button: { label: string; link: string }, notes: string[]): string {
  const p = (t: string, muted = false) => `<p${muted ? ' style="color:#6d6a63;font-size:14px"' : ''}>${escape(t)}</p>`;
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1c1b19;line-height:1.5;max-width:520px;margin:0 auto;padding:24px">
${paragraphs.map((t) => p(t)).join('\n')}
<p><a href="${escape(button.link)}" style="display:inline-block;background:#1f4d3a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${escape(button.label)}</a></p>
${notes.map((t) => p(t, true)).join('\n')}
<p style="color:#6d6a63;font-size:12px">Preshift, by Preshift and Williams, Stanley &amp; Co.</p>
</body></html>`;
}

/** An invitation: the person sets their own password from the link; nobody else ever knows it. */
export function inviteEmail(to: string, name: string, invitedBy: string, role: string, link: string, days: number): Mail {
  const opening = `${invitedBy} has invited you to Preshift as ${role}.`;
  const setUp = 'Use this link to choose your password and sign in. Choose one only you know: nobody else, not even whoever invited you, will see it.';
  const notes = [
    `The link works once and expires in ${days} days.`,
    'If you were not expecting this, ignore it: nothing happens unless the link is used.',
  ];
  const text = [`Hello ${name},`, '', opening, setUp, '', link, '', ...notes, '', 'Preshift, by Preshift and Williams, Stanley & Co.'].join('\n');
  return { to, subject: `${oneLine(invitedBy)} invited you to Preshift`, text, html: letter([`Hello ${name},`, opening, setUp], { label: 'Choose your password', link }, notes) };
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
