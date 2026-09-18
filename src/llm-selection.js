import { analyzeFinancialText, emailText } from './parser.js';

function priorityFor(analysis, text) {
  if (analysis.route === 'NON_TRANSACTIONAL') return -Infinity;

  let priority = analysis.route === 'UNCERTAIN' ? 100 : 40;
  const candidates = analysis.candidates || (analysis.candidate ? [analysis] : []);

  if (candidates.length > 1) priority += 20;
  if (analysis.route === 'UNCERTAIN' && /refund|credit note|chargeback|failed|declined|due|upcoming/i.test(text)) priority += 15;
  if (analysis.promotionalScore > 0 && analysis.promotionalScore < 0.6) priority += 10;

  return priority;
}

export function selectLLMCandidates(messages, baselines, max = 10) {
  return messages.map((message, index) => {
    const content = emailText(message);
    const analysis = analyzeFinancialText(content.text);
    return {
      message,
      baseline: baselines[index],
      analysis,
      priority: priorityFor(analysis, content.text),
      originalIndex: index
    };
  })
    .filter((item) => item.analysis.route !== 'NON_TRANSACTIONAL')
    .sort((first, second) => second.priority - first.priority || first.originalIndex - second.originalIndex)
    .slice(0, Math.max(0, max));
}

export function chunkCandidates(candidates, batchSize = 10) {
  const size = Math.max(1, Number(batchSize) || 10);
  const batches = [];
  for (let index = 0; index < candidates.length; index += size) {
    batches.push(candidates.slice(index, index + size));
  }
  return batches;
}
