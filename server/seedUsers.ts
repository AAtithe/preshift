import type { AccessReview, Membership, User } from '../src/engine/access';
import { sealingKey, seal } from './secrets';
import type { AuthenticatorRecord } from './store';
import { addDays } from '../src/engine/time';

// Demo people for the two London sites. Chosen so the Access overview has real
// things to show: a GM who approves her own hours, a dormant area manager,
// an expired invitation, an auditor
// whose access is about to end, and paired duties held through two roles.

type Grant = [roleId: string, siteIds: string[] | null, extra?: Partial<Membership>];
type Person = [id: string, name: string, email: string, jobTitle: string, audience: User['audience'], grants: Grant[], extra?: Partial<User>];

export const DEMO_OWNER_ID = 'usr_owner';

export function seedUsers(today: string): { users: User[]; reviews: AccessReview[] } {
  const at = (days: number) => `${addDays(today, days)}T09:00:00.000Z`;
  const people: Person[] = [
    [DEMO_OWNER_ID, 'Olivia Grant', 'olivia@marylebonegroup.example', 'Founder', 'operator', [['owner', null]], { mfaEnrolled: true, lastSeenAt: at(0) }],
    ['usr_ops', 'James Whitfield', 'james@marylebonegroup.example', 'Operations Director', 'operator', [['ops_director', null]], { mfaEnrolled: true, lastSeenAt: at(-1) }],
    ['usr_fd', 'Nadia Rahman', 'nadia@marylebonegroup.example', 'Finance Director', 'operator', [['finance_director', null]], { mfaEnrolled: true, lastSeenAt: at(-3) }],
    ['usr_people', 'Kate Morgan', 'kate@marylebonegroup.example', 'People Manager', 'operator', [['people_manager', null], ['assistant_manager', ['mar']]], { mfaEnrolled: true, lastSeenAt: at(-2) }],
    ['usr_area', 'Daniel Price', 'daniel@marylebonegroup.example', 'Area Manager, London', 'operator', [['area_manager', ['mar', 'fitz', 'shd']]], { mfaEnrolled: true, lastSeenAt: at(-118) }],
    ['usr_gm_mar', 'Priya Shah', 'priya@marylebonegroup.example', 'General Manager', 'operator', [['general_manager', ['mar']]], { employeeId: 'mar-1', lastSeenAt: at(0) }],
    ['usr_gm_shd', 'Hannah Lee', 'hannah@marylebonegroup.example', 'General Manager', 'operator', [['general_manager', ['shd']]], { employeeId: 'shd-1', lastSeenAt: at(-1) }],
    ['usr_chef', 'Marco Bianchi', 'marco@marylebonegroup.example', 'Head Chef', 'operator', [['head_chef', ['mar']]], { employeeId: 'mar-2', lastSeenAt: at(-4) }],
    ['usr_sup', 'Grace Mensah', 'grace@marylebonegroup.example', 'Floor Supervisor', 'operator', [['supervisor', ['mar']]], { employeeId: 'mar-7', lastSeenAt: at(-1) }],
    ['usr_am_shd', 'Zoe Hart', 'zoe@marylebonegroup.example', 'Assistant Manager', 'operator', [['assistant_manager', ['shd']]], { status: 'invited', inviteExpiresAt: addDays(today, -2), createdAt: at(-9) }],
    ['usr_viewer', 'Chris Lane', 'chris@marylebonegroup.example', 'Former Ops Analyst', 'operator', [['viewer', null]], { status: 'suspended', lastSeenAt: at(-60) }],
    ['usr_ws_partner', 'Sam Okoro', 'sam.okoro@williamsstanley.example', 'Client Partner', 'ws', [['ws_partner', null]], { mfaEnrolled: true, lastSeenAt: at(-2) }],
    ['usr_ws_ma', 'Leah Turner', 'leah.turner@williamsstanley.example', 'Management Accountant', 'ws', [['ws_accountant', null]], { mfaEnrolled: true, lastSeenAt: at(0) }],
    ['usr_ws_payroll', 'Ravi Desai', 'ravi.desai@williamsstanley.example', 'Payroll Lead', 'ws', [['ws_payroll', null]], { mfaEnrolled: true, lastSeenAt: at(-1) }],
    ['usr_auditor', 'Mark Ellis', 'mark.ellis@auditfirm.example', 'Audit Senior', 'external', [['external_auditor', null, { ends: addDays(today, 18) }]], { mfaEnrolled: true, lastSeenAt: at(-6) }],
  ];

  const users = people.map(([id, name, email, jobTitle, audience, grants, extra]): User => ({
    id,
    name,
    email,
    jobTitle,
    audience,
    status: 'active',
    mfaEnrolled: false,
    createdAt: at(-200),
    activatedAt: extra?.status === 'invited' ? undefined : at(-199),
    ...extra,
    memberships: grants.map(([roleId, siteIds, more], i) => ({
      id: `mem_${id.slice(4)}_${i + 1}`,
      roleId,
      siteIds,
      starts: addDays(today, -200),
      active: true,
      grantedBy: id === DEMO_OWNER_ID ? 'Set-up' : audience === 'ws' ? 'Accounting partner' : 'Olivia Grant',
      grantedAt: at(-200),
      ...more,
    })),
  }));

  const reviews: AccessReview[] = [{ id: 'rev_1', at: at(-104), by: 'Olivia Grant', note: 'Quarterly review. Removed two leavers.', people: 13, attention: 4 }];
  return { users, reviews };
}

/**
 * The demo's enrolled people share one published secret, so anyone trying the demo locally
 * can add it to an authenticator app and sign in as them. Never seeded where a real sealing
 * key is set or in production: the secret is public.
 */
export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

export function demoAuthenticators(users: User[], env: Record<string, string | undefined> = process.env): Record<string, AuthenticatorRecord> {
  if (env.PRESHIFT_SECRET_KEY || env.NODE_ENV === 'production' || env.VERCEL === '1') return {};
  const key = sealingKey(env);
  if (!key) return {};
  return Object.fromEntries(
    users.filter((u) => u.mfaEnrolled).map((u) => [u.id, { id: `demo-${u.id}`, secret: seal(DEMO_TOTP_SECRET, key), enrolledAt: u.activatedAt, lastStep: -1, recovery: [], failures: [] }]),
  );
}
