const $ = (id) => document.getElementById(id);
let currentData;
const formatMoney = (value, currency = '₹') => `${currency}${Math.round(value).toLocaleString('en-IN')}`;
const formatDate = (value) => new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function showDashboard(data, mode = '') {
  currentData = data;
  $('welcome').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
  $('dataMode').textContent = mode ? `· ${mode}` : '';
  $('scanMeta').textContent = `${data.transactionCount} transactions found · analyzed ${new Date(data.generatedAt).toLocaleString('en-IN')}`;
  renderInsights(data.insights || []);
  $('totalSpend').textContent = formatMoney(data.total);
  $('transactionCount').textContent = `${data.transactionCount} source emails analyzed`;
  $('topCategory').textContent = data.categories[0]?.name || '—';
  $('topCategoryAmount').textContent = data.categories[0] ? formatMoney(data.categories[0].total) : 'No data';
  $('topMerchant').textContent = data.merchants[0]?.name || '—';
  $('topMerchantAmount').textContent = data.merchants[0] ? formatMoney(data.merchants[0].total) : 'No data';
  $('recurringCount').textContent = data.recurring.length;
  $('recurringAmount').textContent = data.recurring.length ? `${formatMoney(data.recurring.reduce((sum, item) => sum + item.average, 0))} avg.` : 'No patterns yet';
  renderChart(data.monthly);
  renderCategories(data.categories);
  renderAlerts(data.unusual, data.upcoming || []);
  renderRecurring(data.recurring);
  renderTransactions(data.transactions);
}

function renderInsights(insights) {
  const icons = { category: '↗', 'trend-up': '↑', 'trend-down': '↓', alert: '!' };
  $('insightStrip').innerHTML = insights.slice(0, 3).map((item) => `<article class="insight-card ${item.type === 'alert' ? 'insight-alert' : ''}"><span class="insight-icon">${icons[item.type] || '•'}</span><div><strong>${item.title}</strong><p>${item.body}</p></div></article>`).join('');
}

function renderChart(monthly) {
  const values = monthly.map((x) => x.total);
  const max = Math.max(...values, 1);
  $('chart').innerHTML = monthly.length ? monthly.map((item) => `<div class="chart-col"><div class="chart-value">${formatMoney(item.total)}</div><div class="chart-bar-wrap"><div class="chart-bar" style="height:${Math.max(8, item.total / max * 100)}%"></div></div><div class="chart-label">${item.month}</div></div>`).join('') : '<div class="empty">Not enough dated emails to show a trend.</div>';
}

function renderCategories(categories) {
  const max = Math.max(categories[0]?.total || 1, 1);
  $('categoryList').innerHTML = categories.slice(0, 6).map((item) => `<div class="bar-item"><div class="bar-meta"><span>${item.name}</span><strong>${formatMoney(item.total)}</strong></div><div class="track"><div style="width:${item.total / max * 100}%"></div></div></div>`).join('') || '<div class="empty">No categories found.</div>';
}

function renderAlerts(alerts, upcoming) {
  const upcomingCards = upcoming.map((item) => ({ ...item, upcoming: true, reason: `Upcoming payment due ${formatDate(item.dueDate)}.` }));
  const cards = [...alerts, ...upcomingCards];
  $('alertCount').textContent = cards.length;
  $('alerts').innerHTML = cards.length ? cards.slice(0, 5).map((item) => `<div class="alert-item"><span class="alert-mark">${item.upcoming ? '↗' : '!'}</span><div><strong>${item.merchant} <span>${formatMoney(item.amount, item.currency)}</span></strong><p>${item.reason}</p><a href="${item.sourceUrl}" target="_blank" rel="noreferrer">Open source email ↗</a></div></div>`).join('') : '<div class="empty success">Nothing unusual surfaced in this scan.</div>';
}

function renderRecurring(items) {
  $('recurringList').innerHTML = items.slice(0, 6).map((item) => `<div class="recurring-item"><div class="merchant-dot">${item.merchant.slice(0, 1).toUpperCase()}</div><div><strong>${item.merchant}</strong><small>${item.category} · ${item.count} payments</small></div><b>${formatMoney(item.average)}</b></div>`).join('') || '<div class="empty">Recurring patterns appear after repeated payments.</div>';
}

function renderTransactions(items) {
  $('transactionTable').innerHTML = items.slice(0, 30).map((item) => `<tr><td><strong>${item.merchant}</strong><small>${item.subject}</small></td><td><span class="tag">${item.category}</span></td><td>${formatDate(item.date)}</td><td class="right amount">${formatMoney(item.amount, item.currency)}</td><td class="right"><a class="source-link" href="${item.sourceUrl}" target="_blank" rel="noreferrer">View ↗</a></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No transactions detected.</td></tr>';
}

async function load(mode) {
  const demo = mode === 'demo' ? '?demo=1' : '';
  $('refreshBtn').textContent = 'Scanning…';
  $('refreshBtn').disabled = true;
  try { showDashboard(await getJson(`/api/insights${demo}`), mode === 'demo' ? 'SAMPLE DATA' : 'GMAIL CONNECTED'); }
  catch (error) { alert(error.message); }
  finally { $('refreshBtn').textContent = '↻ Refresh scan'; $('refreshBtn').disabled = false; }
}

async function init() {
  const config = await getJson('/api/config');
  if (config.connected || new URLSearchParams(location.search).get('connected')) {
    $('statusLabel').textContent = config.email || 'Gmail connected';
    await load();
  }
}

$('connectBtn').addEventListener('click', () => { location.href = '/auth/google'; });
$('demoBtn').addEventListener('click', () => load('demo'));
$('refreshBtn').addEventListener('click', () => load());
$('disconnectBtn').addEventListener('click', async () => { await fetch('/auth/logout', { method: 'POST' }); location.href = '/'; });
init().catch((error) => console.error(error));
