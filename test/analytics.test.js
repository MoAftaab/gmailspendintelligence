import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInsights } from '../src/analytics.js';
import { analyzeFinancialText, isPromotionalText, normalizeCurrency, parseEmail } from '../src/parser.js';
import { chunkCandidates, selectLLMCandidates } from '../src/llm-selection.js';

const tx = (id, merchant, amount, category, date, recurringCandidate = false) => ({ id, merchant, amount, currency: '₹', category, date, recurringCandidate, sourceUrl: '#', transactionType: 'expense', eventType: 'PURCHASE', paymentStatus: 'COMPLETED', direction: 'OUTGOING' });

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

test('keeps monthly trend data in chronological order', () => {
  const data = buildInsights([
    tx('new', 'Merchant', 100, 'Shopping', '2026-03-01'),
    tx('old', 'Merchant', 100, 'Shopping', '2025-12-31'),
    tx('middle', 'Merchant', 100, 'Shopping', '2026-01-01')
  ]);
  assert.deepEqual(data.monthly.map((item) => item.monthKey), ['2025-12', '2026-01', '2026-03']);
});

test('parses Indian day/month due dates explicitly', () => {
  const message = {
    id: 'due-date',
    internalDate: String(Date.now()),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'Invoice payment due' },
        { name: 'From', value: 'Billing <billing@example.com>' },
        { name: 'Date', value: new Date().toUTCString() }
      ],
      body: { data: Buffer.from('Invoice payment due 05/12/2026. Amount due: ₹500.').toString('base64url') }
    }
  };
  const parsed = parseEmail(message);
  assert.equal(parsed.dueDate.slice(0, 10), '2026-12-05');
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
  assert.equal(parseEmail(message('Get your exclusive 50% discount today', 'Payment options are available. ₹100. Limited time only. Unsubscribe anytime.')), null);
  assert.equal(parseEmail(message('Last Chance! Save on a Year of Anime', 'Save on a yearly plan for ₹569. Sign up today.')), null);
  assert.equal(isPromotionalText('Get your exclusive 50% discount. Payment options available. ₹100. Unsubscribe anytime.'), true);
  assert.equal(isPromotionalText('Your payment receipt was processed. Amount paid: ₹1,999. Unsubscribe from marketing emails.'), false);
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

test('keeps failed payments out of the transaction ledger', () => {
  const text = 'Your payment of ₹999 failed. Update your billing information.';
  assert.equal(analyzeFinancialText(text).route, 'UNCERTAIN');
  const message = {
    id: 'failed-payment',
    internalDate: String(Date.now()),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'Payment failed' },
        { name: 'From', value: 'Merchant <billing@example.com>' },
        { name: 'Date', value: new Date().toUTCString() }
      ],
      body: { data: Buffer.from(text).toString('base64url') }
    }
  };
  assert.equal(parseEmail(message), null);
});

test('does not count upcoming bills as completed spending', () => {
  const dueDate = new Date(Date.now() + 7 * 86400000).toISOString();
  const data = buildInsights([{ ...tx('upcoming', 'Internet', 999, 'Utilities & bills', new Date().toISOString()), paymentStatus: 'UPCOMING', eventType: 'BILL_DUE', dueDate }]);
  assert.equal(data.total, 0);
  assert.equal(data.categories.length, 0);
  assert.equal(data.upcoming.length, 1);
});

test('does not classify cloud training as travel', () => {
  const message = {
    id: 'cloud-training',
    internalDate: String(Date.now()),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'Your cloud training payment receipt' },
        { name: 'From', value: 'Cloud Provider <billing@example.com>' },
        { name: 'Date', value: new Date().toUTCString() }
      ],
      body: { data: Buffer.from('Your payment was processed successfully. Amount paid: ₹1,000 for cloud service training.').toString('base64url') }
    }
  };
  const parsed = parseEmail(message);
  assert.equal(parsed.category, 'Software & subscriptions');
});

test('does not combine different currencies into one total', () => {
  const data = buildInsights([
    { ...tx('inr', 'Merchant IN', 1000, 'Shopping', '2026-03-01'), currency: '₹' },
    { ...tx('usd', 'Merchant US', 100, 'Shopping', '2026-03-02'), currency: '$' }
  ]);
  assert.equal(data.total, null);
  assert.deepEqual(data.totalsByCurrency, [{ currency: '$', total: 100 }, { currency: '₹', total: 1000 }]);
  assert.equal(data.monthly.length, 0);
});

test('reconciles two source emails sharing a transaction reference', () => {
  const data = buildInsights([
    { ...tx('receipt', 'Merchant', 1200, 'Shopping', '2026-03-01'), referenceId: 'TXN-12345', eventType: 'PURCHASE', paymentStatus: 'COMPLETED' },
    { ...tx('bank-alert', 'Merchant', 1200, 'Finance', '2026-03-01'), referenceId: 'TXN-12345', eventType: 'PURCHASE', paymentStatus: 'COMPLETED' }
  ]);
  assert.equal(data.transactionCount, 1);
  assert.equal(data.total, 1200);
});

test('does not turn a refund-policy footer into a refund', () => {
  const message = {
    id: 'refund-policy-footer',
    internalDate: String(Date.now()),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'Payment receipt' },
        { name: 'From', value: 'Merchant <billing@example.com>' },
        { name: 'Date', value: new Date().toUTCString() }
      ],
      body: { data: Buffer.from('Your payment was completed. Amount paid: ₹999. Refund policy applies to this purchase.').toString('base64url') }
    }
  };
  const parsed = parseEmail(message);
  assert.equal(parsed.transactionType, 'expense');
  assert.equal(parsed.eventType, 'PURCHASE');
});

test('prioritizes ambiguous emails across the full scan for LLM enrichment', () => {
  const clearMessages = Array.from({ length: 10 }, (_, index) => ({
    id: `clear-${index}`,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'Payment receipt' },
        { name: 'From', value: 'Merchant <billing@example.com>' },
        { name: 'Date', value: new Date().toUTCString() }
      ],
      body: { data: Buffer.from('Payment processed successfully. Amount paid: ₹100.').toString('base64url') }
    }
  }));
  const ambiguous = {
    id: 'ambiguous-18',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'Billing update required' },
        { name: 'From', value: 'Merchant <billing@example.com>' },
        { name: 'Date', value: new Date().toUTCString() }
      ],
      body: { data: Buffer.from('Your billing account contains ₹9,999. Update your payment method.').toString('base64url') }
    }
  };
  const selected = selectLLMCandidates([...clearMessages, ambiguous], Array(11).fill(null), 1);
  assert.equal(selected[0].message.id, 'ambiguous-18');
  assert.equal(selected[0].analysis.route, 'UNCERTAIN');
});

test('processes every number of ambiguous candidates in bounded LLM batches', () => {
  const candidates = Array.from({ length: 37 }, (_, index) => ({ id: `ambiguous-${index}` }));
  const batches = chunkCandidates(candidates, 10);
  assert.deepEqual(batches.map((batch) => batch.length), [10, 10, 10, 7]);
  assert.equal(batches.flat().length, 37);
});
