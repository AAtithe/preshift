import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * Sends the person TrustID's invitation to check their own documents on their phone. Shown only
 * where the organisation has connected TrustID; the result fills in the right to work check itself.
 */
export function TrustIdCheck({ employeeId }: { employeeId: string }) {
  const [connected, setConnected] = useState(false);
  const [email, setEmail] = useState('');
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => {
    api.get<{ connected: boolean }>('/v1/integrations/trustid').then((s) => setConnected(s.connected)).catch(() => setConnected(false));
  }, []);
  if (!connected) return null;
  const send = async () => {
    try {
      await api.post(`/v1/employees/${employeeId}/right-to-work/trustid`, { email });
      setNote({ text: 'TrustID has emailed them a link. Their result fills in the check here once TrustID has finished.' });
      setEmail('');
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : String(e), bad: true });
    }
  };
  return (
    <div className="form">
      <label>
        Check with TrustID: their email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
      </label>
      <button type="button" disabled={!email.includes('@')} onClick={() => void send()}>Send TrustID check</button>
      {note && <p className={`small ${note.bad ? 'bad-text' : 'good-text'}`}>{note.text}</p>}
    </div>
  );
}
