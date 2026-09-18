import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { google } from 'googleapis';
import { fetchGmailTransactions, getHistoryState, gmailConfigured, getGoogleAuthUrl, getOAuthClientFromSession, exchangeCode } from './src/gmail.js';
import { buildInsights, demoTransactions } from './src/analytics.js';
import { enrichInsightsWithLLM, extractTransactionsWithLLM, llmConfigured } from './src/llm.js';
import { analyzeFinancialText, emailText } from './src/parser.js';
import { chunkCandidates, selectLLMCandidates } from './src/llm-selection.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const scanVersion = 'financial-events-v3';
const sessionSecret = process.env.SESSION_SECRET || 'local-development-only-change-me';
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be configured in production.');
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
// Render terminates HTTPS at its proxy. Trusting the first proxy is required
// for express-session to set and read the secure OAuth cookie correctly.
app.set('trust proxy', 1);
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 8
  },
  proxy: true
}));

function requireGmail(req, res, next) {
  if (!req.session.tokens) return res.status(401).json({ error: 'Connect Gmail first.' });
  next();
}

function friendlyGmailError(error) {
  const code = Number(error?.code || error?.response?.status);
  const reason = error?.errors?.[0]?.reason || error?.response?.data?.error;
  if (code === 401 || reason === 'invalid_grant') return 'Your Gmail connection expired. Disconnect and reconnect Gmail.';
  if (code === 403 && ['accessNotConfigured', 'SERVICE_DISABLED'].includes(reason)) return 'The Gmail API is not enabled for this Google Cloud project.';
  if (code === 403 && ['insufficientPermissions', 'forbidden'].includes(reason)) return 'Gmail permission is missing. Disconnect and reconnect, then approve read-only Gmail access.';
  if (code === 403 && ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded'].includes(reason)) return 'Gmail is temporarily rate-limiting this scan. Wait a minute and try again.';
  if (code === 429) return 'Gmail is temporarily rate-limiting this scan. Wait a minute and try again.';
  return 'We could not analyze Gmail right now. Please try again.';
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) => {
  res.json({
    gmailConfigured,
    llmConfigured,
    connected: Boolean(req.session.tokens),
    email: req.session.email || null
  });
});

app.get('/auth/google', (req, res, next) => {
  if (!gmailConfigured) return res.status(503).send('Google OAuth is not configured. Copy .env.example to .env and add Google credentials.');
  req.session.oauthState = cryptoRandomState();
  req.session.save((error) => {
    if (error) return next(error);
    res.redirect(getGoogleAuthUrl(req.session.oauthState));
  });
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    if (req.query.error) return res.status(400).send('Google sign-in was cancelled or denied. You can try connecting again.');
    const hasCode = Boolean(req.query.code);
    const hasSessionState = Boolean(req.session.oauthState);
    const stateMatches = hasSessionState && req.query.state === req.session.oauthState;
    if (!hasCode || !stateMatches) {
      console.warn('OAuth callback rejected:', { hasCode, hasSessionState, stateMatches });
      return res.status(400).send('OAuth session expired or opened in another tab. Start the Gmail connection again.');
    }
    const tokens = await exchangeCode(String(req.query.code));
    req.session.tokens = tokens;
    delete req.session.oauthState;
    const auth = getOAuthClientFromSession(req.session);
    const profile = await google.gmail({ version: 'v1', auth }).users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress || null;
    await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
    req.session.tokens = tokens;
    req.session.email = email;
    req.session.gmailHistoryId = profile.data.historyId || null;
    req.session.scanRevision = 0;
    res.redirect('/?connected=1');
  } catch (error) {
    console.error('OAuth callback failed:', error.message);
    res.status(error?.code === 401 ? 401 : 500).send(friendlyGmailError(error).replace('analyze Gmail', 'connect Gmail'));
  }
});

app.post('/auth/logout', async (req, res) => {
  try {
    if (req.session.tokens) await getOAuthClientFromSession(req.session).revokeCredentials();
  } catch (error) {
    console.warn('Google token revoke skipped:', error.message);
  }
  req.session.destroy(() => res.json({ ok: true }));
});

async function getGmailScan(req, { sync = false } = {}) {
  const currentScan = req.session.gmailScan?.scanVersion === scanVersion && req.session.gmailScan?.accountEmail === req.session.email ? req.session.gmailScan : null;
  if (currentScan && !sync) return currentScan;
  const auth = getOAuthClientFromSession(req.session);
  if (currentScan && sync && req.session.gmailHistoryId) {
    const history = await getHistoryState(auth, req.session.gmailHistoryId);
    req.session.gmailHistoryId = history.historyId;
    if (!history.changed) return currentScan;
  }
  const scan = await fetchGmailTransactions(auth, { withLLM: false, includeMessages: true });
  scan.scanVersion = scanVersion;
  scan.accountEmail = req.session.email;
  scan.revision = Number(req.session.scanRevision || 0) + 1;
  scan.scanId = `${req.session.email || 'unknown'}:${scan.revision}`;
  req.session.scanRevision = scan.revision;
  req.session.gmailScan = scan;
  try {
    const profile = await google.gmail({ version: 'v1', auth }).users.getProfile({ userId: 'me' });
    req.session.gmailHistoryId = profile.data.historyId || null;
  } catch (error) {
    console.warn('Could not refresh Gmail history cursor:', error.message);
  }
  return scan;
}

async function getAiTransactions(req) {
  const scan = await getGmailScan(req);
  if (scan.aiReady) return scan.transactions;
  if (!llmConfigured) return scan.transactions;
  const limit = Math.min(scan.messages.length, Math.max(1, Math.min(Number(process.env.OPENAI_MAX_EMAILS || 10), 10)));
  const selected = selectLLMCandidates(scan.messages, scan.baselines, scan.messages.length)
    .filter((item) => item.analysis.route === 'UNCERTAIN');
  const enrichedResults = [];
  for (const batch of chunkCandidates(selected, limit)) {
    const results = await extractTransactionsWithLLM(
      batch.map((item) => item.message),
      batch.map((item) => item.baseline)
    );
    batch.forEach((item, index) => enrichedResults.push({ item, result: results[index] }));
  }
  if (req.session.gmailScan?.scanId !== scan.scanId || req.session.gmailScan?.accountEmail !== req.session.email) {
    return req.session.gmailScan?.transactions || [];
  }
  const enrichedByMessageId = new Map();
  const rejectedByAI = [];
  enrichedResults.forEach(({ item, result }) => {
    if (result) {
      enrichedByMessageId.set(item.message.id, result);
      return;
    }
    if (item.analysis.route !== 'UNCERTAIN') return;
    const candidate = item.analysis.candidates?.[0]?.candidate || item.analysis.candidate?.candidate;
    const evidenceText = item.analysis.candidates?.[0]?.evidence || item.analysis.candidate?.evidence;
    const content = emailText(item.message);
    rejectedByAI.push({
      id: item.message.id,
      sourceUrl: `https://mail.google.com/mail/u/0/#all/${item.message.threadId || item.message.id}`,
      subject: content.subject || 'Untitled email',
      sender: content.from || 'Unknown sender',
      snippet: item.message.snippet || content.body.slice(0, 180),
      amount: candidate?.amount || null,
      currency: candidate?.currency || null,
      evidenceText: evidenceText || null,
      label: 'Review needed',
      reason: 'The AI classifier could not validate this email as a completed financial event, so it was excluded from spending totals.'
    });
  });
  scan.transactions = scan.messages.map((message, index) => enrichedByMessageId.get(message.id) || scan.baselines[index]).filter(Boolean);
  scan.reviewMessages = [...(scan.reviewMessages || []), ...rejectedByAI].filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
  scan.aiReady = true;
  req.session.gmailScan = scan;
  return scan.transactions;
}

app.get('/api/insights', async (req, res) => {
  try {
    if (req.query.demo === '1') {
      const data = buildInsights(demoTransactions());
      if (req.query.ai === '1') return res.json(await enrichInsightsWithLLM(data));
      return res.json({ ...data, llmPending: llmConfigured });
    }
    if (!req.session.tokens) return res.status(401).json({ error: 'Connect Gmail first.' });
    const scan = await getGmailScan(req, { sync: req.query.sync === '1' });
    const transactions = req.query.ai === '1' ? await getAiTransactions(req) : scan.transactions;
    const data = buildInsights(transactions);
    data.filteredMessages = scan.filteredMessages || [];
    data.reviewMessages = scan.reviewMessages || [];
    data.scanId = scan.scanId;
    data.scanRevision = scan.revision;
    data.policyVersion = scan.scanVersion;
    if (req.query.ai === '1') return res.json(await enrichInsightsWithLLM(data));
    res.json({ ...data, llmPending: llmConfigured && !scan.aiReady, llmUsed: Boolean(scan.aiReady), llmModel: scan.aiReady ? process.env.OPENAI_MODEL : undefined });
  } catch (error) {
    console.error('Insight generation failed:', error);
    res.status(error?.code === 401 ? 401 : 500).json({ error: friendlyGmailError(error) });
  }
});

app.get('/api/transactions', requireGmail, async (req, res) => {
  try {
    const transactions = (await getGmailScan(req)).transactions;
    res.json({ transactions });
  } catch (error) {
    console.error('Transaction fetch failed:', error);
    res.status(error?.code === 401 ? 401 : 500).json({ error: friendlyGmailError(error).replace('analyze Gmail', 'load transactions') });
  }
});

app.use(express.static('public'));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

function cryptoRandomState() {
  return randomBytes(24).toString('hex');
}

app.listen(port, () => {
  console.log(`Gmail Spend Intelligence running at http://localhost:${port}`);
  if (!gmailConfigured) console.log('Google OAuth is not configured; demo mode is available.');
});
