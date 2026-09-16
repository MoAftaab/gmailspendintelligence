const $ = (id) => document.getElementById(id);
let currentData;
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const sourceHref = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'mail.google.com' && url.pathname.startsWith('/mail/') ? url.href : null;
  } catch {
    return null;
  }
};
const normalizeCurrency = (currency = '₹') => {
  const raw = String(currency).trim().toUpperCase();
  if (['₹', 'INR', 'RS', 'RS.', 'RUPEE', 'RUPEES'].includes(raw)) return '₹';
  if (['$', 'USD', 'US$'].includes(raw)) return '$';
  if (['€', 'EUR'].includes(raw)) return '€';
  if (['£', 'GBP'].includes(raw)) return '£';
  return String(currency).trim() || '₹';
};
const formatMoney = (value, currency = '₹') => `${normalizeCurrency(currency)}${Math.round(value).toLocaleString('en-IN')}`;
const formatTransactionMoney = (item) => `${item.transactionType === 'refund' ? '-' : ''}${formatMoney(item.amount, item.currency)}`;
const formatDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};
let scanTimer;
let scanMessageTimer;
let scanStartedAt;
let aiTimer;
let aiRequest;
const scanMessages = [
  ['Finding the signal…', 'Checking transaction emails and preparing your spending story.'],
  ['Reading the fine print…', 'Extracting merchants, dates, amounts, and payment context.'],
  ['Connecting the dots…', 'Looking for categories, recurring payments, and unusual activity.'],
  ['Writing your summary…', 'Turning the detected activity into clear, grounded insights.']
];

function setScanState(active) {
  const overlay = $('scanOverlay');
  if (!overlay) return;
  clearInterval(scanTimer);
  clearInterval(scanMessageTimer);
  if (!active) {
    overlay.classList.add('hidden');
    document.body.classList.remove('is-scanning');
    return;
  }
  let messageIndex = 0;
  scanStartedAt = Date.now();
  overlay.classList.remove('hidden');
  document.body.classList.add('is-scanning');
  const update = () => {
    const [title, copy] = scanMessages[messageIndex];
    $('scanTitle').textContent = title;
    $('scanCopy').textContent = copy;
    const seconds = Math.floor((Date.now() - scanStartedAt) / 1000);
    $('scanElapsed').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')} elapsed`;
  };
  update();
  scanTimer = setInterval(update, 1000);
  scanMessageTimer = setInterval(() => {
    messageIndex = (messageIndex + 1) % scanMessages.length;
    update();
  }, 2600);
}

function setAiGenerationState(active) {
  clearInterval(aiTimer);
  const status = $('aiStatus');
  if (!status) return;
  if (!active) {
    status.classList.add('hidden');
    return;
  }
  const startedAt = Date.now();
  status.classList.remove('hidden');
  const update = () => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    $('aiTimer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  };
  update();
  aiTimer = setInterval(update, 1000);
}

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
  $('dataMode').textContent = `${mode ? `· ${mode}` : ''}${data.llmUsed ? ` · AI ASSISTED${data.llmModel ? ` (${data.llmModel})` : ''}` : data.llmPending ? ' · AI ENRICHMENT PENDING' : ''}`;
  $('scanMeta').textContent = `${data.transactionCount} transactions found · analyzed ${new Date(data.generatedAt).toLocaleString('en-IN')}`;
  renderInsights(data.insights || [], data.transactions || []);
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
  renderFilteredMessages(data.filteredMessages || []);
  if (data.llmUsed) setAiGenerationState(false);
}

function renderInsights(insights, transactions) {
  const icons = { category: '↗', 'trend-up': '↑', 'trend-down': '↓', alert: '!' };
  $('insightStrip').innerHTML = insights.slice(0, 3).map((item) => {
    const source = item.transaction || transactions.find((transaction) => item.transactionIds?.includes(transaction.id));
    const traceable = ['alert', 'upcoming', 'recurring'].includes(item.type);
    const href = sourceHref(source?.sourceUrl);
    const trace = traceable && href ? `<a class="insight-source" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">Trace source email ↗</a>` : '';
    return `<article class="insight-card ${item.type === 'alert' ? 'insight-alert' : ''}"><span class="insight-icon">${icons[item.type] || '•'}</span><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.body)}</p>${trace}</div></article>`;
  }).join('');
}

function renderChart(monthly) {
  const values = monthly.map((x) => x.total);
  const max = Math.max(...values, 1);
  $('chart').innerHTML = monthly.length ? monthly.map((item) => `<div class="chart-col"><div class="chart-value">${escapeHtml(formatMoney(item.total))}</div><div class="chart-bar-wrap"><div class="chart-bar" style="height:${Math.max(8, item.total / max * 100)}%"></div></div><div class="chart-label">${escapeHtml(item.month)}</div></div>`).join('') : '<div class="empty">Not enough dated emails to show a trend.</div>';
}

function renderCategories(categories) {
  const max = Math.max(categories[0]?.total || 1, 1);
  $('categoryList').innerHTML = categories.slice(0, 6).map((item) => `<div class="bar-item"><div class="bar-meta"><span>${escapeHtml(item.name)}</span><strong>${escapeHtml(formatMoney(item.total))}</strong></div><div class="track"><div style="width:${item.total / max * 100}%"></div></div></div>`).join('') || '<div class="empty">No categories found.</div>';
}

function renderAlerts(alerts, upcoming) {
  const upcomingCards = upcoming.map((item) => ({ ...item, upcoming: true, reason: `Upcoming payment due ${formatDate(item.dueDate)}.` }));
  const cards = [...alerts, ...upcomingCards];
  $('alertCount').textContent = cards.length;
  $('alerts').innerHTML = cards.length ? cards.slice(0, 5).map((item) => {
    const href = sourceHref(item.sourceUrl);
    const sourceLink = href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">Open source email ↗</a>` : '';
    return `<div class="alert-item"><span class="alert-mark">${item.upcoming ? '↗' : '!'}</span><div><strong>${escapeHtml(item.merchant)} <span>${escapeHtml(formatMoney(item.amount, item.currency))}</span></strong><p>${escapeHtml(item.reason)}</p>${sourceLink}</div></div>`;
  }).join('') : '<div class="empty success">Nothing unusual surfaced in this scan.</div>';
}

function renderRecurring(items) {
  $('recurringList').innerHTML = items.slice(0, 6).map((item) => `<div class="recurring-item"><div class="merchant-dot">${escapeHtml(item.merchant.slice(0, 1).toUpperCase())}</div><div><strong>${escapeHtml(item.merchant)}</strong><small>${escapeHtml(item.category)} · ${item.count} payments</small></div><b>${escapeHtml(formatMoney(item.average))}</b></div>`).join('') || '<div class="empty">Recurring patterns appear after repeated payments.</div>';
}

function renderTransactions(items) {
  $('transactionTable').innerHTML = items.slice(0, 30).map((item) => {
    const href = sourceHref(item.sourceUrl);
    const sourceLink = href ? `<a class="source-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">View ↗</a>` : '<span class="muted">—</span>';
    return `<tr><td><strong>${escapeHtml(item.merchant)}</strong><small>${escapeHtml(item.subject)}</small></td><td><span class="tag">${escapeHtml(item.category)}</span></td><td>${escapeHtml(formatDate(item.date))}</td><td class="right amount">${escapeHtml(formatTransactionMoney(item))}</td><td class="right">${sourceLink}</td></tr>`;
  }).join('') || '<tr><td colspan="5" class="empty">No transactions detected.</td></tr>';
}

function renderFilteredMessages(items) {
  const panel = $('filteredPanel');
  if (!panel) return;
  if (!items.length) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  $('filteredCount').textContent = items.length;
  $('filteredList').innerHTML = items.slice(0, 10).map((item) => {
    const href = sourceHref(item.sourceUrl);
    const sourceLink = href ? `<a class="source-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">Review email ↗</a>` : '';
    return `<div class="filtered-item"><div><strong>${escapeHtml(item.subject)}</strong><small>${escapeHtml(item.sender)} · ${escapeHtml(item.snippet || '')}</small><p>${escapeHtml(item.reason)}</p></div><div class="filtered-meta"><span class="filter-tag">${escapeHtml(item.label)}</span>${sourceLink}</div></div>`;
  }).join('');
}

async function load(mode, sync = false) {
  $('refreshBtn').textContent = 'Scanning…';
  $('refreshBtn').disabled = true;
  setScanState(true);
  let data;
  try {
    const query = mode === 'demo' ? '?demo=1' : sync ? '?sync=1' : '?fast=1';
    data = await getJson(`/api/insights${query}`);
    showDashboard(data, mode === 'demo' ? 'SAMPLE DATA' : 'GMAIL CONNECTED');
  }
  catch (error) { alert(error.message); }
  finally { setScanState(false); $('refreshBtn').textContent = '↻ Refresh scan'; $('refreshBtn').disabled = false; }
  if (data?.llmPending) startAiGeneration(mode);
}

function startAiGeneration(mode) {
  if (aiRequest) return;
  setAiGenerationState(true);
  $('aiStatus').classList.remove('ai-status-error');
  $('aiStatusText').textContent = 'AI insights are being generated…';
  $('dataMode').textContent = `${mode === 'demo' ? '· SAMPLE DATA' : '· GMAIL CONNECTED'} · AI GENERATING`;
  $('scanMeta').textContent += ' · AI narrative timer is running';
  const query = mode === 'demo' ? '?demo=1&ai=1' : '?ai=1';
  let aiFailed = false;
  aiRequest = getJson(`/api/insights${query}`)
    .then((data) => showDashboard(data, mode === 'demo' ? 'SAMPLE DATA' : 'GMAIL CONNECTED'))
    .catch(() => {
      aiFailed = true;
      clearInterval(aiTimer);
      $('aiStatus').classList.add('ai-status-error');
      $('aiStatus').classList.remove('hidden');
      $('aiStatusText').textContent = 'AI unavailable; showing the verified scan.';
      $('aiTimer').textContent = '';
    })
    .finally(() => { if (!aiFailed) setAiGenerationState(false); aiRequest = null; });
}

async function disconnect() {
  await fetch('/auth/logout', { method: 'POST' });
  location.href = '/';
}

async function init() {
  const config = await getJson('/api/config');
  if (config.connected || new URLSearchParams(location.search).get('connected')) {
    $('statusLabel').textContent = config.email || 'Gmail connected';
    $('topDisconnectBtn').classList.remove('hidden');
    await load();
  }
}

$('connectBtn').addEventListener('click', () => { location.href = '/auth/google'; });
$('demoBtn').addEventListener('click', () => load('demo'));
$('refreshBtn').addEventListener('click', () => load(undefined, true));
$('disconnectBtn').addEventListener('click', disconnect);
$('topDisconnectBtn').addEventListener('click', disconnect);
init().catch((error) => console.error(error));
