// Transactional email through Resend's HTTP API. Configure RESEND_API_KEY and MAIL_FROM
// (an address on a domain verified in Resend). Without a key, development prints the email to
// the console so the flow can be worked on locally; production reports the failure.

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function sendMail(mail: Mail): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) {
    if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
      console.log(`\n[mail not configured] To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n`);
      return true;
    }
    console.error('Email not sent: RESEND_API_KEY or MAIL_FROM is not set');
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
  });
  if (!res.ok) console.error(`Email not sent: Resend returned ${res.status} ${await res.text()}`);
  return res.ok;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function resetEmail(name: string, to: string, link: string, minutes: number): Mail {
  const first = name.split(' ')[0];
  const text = [
    `Hi ${first},`,
    '',
    'Someone asked to reset the password for your Preshift Rota account. If it was you, use this link to choose a new one:',
    '',
    link,
    '',
    `The link works once and expires in ${minutes} minutes. Using it signs out every device signed in to your account.`,
    '',
    'If you did not ask for this, ignore this email. Your password has not changed.',
    '',
    'Preshift Rota, by Preshift and Williams, Stanley & Co.',
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1c1b19;line-height:1.5;max-width:520px;margin:0 auto;padding:24px">
<p>Hi ${escape(first)},</p>
<p>Someone asked to reset the password for your Preshift Rota account. If it was you, choose a new one here:</p>
<p><a href="${escape(link)}" style="display:inline-block;background:#1f4d3a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Choose a new password</a></p>
<p style="color:#6d6a63;font-size:14px">The link works once and expires in ${minutes} minutes. Using it signs out every device signed in to your account.</p>
<p style="color:#6d6a63;font-size:14px">If you did not ask for this, ignore this email. Your password has not changed.</p>
<p style="color:#6d6a63;font-size:12px">Preshift Rota, by Preshift and Williams, Stanley &amp; Co.</p>
</body></html>`;
  return { to, subject: 'Reset your Preshift Rota password', text, html };
}
