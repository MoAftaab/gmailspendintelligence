import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { google } from 'googleapis';
import { fetchGmailTransactions, gmailConfigured, getGoogleAuthUrl, getOAuthClientFromSession, exchangeCode } from './src/gmail.js';
import { buildInsights, demoTransactions } from './src/analytics.js';

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'local-development-only-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 8
  }
}));

function requireGmail(req, res, next) {
  if (!req.session.tokens) return res.status(401).json({ error: 'Connect Gmail first.' });
  next();
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) => {
  res.json({
    gmailConfigured,
    connected: Boolean(req.session.tokens),
    email: req.session.email || null
  });
});

app.get('/auth/google', (req, res) => {
  if (!gmailConfigured) return res.status(503).send('Google OAuth is not configured. Copy .env.example to .env and add Google credentials.');
  req.session.oauthState = cryptoRandomState();
  res.redirect(getGoogleAuthUrl(req.session.oauthState));
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    if (!req.query.code || req.query.state !== req.session.oauthState) return res.status(400).send('Invalid OAuth callback.');
    const tokens = await exchangeCode(String(req.query.code));
    req.session.tokens = tokens;
    delete req.session.oauthState;
    const auth = getOAuthClientFromSession(req.session);
    const profile = await google.gmail({ version: 'v1', auth }).users.getProfile({ userId: 'me' });
    req.session.email = profile.data.emailAddress || null;
    res.redirect('/?connected=1');
  } catch (error) {
    console.error('OAuth callback failed:', error.message);
    res.status(500).send('Could not connect Gmail. Check the server log for details.');
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/insights', async (req, res) => {
  try {
    if (req.query.demo === '1') return res.json(buildInsights(demoTransactions()));
    if (!req.session.tokens) return res.status(401).json({ error: 'Connect Gmail first.' });
    const auth = getOAuthClientFromSession(req.session);
    const transactions = await fetchGmailTransactions(auth);
    res.json(buildInsights(transactions));
  } catch (error) {
    console.error('Insight generation failed:', error);
    res.status(500).json({ error: 'We could not analyze Gmail right now. Please try again.' });
  }
});

app.get('/api/transactions', requireGmail, async (req, res) => {
  try {
    const auth = getOAuthClientFromSession(req.session);
    const transactions = await fetchGmailTransactions(auth);
    res.json({ transactions });
  } catch (error) {
    console.error('Transaction fetch failed:', error);
    res.status(500).json({ error: 'We could not load transactions right now.' });
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
