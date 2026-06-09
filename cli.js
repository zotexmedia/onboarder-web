#!/usr/bin/env node
// Thin CLI over core.runOnboard. Reads the form from --input/--text/stdin.
const fs = require('fs');
require('dotenv').config();
const { runOnboard } = require('./core');

function arg(name, short) {
  const i = process.argv.findIndex((a) => a === name || a === short);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(name);

(async () => {
  let text = arg('--text', '-t');
  const input = arg('--input', '-i');
  if (!text && input) text = fs.readFileSync(input, 'utf8');
  if (!text && !process.stdin.isTTY) text = fs.readFileSync(0, 'utf8');

  const result = await runOnboard({
    text,
    apolloSource: arg('--source', '-s') || arg('--apollo-source'),
    gmapsSource: arg('--gmaps-source'),
    brand: arg('--brand'),
    tag: arg('--tag'),
    domains: arg('--domains'),
    accounts: arg('--accounts'),
    timezone: arg('--timezone') || arg('--tz'),
    phone: !has('--no-phone'),
    noTag: has('--no-tag'),
    create: has('--create'),
  }, (m) => console.log(m));

  console.log('\nApollo URL:\n' + result.apolloUrl + '\n');
  console.log(JSON.stringify({ brand: result.brand, timezone: result.timezone, campaigns: result.campaigns.map((c) => ({ kind: c.kind, name: c.name, id: c.id, status: c.status })), tag: result.tag }, null, 2));
})().catch((e) => { console.error('Failed:', e.response?.data || e.message); process.exit(1); });
