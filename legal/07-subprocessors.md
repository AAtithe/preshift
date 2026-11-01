# Preshift Rota: Sub-processors

DRAFT v0.1, 1 November 2026. Publish at [preshift.co.uk/subprocessors]. Annex 3 to the Data
Processing Agreement. Every entry marked [confirm] needs its signed DPA, location and transfer
mechanism checked before publication (to-do list D7, D8).

## Sub-processors we engage

| Provider | What it does | Data | Location | Transfer mechanism |
| --- | --- | --- | --- | --- |
| Vercel Inc. | Hosting of the website, app, API and scheduled jobs | All Customer Data in transit and processing | United Kingdom (London); US company, support access from the US | [UK Extension to DPF / IDTA. Confirm] |
| Neon Inc. (Databricks) | Database | All Customer Data at rest | United Kingdom (London); US company, support access from the US | [IDTA / UK Addendum. Confirm] |
| Stripe Payments UK Ltd / Stripe Inc. | Subscription billing | Owner name and email, organisation name, billing address, VAT number, site count. No staff data | UK, EU, US | [UK Extension to DPF. Confirm] |
| [Resend Inc.] | Account emails from Preshift itself (sign-up confirmation, support) | Recipient name and email, email content | US | [Confirm] |
| Xero Ltd (via Preshift's Xero app) | Posting labour journals the Customer approves | Aggregated labour cost by site and role. No per-person lines | UK, US, Australia | [Confirm] |
| Apple, Google, Mozilla, Microsoft push services | Delivering encrypted lock-screen notices to the staff app | Encrypted notification content (names, times, decisions), device push token | US | Content end-to-end encrypted to the device; [confirm] |
| Google Fonts (Google LLC) | Fonts on the website and manager app | Visitor IP address | US | [Remove by self-hosting fonts. To-do list P5] |
| Williams, Stanley & Co. Limited | Support, finance features and customer operations as joint venture partner | Owner name and email, billing standing, summary counts; support ticket content; full access only when the Customer grants it for support | UK | Not applicable |

## Services that receive no personal data

- Open-Meteo (weather), Ticketmaster (local events), TfL journey planner and postcodes.io (staff
  travel times): site location and postcodes only.
- Vercel Web Analytics: page paths only, no personal identifiers, no cookies. [Confirm it is not
  personal data; list as a sub-processor if in doubt.]

## Providers the Customer contracts with directly

Connected with the Customer's own account or key. They act under the Customer's own contract and
are the Customer's processors, not ours. The Customer should list them in its own records.

| Provider | Used for |
| --- | --- |
| Anthropic PBC (Claude API, Customer's own key) | AI rota drafting and the assistant, Shifty |
| Anthropic (claude.ai connector, Customer's own account) | Reading Preshift data from the Customer's own Claude conversations |
| Resend (Customer's own key) | Staff and manager emails from the Customer's organisation |
| Meta Platforms (WhatsApp Business, Customer's own account) | Staff messages by WhatsApp |
| Twilio Inc. (Customer's own account) | Staff messages by text |
| Slack, Microsoft Teams (Customer's own webhooks) | Notifying managers a message is waiting. No message content |
| Square (Customer's own token) | Till sales figures |
| Hospitality Rewards | Staff recognition and benefits, where enabled. [Confirm whether controller or processor] |

## Our own payroll service

TeamPay payroll is provided by TeamPay Payroll Limited, the same company that provides Preshift Rota, under a
separate agreement and its own data processing terms. It is not a sub-processor of Preshift Rota.
When a Customer connects it, Preshift Rota passes the pay details listed in the Privacy Notice to
it on the Customer's instruction.

Last updated: [date]. Subscribe to changes: [privacy@preshift.co.uk].
