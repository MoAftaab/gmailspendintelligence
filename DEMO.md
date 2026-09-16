# Short demo walkthrough

The assessment asks for a short video or live demonstration. The app includes a safe demo mode so the full product can be shown without exposing a real Gmail account.

1. Run `npm install` and `npm run dev`.
2. Open `http://localhost:3000`.
3. Click **Explore with sample data**.
4. Show the total-spend card, top category, top merchant, recurring payments, and the spending-over-time chart.
5. Scroll to **Worth a second look** to show the new-merchant alert and upcoming renewal with explanations.
6. Scroll to **Detected transactions** to show source-email traceability.
7. For the end-to-end Gmail flow, configure `.env`, click **Connect Gmail**, grant read-only access, and refresh the scan.

Suggested narration: “Ledgerly asks for read-only Gmail access, searches transaction-like emails, extracts merchant, amount, date, category, and due dates, then turns them into a spending profile. The anomaly cards explain why a payment is unusual, and every finding keeps a link back to its source email.”
