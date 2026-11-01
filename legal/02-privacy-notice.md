# Preshift Rota: Privacy Notice

DRAFT v0.1, 1 November 2026. For publication at [preshift.co.uk/privacy] after solicitor review.
Square brackets are facts or decisions still to confirm.

Source: replaces the WS Privacy Policy (2019), which predates UK GDPR as retained law, the Data
(Use and Access) Act 2025, and anything Preshift does. Structure follows the ICO's privacy notice
checklist (UK GDPR Articles 13 and 14).

---

## 1. Who we are

Preshift Rota is provided by [CONTRACTING ENTITY], company number [NUMBER], registered office
[ADDRESS] ("Preshift", "we", "us"). We are registered with the Information Commissioner's Office
under number [ICO REGISTRATION NUMBER]. Preshift Rota is a joint venture between Williams,
Stanley & Co. Limited (company number 05860058) and Preshift.

Contact for anything in this notice: [privacy@preshift.co.uk], or write to [ADDRESS].
[If a Data Protection Officer is appointed, name and contact here. See to-do list D3.]

## 2. Two roles: read the one that applies to you

**If you work for a business that uses Preshift Rota** (you have the staff app, a kiosk PIN, a
clock-in card or tag, or receive rota messages): your employer decides what data about you goes
into Preshift and why. Your employer is the controller and we are its processor. Your employer's
own privacy notice is the main one for you; section 9 below summarises what Preshift holds so
you know what to ask about.

**If you are a customer, a manager with a Preshift login, someone who signs up, books a demo, or
visits our website**: we are the controller for the data in sections 3 to 8.

## 3. What we collect and why (where we are controller)

| Who | What | Why | Lawful basis |
| --- | --- | --- | --- |
| Website visitors | IP address (passed to Google Fonts [until self-hosted] and our host Vercel); a keyed hash of the IP address for one day when you start the demo or sign up | Show the site; stop abuse of the free demo and sign-up | Legitimate interests (running a secure website) |
| People who sign up | Business name, your name, work email | Create your account, confirm your email | Contract (taking steps at your request) |
| Account owners and managers | Name, email, job title, roles and sites, password (stored as a one-way hash), authenticator secret (encrypted), sign-in sessions, an audit trail of actions, API key usage | Provide and secure your login; show who changed what | Contract; legitimate interests (security, audit) |
| Account owners and billing contacts | Name, email, organisation, billing address, VAT number, subscription status, invoices. Card details go straight to Stripe; we never see them | Take payment; issue VAT invoices | Contract; legal obligation (tax records) |
| Anyone who contacts support | Your message, contact details, the ticket history | Answer you; improve the Service | Legitimate interests |
| Managers in the web app | Pages viewed (path only, no site, week or personal identifiers), device type, approximate country, via Vercel Web Analytics, without cookies | Understand which features are used, so we build what operators need | Legitimate interests; you can opt out (see Cookies notice) |
| Customers' owners | Name and work email, used to tell you about changes to the Service and new features | Product updates | Legitimate interests (existing customer, soft opt-in); unsubscribe in every email |
| Anyone | Information we must keep or disclose by law | Tax, accounting, legal claims, regulators | Legal obligation; legitimate interests (defending claims) |

We do not sell personal data, and we do not use it for advertising.

## 4. Who we share it with

- **Our service providers** (sub-processors), listed in full with their locations at
  [preshift.co.uk/subprocessors] (`legal/07`): hosting (Vercel), database (Neon), payments
  (Stripe), email delivery for account emails ([Resend]), web push services (Apple, Google,
  Mozilla, Microsoft) and fonts (Google Fonts).
- **Williams, Stanley & Co.**, our joint venture partner, which provides support and finance
  features. It sees the owner's name and email, billing standing and summary counts for each
  customer, and handles support requests from its own clients.
- **Professional advisers** (lawyers, accountants, insurers) under duties of confidentiality.
- **A buyer or successor** of the Service, under equivalent protections.
- **Regulators, HMRC, the police or courts** where the law requires.

## 5. International transfers

Some providers are based in, or access data from, the United States. Where personal data leaves
the UK we rely on UK adequacy regulations (including the UK Extension to the EU-US Data Privacy
Framework, where the provider is certified), or the International Data Transfer Agreement or UK
Addendum to the EU Standard Contractual Clauses, with a transfer risk assessment. Details per
provider are in the sub-processor list. [Confirm each provider's mechanism: to-do list D8.]

## 6. How long we keep it

| Data | How long |
| --- | --- |
| Account and login data | While your organisation's account is open, then [90 days] |
| Billing and invoices | 6 years after the end of the financial year they relate to (tax law) |
| Support tickets | 2 years after closing |
| Email delivery log (no content) | 180 days |
| API key usage log | 13 months |
| Demo sandboxes | Deleted at midnight UK time the same day |
| Daily hashed IP address for demo and sign-up limits | [24 hours] |
| Audit trail | Most recent 5,000 events per organisation, [or 6 years if longer is agreed] |

## 7. Your rights

You have the right to: be informed; access your data; have it corrected; have it erased; restrict
its use; data portability; object to processing based on legitimate interests (including
analytics and product emails); and not to be subject to a decision based solely on automated
processing that has legal or similarly significant effects without the safeguards the law
requires.

To use any right, email [privacy@preshift.co.uk]. We will reply within one month (extendable by
two months for complex requests, in which case we will tell you why). We may need to confirm your
identity. There is normally no charge.

If you are unhappy, please tell us first and we will investigate and reply [within 30 days].
You also have the right to complain to the Information Commissioner's Office: ico.org.uk,
0303 123 1113.

## 8. Security

Data is encrypted in transit (TLS) and at rest. Sensitive documents (right to work copies, fit
notes, HR files) are encrypted with a separate key held outside the database, and every view is
logged. Passwords are stored only as one-way hashes. Two-factor authentication is required for
access to pay, payroll, journals, settings and access control. Access by our own staff is limited
to what support needs and is logged.

## 9. If you are a member of staff at a business using Preshift

Your employer is the controller. Depending on what your employer switches on, Preshift may hold:

- **About you and your work**: name, date of birth, contact details, roles, pay rate or salary,
  contracted hours, start date, availability, leave and holiday, rota notes.
- **Clocking**: when and how you clocked in and out (card, kiosk PIN, phone tag or app). If your
  employer uses location clocking, your phone's position at the moment of clocking only, kept for
  [3 months].
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
availability, leave, hours, and lateness and no-show counts may be sent to Anthropic (the
provider of Claude) to draft a rota. A manager reviews every draft before it is used. Your NI
number, address, absence reasons, HR notes and bank or medical details are not sent.

**Your rights** are exercised with your employer. You can see and download your own data in the
staff app. If you contact us, we will pass your request to your employer promptly.

## 10. Changes to this notice

We will update this notice when what we do changes, and tell account owners of material changes
by email and in the app. Version and date are at the top.
