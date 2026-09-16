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

function amountFrom(text) {
  const currency = text.match(/(?:₹|INR|Rs\.?|\$|USD|€|EUR|£|GBP)/i)?.[0] || '₹';
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
    ['Travel', /flight|airline|hotel|booking|uber|ola|makemytrip|airbnb|travel/i],
    ['Food & dining', /restaurant|food|swiggy|zomato|doordash|cafe|grocery|instacart/i],
    ['Shopping', /order confirmation|shopping|amazon|flipkart|myntra|walmart|retail/i],
    ['Software & subscriptions', /adobe|notion|openai|netflix|spotify|subscription|saas|cloud|microsoft|google one/i],
    ['Utilities & bills', /electricity|water bill|internet|mobile bill|utility|insurance|rent|statement/i],
    ['Health', /pharmacy|hospital|clinic|medical|health/i],
    ['Finance', /bank|credit card|loan|emi|investment|broker|payment confirmation/i]
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || 'Other';
}

function dueDateFrom(text, receivedDate) {
  const match = text.match(/(?:due|renewal|renews|next payment|billing date|payment date)[^\d]{0,24}(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?)/i);
  if (!match) return null;
  const raw = match[1];
  const parsed = /\d{4}/.test(raw) ? new Date(raw) : new Date(`${raw}, ${receivedDate.getFullYear()}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function parseEmail(message) {
  const headers = message.payload?.headers || [];
  const subject = header(headers, 'Subject');
  const from = header(headers, 'From');
  const dateHeader = header(headers, 'Date');
  const parts = walkParts(message.payload);
  const body = `${parts.text.join(' ')} ${parts.html.map(stripHtml).join(' ')}`.replace(/\s+/g, ' ').trim();
  const text = `${subject} ${from} ${body}`;
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
