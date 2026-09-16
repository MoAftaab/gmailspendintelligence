const eventTypes = new Set(['PURCHASE', 'REFUND', 'BILL_DUE', 'UPCOMING_CHARGE', 'SUBSCRIPTION_CHARGE', 'TRANSFER', 'CARD_REPAYMENT', 'UNKNOWN']);
const paymentStatuses = new Set(['COMPLETED', 'PENDING', 'FAILED', 'UPCOMING', 'UNKNOWN']);
const directions = new Set(['OUTGOING', 'INCOMING', 'TRANSFER', 'UNKNOWN']);

function normalized(value = '') {
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function amountAppearsInText(amount, text) {
  if (!Number.isFinite(Number(amount))) return false;
  const normalizedAmount = Number(amount).toFixed(2).replace(/\.00$/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const plainAmount = normalizedAmount.replace(/,/g, '');
  const escaped = plainAmount.replace('.', '\\.');
  return new RegExp(`(?:${escaped}|${normalizedAmount.replace('.', '\\.')})`).test(text.replace(/,/g, ''));
}

export function validateFinancialEvent({ sourceText = '', evidenceText = '', amount, currency, eventType, paymentStatus, direction } = {}) {
  const reasons = [];
  const source = normalized(sourceText);
  const evidence = normalized(evidenceText);
  if (evidence.length < 12 || !source.includes(evidence)) reasons.push('EVIDENCE_NOT_FOUND');
  if (!amountAppearsInText(amount, evidence)) reasons.push('AMOUNT_NOT_IN_EVIDENCE');
  if (!currency || currency === 'UNKNOWN') reasons.push('CURRENCY_MISSING');
  const currencyPattern = { '₹': /₹|\binr\b|\brs\.?\b/i, '$': /\$|\busd\b/i, '€': /€|\beur\b/i, '£': /£|\bgbp\b/i }[currency];
  if (currencyPattern && !currencyPattern.test(evidence)) reasons.push('CURRENCY_NOT_IN_EVIDENCE');
  if (!eventTypes.has(eventType)) reasons.push('EVENT_TYPE_INVALID');
  if (!paymentStatuses.has(paymentStatus)) reasons.push('PAYMENT_STATUS_INVALID');
  if (!directions.has(direction)) reasons.push('DIRECTION_INVALID');
  if (paymentStatus === 'COMPLETED' && ['FAILED', 'UPCOMING', 'PENDING'].includes(paymentStatus)) reasons.push('STATUS_CONFLICT');
  if (eventType === 'REFUND' && direction === 'OUTGOING') reasons.push('REFUND_DIRECTION_CONFLICT');
  if (['TRANSFER', 'CARD_REPAYMENT'].includes(eventType) && direction === 'OUTGOING' && paymentStatus === 'COMPLETED') reasons.push('NON_PURCHASE_EVENT');
  return { valid: reasons.length === 0, reasons };
}
