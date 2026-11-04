# Sub-processors

Source for the published page at /subprocessors (`site/subprocessors.html`), Annex 3 to the Data
Processing Agreement. Edit here, then run `npm run legal`. Everything above the first line of three
dashes is internal.

Still to do before this list can be relied on: a signed DPA on file for every provider below, and
each provider's transfer mechanism confirmed (to-do list D7, D8).

---

# Sub-processors

The providers that process personal data for Preshift Rota, as described in our
[Data Processing Agreement](/dpa). We give at least 30 days' notice of a new or replacement
sub-processor by email to account owners and on this page.

## Sub-processors we engage

| Provider | What it does | Data | Location |
| --- | --- | --- | --- |
| Vercel Inc. | Hosting of the website, app, API and scheduled jobs | All Customer Data in transit and processing | United Kingdom (London); US company, support access from the US |
| Neon Inc. | Database | All Customer Data at rest | United Kingdom (London); US company, support access from the US |
| Stripe Payments UK Ltd and Stripe Inc. | Subscription billing | Owner name and email, organisation name, billing address, VAT number, site count. No staff data | UK, EU, US |
| Resend Inc. | Account emails from Preshift itself (sign-up confirmation, support) | Recipient name and email, email content | US |
| Xero Ltd (through Preshift's Xero app) | Posting labour journals the Customer approves | Labour cost by site and role. No per-person lines | UK, US, Australia |
| Apple, Google, Mozilla and Microsoft push services | Delivering encrypted lock-screen notices to the staff app | Encrypted notification content, device push token | US |
| Google LLC (Google Fonts) | Fonts on the website and manager app | Visitor IP address | US |
| Williams, Stanley & Co. Limited | Support, finance features and customer operations as joint venture partner | Owner name and email, billing standing, summary counts; support ticket content; wider access only when the Customer grants it for support | UK |

Where a provider processes personal data outside the UK, we rely on UK adequacy regulations
(including the UK Extension to the EU-US Data Privacy Framework, where the provider is certified),
or the International Data Transfer Agreement or UK Addendum to the EU Standard Contractual Clauses.

## Services that receive no personal data

- Open-Meteo (weather), Ticketmaster (local events), TfL journey planner and postcodes.io (staff
  travel times): site locations and postcodes only.
- Vercel Web Analytics: screen names only, no personal identifiers, no cookies.

## Providers the Customer contracts with directly

These are connected with the Customer's own account or key. They act under the Customer's own
contract and are the Customer's processors, not ours. The Customer should list them in its own
records.

| Provider | Used for |
| --- | --- |
| Anthropic PBC (Claude API, Customer's own key) | AI rota drafting and the assistant, Shifty |
| Anthropic PBC (claude.ai connector, Customer's own account) | Reading Preshift data from the Customer's own Claude conversations |
| Resend Inc. (Customer's own key) | Staff and manager emails from the Customer's organisation |
| Meta Platforms (WhatsApp Business, Customer's own account) | Staff messages by WhatsApp |
| Twilio Inc. (Customer's own account) | Staff messages by text |
| Slack and Microsoft Teams (Customer's own webhooks) | Telling managers a message is waiting. No message content |
| Square (Customer's own token) | Till sales figures |
| Hospitality Rewards | Staff recognition and benefits, where the Customer enables it |

## Our own payroll service

TeamPay payroll is provided by TeamPay Payroll Limited, the same company that provides Preshift
Rota, under a separate agreement and its own data processing terms. It is not a sub-processor of
Preshift Rota. When a Customer connects it, Preshift Rota passes the pay details listed in the
[Privacy Notice](/privacy#staff) to it on the Customer's instruction.

## Contact

Questions about this list: hello@preshift.co.uk
