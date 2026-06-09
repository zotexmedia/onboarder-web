const path = require('path');
const express = require('express');
require('dotenv').config();

const { runOnboard, tagAccountsByDomain } = require('./core');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, hasKey: !!process.env.INSTANTLY_API_KEY });
});

// Run the onboarder. Body mirrors runOnboard opts (text, apolloSource,
// gmapsSource, brand, tag, accounts, timezone, create).
app.post('/api/onboard', async (req, res) => {
  const logs = [];
  try {
    const b = req.body || {};
    const result = await runOnboard({
      text: b.text,
      apolloSource: b.apolloSource?.trim() || undefined,
      gmapsSource: b.gmapsSource?.trim() || undefined,
      brand: b.brand?.trim() || undefined,
      apolloName: b.apolloName?.trim() || undefined,
      gmapsName: b.gmapsName?.trim() || undefined,
      tag: b.tag?.trim() || undefined,
      noTag: !!b.noTag,
      domains: b.domains || undefined,
      accounts: b.accounts || undefined,
      state: b.state?.trim() || undefined,
      timezone: b.timezone?.trim() || undefined,
      phone: b.phone === false ? false : true,
      create: !!b.create,
    }, (m) => logs.push(m));
    res.json({ ok: true, ...result, logs });
  } catch (err) {
    const detail = err.response?.data || err.message || String(err);
    res.status(400).json({ ok: false, error: typeof detail === 'string' ? detail : JSON.stringify(detail), logs });
  }
});

// Standalone: tag sending accounts by domain (no form / no campaigns).
// Body: { tag, domains, accounts?, apply }. apply=false → dry count.
app.post('/api/tag-accounts', async (req, res) => {
  const logs = [];
  try {
    const b = req.body || {};
    const result = await tagAccountsByDomain({
      tag: b.tag?.trim() || undefined,
      domains: b.domains || undefined,
      accounts: b.accounts || undefined,
      apply: !!b.apply,
    }, (m) => logs.push(m));
    res.json({ ok: true, tag: result, logs });
  } catch (err) {
    const detail = err.response?.data || err.message || String(err);
    res.status(400).json({ ok: false, error: typeof detail === 'string' ? detail : JSON.stringify(detail), logs });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Onboarder web running on :${PORT}`));
