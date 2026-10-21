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
