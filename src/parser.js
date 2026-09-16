import { validateFinancialEvent } from './validation.js';

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
const weakBillingPhrase = /\b(?:billing\s+(?:address|account|information|info|profile)|payment\s+(?:method|methods|details|information|info)|update\s+(?:your\s+)?payment|manage\s+(?:your\s+)?subscription)\b/i;
const moneyToken = '(?:₹|INR|Rs\\.?|\\$|USD|€|EUR|£|GBP)\\s*[\\d,]+(?:\\.\\d{1,2})?';
const completedEvidence = new RegExp(`(?:amount|invoice|order|grand|total|payment|purchase|subscription|transaction|bill)[^.!?\\n]{0,100}(?:paid|charged|debited|processed|successful|received|completed|renewed)|(?:paid|charged|debited|processed|successful|received|completed|renewed)[^.!?\\n]{0,100}(?:amount|invoice|order|grand|total|payment|purchase|subscription|transaction|bill)|${moneyToken}[^.!?\\n]{0,80}(?:was|has been|is)?\\s*(?:paid|charged|debited|processed|successful|received|completed|renewed)`, 'i');
const dueEvidence = new RegExp(`(?:amount|payment|bill|invoice|subscription|renewal)[^.!?\\n]{0,100}(?:due|upcoming|next|will\\s+be\\s+charged|renewal)|(?:due|upcoming|next|will\\s+be\\s+charged|renewal)[^.!?\\n]{0,100}(?:amount|payment|bill|invoice|subscription)|${moneyToken}[^.!?\\n]{0,80}(?:is|will\\s+be)?\\s*(?:due|upcoming|charged)`, 'i');
const failedEvidence = new RegExp(`(?:payment|transaction|charge|debit|order)[^.!?\\n]{0,80}(?:failed|declined|cancelled|canceled)|(?:failed|declined|cancelled|canceled)[^.!?\\n]{0,80}(?:payment|transaction|charge|debit|order)|${moneyToken}[^.!?\\n]{0,80}(?:failed|declined|cancelled|canceled)`, 'i');
const refundEvidence = /(?:refund(?:ed)?\s+(?:of|for)|refund\s+(?:issued|processed|received)|credit\s+note|cashback(?:\s+received)?|reversal|chargeback)[^.!?\n]{0,100}(?:amount|payment|₹|INR|Rs\.?|\$|USD|€|EUR|£|GBP)|(?:amount|payment|₹|INR|Rs\.?|\$|USD|€|EUR|£|GBP)[^.!?\n]{0,100}(?:refunded|refund\s+(?:issued|processed|received)|credit\s+note|cashback(?:\s+received)?|reversal|chargeback)/i;
const promotionalSignals = [
  { pattern: /exclusive(?:\s+\d+%?)?\s+(?:offer|discount)|discount\s+today/i, score: 0.7 },
  { pattern: /limited\s+time|%\s*off/i, score: 0.45 },
  { pattern: /coupon\s+code|use\s+code|promo\s+code/i, score: 0.9 },
  { pattern: /last\s+chance[\s\S]{0,80}save|save[\s\S]{0,80}last\s+chance/i, score: 0.7 },
  { pattern: /newsletter|promotion|promo|special\s+offer|free\s+trial|marketing|deal|sign\s+up/i, score: 0.35 },
  { pattern: /unsubscribe/i, score: 0.2 }
];

function promotionalScore(text) {
  return Math.min(1, promotionalSignals.reduce((score, signal) => score + (signal.pattern.test(text) ? signal.score : 0), 0));
}

function amountCandidatesFrom(text) {
  const candidates = [...text.matchAll(/(?:₹|INR|Rs\.?|\$|USD|€|EUR|£|GBP)\s*([\d,]+(?:\.\d{1,2})?)/gi)]
    .map((match) => ({
      amount: Number(match[1].replace(/,/g, '')),
      currency: normalizeCurrency(match[0].match(/^(?:₹|INR|Rs\.?|\$|USD|€|EUR|£|GBP)/i)?.[0] || '₹'),
      index: match.index || 0,
      length: match[0].length
    }))
    .filter((candidate) => Number.isFinite(candidate.amount) && candidate.amount > 0);
  const labeled = [...text.matchAll(/(?:total|amount\s+(?:paid|due)|grand\s+total|charged|debited|refund(?:ed)?)[^\d]{0,20}([\d,]+(?:\.\d{1,2})?)/gi)]
    .map((match) => ({ amount: Number(match[1].replace(/,/g, '')), currency: null, index: match.index || 0, length: match[0].length }))
    .filter((candidate) => Number.isFinite(candidate.amount) && candidate.amount > 0);
  return [...candidates, ...labeled].filter((candidate, index, all) => all.findIndex((item) => item.amount === candidate.amount && Math.abs(item.index - candidate.index) < 3) === index);
}

function amountFrom(text, analysis = analyzeFinancialText(text)) {
  const candidates = amountCandidatesFrom(text);
  if (!candidates.length) return null;
  const selected = analysis.amountCandidate || candidates[0];
  if (!selected.currency) return null;
  return { amount: selected.amount, currency: selected.currency };
}

function evidenceForCandidate(text, candidate) {
  const start = Math.max(0, candidate.index - 100);
  const end = Math.min(text.length, candidate.index + candidate.length + 80);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function sentenceForCandidate(text, candidate) {
  const startBoundary = Math.max(text.lastIndexOf('.', candidate.index), text.lastIndexOf('!', candidate.index), text.lastIndexOf('?', candidate.index), text.lastIndexOf('\n', candidate.index)) + 1;
  const nextBoundaries = [text.indexOf('.', candidate.index + candidate.length), text.indexOf('!', candidate.index + candidate.length), text.indexOf('?', candidate.index + candidate.length), text.indexOf('\n', candidate.index + candidate.length)].filter((index) => index >= 0);
  const endBoundary = nextBoundaries.length ? Math.min(...nextBoundaries) : text.length;
  return text.slice(startBoundary, endBoundary).replace(/\s+/g, ' ').trim();
}

function classifyCandidate(text, candidate) {
  const evidence = evidenceForCandidate(text, candidate);
  const sentence = sentenceForCandidate(text, candidate);
  const cleanSentence = sentence.replace(weakBillingPhrase, ' ');
  const hasRefund = refundEvidence.test(cleanSentence);
  const hasFailed = failedEvidence.test(cleanSentence);
  const hasDue = dueEvidence.test(cleanSentence);
  const hasCompleted = completedEvidence.test(cleanSentence) || hasRefund;
  const eventType = hasRefund ? 'REFUND' : hasDue && !hasCompleted ? 'BILL_DUE' : /subscription|renewal|membership/i.test(cleanSentence) ? 'SUBSCRIPTION_CHARGE' : /transfer|sent\s+to|bank\s+transfer/i.test(cleanSentence) ? 'TRANSFER' : 'PURCHASE';
  const paymentStatus = hasFailed ? 'FAILED' : hasDue && !hasCompleted ? 'UPCOMING' : hasCompleted ? 'COMPLETED' : 'UNKNOWN';
  const strongEvidence = hasCompleted || hasDue || hasRefund;
  return { candidate, evidence, eventType, paymentStatus, strongEvidence };
}

export function analyzeFinancialText(text = '') {
  const amounts = amountCandidatesFrom(text);
  const score = promotionalScore(text);
  const candidates = amounts.map((candidate) => classifyCandidate(text, candidate));
  const financialCandidate = candidates.find((candidate) => candidate.strongEvidence && candidate.paymentStatus !== 'FAILED');
  if (financialCandidate) return { route: 'FINANCIAL_CANDIDATE', promotionalScore: score, ...financialCandidate };
  if (score >= 0.6) return { route: 'NON_TRANSACTIONAL', promotionalScore: score, candidates };
  if (transactionEvidence.test(text) || amounts.length) return { route: 'UNCERTAIN', promotionalScore: score, candidates };
  return { route: 'NON_TRANSACTIONAL', promotionalScore: score, candidates };
}

export function isPromotionalText(text = '') {
  return analyzeFinancialText(text).route === 'NON_TRANSACTIONAL' && promotionalScore(text) >= 0.6;
}

export function isLikelyFinancialText(text = '') {
  return analyzeFinancialText(text).route === 'FINANCIAL_CANDIDATE';
}

function categoryFor(text) {
  const rules = [
    ['Software & subscriptions', /\badobe\b|\bnotion\b|\bopenai\b|\bchatgpt\b|\bnetflix\b|\bspotify\b|\bprime\b|youtube premium|subscription|renewal|membership|\bsaas\b|hosting|\bdomain\b|api plan|cloud service|microsoft 365|google one/i],
    ['Travel', /flight|airline|hotel|booking|\buber\b|\bola\b|\blyft\b|makemytrip|airbnb|\btravel\b|railway|\btrain\b(?:\s+(?:ticket|booking|station|journey))?|bus ticket|parking|toll/i],
    ['Food & dining', /restaurant|\bfood\b|\bswiggy\b|\bzomato\b|doordash|\bcafe\b|grocery|instacart|blinkit|zepto|bigbasket|meal|dining/i],
    ['Shopping', /order confirmation|order total|shopping|amazon|flipkart|myntra|walmart|retail|\bstore\b|\bproduct\b|\bcart\b/i],
    ['Utilities & bills', /electricity|water bill|internet|mobile bill|utility|insurance|rent|broadband|gas bill|recharge|telecom|phone bill/i],
    ['Health', /pharmacy|hospital|clinic|medical|health|doctor|diagnostic|medicine/i],
    ['Finance', /\bbank\b|credit card|loan|emi|investment|broker|payment confirmation|upi|phonepe|paytm|razorpay|stripe|cashfree|account statement|\btax\b|\bfee\b/i]
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || 'Other';
}

function referenceIdFrom(text) {
  const match = text.match(/(?:transaction|txn|order|invoice|receipt|reference|ref)(?:\s+(?:id|number|no))?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{5,})/i);
  return match && /\d/.test(match[1]) ? match[1].toUpperCase() : null;
}

function parseDateToken(raw, fallbackYear) {
  const numeric = raw.match(/^(\d{1,4})[/-](\d{1,2})[/-](\d{1,4})$/);
  if (numeric) {
    let first = Number(numeric[1]);
    let second = Number(numeric[2]);
    let third = Number(numeric[3]);
    let year;
    let month;
    let day;
    if (String(first).length === 4) {
      year = first;
      month = second;
      day = third;
    } else {
      year = third < 100 ? 2000 + third : third;
      // Email dates are interpreted as day/month/year by default. If one
      // component is greater than 12, use it to disambiguate month/day.
      if (first > 12) {
        day = first;
        month = second;
      } else if (second > 12) {
        month = first;
        day = second;
      } else {
        day = first;
        month = second;
      }
    }
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
    return parsed;
  }
  const monthName = raw.match(/^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i);
  if (!monthName) return null;
  const monthIndex = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].findIndex((prefix) => monthName[1].toLowerCase().startsWith(prefix));
  const year = Number(monthName[3] || fallbackYear);
  const day = Number(monthName[2]);
  const parsed = new Date(Date.UTC(year, monthIndex, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === monthIndex && parsed.getUTCDate() === day ? parsed : null;
}

function dueDateFrom(text, receivedDate) {
  const match = text.match(/(?:due|renewal|renews|next payment|billing date|payment date)[^\d]{0,24}(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?)/i);
  if (!match) return null;
  const raw = match[1];
  const parsed = parseDateToken(raw, receivedDate.getFullYear());
  return parsed ? parsed.toISOString() : null;
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
  const analysis = analyzeFinancialText(text);
  if (analysis.route !== 'FINANCIAL_CANDIDATE') return null;
  const amount = amountFrom(text, analysis);
  if (!amount || amount.amount <= 0) return null;
  const date = new Date(dateHeader || Number(message.internalDate));
  if (Number.isNaN(date.getTime())) return null;
  const merchant = merchantFrom(from, subject);
  const sourceUrl = `https://mail.google.com/mail/u/0/#all/${message.threadId || message.id}`;
  const event = {
    id: message.id,
    sourceMessageId: message.id,
    threadId: message.threadId,
    sourceUrl,
    merchant,
    amount: Number(amount.amount.toFixed(2)),
    currency: amount.currency,
    transactionType: analysis.eventType === 'REFUND' ? 'refund' : analysis.eventType === 'TRANSFER' ? 'transfer' : 'expense',
    eventType: analysis.eventType,
    paymentStatus: analysis.paymentStatus,
    direction: analysis.eventType === 'REFUND' ? 'INCOMING' : analysis.eventType === 'TRANSFER' ? 'TRANSFER' : 'OUTGOING',
    countsAsSpending: analysis.paymentStatus === 'COMPLETED' && !['REFUND', 'TRANSFER', 'BILL_DUE'].includes(analysis.eventType),
    evidenceText: analysis.evidence,
    referenceId: referenceIdFrom(text),
    date: date.toISOString(),
    dueDate: dueDateFrom(text, date),
    category: categoryFor(`${subject} ${from} ${analysis.evidence}`),
    subject: subject || 'Untitled email',
    sender: from,
    snippet: message.snippet || body.slice(0, 180),
    recurringCandidate: /subscription|renewal|recurring|monthly|annual|membership/i.test(text),
    source: 'gmail'
  };
  const validation = validateFinancialEvent({ ...event, sourceText: text });
  return validation.valid ? event : null;
}
