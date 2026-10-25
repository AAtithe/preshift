// TrustID Cloud, for right to work checks done by the person on their own phone. Preshift creates a
// guest link (TrustID emails it to the starter), TrustID checks the documents and calls back when the
// result is ready, and Preshift reads the result and writes it to the person's right to work record.
// Written against the raw API at https://developer.trustid.co.uk: /VPE/session/login/,
// /VPE/guestLink/createGuestLink/ and /VPE/dataAccess/retrieveDocumentContainer/.

type Fetch = typeof fetch;

export interface TrustIdCredentials {
  /** The organisation's TrustID Cloud host, such as https://cloud.trustid.co.uk. */
  base: string;
  apiKey: string;
  username: string;
  password: string;
}

export class TrustIdError extends Error {}

/** What TrustID decided about the person's right to work, read from the finished application. */
export interface TrustIdResult {
  /** Continuous: no follow-up. Time Limited: a follow-up check by followUpDate. Rejected: no right to work shown. */
  status: 'Continuous' | 'Time Limited' | 'Rejected' | 'Unknown';
  followUpDate?: string;
  restrictions?: string;
  /** The document checked, as TrustID names it. */
  document?: string;
  /** TrustID's own overall flag on the application: an alert needs a person to look before relying on it. */
  alert: boolean;
}

interface FlexiblePair {
  m_Item1?: { Name?: string };
  m_Item2?: { FieldValueString?: string | null; FieldValueDate?: string | null };
}

interface Container {
  Id?: string;
  OverallStatus?: string | number;
  ApplicationFlexibleFieldList?: FlexiblePair[];
  Documents?: { DocumentName?: string; DocumentType?: string | number }[];
}

/** TrustID writes dates as /Date(ms+zone)/. */
export function trustIdDate(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const ms = /\/Date\((-?\d+)/.exec(v)?.[1];
  const d = ms ? new Date(Number(ms)) : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

/** Reads the right to work outcome from a finished application's flexible fields. */
export function trustIdResult(container: Container): TrustIdResult {
  const field = (name: string) => container.ApplicationFlexibleFieldList?.find((p) => p.m_Item1?.Name === name)?.m_Item2;
  const raw = field('__RTW_RightToWorkStatus')?.FieldValueString?.trim();
  const status = raw === 'Continuous' || raw === 'Time Limited' || raw === 'Rejected' ? raw : 'Unknown';
  const follow = field('__RTW_FollowUpDate');
  const followUpDate = trustIdDate(follow?.FieldValueDate) ?? trustIdDate(follow?.FieldValueString ?? undefined);
  const restrictions = field('__RTW_WorkRestrictions')?.FieldValueString?.trim() || undefined;
  const document = container.Documents?.find((d) => d.DocumentName)?.DocumentName;
  const alert = container.OverallStatus === 'Alert' || container.OverallStatus === 1;
  return { status, ...(followUpDate ? { followUpDate } : {}), ...(restrictions ? { restrictions } : {}), ...(document ? { document } : {}), alert };
}

export class TrustIdClient {
  private session?: string;
  private readonly deviceId: string;

  constructor(
    private readonly creds: TrustIdCredentials,
    private readonly f: Fetch,
    deviceId = 'preshift',
  ) {
    this.deviceId = deviceId;
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await this.f(`${this.creds.base.replace(/\/+$/, '')}/VPE${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'tid-api-key': this.creds.apiKey },
        body: JSON.stringify({ DeviceId: this.deviceId, ...body }),
      });
    } catch (err) {
      throw new TrustIdError(`Could not reach TrustID: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as { Success?: boolean; Message?: string; SessionExpired?: boolean; AccessDenied?: boolean } & T;
    if (!res.ok || json.Success === false) {
      if (json.AccessDenied || res.status === 401 || res.status === 403) throw new TrustIdError('TrustID refused the sign-in. Check the API key, user name and password.');
      throw new TrustIdError(`TrustID: ${json.Message ?? `returned ${res.status}`}`);
    }
    return json;
  }

  async login(): Promise<void> {
    const r = await this.post<{ SessionId?: string }>('/session/login/', { Username: this.creds.username, Password: this.creds.password });
    if (!r.SessionId) throw new TrustIdError('TrustID did not start a session.');
    this.session = r.SessionId;
  }

  private async withSession<T>(path: string, body: Record<string, unknown>): Promise<T> {
    if (!this.session) await this.login();
    return this.post<T>(path, { SessionId: this.session, ...body });
  }

  /** Sends the person TrustID's invitation to check their documents, calling back to Preshift when done. */
  async createGuestLink(opts: { email: string; name: string; reference: string; callbackUrl: string; callbackToken: string }): Promise<void> {
    await this.withSession('/guestLink/createGuestLink/', {
      Email: opts.email,
      Name: opts.name,
      SendEmail: true,
      ClientApplicationReference: opts.reference,
      ContainerEventCallbackUrl: opts.callbackUrl,
      ContainerEventCallbackHeaders: [{ Header: 'Authorization', Value: `Bearer ${opts.callbackToken}` }],
    });
  }

  async retrieveContainer(containerId: string): Promise<Container> {
    const r = await this.withSession<{ Container?: Container }>('/dataAccess/retrieveDocumentContainer/', { ContainerId: containerId });
    if (!r.Container) throw new TrustIdError('TrustID returned no application.');
    return r.Container;
  }
}
