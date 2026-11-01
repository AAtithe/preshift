# Preshift Rota: legal to-do list

1 November 2026. Owner column is a proposal; assign before the first review meeting.
Status: every document in `legal/` is a DRAFT. Nothing goes on the website until A1 to A4 are done.

## How to read this

Priority 1 means we are exposed today: the product takes sign-ups without terms, holds employee
health and immigration data, and the website makes promises the contract would contradict.
Priority 2 must be done before the documents are published. Priority 3 is within 90 days of
publication.

## A. Structure: decide first, because every document depends on it

| ID | P | Item | Owner |
| --- | --- | --- | --- |
| A1 | Done | Contracting entity decided (for now): TeamPay Payroll Limited, company number 17197586, incorporated 5 May 2026, registered office c/o Williams Stanley and Co, 144 Great Portland Street, London W1W 6QT. In every draft. Preshift Rota is stated as its trading name | TS |
| A1a | 1 | Confirm the registered office on Companies House today matches the IN01 address above | Stat & Tax |
| A1b | 1 | SIC code. The IN01 gives 78300 (other human resources provision). Selling software needs 62012 (business and domestic software development) or 58290 (other software publishing) added at the next confirmation statement | Stat & Tax |
| A1c | 1 | One company now carries the payroll bureau and the rota software. A claim on either reaches the assets of both. Confirm the insurance covers both activities (S4), and keep the two services on separate agreements and data processing terms, as the drafts now do | TS + broker |
| A1d | 2 | "For now" means the contract will move later. Terms clause 16.2 lets us transfer the Agreement to a group company or successor on notice. Confirm with the solicitor that it is enough to move every customer to a joint venture company without re-signing | Solicitor |
| A1e | 2 | AML supervision. HMRC's guidance treats payroll services as accountancy services under the Money Laundering Regulations 2017. Confirm TeamPay Payroll Limited is supervised in its own name, not relying on WS's ICAEW supervision | TS |
| A2 | 1 | Joint venture agreement between WS and Preshift: ownership of the code and IP, who employs the developers, revenue split, who bears liability and insurance, data sharing between the partners, exit and what happens to customers and data if the JV ends | TS + solicitor |
| A3 | 1 | Data roles between WS and Preshift. WS sees every customer's owner details and billing standing, and support tickets go to WS client partners. Decide whether WS is a sub-processor of the JV, a joint controller, or the operator itself, and document it | TS + solicitor |
| A4 | 1 | Instruct a solicitor (commercial SaaS plus employment data) to review all seven drafts. Budget and deadline | TS |
| A5 | 2 | Register the company with ICO and pay the data protection fee; put the registration number in the Privacy Notice | Finance |
| A6 | 2 | VAT registration for the contracting entity, if new; Stripe account in the right entity's name | Finance |
| A7 | 2 | Trade mark search and filing for PRESHIFT (classes 9, 35, 42) | Solicitor |
| A8 | 2 | Companies (Trading Disclosures) Regulations 2008: website footer, emails and invoices to show registered name, number, place of registration and registered office | Product |

## B. Marketing claims: done 1 November 2026

All rewritten in the site, README, What's new archive, in-app help, the support answers and the
AI rota assistant's instructions. Two further untrue claims were found while checking the code
and fixed: the site said nobody could be rostered outside their availability, and only trained
people could be put on a role. Both are warnings, not blocks (`src/engine/compliance.ts:207,210`).
The table below is kept as the record of what changed and why.

Rule going forward: before any new claim about compliance goes on the site, check whether the
engine blocks it, warns on it, or allows an override. Only a hard block may be described as
"cannot".

The Terms say compliance checks are aids and payroll figures are estimates. The website says the
opposite. An entire agreement clause will not reliably protect us from a misrepresentation claim,
and the ASA can act on the copy regardless of the contract. Rewrite before anything else goes live.

| ID | Claim today | Where | Change to (direction) |
| --- | --- | --- | --- |
| M1 | "Legal by default. Not by luck." | `site/index.html:9, 595, 666` | "Built to keep you legal": checks against the Working Time Regulations, minimum wage and young worker rules |
| M2 | "Blocks anything that breaks UK employment law" | `README.md:9` and copy derived from it | "Blocks shifts that break the rules it checks", and list the rules |
| M3 | "It cannot roster illegally"; "The model can suggest; it cannot break the law" | `site/index.html:695, 1006`; `src/ai/rotaTools.ts:17` | "Every AI draft is checked against the same rules before a manager sees it" |
| M4 | "Costs every shift the way payroll will"; "reconciles to payroll" | `README.md:8, 88`; `site/index.html:501, 966` | "Costs every shift on the same basis as payroll, and shows the difference when payroll runs" |
| M5 | "Nobody without a valid check can be rostered" | `site/index.html:675` | Keep only if the block cannot be overridden; otherwise qualify |
| M6 | "Who keeps the statutory rates up to date? We do" | `site/index.html:1034` | Keep, and add "rates are checked each April; your payroll provider remains responsible for pay" |
| M7 | "Staff data handled properly" | `site/index.html:684` | Link to the Privacy Notice and DPA instead of asserting it |
| M8 | Penalty ceilings and tribunal awards "as a regulator would" price them | `site/index.html:502`; `src/engine/exposure.ts` | Label as illustrative maximums, not advice |

## C. Contract acceptance in the product (Priority 1, after A1 and A4)

| ID | Item | Where |
| --- | --- | --- |
| C1 | Sign-up: required tick box "I agree to the Terms of Service and Data Processing Agreement on behalf of [business], and have read the Privacy Notice", with links. Record user, organisation, version, time and IP | `site/login.html:100`, `server/routes/signup.ts` |
| C2 | Invited managers: same acceptance on first sign-in, recorded | `server/routes/access.ts:178` |
| C3 | Staff app and kiosk: show Staff Terms of Use (`legal/05`) at first sign-in with links to the privacy summary; record acceptance | `staff/`, `src/staff/StaffApp.tsx` |
| C4 | Versioning: store which version each organisation accepted; prompt owners to accept a materially changed version (clause 15) | Server |
| C5 | Footer and app links: replace the four `href="#"` links in `site/index.html:1121`; add the same links to login, demo, walkthrough, the app's Help menu, the staff app and the kiosk | Site, app |
| C6 | Publish the legal pages as static pages under `site/` (terms, privacy, dpa, subprocessors, cookies) once approved | Product |
| C7 | Group Plan Order Form template (over 20 sites): sites, term, fees, 90 day renewal notice, service levels, signatures | Solicitor, from `legal/01` |
| C8 | WS engagement letter: a Preshift Rota schedule for WS clients who receive it within the WS fee, pointing to these Terms and the DPA | WS ops |

## D. Data protection compliance (Priority 1 and 2)

| ID | P | Item | Owner |
| --- | --- | --- | --- |
| D1 | 1 | Data Protection Impact Assessment. Required: large scale employee monitoring, special category health data, location at clock-in, scoring and profiling of staff (Bradford, retention risk, lateness), automated approvals, AI, and workers under 18 | DPO lead + solicitor |
| D2 | 1 | Legitimate interests assessments for our own processing (analytics, product emails, security logs) | DPO lead |
| D3 | 2 | Decide whether a Data Protection Officer is mandatory (large scale special category data processed as a core activity points towards yes). Appoint or record the reasoning | TS |
| D4 | 2 | Record of processing activities (Article 30) for Preshift as controller and as processor. The product already generates customers' registers; we need our own | DPO lead |
| D5 | 2 | Subject access and rights procedure for requests that reach us, including passing staff requests to the employer within 3 Business Days (DPA 7.1) | Support |
| D6 | 1 | Personal data breach procedure: detect, contain, assess, notify customers within 48 hours (DPA 8.1), log every incident. Name the people on call | Product + TS |
| D7 | 1 | Signed DPAs in place with every sub-processor in `legal/07` (Vercel, Neon, Stripe, Resend, Xero). Confirm with TeamPay and Hospitality Rewards whether they are our sub-processor, the customer's, or a controller | Product |
| D8 | 2 | International transfers: for each US provider record the mechanism (UK Extension to DPF certification, or IDTA / UK Addendum) and a transfer risk assessment | Solicitor |
| D9 | 2 | Data protection complaints procedure, as the Data (Use and Access) Act 2025 requires of controllers (Privacy Notice section 7) | Support |
| D10 | 2 | Children's Code: take a view on whether the staff app is "likely to be accessed by children" given school-age workers, and what follows | Solicitor |
| D11 | 2 | Staff training on data protection for everyone with production access; record it | TS |
| D12 | 3 | Help page for customers: appropriate policy document template for health data (the product checks one exists per company, `src/engine/gdpr.ts:601`) | Product |

## P. Product changes the documents depend on

| ID | P | Item | Why |
| --- | --- | --- | --- |
| P1 | Done | Data stored in the UK (London), confirmed by TS. Stated in the Privacy Notice, DPA Annex 2, the sub-processor list and the product's own processor register (`src/engine/gdpr.ts:588`) | Keep a screenshot of the Vercel and Neon region settings on file as evidence |
| P2 | 1 | Complete the in-product processor list: it omits Stripe, Xero, Square, Vercel Analytics, Google Fonts, push services and the feed APIs | Customers' own registers are generated from it (`src/engine/gdpr.ts:366-594`) and are wrong today |
| P3 | 2 | Customer exit: an export of all data for an organisation, and deletion of the organisation after the period in Terms 10.5 | The Terms promise both; neither exists |
| P4 | 2 | Run retention automatically (nightly cron) rather than only when an administrator presses Apply | Retention periods are meaningless if nobody presses the button (`server/routes/privacy.ts:174`) |
| P5 | 2 | Self-host the fonts and remove Google Fonts | Removes a US transfer of every visitor's IP; removes a sub-processor |
| P6 | 2 | Analytics opt-out in Settings, Privacy | Condition of the cookieless analytics exemption |
| P7 | 3 | Warning on HR notes and documents not to store criminal records data; confirm the AI assistant warns managers not to type health details | Criminal offence data needs an Article 10 condition we have not planned for |
| P8 | 2 | Automated features: make sure automatic approval of open shift claims and "first legal yes" are off by default, explained on screen, and that staff can ask for a manager review | Article 22 and the Data (Use and Access) Act 2025 safeguards; Terms 4.6 says they are off unless switched on |
| P9 | 3 | Staff app: privacy summary screen and link to the employer's notice (template `legal/04`) | Staff currently see no privacy information at all |

## S. Security and insurance

| ID | P | Item |
| --- | --- | --- |
| S1 | 2 | Cyber Essentials Plus certification. Larger hospitality groups will ask for it in procurement |
| S2 | 2 | Independent penetration test before publication; annually after |
| S3 | 2 | Key management: document who holds `PRESHIFT_DOCUMENT_KEY` and `PRESHIFT_SECRET_KEY`, rotation, and recovery |
| S4 | 1 | Insurance. WS professional indemnity (£3m, per the WS terms) covers accountancy services and almost certainly does not cover a software product. Obtain technology errors and omissions and cyber cover in the contracting entity, then set the caps in Terms 13.5 and 13.6 to match |
| S5 | 3 | Business continuity: backup restore test, and what customers are told if the Service is unavailable on rota publishing day |

## W. Williams, Stanley & Co.'s own terms: found while adapting them

These are not Preshift items, but they came up from reading the June 2025 WS Standard Terms of
Business, and they matter more than anything above because every WS client is on them.

| ID | Issue |
| --- | --- |
| W1 | Clause 7 (data protection) points to a policy, not a contract. WS processes client payroll and employee data and needs Article 28 processor terms (or controller terms where it acts as payroll agent) in the engagement. The DPA in `legal/03` is a starting point |
| W2 | Cross-references are broken: clause 12 refers to clauses 3, 12.4, 12.5, 12.6 and 12.9 that do not exist under those numbers; clause 5(b)(ii) refers to "clause 2(a)"; clause 15 refers to "clause 3" and "clause 8". A court resolves ambiguity against the drafter |
| W3 | Statute names are wrong: "Supply of Goods Act 1982" should be the Supply of Goods and Services Act 1982; "Agreements (Rights of Third Parties) Act 1999" should be the Contracts (Rights of Third Parties) Act 1999 |
| W4 | The header gives the Witherslack address; invoices and other documents use Newcombe House, London. Confirm the registered office and use one address |
| W5 | Clause 12(d) excludes from the cap the Customer's liability under "clauses 4 and our data processing policy", which reads as a drafting slip |
| W6 | One client TOB on SharePoint ("Leonid TOB") states an end date of 31/11/26, a date that does not exist |
| W7 | The commissions clause 4(e) lets WS keep commissions; check it against the ICAEW Code of Ethics disclosure requirements |

## Document register

| File | What | Publish at |
| --- | --- | --- |
| `legal/01-terms-of-service.md` | Customer contract | /terms |
| `legal/02-privacy-notice.md` | Our privacy notice, with a staff summary | /privacy |
| `legal/03-data-processing-agreement.md` | Article 28 DPA with annexes | /dpa |
| `legal/04-staff-privacy-notice-template.md` | Insert for customers' employee notices | In-app Help |
| `legal/05-staff-terms-of-use.md` | Staff app first sign-in screen | Staff app |
| `legal/06-cookie-notice.md` | Cookies and storage | /cookies |
| `legal/07-subprocessors.md` | Sub-processor list | /subprocessors |
| To write | Group Plan Order Form (C7), DPIA (D1), breach procedure (D6), records of processing (D4), JV agreement (A2) | Internal |
