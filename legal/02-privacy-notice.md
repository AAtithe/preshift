# Privacy Notice

Source for the published page at /privacy (`site/privacy.html`). Edit here, then run
`npm run legal` to rebuild the page; `server/legal.test.ts` fails if the two drift. Everything above
the first line of three dashes is internal and is not published.

Structure follows the ICO's privacy notice checklist (UK GDPR Articles 13 and 14). Replaces the WS
Privacy Policy (2019). Solicitor review is still outstanding (to-do list A4).

---

# Privacy Notice

## 1. Who we are

Preshift Rota is provided by TeamPay Payroll Limited, company number 17197586, registered office
c/o Williams Stanley and Co, 144 Great Portland Street, London W1W 6QT ("Preshift", "we", "us").
Preshift Rota is a joint venture between Williams, Stanley & Co. Limited (company number 05860058)
and Preshift.

Contact for anything in this notice: hello@preshift.co.uk, or write to us at the address above.

If we also run your payroll through our TeamPay payroll service, that service has its own privacy
notice and data processing terms. This notice covers Preshift Rota only.

## 2. Two roles: read the one that applies to you

**If you work for a business that uses Preshift Rota** (you have the staff app, a kiosk PIN, a
clock-in card or tag, or receive rota messages): your employer decides what data about you goes
into Preshift and why. Your employer is the controller and we are its processor. Your employer's
own privacy notice is the main one for you. [Section 9](#staff) summarises what Preshift holds so
you know what to ask about.

**If you are a customer, a manager with a Preshift login, someone who signs up, books a demo, or
visits our website**: we are the controller for the data in sections 3 to 8.

## 3. What we collect and why (where we are controller)

| Who | What | Why | Lawful basis |
| --- | --- | --- | --- |
| Website visitors | IP address, received by our host Vercel to serve the site, and by Google Fonts where the page loads its fonts | Show the site | Legitimate interests (running a website) |
| People who start the demo or sign up | A keyed hash of the IP address, counted per day | Stop abuse of the free demo and sign-up | Legitimate interests (security) |
| People who sign up | Business name, your name, work email, and the version and time of the Terms you accepted | Create your account, confirm your email, keep a record of the contract | Contract (taking steps at your request); legal obligation (contract records) |
| Account owners and managers | Name, email, job title, roles and sites, password (stored as a one-way hash), authenticator secret (encrypted), sign-in sessions, an audit trail of actions, API key usage | Provide and secure your login; show who changed what | Contract; legitimate interests (security, audit) |
| Account owners and billing contacts | Name, email, organisation, billing address, VAT number, subscription status, invoices. Card details go straight to Stripe; we never see them | Take payment; issue VAT invoices | Contract; legal obligation (tax records) |
| Anyone who contacts support | Your message, contact details, the ticket history | Answer you; improve the Service | Legitimate interests |
| Managers in the web app | Screens viewed (the screen name only, never a site, week or personal identifier), device type and approximate country, through Vercel Web Analytics, without cookies | Understand which features are used, so we build what operators need | Legitimate interests; you can opt out on the [Cookies](/cookies) page |
| Customers' owners | Name and work email, used to tell you about changes to the Service and new features | Product updates | Legitimate interests (existing customer); unsubscribe in every email |
| Anyone | Information we must keep or disclose by law | Tax, accounting, legal claims, regulators | Legal obligation; legitimate interests (defending claims) |

We do not sell personal data, and we do not use it for advertising.

## 4. Who we share it with

- **Our service providers** (sub-processors), listed in full with their locations on our
  [sub-processors page](/subprocessors): hosting (Vercel), database (Neon), payments (Stripe),
  email delivery for account emails (Resend), web push services (Apple, Google, Mozilla,
  Microsoft) and fonts (Google Fonts).
- **Williams, Stanley & Co.**, our joint venture partner, which provides support and finance
  features. It sees the owner's name and email, billing standing and summary counts for each
  customer, and handles support requests from its own clients.
- **Professional advisers** (lawyers, accountants, insurers) under duties of confidentiality.
- **A buyer or successor** of the Service, under equivalent protections.
- **Regulators, HMRC, the police or courts** where the law requires.

## 5. Where your data is, and international transfers

All Preshift Rota data is stored in the United Kingdom (London). Some providers are based in, or
may access data from, the United States: Stripe (billing), our account email provider, web push
services, Google Fonts, and our hosting and database providers for support. Where personal data
leaves the UK we rely on UK adequacy regulations (including the UK Extension to the EU-US Data
Privacy Framework, where the provider is certified), or the International Data Transfer Agreement
or UK Addendum to the EU Standard Contractual Clauses.

## 6. How long we keep it

| Data | How long |
| --- | --- |
| Account and login data | While your organisation's account is open, then up to 90 days |
| Record of the Terms you accepted | 6 years after the account closes |
| Billing and invoices | 6 years after the end of the financial year they relate to |
| Support tickets | 2 years after closing |
| Email delivery log (no content) | 180 days |
| API key usage log | 13 months |
| Demo sandboxes | Deleted at midnight UK time the same day |
| Keyed hash of IP address for demo and sign-up limits | Up to 12 months, as a daily count not linked to any account |
| Audit trail | The most recent 5,000 events per organisation |

## 7. Your rights

You have the right to: be informed; access your data; have it corrected; have it erased; restrict
its use; data portability; object to processing based on legitimate interests (including
analytics and product emails); and not to be subject to a decision based solely on automated
processing that has legal or similarly significant effects without the safeguards the law
requires.

To use any right, email hello@preshift.co.uk. We will reply within one month (extendable by two
months for complex requests, in which case we will tell you why). We may need to confirm your
identity. There is normally no charge.

If you are unhappy with how we have handled your data, tell us first and we will investigate and
reply within 30 days. You also have the right to complain to the Information Commissioner's
Office: ico.org.uk, 0303 123 1113.

## 8. Security

Data is encrypted in transit and at rest. Sensitive documents (right to work copies, fit notes, HR
files) are encrypted with a separate key held outside the database, and every view is logged.
Passwords are stored only as one-way hashes. Two-factor authentication is required for access to
pay, payroll, journals, settings and access control. Access by our own staff is limited to what
support needs and is logged.

## 9. If you are a member of staff at a business using Preshift {#staff}

Your employer is the controller. Depending on what your employer switches on, Preshift may hold:

- **About you and your work**: name, date of birth, contact details, roles, pay rate or salary,
  contracted hours, start date, availability, leave and holiday, rota notes.
- **Clocking**: when and how you clocked in and out (card, kiosk PIN, phone tag or app). If your
  employer uses location clocking, your phone's position at the moment of clocking only, kept for
  3 months unless your employer sets a different period.
- **HR records**: NI number, address, emergency contact, contract and handbook signatures
  (including the IP address and device used to sign), training, reviews, and any formal cases.
- **Right to work**: check date, document type and expiry, and an encrypted copy of the document.
- **Health**: sickness absence, its reason, and fit notes (encrypted). Your employer must have a
  specific legal condition and a policy document to hold these.
- **Messages**: work messages with your managers, read receipts, and your choice of WhatsApp, text
  or email with your consent.
- **Wellbeing**: weekly pulse answers are stored without your name and shown only when at least
  five people at a site have answered.
- **Pay figures** passed to your employer's payroll provider: name, date of birth, pay basis,
  hours, premiums and tips. Preshift does not hold bank details.
- **Scores**: some employers use absence scores (Bradford factor), shift fairness counts,
  lateness and no-show counts, and a retention risk indicator. These are information for
  managers. Ask your employer how it uses them; you may ask for any decision about you to be
  reviewed by a person.

**AI.** If your employer uses Preshift's AI assistant, your name, roles, pay rate, age,
availability, leave, hours, and lateness and no-show counts may be sent to Anthropic (the provider
of Claude, based in the US) to draft a rota, under your employer's own agreement with Anthropic. A
manager reviews every draft before it is used. Your NI number, address, absence reasons, HR notes
and bank or medical details are not sent.

**Your rights** are exercised with your employer. You can see and download your own data in the
staff app. If you contact us, we will pass your request to your employer promptly.

## 10. Changes to this notice

We will update this notice when what we do changes, and tell account owners of material changes by
email and in the app. The version and date are at the top.
