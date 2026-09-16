import { google } from 'googleapis';
import { parseEmail } from './parser.js';

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
    prompt: 'consent',
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
  '{receipt invoice payment subscription bill order confirmation charged statement}'
].join(' ');

export async function fetchGmailTransactions(auth) {
  const gmail = google.gmail({ version: 'v1', auth });
  const ids = [];
  let pageToken;
  do {
    const page = await gmail.users.messages.list({
      userId: 'me',
      q: SEARCH_QUERY,
      maxResults: 500,
      pageToken
    });
    ids.push(...(page.data.messages || []));
    pageToken = page.data.nextPageToken;
  } while (pageToken && ids.length < 3000);

  const transactions = [];
  for (let i = 0; i < ids.length; i += 10) {
    const batch = await Promise.all(ids.slice(i, i + 10).map(async ({ id }) => {
      const message = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      return parseEmail(message.data);
    }));
    transactions.push(...batch.filter(Boolean));
  }
  return transactions;
}
