function decodeBase64Url(value = '') {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function walkParts(part, result = { text: [], html: [] }) {
  if (!part) return result;
  if (part.body?.data) {
    const decoded = decodeBase64Url(part.body.data);
    if (part.mimeType === 'text/html') result.html.push(decoded);
    else if (part.mimeType === 'text/plain') result.text.push(decoded);
  }
  for (const child of part.parts || []) walkParts(child, result);
  return result;
}

function stripHtml(html) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

function header(headers, name) {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

function merchantFrom(from, subject) {
  const name = from.match(/^\s*"?([^"<]+?)"?\s*</)?.[1] || from.split('@')[0] || subject.split(/[-|:]/)[0];
  return name.replace(/["']/g, '').replace(/\s+/g, ' ').trim() || 'Unknown merchant';
}

export function normalizeCurrency(value = '₹') {
  const raw = String(value).trim().toUpperCase();
  if (['₹', 'INR', 'RS', 'RS.', 'RUPEE', 'RUPEES'].includes(raw)) return '₹';
  if (['$', 'USD', 'US$'].includes(raw)) return '$';
  if (['€', 'EUR'].includes(raw)) return '€';
  if (['£', 'GBP'].includes(raw)) return '£';
  return String(value).trim() || '₹';
}

const transactionEvidence = /receipt|invoice|payment|charged|debited|amount\s+(?:paid|due)|order\s+(?:total|confirmation)|bill(?:ing)?|renewal|transaction(?:\s+id)?|refund|credit\s+note|upi|emi/i;
const strongPaymentEvidence = /receipt|invoice|payment\s+(?:receipt|confirmation|successful|processed|received)|(?:payment|transaction)\s+id|charged|debited|amount\s+(?:paid|due)|order\s+(?:total|confirmation)|bill(?:ing)?|refund|credit\s+note|upi|emi/i;
const promotionalEvidence = /exclusive|discount|%\s*off|limited\s+time|newsletter|unsubscribe|promotion|promo|coupon|sale|free\s+trial|special\s+offer|marketing|last\s+chance|save\s+on|save\s+\d|deal|sign\s+up/i;

export function isPromotionalText(text = '') {
  return promotionalEvidence.test(text) && !strongPaymentEvidence.test(text);
}

export function isLikelyFinancialText(text = '') {
  if (!transactionEvidence.test(text)) return false;
  return !isPromotionalText(text);
}

function amountFrom(text) {
  const currency = normalizeCurrency(text.match(/(?:₹|INR|Rs\.?|\$|USD|€|EUR|£|GBP)/i)?.[0] || '₹');
  const candidates = [...text.matchAll(/(?:₹|INR|Rs\.?|\$|USD|€|EUR|£|GBP)\s*([\d,]+(?:\.\d{1,2})?)/gi)]
    .map((m) => ({ value: Number(m[1].replace(/,/g, '')), index: m.index || 0 }));
  if (!candidates.length) {
    const labeled = text.match(/(?:total|amount paid|grand total|charged|amount due)[^\d]{0,20}([\d,]+(?:\.\d{1,2})?)/i);
    if (!labeled) return null;
    return { amount: Number(labeled[1].replace(/,/g, '')), currency: '₹' };
  }
  const labeled = candidates.find((candidate) => /(total|paid|charged|amount due|order total)/i.test(text.slice(Math.max(0, candidate.index - 45), candidate.index)));
  return { amount: (labeled || candidates[0]).value, currency };
}

function categoryFor(text) {
  const rules = [
    ['Software & subscriptions', /adobe|notion|openai|chatgpt|netflix|spotify|prime|youtube premium|subscription|renewal|membership|saas|hosting|domain|api plan|cloud service|microsoft 365|google one/i],
    ['Travel', /flight|airline|hotel|booking|uber|ola|lyft|makemytrip|airbnb|travel|railway|train|bus ticket|parking|toll/i],
    ['Food & dining', /restaurant|food|swiggy|zomato|doordash|cafe|grocery|instacart|blinkit|zepto|bigbasket|meal|dining/i],
    ['Shopping', /order confirmation|order total|shopping|amazon|flipkart|myntra|walmart|retail|store|product|cart/i],
    ['Utilities & bills', /electricity|water bill|internet|mobile bill|utility|insurance|rent|broadband|gas bill|recharge|telecom|phone bill/i],
    ['Health', /pharmacy|hospital|clinic|medical|health|doctor|diagnostic|medicine/i],
    ['Finance', /bank|credit card|loan|emi|investment|broker|payment confirmation|upi|phonepe|paytm|razorpay|stripe|cashfree|account statement|tax|fee/i]
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || 'Other';
}

function transactionTypeFor(text) {
  if (/refund|refunded|credit note|cashback|reversal|chargeback/i.test(text)) return 'refund';
  if (/salary|payroll|interest credited|deposit received|income received/i.test(text)) return 'income';
  if (/money transfer|funds transfer|transferred to|sent to another account/i.test(text)) return 'transfer';
  return 'expense';
}

function dueDateFrom(text, receivedDate) {
  const match = text.match(/(?:due|renewal|renews|next payment|billing date|payment date)[^\d]{0,24}(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?)/i);
  if (!match) return null;
  const raw = match[1];
  const parsed = /\d{4}/.test(raw) ? new Date(raw) : new Date(`${raw}, ${receivedDate.getFullYear()}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function emailText(message) {
  const headers = message.payload?.headers || [];
  const subject = header(headers, 'Subject');
  const from = header(headers, 'From');
  const dateHeader = header(headers, 'Date');
  const parts = walkParts(message.payload);
  const body = `${parts.text.join(' ')} ${parts.html.map(stripHtml).join(' ')}`.replace(/\s+/g, ' ').trim();
  return { subject, from, dateHeader, body, text: `${subject} ${from} ${body}`.trim() };
}

export function parseEmail(message) {
  const { subject, from, dateHeader, body, text } = emailText(message);
  if (!isLikelyFinancialText(text)) return null;
  const amount = amountFrom(text);
  if (!amount || amount.amount <= 0) return null;
  const date = new Date(dateHeader || Number(message.internalDate));
  if (Number.isNaN(date.getTime())) return null;
  const merchant = merchantFrom(from, subject);
  const sourceUrl = `https://mail.google.com/mail/u/0/#all/${message.threadId || message.id}`;
  return {
    id: message.id,
    sourceMessageId: message.id,
    threadId: message.threadId,
    sourceUrl,
    merchant,
    amount: Number(amount.amount.toFixed(2)),
    currency: amount.currency,
    transactionType: transactionTypeFor(text),
    date: date.toISOString(),
    dueDate: dueDateFrom(text, date),
    category: categoryFor(text),
    subject: subject || 'Untitled email',
    sender: from,
    snippet: message.snippet || body.slice(0, 180),
    recurringCandidate: /subscription|renewal|recurring|monthly|annual|membership/i.test(text),
    source: 'gmail'
  };
}
