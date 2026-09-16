# Ledgerly — Gmail Spend Intelligence

Ledgerly is a read-only Gmail spending dashboard. It asks the user for permission through Google OAuth, searches transaction-like email, extracts basic transaction fields, and presents totals, category and merchant breakdowns, recurring payments, trends, unusual-payment explanations, and links back to source emails.

## Run locally

Requirements: Node.js 20+ and a Google Cloud project.

1. Enable the **Gmail API** in Google Cloud Console.
2. Configure the OAuth consent screen. Add the scope `https://www.googleapis.com/auth/gmail.readonly`.
3. Create an OAuth 2.0 **Web application** client. Add `http://localhost:3000/auth/google/callback` as an authorized redirect URI.
4. Copy `.env.example` to `.env` and fill in `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and a long `SESSION_SECRET`.
5. Install dependencies and start the app:

```bash
npm install
npm run dev
```

Open http://localhost:3000. If Google credentials are not configured, use **Explore with sample data** to review the dashboard without connecting an account.

Run the test suite with:

```bash
npm test
```

## Architecture

```text
Browser
  ├─ /auth/google → Google OAuth 2.0 → /auth/google/callback
  └─ /api/insights
        ├─ Gmail users.messages.list (search)
        ├─ Gmail users.messages.get (read-only message content)
        ├─ parser.js (amount, merchant, date, category)
        └─ analytics.js (totals, trends, recurring, anomaly explanations)
```

- `server.js` owns HTTP routes, sessions, and the read-only API boundary.
- `src/gmail.js` owns OAuth and Gmail API calls.
- `src/parser.js` handles MIME parts, HTML-to-text cleanup, amount detection, and category rules.
- `src/analytics.js` is pure, deterministic business logic. It is easy to replace or augment with an AI extraction step later.
- `public/` is a small dependency-free dashboard.

## Important technical decisions

- **Read-only access:** the app requests only `gmail.readonly`; it never sends, deletes, labels, or modifies email.
- **Search first, then fetch:** Gmail search reduces the number of messages that need to be downloaded. The first version caps the scan at 3,000 matching messages to keep a local demo responsive.
- **Traceability:** each transaction keeps Gmail `messageId`, `threadId`, subject, sender, and a Gmail thread link.
- **Explainable flags:** repeat merchants are compared with their median historical payment. A payment is flagged when it is materially larger, or when a high-value payment is from a merchant seen only once.
- **No AI by default:** financial extraction is deterministic and inspectable. A production version could use an LLM only for ambiguous emails, with redaction, structured JSON validation, and strict retention controls.
- **Demo mode:** sample data makes the product reviewable before OAuth credentials are configured.

## Production hardening

The local version keeps OAuth tokens in the server session so the implementation is easy to run. Before deploying, replace Express's in-memory session store with an encrypted, server-side store; use HTTPS; rotate session secrets; encrypt stored data; add account deletion and token revocation; implement Gmail API quotas/backoff; and complete Google's verification requirements for the restricted Gmail scope.

For near-real-time updates, add Gmail `users.watch`, Google Cloud Pub/Sub, and `users.history.list`. The current MVP performs an explicit scan when the user opens or refreshes the dashboard.
