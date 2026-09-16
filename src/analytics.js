import { normalizeCurrency } from './parser.js';

const money = (value, currency = '₹') => `${normalizeCurrency(currency)}${Math.round(value).toLocaleString('en-IN')}`;
const monthKey = (date) => {
  const parsed = new Date(date);
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (key) => new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}-01T00:00:00.000Z`));
const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const signedAmount = (item) => item.transactionType === 'refund' ? -item.amount : ['income', 'transfer'].includes(item.transactionType) ? 0 : item.amount;
// Categories and merchants are built from spendTransactions, which contains expenses only.
const aggregate = (transactions, key) => Object.entries(transactions.reduce((out, item) => {
  const group = item[key] || (key === 'merchant' ? 'Unknown merchant' : 'Other');
  out[group] = (out[group] || 0) + item.amount;
  return out;
}, {})).map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total);

export function buildInsights(input) {
  const seen = new Set();
  const transactions = [...input].filter((item) => {
    if (!item || !Number.isFinite(Number(item.amount)) || Number(item.amount) <= 0) return false;
    const key = item.sourceMessageId || item.id || `${item.merchant}:${item.amount}:${item.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => new Date(b.date) - new Date(a.date));
  const now = new Date();
  const upcoming = transactions.filter((item) => item.transactionType !== 'refund' && item.transactionType !== 'income' && item.transactionType !== 'transfer' && item.dueDate && new Date(item.dueDate) >= now && new Date(item.dueDate) <= new Date(now.getTime() + 45 * 86400000)).sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  const total = transactions.reduce((sum, item) => sum + signedAmount(item), 0);
  const spendTransactions = transactions.filter((item) => !item.transactionType || item.transactionType === 'expense');
  const spendTotal = spendTransactions.reduce((sum, item) => sum + item.amount, 0);
  const categories = aggregate(spendTransactions, 'category');
  const merchants = aggregate(spendTransactions, 'merchant');
  const latestMonth = transactions[0] ? new Date(transactions[0].date).toISOString().slice(0, 7) : null;
  const latestMonthCategories = aggregate(spendTransactions.filter((item) => new Date(item.date).toISOString().slice(0, 7) === latestMonth), 'category');
  const monthlyMap = transactions.reduce((out, item) => {
    const key = monthKey(item.date);
    out[key] = (out[key] || 0) + signedAmount(item);
    return out;
  }, {});
  const monthly = Object.entries(monthlyMap)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, total]) => ({ month: monthLabel(key), monthKey: key, total }));
  const groupedMerchants = spendTransactions.reduce((out, item) => {
    (out[item.merchant] ||= []).push(item);
    return out;
  }, {});
  const recurring = Object.entries(groupedMerchants)
    .map(([merchant, items]) => ({ merchant, count: items.length, average: items.reduce((s, x) => s + x.amount, 0) / items.length, lastDate: items[0].date, category: items[0].category }))
    .filter((item) => item.count >= 2 && (item.count >= 3 || transactions.some((t) => t.merchant === item.merchant && t.recurringCandidate)))
    .sort((a, b) => b.average - a.average);

  const unusual = [];
  for (const item of transactions) {
    if (item.transactionType && item.transactionType !== 'expense') continue;
    const peers = (groupedMerchants[item.merchant] || []).filter((peer) => peer.id !== item.id).map((peer) => peer.amount);
    const baseline = median(peers);
    const isNewMerchant = peers.length === 0;
    if (isNewMerchant && item.amount >= Math.max(10000, spendTotal * 0.12)) {
      unusual.push({ ...item, reason: `${money(item.amount, item.currency)} to a merchant not seen elsewhere in the scan.` });
    } else if (peers.length >= 2 && item.amount >= Math.max(baseline * 1.8, baseline + 1000)) {
      unusual.push({ ...item, reason: `${money(item.amount, item.currency)} is materially above this merchant's typical ${money(baseline, item.currency)} payment.` });
    }
  }
  const insights = [];
  if (categories[0]) {
    const monthCategory = latestMonthCategories[0] || categories[0];
    const monthLabel = transactions[0] ? new Date(transactions[0].date).toLocaleDateString('en-IN', { month: 'long' }) : 'this period';
    insights.push({ type: 'category', title: `${monthCategory.name} is your highest-spend category`, body: `You spent ${money(monthCategory.total)} on ${monthCategory.name.toLowerCase()} in ${monthLabel}, your highest spending category.`, transaction: transactions.find((t) => t.category === monthCategory.name) });
  }
  if (monthly.length >= 2) {
    const current = monthly.at(-1);
    const previous = monthly.at(-2);
    const delta = previous.total > 0 ? ((current.total - previous.total) / previous.total) * 100 : null;
    const direction = current.total >= previous.total ? 'increased' : 'decreased';
    const percentage = delta === null ? '' : ` (${Math.abs(delta).toFixed(0)}% ${delta >= 0 ? 'higher' : 'lower'})`;
    insights.push({ type: direction === 'increased' ? 'trend-up' : 'trend-down', title: `${current.month} spending ${direction}`, body: `${money(current.total)} in ${current.month} versus ${money(previous.total)} in ${previous.month}${percentage}.` });
  }
  for (const item of unusual.slice(0, 3)) insights.push({ type: 'alert', title: `Review ${item.merchant}`, body: item.reason, transaction: item });
  return { generatedAt: new Date().toISOString(), transactionCount: transactions.length, total, categories, merchants, monthly, recurring, upcoming, unusual: unusual.slice(0, 10), insights, transactions };
}

export function demoTransactions() {
  const now = new Date();
  const date = (monthsAgo, day) => new Date(now.getFullYear(), now.getMonth() - monthsAgo, day).toISOString();
  return [
    { id: 'demo-adobe-1', sourceMessageId: 'demo-adobe-1', threadId: 'demo-adobe-1', sourceUrl: '#', merchant: 'Adobe', amount: 6899, currency: '₹', date: date(0, 5), category: 'Software & subscriptions', subject: 'Your Adobe payment receipt', sender: 'Adobe <billing@adobe.com>', snippet: 'Your monthly subscription payment was processed.', recurringCandidate: true, transactionType: 'expense', source: 'demo' },
    { id: 'demo-adobe-2', sourceMessageId: 'demo-adobe-2', threadId: 'demo-adobe-2', sourceUrl: '#', merchant: 'Adobe', amount: 6899, currency: '₹', date: date(1, 5), category: 'Software & subscriptions', subject: 'Your Adobe payment receipt', sender: 'Adobe <billing@adobe.com>', snippet: 'Your monthly subscription payment was processed.', recurringCandidate: true, transactionType: 'expense', source: 'demo' },
    { id: 'demo-adobe-3', sourceMessageId: 'demo-adobe-3', threadId: 'demo-adobe-3', sourceUrl: '#', merchant: 'Adobe', amount: 2499, currency: '₹', date: date(2, 5), category: 'Software & subscriptions', subject: 'Your Adobe payment receipt', sender: 'Adobe <billing@adobe.com>', snippet: 'Your monthly subscription payment was processed.', recurringCandidate: true, transactionType: 'expense', source: 'demo' },
    { id: 'demo-flight-1', sourceMessageId: 'demo-flight-1', threadId: 'demo-flight-1', sourceUrl: '#', merchant: 'IndiGo', amount: 42000, currency: '₹', date: date(0, 8), category: 'Travel', subject: 'Booking confirmation: Mumbai to London', sender: 'IndiGo <noreply@goindigo.in>', snippet: 'Your booking confirmation and payment receipt.', recurringCandidate: false, transactionType: 'expense', source: 'demo' },
    { id: 'demo-flight-2', sourceMessageId: 'demo-flight-2', threadId: 'demo-flight-2', sourceUrl: '#', merchant: 'MakeMyTrip', amount: 12500, currency: '₹', date: date(1, 16), category: 'Travel', subject: 'Hotel booking confirmation', sender: 'MakeMyTrip <bookings@makemytrip.com>', snippet: 'Your hotel booking is confirmed.', recurringCandidate: false, transactionType: 'expense', source: 'demo' },
    { id: 'demo-food-1', sourceMessageId: 'demo-food-1', threadId: 'demo-food-1', sourceUrl: '#', merchant: 'Swiggy', amount: 850, currency: '₹', date: date(0, 12), category: 'Food & dining', subject: 'Your Swiggy order receipt', sender: 'Swiggy <no-reply@swiggy.in>', snippet: 'Thanks for ordering.', recurringCandidate: false, transactionType: 'expense', source: 'demo' },
    { id: 'demo-new-1', sourceMessageId: 'demo-new-1', threadId: 'demo-new-1', sourceUrl: '#', merchant: 'Unknown Merchant', amount: 35000, currency: '₹', date: date(0, 14), category: 'Other', subject: 'Payment confirmation', sender: 'Payments <receipts@example.com>', snippet: 'A payment of ₹35,000 was processed.', recurringCandidate: false, transactionType: 'expense', source: 'demo' },
    { id: 'demo-netflix-1', sourceMessageId: 'demo-netflix-1', threadId: 'demo-netflix-1', sourceUrl: '#', merchant: 'Netflix', amount: 649, currency: '₹', date: date(0, 15), dueDate: new Date(now.getFullYear(), now.getMonth() + 1, 5).toISOString(), category: 'Software & subscriptions', subject: 'Your Netflix renewal is coming up', sender: 'Netflix <info@netflix.com>', snippet: 'Your next payment is due soon.', recurringCandidate: true, transactionType: 'expense', source: 'demo' }
  ];
}
