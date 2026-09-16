import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInsights } from '../src/analytics.js';
import { normalizeCurrency, parseEmail } from '../src/parser.js';

const tx = (id, merchant, amount, category, date, recurringCandidate = false) => ({ id, merchant, amount, currency: '₹', category, date, recurringCandidate, sourceUrl: '#' });

test('builds totals and ranked breakdowns', () => {
  const data = buildInsights([
    tx('1', 'Adobe', 2000, 'Software & subscriptions', '2026-01-01'),
    tx('2', 'Adobe', 2000, 'Software & subscriptions', '2026-02-01', true),
    tx('3', 'Travel Co', 5000, 'Travel', '2026-02-08')
  ]);
  assert.equal(data.total, 9000);
  assert.equal(data.categories[0].name, 'Travel');
  assert.equal(data.merchants[0].name, 'Travel Co');
  assert.equal(data.recurring[0].merchant, 'Adobe');
});

test('flags a materially larger repeat payment', () => {
  const data = buildInsights([
    tx('1', 'Adobe', 2000, 'Software & subscriptions', '2026-01-01'),
    tx('2', 'Adobe', 2000, 'Software & subscriptions', '2026-02-01'),
    tx('3', 'Adobe', 6899, 'Software & subscriptions', '2026-03-01')
  ]);
  assert.equal(data.unusual[0].merchant, 'Adobe');
  assert.match(data.unusual[0].reason, /typical/);
});

test('surfaces upcoming payments within the next 45 days', () => {
  const dueDate = new Date(Date.now() + 7 * 86400000).toISOString();
  const data = buildInsights([{
    ...tx('1', 'Netflix', 649, 'Software & subscriptions', new Date().toISOString(), true),
    dueDate
  }]);
  assert.equal(data.upcoming.length, 1);
  assert.equal(data.upcoming[0].merchant, 'Netflix');
});

test('normalizes Indian currency and removes duplicate source messages', () => {
  assert.equal(normalizeCurrency('rs'), '₹');
  const duplicate = tx('same-message', 'Merchant', 1200, 'Shopping', '2026-03-01');
  const data = buildInsights([duplicate, { ...duplicate, id: 'different-row', sourceMessageId: 'same-message' }]);
  assert.equal(data.transactionCount, 1);
  assert.equal(data.total, 1200);
});

test('rejects promotional newsletters without payment evidence', () => {
  const message = (subject, body) => ({
    id: subject,
    internalDate: String(Date.now()),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: subject },
        { name: 'From', value: 'Newsletter <newsletter@example.com>' },
        { name: 'Date', value: new Date().toUTCString() }
      ],
      body: { data: Buffer.from(body).toString('base64url') }
    }
  });
  assert.equal(parseEmail(message('Exclusive 50% discount', 'Limited time offer. Unsubscribe anytime.')), null);
  const receipt = parseEmail(message('Payment receipt', 'Your payment receipt. Amount paid: ₹1,999.'));
  assert.equal(receipt.amount, 1999);
});

test('handles refunds and transfers without crashing anomaly analysis', () => {
  const data = buildInsights([
    { ...tx('expense', 'Cloud', 1000, 'Software & subscriptions', '2026-03-01'), transactionType: 'expense' },
    { ...tx('refund', 'Cloud', 250, 'Software & subscriptions', '2026-03-02'), transactionType: 'refund' },
    { ...tx('transfer', 'Bank', 5000, 'Finance', '2026-03-03'), transactionType: 'transfer' }
  ]);
  assert.equal(data.total, 750);
  assert.equal(data.categories[0].total, 1000);
  assert.equal(data.merchants[0].total, 1000);
  assert.equal(data.unusual.length, 0);
});
