# Ledgerly — Gmail Spend Intelligence

Ledgerly is a read-only spending intelligence application that connects to Gmail with Google OAuth, finds transaction-related emails, extracts financial facts, and turns them into an understandable spending profile.

The application is designed for receipts, order confirmations, invoices, bills, payment confirmations, card/UPI debit notifications, subscription renewals, refunds, cashback, credit notes, and transfer notifications.

It presents net spending, highest-spend categories, highest-spend merchants, recurring payments, spending trends, upcoming payments, unusual transactions, short explanations, and links back to the relevant Gmail thread where possible.

The application never sends, deletes, labels, or modifies Gmail messages.

## Live application and repository

- Live application: <https://gmailspendintelligence.onrender.com>
- Source repository: <https://github.com/MoAftaab/gmailspendintelligence>
- Demo mode is available from the landing page and uses synthetic data only.

## Features

### Gmail connection

The user clicks **Connect Gmail** and completes a server-side Google OAuth 2.0 flow. The application requests only:

```text
https://www.googleapis.com/auth/gmail.readonly
```

The scope is intentionally read-only. Gmail access tokens stay on the server session and are never sent to the browser or the LLM provider.

The OAuth flow includes:

1. A random state value to protect against forged callbacks.
2. `select_account consent` so users can choose the intended Gmail account.
3. A secure, HTTP-only session cookie in production.
4. Explicit proxy configuration for Render HTTPS termination.
5. Refresh-token support from Google’s offline OAuth flow.
6. Token revocation when the user clicks **Disconnect**.

### Transaction discovery

Ledgerly first uses Gmail search to reduce the number of messages that need to be downloaded. The search looks for transaction-related terms including:

```text
receipt invoice payment subscription bill order confirmation charged
statement UPI debited credited card bank transaction renewal autopay EMI
refund cashback
```

Spam and trash are excluded. The lookback period and message cap are configurable through environment variables.

Each matching message is fetched with Gmail’s `users.messages.get` endpoint and parsed locally.

### Automatic extraction and categorization

The deterministic parser extracts:

- Merchant or sender name
- Amount and currency
- Received date
- Possible due or renewal date
- Subject and snippet
- Gmail message/thread identifiers
- Transaction type
- Initial category
- Recurring-payment hints

The category set is:

- Travel
- Food & dining
- Shopping
- Software & subscriptions
- Utilities & bills
- Health
- Finance
- Other

Categorization is automatic. The user does not need to select a category manually.

The parser also rejects likely promotional newsletters. For example, an email containing “exclusive 50% discount”, “limited time”, and “unsubscribe” is not treated as a purchase unless it contains strong payment evidence such as a receipt, invoice, charge, or amount paid.

### Spending profile

The analytics layer calculates:

- Net total: expenses minus refunds; income and transfers do not inflate spending.
- Category totals and ranking.
- Merchant totals and ranking.
- Monthly spending trend.
- Repeated merchants and recurring-payment candidates.
- Upcoming payments detected within the next 45 days.
- Unusual payments with an explanation.

Transactions are deduplicated by Gmail `sourceMessageId` before analytics are calculated.

### Unusual-payment detection

The rules are deterministic and explainable:

- A new merchant is flagged when the payment is high value relative to the scan.
- A repeated merchant is flagged when the latest payment is materially above its historical median.
- Refunds, income, and transfers are excluded from expense anomaly comparisons.

The UI explains the reason, for example:

```text
₹35,000 to a merchant not seen elsewhere in the scan.
```

or:

```text
₹6,899 is materially above this merchant’s typical ₹2,499 payment.
```

### Traceability

Each Gmail transaction keeps its source message ID, thread ID, subject, sender, and Gmail thread URL.

Source links are shown only when:

- The finding is tied to a specific transaction, such as an alert or upcoming payment.
- The URL is an HTTPS Gmail URL on `mail.google.com`.

Aggregate totals, category summaries, and trend narratives are not linked to an arbitrary email. This prevents a summary such as “Net total” from incorrectly opening an unrelated promotional message.

### Loading experience

The dashboard uses two stages:

1. A fast deterministic scan renders the verified baseline data.
2. AI extraction and narrative generation run afterward.

The interface shows a scan overlay, rotating progress messages, elapsed time, and a separate AI-generation timer so users know that processing is still active.

## AI and agent components

Ledgerly uses an optional LLM component, but it does not use an autonomous agent. There is no tool-using agent making decisions or taking actions in Gmail. The system is a controlled extraction and narrative pipeline.

### Why an LLM is used

Email formats vary widely. A deterministic parser works well for obvious receipts but struggles with different merchant templates, natural-language confirmations, multiple amounts, ambiguous categories, renewal wording, and refund/transfer language.

The LLM improves classification and creates readable explanations while the deterministic analytics layer remains the source of truth for totals and thresholds.

### LLM architecture

The LLM is accessed through an OpenAI-compatible Chat Completions API. The current deployment uses CodeCraft with a configurable model such as `gpt-5.6-luna`.

```text
Gmail message
    ↓
Local parser and promotional-email filter
    ↓
Candidate email batch
    ↓
LLM structured extraction
    ↓
Validated transaction objects
    ↓
Deterministic analytics
    ↓
Verified analytics JSON
    ↓
LLM grounded narrative generation
    ↓
Dashboard insight cards
```

The LLM receives only the candidate email content needed for extraction and the calculated analytics needed for narrative generation. The API key is read only by the server and is never embedded in frontend JavaScript.

### Structured output and safeguards

LLM extraction uses strict JSON schemas. Results are accepted only when they satisfy validation rules:

- The model marks the email as financial.
- The confidence score is at least `0.6`.
- The amount is positive.
- The email passes the local financial-evidence filter.
- The category is one of the supported categories.
- The transaction type is one of `expense`, `refund`, `income`, or `transfer`.
- Dates are parsed and normalized.

Narrative generation receives verified analytics rather than raw untrusted instructions. Narrative transaction IDs are checked against real transaction IDs before the frontend can use them for traceability.

If the LLM is unavailable, times out, returns invalid JSON, or rejects the request, the application keeps the deterministic scan and displays an AI-unavailable state instead of failing the entire dashboard.

## High-level architecture

```text
Browser
  │
  ├── GET /auth/google
  │       └── Google OAuth consent
  │               └── GET /auth/google/callback
  │
  ├── GET /api/config
  │
  ├── GET /api/insights?fast=1
  │       ├── Gmail search and message fetch
  │       ├── Local parser
  │       └── Deterministic analytics
  │
  ├── GET /api/insights?ai=1
  │       ├── Batched LLM extraction
  │       ├── Deterministic analytics again
  │       └── Grounded LLM narratives
  │
  ├── GET /api/insights?sync=1
  │       ├── Gmail history check
  │       └── Full filtered scan only when changes exist
  │
  └── POST /auth/logout
          └── Google token revocation and session destruction

server.js
  ├── Express routes and session boundary
  ├── OAuth callback validation
  ├── Friendly error mapping
  └── Scan and AI result caching in the session

src/gmail.js
  ├── OAuth client creation
  ├── Gmail search
  ├── Message retrieval with retry/backoff
  └── Gmail history cursor checks

src/parser.js
  ├── MIME part traversal
  ├── HTML-to-text conversion
  ├── Amount/currency/date extraction
  ├── Promotional-email filtering
  └── Baseline categories and transaction types

src/analytics.js
  ├── Validation and deduplication
  ├── Totals and ranking
  ├── Monthly trends
  ├── Recurring payments
  └── Upcoming and unusual-payment logic

src/llm.js
  ├── OpenAI-compatible provider client
  ├── Strict extraction schemas
  ├── Batch extraction
  └── Grounded narrative generation

public/
  ├── index.html: dashboard structure
  ├── styles.css: responsive visual design and animations
  └── app.js: fetches API data and renders charts/cards/tables
```

The main modules are intentionally separated so Gmail access, parsing, analytics, AI, and presentation can be tested or replaced independently.

## Important technical decisions

### Read-only Gmail permissions

The app requests `gmail.readonly` only. It does not request send, modify, label, delete, or full mailbox-management permissions.

The Gmail scope is restricted by Google because it can read email content. A public launch therefore requires careful privacy disclosures and Google OAuth verification.

### Search before message retrieval

The app does not download every mailbox message. It starts with Gmail’s search query and then fetches details only for matching message IDs. This reduces latency, memory use, and Gmail quota consumption.

The local defaults are:

```env
GMAIL_LOOKBACK_YEARS=2
GMAIL_MAX_MESSAGES=25
OPENAI_MAX_EMAILS=10
```

These values are intentionally conservative for an MVP. They can be increased after quota and performance testing.

### Gmail rate limits and retries

Gmail API calls can return rate-limit or quota errors. Message-detail requests are fetched in batches of five. Retryable `429` responses and `403 rateLimitExceeded` responses use exponential backoff before failing.

The application also:

- Avoids LLM work during the first fast dashboard response.
- Caches the Gmail scan in the session.
- Checks Gmail `historyId` on explicit refresh.
- Avoids a full scan when no message additions or deletions occurred.
- Rebuilds the scan when the Gmail history cursor has expired.
- Reports common quota, permission, and expired-token errors in user-friendly language.

The current MVP does not use Gmail push notifications. For near-real-time updates, add `users.watch` and Google Cloud Pub/Sub.

### Handling refunds, income, and transfers

Transaction type is classified as:

```text
expense | refund | income | transfer
```

Refunds reduce net spending. Income and transfers are retained for traceability but do not count as spending. Expense-only merchant and category rankings prevent salary, bank transfers, and refunds from distorting the spending profile.

### Currency handling

Common currency spellings such as `INR`, `Rs`, `rupees`, `$`, `USD`, `€`, and `£` are normalized for display.

The MVP does not perform foreign-exchange conversion. If a mailbox contains multiple currencies, totals should be interpreted as grouped raw amounts rather than a converted single-currency balance. A production version should add currency grouping or exchange-rate conversion before presenting a combined total.

### Security boundaries

- OAuth client secrets and LLM API keys are server-only environment variables.
- Session cookies are HTTP-only and secure in production.
- OAuth state is checked on every callback.
- User-controlled email text is HTML-escaped before rendering.
- Source links are restricted to Gmail HTTPS URLs.
- Raw email bodies are not returned to the browser.
- Gmail tokens are revoked when the user disconnects.
- The app does not modify Gmail data.

## Run locally

### Requirements

- Node.js 20 or newer
- npm
- A Google Cloud project
- Gmail API enabled
- OAuth 2.0 Web Application credentials
- An external OAuth test user while the Google app is in Testing mode
- Optional: an OpenAI-compatible LLM provider

### Google Cloud setup

1. Create or select a Google Cloud project.
2. Enable the Gmail API.
3. Open **Google Auth Platform**.
4. Configure an External audience.
5. Add the Gmail read-only scope:

   ```text
   https://www.googleapis.com/auth/gmail.readonly
   ```

6. Add your Gmail account under **Test users**.
7. Create an OAuth 2.0 client of type **Web application**.
8. Add this authorized redirect URI:

   ```text
   http://localhost:3000/auth/google/callback
   ```

### Environment setup

Copy the example file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Fill in at least:

```env
PORT=3000
NODE_ENV=development
SESSION_SECRET=use-a-long-random-secret
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
```

To enable AI enrichment, configure the provider on the server:

```env
OPENAI_API_KEY=your-server-side-provider-key
OPENAI_BASE_URL=https://codecraftapi.com/v1
OPENAI_MODEL=gpt-5.6-luna
OPENAI_MAX_EMAILS=10
```

Never commit `.env`. It is ignored by Git. Do not place Google secrets or LLM keys in `public/` files.

### Install and run

```bash
npm install
npm run dev
```

The development server runs at:

```text
http://localhost:3000
```

For a normal start without file watching:

```bash
npm start
```

### Test

Run the automated tests:

```bash
npm test
```

The tests cover totals and rankings, repeated-payment anomaly detection, upcoming payments, currency normalization, duplicate removal, promotional-newsletter rejection, and refund/transfer handling.

Useful manual checks:

```text
GET http://localhost:3000/healthz
GET http://localhost:3000/api/config
```

Use **Explore with sample data** to validate the UI and narrative flow without connecting a real mailbox.

## API routes

| Route | Purpose |
|---|---|
| `GET /healthz` | Deployment health check |
| `GET /api/config` | Reports whether Gmail/LLM are configured and whether the current session is connected |
| `GET /auth/google` | Starts Google OAuth |
| `GET /auth/google/callback` | Validates the OAuth callback and stores Gmail tokens in the session |
| `POST /auth/logout` | Revokes Gmail credentials and destroys the session |
| `GET /api/insights?fast=1` | Returns the fast deterministic dashboard |
| `GET /api/insights?ai=1` | Runs LLM extraction and grounded narrative generation |
| `GET /api/insights?sync=1` | Checks Gmail history and refreshes when mailbox changes exist |
| `GET /api/insights?demo=1` | Returns synthetic sample data |
| `GET /api/transactions` | Returns cached detected transactions for a connected session |

## Deployment

The current application is deployed as a Render Node web service from the `master` branch.

### Render configuration

Use:

```text
Build command: npm install
Start command: npm start
Health check: /healthz
Runtime: Node
```

Production environment variables must include:

```env
NODE_ENV=production
SESSION_SECRET=a-long-production-secret
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://your-domain.com/auth/google/callback
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://codecraftapi.com/v1
OPENAI_MODEL=gpt-5.6-luna
```

The exact production callback URL must be added in the Google OAuth client configuration. If a custom domain is added later, update both the Render environment variable and Google’s authorized redirect URI.

### Production OAuth verification

For public access, configure:

- A verified application domain
- Public homepage
- Public privacy policy
- Public terms of service
- Support and developer contact information
- Exact production redirect URI
- Scope justification
- Demo video for reviewers

Because `gmail.readonly` is a restricted Gmail scope, Google may require restricted-scope verification and a security assessment before unrestricted public access.

## Production hardening and future improvements

The current MVP keeps OAuth tokens, scan results, and history cursors in the Express in-memory session. This is convenient for local development and a single-instance demo, but it is not sufficient for a robust multi-instance production service.

Before a larger public launch:

1. Replace the default session store with a persistent encrypted store such as Redis.
2. Encrypt OAuth tokens at rest.
3. Add explicit account-data deletion controls.
4. Store only the minimum transaction fields needed for the product.
5. Document the LLM provider’s retention and training policy.
6. Add per-user request throttling and abuse prevention.
7. Add structured request IDs and redacted production logs.
8. Add automated health, OAuth, Gmail quota, and LLM-provider monitoring.
9. Add Gmail `users.watch` plus Pub/Sub for mailbox notifications.
10. Add cursor-based pagination or a background job for larger mailboxes.
11. Add currency conversion or currency-separated totals.
12. Add stronger merchant normalization for aliases and payment processors.
13. Add attachment/PDF invoice extraction only if it is required and separately reviewed for privacy.

The MVP deliberately favors a fast, explainable, read-only workflow over silently importing an entire mailbox or making irreversible changes.

## Privacy and data handling summary

Ledgerly processes sensitive financial email data. A real public deployment must provide a privacy policy that accurately describes:

- What Gmail data is read.
- Why it is read.
- Which fields are extracted.
- Whether email content is sent to an external AI provider.
- How long data and tokens are retained.
- How users disconnect and request deletion.
- How security incidents are handled.

The application should only be deployed publicly after these disclosures match the actual provider configuration and Google’s Gmail user-data requirements.
