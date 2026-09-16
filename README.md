# Ledgerly — Gmail Spend Intelligence

Ledgerly is a read-only Gmail spending dashboard. It asks the user for permission through Google OAuth, searches transaction-like email, extracts basic transaction fields, and presents totals, category and merchant breakdowns, recurring payments, trends, unusual-payment explanations, and links back to source emails.

The project also includes [DEMO.md](DEMO.md), a short live-demo script for the assessment. Demo mode includes an upcoming renewal so the end-to-end product story can be shown without exposing a real mailbox.

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
        ├─ Gmail users.messages.list/history.list (filtered and incremental sync)
        ├─ Gmail users.messages.get (read-only message content)
        ├─ parser.js (baseline extraction and validation)
        ├─ optional batched LLM extraction (CodeCraft/OpenAI-compatible)
        └─ analytics.js (totals, trends, recurring, anomaly explanations)
```

- `server.js` owns HTTP routes, sessions, and the read-only API boundary.
- `src/gmail.js` owns OAuth and Gmail API calls.
- `src/parser.js` handles MIME parts, HTML-to-text cleanup, amount detection, and category rules.
- `src/analytics.js` is pure, deterministic business logic. It deduplicates and validates transactions before calculating totals, trends, recurring payments, and flags.
- `public/` is a small dependency-free dashboard.

## Important technical decisions

- **Read-only access:** the app requests only `gmail.readonly`; it never sends, deletes, labels, or modifies email.
- **Search first, then fetch:** Gmail search includes receipt, invoice, payment, UPI, debit, credit, card, bank, renewal, autopay, EMI, refund, and cashback terms. A local scan caps message details at 25 to respect Gmail quotas.
- **Incremental refresh:** the OAuth profile's `historyId` is stored in the session. Refresh checks Gmail history first and avoids re-downloading messages when nothing changed.
- **Traceability:** each transaction keeps Gmail `messageId`, `threadId`, subject, sender, and a Gmail thread link.
- **Safe trace links:** aggregate totals and category/trend narratives never point to an arbitrary email; source links are shown only for findings tied to a verified Gmail transaction URL.
- **Explainable flags:** repeat merchants are compared with their median historical payment. A payment is flagged when it is materially larger, or when a high-value payment is from a merchant seen only once.
- **Upcoming payments:** due/renewal language is parsed when present, and payments due within the next 45 days are surfaced alongside unusual transactions.
- **Staged AI enrichment:** the dashboard first renders the fast deterministic scan. A batched LLM request then classifies up to 10 candidate emails and a second request writes grounded narratives; the UI shows a timer while this runs.
- **Optional LLM enrichment:** set `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL` to use an OpenAI-compatible provider such as CodeCraft. The server uses strict JSON schemas for email extraction and narrative generation; the browser never receives the API key.
- **Automatic categorization:** merchant/domain rules provide a deterministic baseline, while the batched LLM validates ambiguous candidates. Promotional newsletters are rejected, and refunds/income/transfers are separated from spending totals.
- **Demo mode:** sample data makes the product reviewable before OAuth credentials are configured.
- **Resilient sync:** refresh checks additions and deletions, recovers from expired Gmail history cursors, and reports common OAuth/API quota problems with actionable messages.

## Production hardening

The local version keeps OAuth tokens in the server session so the implementation is easy to run. Before deploying, replace Express's in-memory session store with an encrypted, server-side store; use HTTPS; rotate session secrets; encrypt stored data; add account deletion and token revocation; implement Gmail API quotas/backoff; and complete Google's verification requirements for the restricted Gmail scope.

For near-real-time updates, add Gmail `users.watch` and Google Cloud Pub/Sub. The MVP already uses `users.history.list` to avoid a full rescan when an explicit refresh finds no new messages.
