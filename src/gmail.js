import { google } from 'googleapis';
import { parseEmail } from './parser.js';
import { extractTransactionsWithLLM, llmConfigured } from './llm.js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
export const gmailConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

function createClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback'
  );
}

export function getGoogleAuthUrl(state) {
  const client = createClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'select_account consent',
    scope: SCOPES,
    state
  });
}

export async function exchangeCode(code) {
  const client = createClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

export function getOAuthClientFromSession(session) {
  const client = createClient();
  client.setCredentials(session.tokens);
  return client;
}

const SEARCH_QUERY = [
  `newer_than:${Math.max(1, Number(process.env.GMAIL_LOOKBACK_YEARS || 2))}y`,
  '-label:spam -label:trash',
  '{receipt invoice payment subscription bill order confirmation charged statement UPI debited credited card bank transaction renewal autopay EMI refund cashback}'
].join(' ');

const MAX_MESSAGES_PER_RUN = Math.max(1, Math.min(Number(process.env.GMAIL_MAX_MESSAGES || 25), 100));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getMessageWithBackoff(gmail, id) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    } catch (error) {
      const reason = error?.errors?.[0]?.reason;
      const retryable = error?.code === 429 || (error?.code === 403 && reason === 'rateLimitExceeded');
      if (!retryable || attempt === 2) throw error;
      await sleep(1500 * 2 ** attempt);
    }
  }
}

export async function getHistoryState(auth, startHistoryId) {
  if (!startHistoryId) return { changed: true, historyId: null };
  const gmail = google.gmail({ version: 'v1', auth });
  let pageToken;
  let changed = false;
  let historyId = startHistoryId;
  try {
    do {
      const page = await gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: ['messageAdded', 'messageDeleted'],
        pageToken
      });
      historyId = page.data.historyId || historyId;
      changed ||= (page.data.history || []).some((item) => item.messagesAdded?.length || item.messagesDeleted?.length);
      pageToken = page.data.nextPageToken;
    } while (pageToken);
    return { changed, historyId };
  } catch (error) {
    if (error?.code === 404) return { changed: true, historyId: null };
    throw error;
  }
}

export async function fetchGmailTransactions(auth, { withLLM = true, includeMessages = false } = {}) {
  const gmail = google.gmail({ version: 'v1', auth });
  const ids = [];
  let pageToken;
  do {
    const page = await gmail.users.messages.list({
      userId: 'me',
      q: SEARCH_QUERY,
      maxResults: Math.min(100, MAX_MESSAGES_PER_RUN - ids.length),
      pageToken
    });
    ids.push(...(page.data.messages || []).slice(0, MAX_MESSAGES_PER_RUN - ids.length));
    pageToken = page.data.nextPageToken;
  } while (pageToken && ids.length < MAX_MESSAGES_PER_RUN);

  const messages = [];
  for (let i = 0; i < ids.length; i += 5) {
    const batch = await Promise.all(ids.slice(i, i + 5).map(({ id }) => getMessageWithBackoff(gmail, id)));
    messages.push(...batch.map(({ data }) => data));
    if (i + 5 < ids.length) await sleep(100);
  }

  const baselines = messages.map((message) => parseEmail(message));
  if (!withLLM) {
    const transactions = baselines.filter(Boolean);
    return includeMessages ? { transactions, messages, baselines } : transactions;
  }
  if (!llmConfigured) return baselines.filter(Boolean);

  const llmLimit = Math.min(messages.length, Math.max(1, Math.min(Number(process.env.OPENAI_MAX_EMAILS || 10), 10)));
  const enriched = await extractTransactionsWithLLM(messages.slice(0, llmLimit), baselines.slice(0, llmLimit));
  return [...enriched, ...baselines.slice(llmLimit)].filter(Boolean);
}
