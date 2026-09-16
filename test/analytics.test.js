import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInsights } from '../src/analytics.js';

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
