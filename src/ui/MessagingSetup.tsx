import { useEffect, useState, type FormEvent } from 'react';
import type { Site } from '../engine/types';
import { api, ApiError } from './api';

interface TeamHook {
  siteId: string;
  siteName: string;
  host: string;
}

interface View {
  whatsapp: { set: boolean; phoneNumberId?: string; tokenEndsWith?: string; template?: string; language?: string; webhook?: { url: string; verifyToken: string } };
  sms: { set: boolean; accountSid?: string; from?: string; tokenEndsWith?: string };
  slack: TeamHook[];
  teams: TeamHook[];
  emailWhenUnset: boolean;
  appUrl: string | null;
}

const problem = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/**
 * Where messages to staff and notices to managers go beyond Preshift. Staff choose and agree to
 * WhatsApp or text themselves in the staff app; this only connects what they may choose from.
 */
export function MessagingSetup({ sites }: { sites: Site[] }) {
  const [view, setView] = useState<View | null>(null);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const [wa, setWa] = useState({ phoneNumberId: '', accessToken: '', appSecret: '', template: '', language: 'en_GB' });
  const [sms, setSms] = useState({ accountSid: '', authToken: '', from: '' });
  const [team, setTeam] = useState({ channel: 'slack', siteId: '*', url: '' });

  useEffect(() => {
    api
      .get<View>('/v1/settings/messaging')
      .then((v) => {
        setView(v);
        if (v.whatsapp.set) setWa((f) => ({ ...f, phoneNumberId: v.whatsapp.phoneNumberId ?? '', template: v.whatsapp.template ?? '', language: v.whatsapp.language ?? 'en_GB' }));
        if (v.sms.set) setSms((f) => ({ ...f, accountSid: v.sms.accountSid ?? '', from: v.sms.from ?? '' }));
      })
      .catch((e) => setMessage({ text: problem(e), bad: true }));
  }, []);

  async function act(done: string, fn: () => Promise<View>) {
    try {
      setView(await fn());
      setMessage({ text: done });
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  }

  const saveWa = (e: FormEvent) => {
    e.preventDefault();
    void act('WhatsApp saved. Set up the webhook in Meta with the address and verify token below so replies come back.', () => api.put('/v1/settings/messaging/whatsapp', wa)).then(() => setWa((f) => ({ ...f, accessToken: '', appSecret: '' })));
  };
  const saveSms = (e: FormEvent) => {
    e.preventDefault();
    void act('Text messages saved.', () => api.put('/v1/settings/messaging/sms', sms)).then(() => setSms((f) => ({ ...f, authToken: '' })));
  };
  const saveTeam = (e: FormEvent) => {
    e.preventDefault();
    void act('Saved. Use Test to check it posts.', () => api.put('/v1/settings/messaging/team', team)).then(() => setTeam((f) => ({ ...f, url: '' })));
  };
  const test = async (channel: string, siteId: string) => {
    try {
      await api.post('/v1/settings/messaging/test', { channel, siteId });
      setMessage({ text: 'Test posted. Check the channel.' });
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  };

  return (
    <section className="settings-card">
      <h2>Messaging channels</h2>
      <p className="muted small">
        Every message, announcement and rota notice is kept in Preshift, one thread per person, with who read it. These channels only carry it to people's
        phones. Staff choose WhatsApp, text or email in the staff app and agree to it there, with their own number; nobody can choose for them. Slack and
        Teams tell managers that something needs them, with a link, and never carry what staff wrote: staff write about sickness and childcare, and a
        team channel is read by people who have no need to know.
      </p>
      {message && <p className={`small ${message.bad ? 'bad-text' : 'muted'}`}>{message.text}</p>}

      <h3 className="settings-sub">WhatsApp</h3>
      <p className="small">{view ? (view.whatsapp.set ? `On. Number ID ${view.whatsapp.phoneNumberId}, token ending ${view.whatsapp.tokenEndsWith}, template ${view.whatsapp.template}.` : 'Off.') : '...'}</p>
      <p className="muted small">
        Through Meta's WhatsApp Business Cloud API, from your own business number. WhatsApp lets a business send free text only within 24 hours of the
        person's last message; otherwise it must be an approved template. Create a Utility template with one body variable, such as "Message from work: {'{{1}}'}",
        and enter its name here. Preshift uses free text when it can and the template when it must.
      </p>
      <form className="settings-form" onSubmit={saveWa}>
        <label>Phone number ID <input required inputMode="numeric" value={wa.phoneNumberId} onChange={(e) => setWa({ ...wa, phoneNumberId: e.target.value })} /></label>
        <label>{view?.whatsapp.set ? 'Replace access token (blank keeps it)' : 'Access token'} <input type="password" autoComplete="off" required={!view?.whatsapp.set} value={wa.accessToken} onChange={(e) => setWa({ ...wa, accessToken: e.target.value })} /></label>
        <label>{view?.whatsapp.set ? 'Replace app secret (blank keeps it)' : 'App secret'} <input type="password" autoComplete="off" required={!view?.whatsapp.set} value={wa.appSecret} onChange={(e) => setWa({ ...wa, appSecret: e.target.value })} /></label>
        <label>Template name <input required placeholder="work_message" value={wa.template} onChange={(e) => setWa({ ...wa, template: e.target.value })} /></label>
        <label>Language <input required value={wa.language} onChange={(e) => setWa({ ...wa, language: e.target.value })} /></label>
        <button className="primary" type="submit">Save</button>
        {view?.whatsapp.set && <button type="button" className="danger" onClick={() => confirm('Turn off WhatsApp? Staff who chose it get messages in the app only.') && void act('WhatsApp is off.', () => api.del('/v1/settings/messaging/whatsapp'))}>Turn off</button>}
      </form>
      {view?.whatsapp.set && view.whatsapp.webhook && (
        <p className="muted small">
          Replies: in your Meta app, under WhatsApp, Configuration, set the callback URL to <code>{view.whatsapp.webhook.url}</code>, the verify token to{' '}
          <code>{view.whatsapp.webhook.verifyToken}</code>, and subscribe to messages. {view.appUrl ? '' : 'Set up email first, so Preshift knows its own address.'}
        </p>
      )}

      <h3 className="settings-sub">Text messages</h3>
      <p className="small">{view ? (view.sms.set ? `On. From ${view.sms.from}, Twilio account ${view.sms.accountSid}, token ending ${view.sms.tokenEndsWith}.` : 'Off.') : '...'}</p>
      <p className="muted small">Through Twilio, for staff without WhatsApp or who prefer a text. Texts go one way: replies come by WhatsApp or in the staff app.</p>
      <form className="settings-form" onSubmit={saveSms}>
        <label>Account SID <input required placeholder="AC..." value={sms.accountSid} onChange={(e) => setSms({ ...sms, accountSid: e.target.value })} /></label>
        <label>{view?.sms.set ? 'Replace auth token (blank keeps it)' : 'Auth token'} <input type="password" autoComplete="off" required={!view?.sms.set} value={sms.authToken} onChange={(e) => setSms({ ...sms, authToken: e.target.value })} /></label>
        <label>From <input required placeholder="+447700900000 or Preshift" value={sms.from} onChange={(e) => setSms({ ...sms, from: e.target.value })} /></label>
        <button className="primary" type="submit">Save</button>
        {view?.sms.set && <button type="button" className="danger" onClick={() => confirm('Turn off text messages?') && void act('Text messages are off.', () => api.del('/v1/settings/messaging/sms'))}>Turn off</button>}
      </form>

      <h3 className="settings-sub">Slack and Teams, for managers</h3>
      <p className="muted small">
        Posts to a channel when the rota is published, a member of staff writes in, or an announcement goes out. In Slack, add an incoming webhook to the
        channel. In Teams, use the Workflows app in the channel: "Post to a channel when a webhook request is received". One channel for every site, or one per site.
      </p>
      {view && (view.slack.length > 0 || view.teams.length > 0) && (
        <table className="table">
          <thead><tr><th>Channel</th><th>Site</th><th>Posts to</th><th /></tr></thead>
          <tbody>
            {(['slack', 'teams'] as const).flatMap((c) =>
              view[c].map((h) => (
                <tr key={`${c}-${h.siteId}`}>
                  <td>{c === 'slack' ? 'Slack' : 'Teams'}</td>
                  <td>{h.siteName}</td>
                  <td className="muted small">{h.host}</td>
                  <td>
                    <button className="link small" onClick={() => void test(c, h.siteId)}>Test</button>{' '}
                    <button className="link small" onClick={() => void act('Removed.', () => api.put('/v1/settings/messaging/team', { channel: c, siteId: h.siteId, url: null }))}>Remove</button>
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}
      <form className="settings-form" onSubmit={saveTeam}>
        <label>Channel
          <select value={team.channel} onChange={(e) => setTeam({ ...team, channel: e.target.value })}>
            <option value="slack">Slack</option>
            <option value="teams">Microsoft Teams</option>
          </select>
        </label>
        <label>For
          <select value={team.siteId} onChange={(e) => setTeam({ ...team, siteId: e.target.value })}>
            <option value="*">Every site without its own</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label>Webhook address <input type="url" required value={team.url} onChange={(e) => setTeam({ ...team, url: e.target.value })} /></label>
        <button className="primary" type="submit">Add</button>
      </form>

      <h3 className="settings-sub">Staff who have not chosen</h3>
      <label className="small">
        <input
          type="checkbox"
          checked={!!view?.emailWhenUnset}
          onChange={(e) => void act('Saved.', () => api.put('/v1/settings/messaging/defaults', { emailWhenUnset: e.target.checked }))}
        />{' '}
        Email rota notices and messages to staff who have not chosen a channel, once email is set up above. Off, they get them in the staff app only.
      </label>
    </section>
  );
}
