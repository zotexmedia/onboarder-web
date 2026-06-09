/**
 * Onboarder core logic (shared by the CLI and the web server).
 *
 * Paste a client onboarding form -> parse it, build an Apollo people-search URL
 * for the serviceable cities, and (optionally) duplicate existing client
 * campaigns in Instantly (Apollo "Industry Specific" + "(GMaps)"), swapping ONLY
 * the company name + signature. Also ensures an account-scoped Instantly tag.
 *
 * No console output here — runOnboard() returns structured data and emits
 * progress lines via an optional onLog callback so the CLI and UI can render it.
 */

const axios = require('axios');

const API_BASE = 'https://api.instantly.ai/api/v2';
const TAG_RESOURCE_ACCOUNT = 1; // /custom-tags/toggle-resource: 1=account, 2=campaign

// ── Apollo: fixed title set (only personLocations vary) ──────────────────────
const APOLLO_TITLES = [
  'owner', 'business owner', 'co-owner', 'chief executive officer', 'ceo',
  'president', 'president/ceo', 'chief operating officer', 'coo',
  'vice president of operations', 'vp of operations', 'vice president',
  'partner', 'managing partner', 'founder', 'co-founder', 'founding partner',
  'director of operations', 'operations manager', 'operation manager',
  'district operations manager', 'operations and business manager',
  'director of commercial operations', 'general manager', 'branch manager',
  'district manager', 'area manager', 'regional manager',
  'facilities manager', 'facility manager', 'director of facilities',
  'facilities director', 'facilities management director',
  'property manager', 'senior property manager', 'assistant property manager',
  'director of maintenance', 'maintenance manager', 'regional maintenance manager',
  'manager of cleaning services', 'office manager', 'office administrator',
  'office admin', 'office coordinator', 'administrator', 'business manager',
  'director of administration',
  // added from the lead-generating-titles review (proven converters, flukes removed)
  'project manager', 'senior project manager', 'assistant project manager',
  'executive director', 'managing director', 'executive vice president',
  'senior director of operations', 'regional service manager',
  'deputy director of facilities', 'practice manager', 'community manager',
  // finance / accounting (excl. the HR admin)
  'cfo', 'chief financial officer', 'controller', 'financial controller',
  'financial manager', 'director of finance', 'cfa', 'finance and development administrator',
  // coordinators (project + resource only)
  'project coordinator', 'resource coordinator',
  // industrial / retail / engineering
  'plant manager', 'parts manager', 'pos manager', 'retail manager', 'director of retail operations',
  'warehouse manager', 'warehouse coordinator', 'manufacturing coordinator', 'gse manager',
  'executive estimator', 'sr. dir. engineering', 'operations and events manager',
  // education / clergy / clinical (excl. culinary)
  'pastor', 'principal', 'school principal', 'chief school administrator', 'clinical director',
];

const STATE_ABBR_TO_NAME = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};

// Instantly's campaign-schedule `timezone` is a curated, offset-ordered enum that
// REJECTS America/Los_Angeles/Denver/Phoenix. Tokens (verified against the API):
const TZ_PACIFIC = 'America/Dawson';   // = "Pacific Time (US & Canada)" in the UI
const TZ_MOUNTAIN = 'America/Boise';
const TZ_CENTRAL = 'America/Chicago';
const TZ_EASTERN = 'America/Detroit';
const INSTANTLY_TZ_BY_STATE = {
  CA: TZ_PACIFIC, WA: TZ_PACIFIC, OR: TZ_PACIFIC, NV: TZ_PACIFIC,
  AZ: 'America/Creston', AK: 'America/Anchorage', HI: 'Pacific/Honolulu',
  ID: TZ_MOUNTAIN, MT: TZ_MOUNTAIN, WY: TZ_MOUNTAIN, UT: TZ_MOUNTAIN, CO: TZ_MOUNTAIN, NM: TZ_MOUNTAIN,
  TX: TZ_CENTRAL, OK: TZ_CENTRAL, KS: TZ_CENTRAL, NE: TZ_CENTRAL, SD: TZ_CENTRAL, ND: TZ_CENTRAL,
  MN: TZ_CENTRAL, IA: TZ_CENTRAL, MO: TZ_CENTRAL, AR: TZ_CENTRAL, LA: TZ_CENTRAL, WI: TZ_CENTRAL,
  IL: TZ_CENTRAL, MS: TZ_CENTRAL, AL: TZ_CENTRAL, TN: TZ_CENTRAL,
  NY: TZ_EASTERN, NJ: TZ_EASTERN, PA: TZ_EASTERN, OH: TZ_EASTERN, MI: TZ_EASTERN, IN: TZ_EASTERN,
  KY: TZ_EASTERN, WV: TZ_EASTERN, VA: TZ_EASTERN, NC: TZ_EASTERN, SC: TZ_EASTERN, GA: TZ_EASTERN,
  FL: TZ_EASTERN, MD: TZ_EASTERN, DE: TZ_EASTERN, DC: TZ_EASTERN, CT: TZ_EASTERN, RI: TZ_EASTERN,
  MA: TZ_EASTERN, VT: TZ_EASTERN, NH: TZ_EASTERN, ME: TZ_EASTERN,
};

// ── Parsing ──────────────────────────────────────────────────────────────────
const FIELD_LABELS = [
  ['fullName', /full name\s*:/i],
  ['personalPhone', /personal phone number\s*:/i],
  ['businessName', /full business name\s*:/i],
  ['businessAddress', /business address\s*:/i],
  ['website', /your website\s*:/i],
  ['forwardingEmails', /which email address\(es\)/i],
  ['signaturePhones', /best business phone number[^:]*:/i],
  ['senderNames', /what name\(s\) should we use/i],
  ['cities', /list all possible cities[^:]*:/i],
  ['excludedIndustries', /which industries\s*\/\s*niches[^:]*:/i],
  ['monthlyLeadCap', /(?:what is the\s*)?maximum number of leads[^:]*:/i],
];

function stripPreamble(s) {
  if (!s) return '';
  let v = s;
  const star = v.lastIndexOf(':*');
  if (star !== -1) {
    v = v.slice(star + 2);
  } else {
    const q = v.lastIndexOf('?');
    if (q !== -1) {
      const colon = v.indexOf(':', q);
      if (colon !== -1) v = v.slice(colon + 1);
    }
  }
  return v.replace(/^[\s*]+/, '').replace(/[\s*]+$/, '').trim();
}

function clean(s) { return s ? stripPreamble(s).replace(/\s+/g, ' ').trim() : ''; }
function splitList(s, sep) {
  if (!s) return [];
  return stripPreamble(s).split(sep).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
function isEmail(s) { return /\S+@\S+\.\S+/.test(s); }
function titleCase(s) { return s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase()); }
function parseExcluded(s) {
  if (!s) return [];
  if (/^\s*n\/?a\b/i.test(s)) return [];
  return splitList(s, /[;,]/);
}
function parseLeadCap(s) {
  if (!s) return null;
  const m = /(\d[\d,]*)/.exec(s);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
}

function parseOnboarding(text) {
  const found = [];
  for (const [key, re] of FIELD_LABELS) {
    const m = re.exec(text);
    if (m) found.push({ key, start: m.index, end: m.index + m[0].length });
  }
  found.sort((a, b) => a.start - b.start);
  const raw = {};
  for (let i = 0; i < found.length; i++) {
    const cur = found[i];
    const valEnd = i + 1 < found.length ? found[i + 1].start : text.length;
    raw[cur.key] = text.slice(cur.end, valEnd).trim();
  }
  return {
    fullName: clean(raw.fullName),
    personalPhone: clean(raw.personalPhone),
    businessName: clean(raw.businessName),
    businessAddress: clean(raw.businessAddress),
    website: clean(raw.website),
    forwardingEmails: splitList(raw.forwardingEmails, /[;,]/).filter(isEmail),
    signaturePhones: splitList(raw.signaturePhones, /[;,]/).filter(Boolean),
    senderNames: splitList(raw.senderNames, /[;,]/).filter(Boolean),
    cities: splitList(raw.cities, /,/).map(titleCase).filter(Boolean),
    excludedIndustries: parseExcluded(raw.excludedIndustries),
    monthlyLeadCap: parseLeadCap(raw.monthlyLeadCap),
  };
}

// ── Address / timezone / Apollo ──────────────────────────────────────────────
function normalizeStateAbbr(s) {
  const up = s.trim().toUpperCase();
  if (STATE_ABBR_TO_NAME[up]) return up;
  const hit = Object.entries(STATE_ABBR_TO_NAME).find(([, name]) => name.toUpperCase() === up);
  return hit ? hit[0] : up;
}
function oneLineAddress(addr) {
  if (!addr) return '';
  const re = /^(.*?)[,\s]+([A-Za-z][A-Za-z. ]*?),\s*([A-Za-z]{2,})\.?\s+(\d{5}(?:-\d{4})?)\s*$/;
  const m = re.exec(addr.trim());
  if (!m) return addr.trim().replace(/\s+/g, ' ');
  const [, street, city, stateRaw, zip] = m;
  return `${street.trim().replace(/,$/, '')}, ${city.trim()}, ${normalizeStateAbbr(stateRaw)} ${zip}`;
}
function stateNameFromAddress(addr) {
  const m = /,\s*([A-Za-z]{2,})\.?\s+\d{5}/.exec(addr || '');
  if (!m) return null;
  return STATE_ABBR_TO_NAME[normalizeStateAbbr(m[1])] || null;
}
function resolveTimezone(opts, addr) {
  if (opts.timezone) return opts.timezone;
  const m = /,\s*([A-Za-z]{2,})\.?\s+\d{5}/.exec(addr || '');
  if (!m) return null;
  return INSTANTLY_TZ_BY_STATE[normalizeStateAbbr(m[1])] || null;
}
function buildApolloUrl(cities, stateName) {
  const parts = [];
  parts.push(`contactEmailStatusV2[]=${encodeURIComponent('verified')}`);
  for (const t of APOLLO_TITLES) parts.push(`personTitles[]=${encodeURIComponent(t)}`);
  parts.push('sortAscending=false');
  parts.push(`sortByField=${encodeURIComponent('[none]')}`);
  parts.push(`prospectedByCurrentTeam[]=${encodeURIComponent('no')}`);
  parts.push('includeSimilarTitles=false'); // exact-title match only (no Apollo title expansion)
  for (const c of cities) parts.push(`personLocations[]=${encodeURIComponent(stateName ? `${c}, ${stateName}` : c)}`);
  parts.push('page=1');
  return `https://app.apollo.io/#/people?${parts.join('&')}`;
}

// ── Instantly API ────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function instantlyClient(apiKey) {
  const key = apiKey || process.env.INSTANTLY_API_KEY;
  if (!key) throw new Error('INSTANTLY_API_KEY not set');
  return axios.create({ baseURL: API_BASE, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
}
async function withRetry(fn, label = 'request', maxRetries = 7) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); }
    catch (err) {
      if (err.response?.status === 429 && attempt < maxRetries) { await sleep(Math.min(2000 * 2 ** attempt, 32000)); continue; }
      throw err;
    }
  }
}
async function resolveSourceCampaign(client, source) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(source)) {
    const { data } = await withRetry(() => client.get(`/campaigns/${source}`), 'get campaign');
    return data;
  }
  const { data } = await withRetry(() => client.get('/campaigns', { params: { search: source, limit: 20 } }), 'search campaigns');
  const items = data?.items || [];
  const exact = items.find((c) => c.name.trim().toLowerCase() === source.trim().toLowerCase());
  const pick = exact || items[0];
  if (!pick) throw new Error(`No campaign found matching "${source}"`);
  const { data: full } = await withRetry(() => client.get(`/campaigns/${pick.id}`), 'get campaign');
  return full;
}
// Search existing custom tags (for the UI's tag-picker dropdown).
async function searchTags(query, apiKey, limit = 25) {
  const client = instantlyClient(apiKey);
  const { data } = await withRetry(
    () => client.get('/custom-tags', { params: { search: query || '', limit } }), 'search tags');
  return (data?.items || []).map((t) => ({ id: t.id, label: t.label }));
}
async function ensureTag(client, label) {
  const { data } = await withRetry(() => client.get('/custom-tags', { params: { search: label, limit: 20 } }), 'search tags');
  const existing = (data?.items || []).find((t) => (t.label || '').toLowerCase() === label.toLowerCase());
  if (existing) return { ...existing, _created: false };
  const { data: created } = await withRetry(() => client.post('/custom-tags', { label }), 'create tag');
  return { ...created, _created: true };
}
// An Instantly account's resource_id for /custom-tags/toggle-resource is its
// EMAIL (the /accounts `id` field is always null). Verified live 2026-06-09.
async function assignTagToAccounts(client, tagId, accountEmails) {
  return withRetry(() => client.post('/custom-tags/toggle-resource', {
    resource_ids: accountEmails, resource_type: TAG_RESOURCE_ACCOUNT, assign: true, tag_ids: [tagId],
  }), 'assign tag to accounts');
}

function normalizeDomain(d) {
  return String(d || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '')
    .replace(/\/.*$/, '').replace(/^@/, '').trim();
}
function domainOf(email) {
  const at = String(email || '').lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).toLowerCase().trim();
}

// Paginate every sending account (cursor = next_starting_after).
async function listAllAccounts(client) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 1000; i++) {
    const params = { limit: 100 };
    if (cursor) params.starting_after = cursor;
    const { data } = await withRetry(() => client.get('/accounts', { params }), 'list accounts');
    const items = data?.items || [];
    out.push(...items);
    cursor = data?.next_starting_after;
    if (!cursor || items.length === 0) break;
  }
  return out;
}

// Resolve client domains -> the sending-account emails to tag.
async function resolveAccountsByDomains(client, domains) {
  const wanted = new Set(domains.map(normalizeDomain).filter(Boolean));
  if (!wanted.size) return { emails: [], byDomain: {}, missingDomains: [] };
  const accounts = await listAllAccounts(client);
  const byDomain = {};
  for (const d of wanted) byDomain[d] = [];
  for (const a of accounts) {
    const dom = domainOf(a.email);
    if (wanted.has(dom)) byDomain[dom].push(a.email);
  }
  const emails = Object.values(byDomain).flat();
  const missingDomains = [...wanted].filter((d) => byDomain[d].length === 0);
  return { emails, byDomain, missingDomains };
}

// Double-check: read the tag's resources back and confirm every email is present.
async function verifyTagOnAccounts(client, tagId, emails) {
  const tagged = new Set();
  let cursor = null;
  for (let i = 0; i < 1000; i++) {
    const params = { limit: 100, tag_ids: tagId };
    if (cursor) params.starting_after = cursor;
    const { data } = await withRetry(() => client.get('/accounts', { params }), 'verify tag accounts');
    const items = data?.items || [];
    for (const a of items) tagged.add((a.email || '').toLowerCase());
    cursor = data?.next_starting_after;
    if (!cursor || items.length === 0) break;
  }
  const missing = emails.filter((e) => !tagged.has(e.toLowerCase()));
  return { ok: missing.length === 0, verifiedCount: emails.length - missing.length, missing };
}

/**
 * Standalone: tag the sending accounts on given domains with a client tag.
 * Independent of onboarding/campaign creation — run it whenever the accounts exist.
 * @param {object} opts { tag, domains (csv|array), accounts (csv|array of emails),
 *   apply (bool — false = dry count only), apiKey }
 * @returns {Promise<object>} { label, id, domains, byDomain, missingDomains,
 *   resolvedAccounts, applied, verified }
 */
async function tagAccountsByDomain(opts = {}, onLog = () => {}) {
  const log = (m) => onLog(m);
  const label = (opts.tag || '').trim();
  if (!label) throw new Error('Tag label is required.');
  const domains = (Array.isArray(opts.domains)
    ? opts.domains
    : String(opts.domains || '').split(/[,\s]+/)).map(normalizeDomain).filter(Boolean);
  const explicitEmails = (Array.isArray(opts.accounts)
    ? opts.accounts
    : String(opts.accounts || '').split(/[,\s]+/)).map((s) => s.trim()).filter(Boolean);
  if (!domains.length && !explicitEmails.length) throw new Error('Provide at least one sending domain (or account email).');

  const client = instantlyClient(opts.apiKey);
  const out = {
    label, id: null, domains, byDomain: {}, missingDomains: [],
    resolvedAccounts: [], applied: !!opts.apply, verified: null,
  };

  let emails = [...explicitEmails];
  if (domains.length) {
    log(`Resolving accounts for ${domains.length} domain(s): ${domains.join(', ')}…`);
    const res = await resolveAccountsByDomains(client, domains);
    out.byDomain = res.byDomain;
    out.missingDomains = res.missingDomains;
    for (const [d, list] of Object.entries(res.byDomain)) log(`  ${d}: ${list.length} account(s)`);
    if (res.missingDomains.length) log(`  ⚠️ no accounts found for: ${res.missingDomains.join(', ')}`);
    emails = [...new Set([...emails, ...res.emails])];
  }
  out.resolvedAccounts = emails;

  if (!emails.length) { log('No accounts matched — nothing to tag.'); return out; }

  if (!opts.apply) {
    log(`Dry run: ${emails.length} account(s) would get tag "${label}". Not applied.`);
    return out;
  }

  const tag = await ensureTag(client, label);
  out.id = tag.id;
  log(`Tag "${label}" ${tag._created ? 'created' : 'already existed'} (${tag.id}).`);
  await assignTagToAccounts(client, tag.id, emails);
  log(`Applied tag to ${emails.length} account(s); verifying…`);
  const check = await verifyTagOnAccounts(client, tag.id, emails);
  out.verified = check;
  if (check.ok) log(`✅ Verified tag on all ${check.verifiedCount} account(s).`);
  else log(`❌ Verification FAILED: ${check.missing.length} account(s) missing the tag.`);
  return out;
}

// ── Signature swap ───────────────────────────────────────────────────────────
function detectSignature(body) {
  const anchor = '{{sendingAccountName}}</div>';
  const idx = body.indexOf(anchor);
  if (idx === -1) return null;
  const after = body.slice(idx + anchor.length);
  const lines = [];
  const re = /<div[^>]*>(.*?)<\/div>/gis;
  let m;
  while ((m = re.exec(after)) !== null) {
    const inner = m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;| /g, ' ').trim();
    if (!inner || /^if this is not relevant/i.test(inner) || /unsubscribe|opt out|reply\s*"/i.test(inner)) break;
    lines.push(inner);
    if (lines.length >= 4) break;
  }
  if (lines.length === 0) return null;
  return { company: lines[0], addressLines: lines.slice(1) };
}
function firstSignatureBody(source) {
  for (const seq of source.sequences || [])
    for (const step of seq.steps || [])
      for (const v of step.variants || [])
        if (v.body && v.body.includes('{{sendingAccountName}}')) return v.body;
  return null;
}
function replaceAll(haystack, from, to) { return from ? haystack.split(from).join(to) : haystack; }
function applySwap(text, swap) {
  let out = replaceAll(text, swap.oldCompany, swap.newCompany);
  const phoneSuffix = swap.phone ? `</div><div>${swap.phone}` : '';
  const replacement = `${swap.newAddress}${phoneSuffix}`;
  const old = swap.oldAddressLines || [];
  if (old.length) {
    out = replaceAll(out, old.join('</div><div>'), replacement);
    out = replaceAll(out, old.join(', '), replacement);
  }
  return out;
}
function buildSwap(source, opts, parsed) {
  const brand = opts.brand || parsed.businessName;
  const detected = detectSignature(firstSignatureBody(source) || '');
  return {
    oldCompany: opts.sourceCompany || detected?.company || '',
    newCompany: brand,
    oldAddressLines: detected?.addressLines || [],
    newAddress: oneLineAddress(parsed.businessAddress),
    phone: opts.phone === false ? '' : (parsed.signaturePhones[0] || ''),
  };
}
function cloneSequences(source, swap) {
  return (source.sequences || []).map((seq) => ({
    steps: (seq.steps || []).map((step) => ({
      type: step.type, delay: step.delay, delay_unit: step.delay_unit, pre_delay_unit: step.pre_delay_unit,
      variants: (step.variants || []).map((v) => ({
        subject: applySwap(v.subject || '', swap),
        body: applySwap(v.body || '', swap),
        ...(v.v_disabled !== undefined ? { v_disabled: v.v_disabled } : {}),
      })),
    })),
  }));
}
function buildCreatePayload(source, swap, newName, timezone) {
  const carry = [
    'campaign_schedule', 'daily_limit', 'stop_on_reply', 'stop_on_auto_reply',
    'link_tracking', 'open_tracking', 'text_only', 'first_email_text_only',
    'random_wait_max', 'prioritize_new_leads', 'match_lead_esp', 'stop_for_company',
    'insert_unsubscribe_header', 'allow_risky_contacts', 'disable_bounce_protect',
    'cc_list', 'bcc_list',
  ];
  const payload = { name: newName, sequences: cloneSequences(source, swap) };
  for (const k of carry) if (source[k] !== undefined) payload[k] = source[k];
  if (timezone && payload.campaign_schedule?.schedules) {
    payload.campaign_schedule = {
      ...payload.campaign_schedule,
      schedules: payload.campaign_schedule.schedules.map((s) => ({ ...s, timezone })),
    };
  }
  return payload;
}
function sigBlock(body) {
  const idx = body.indexOf('{{sendingAccountName}}');
  if (idx === -1) return '';
  return body.slice(idx, idx + 400).split(/<\/div>/i)
    .map((s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;| /g, ' ').trim())
    .filter(Boolean).slice(0, 5).join('\n');
}
function sigPreview(source, swap) {
  const body = firstSignatureBody(source);
  if (!body) return null;
  return { before: sigBlock(body), after: sigBlock(applySwap(body, swap)) };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────
/**
 * @param {object} opts { text, apolloSource, gmapsSource, brand, apolloName,
 *   gmapsName, tag, noTag, domains (csv|array of sending domains to tag),
 *   accounts (csv|array of explicit account emails), state, timezone,
 *   sourceCompany, phone (bool), create (bool), apiKey }
 * @param {(msg:string)=>void} [onLog]
 * @returns {Promise<object>} structured result
 */
async function runOnboard(opts = {}, onLog = () => {}) {
  const log = (m) => { onLog(m); };
  if (!opts.text || !opts.text.trim()) throw new Error('No onboarding text provided.');

  const parsed = parseOnboarding(opts.text);
  const brand = opts.brand || parsed.businessName;
  if (!brand) throw new Error('Could not determine brand/business name — set it explicitly.');
  const stateName = opts.state || stateNameFromAddress(parsed.businessAddress) || null;
  const timezone = resolveTimezone(opts, parsed.businessAddress);
  const apolloUrl = buildApolloUrl(parsed.cities, stateName);
  log(`Parsed ${parsed.cities.length} cities for ${brand} (${stateName || 'state n/a'}).`);

  const jobs = [];
  if (opts.apolloSource) jobs.push({ kind: 'apollo', source: opts.apolloSource, name: opts.apolloName || `${brand} Industry Specific` });
  if (opts.gmapsSource) jobs.push({ kind: 'gmaps', source: opts.gmapsSource, name: opts.gmapsName || `${brand} (GMaps)` });

  const campaigns = [];
  const tagOut = {
    label: opts.noTag ? null : (opts.tag || brand), id: null, scope: 'accounts',
    domains: [], taggedAccounts: [], byDomain: {}, missingDomains: [], verified: null,
  };

  if (jobs.length) {
    const client = instantlyClient(opts.apiKey);
    for (const job of jobs) {
      log(`Fetching ${job.kind} template "${job.source}"…`);
      const source = await resolveSourceCampaign(client, job.source);
      const swap = buildSwap(source, opts, parsed);
      const payload = buildCreatePayload(source, swap, job.name, timezone);
      const srcTz = source.campaign_schedule?.schedules?.[0]?.timezone || null;
      const prev = sigPreview(source, swap);
      const entry = {
        kind: job.kind, templateName: source.name, name: job.name,
        companySwap: { from: swap.oldCompany, to: swap.newCompany },
        addressSwap: { from: swap.oldAddressLines, to: swap.newAddress, phone: swap.phone || null },
        timezone: timezone || srcTz, templateTimezone: srcTz,
        signatureBefore: prev?.before || null, signatureAfter: prev?.after || null,
        status: 'preview', id: null, url: null,
      };
      if (opts.create) {
        log(`Creating ${job.kind} campaign "${job.name}" in Instantly…`);
        const { data } = await withRetry(() => client.post('/campaigns', payload), 'create campaign');
        entry.id = data.id;
        entry.url = `https://app.instantly.ai/app/campaign/${data.id}`;
        entry.status = 'draft';
        log(`✅ Created ${job.kind}: ${data.id}`);
        await sleep(800);
      }
      campaigns.push(entry);
    }

    if (!opts.noTag) {
      // Domains whose sending accounts should get the client tag.
      const domains = (Array.isArray(opts.domains)
        ? opts.domains
        : String(opts.domains || '').split(/[,\s]+/)).map(normalizeDomain).filter(Boolean);
      // Explicit account emails (optional) tag in addition to domain-resolved ones.
      const explicitEmails = (Array.isArray(opts.accounts)
        ? opts.accounts
        : String(opts.accounts || '').split(/[,\s]+/)).map((s) => s.trim()).filter(Boolean);
      tagOut.domains = domains;

      if (opts.create) {
        const tag = await ensureTag(client, tagOut.label);
        tagOut.id = tag.id;
        log(`Tag "${tagOut.label}" ${tag._created ? 'created' : 'already existed'} (${tag.id}).`);

        let emails = [...explicitEmails];
        if (domains.length) {
          log(`Resolving accounts for ${domains.length} domain(s): ${domains.join(', ')}…`);
          const res = await resolveAccountsByDomains(client, domains);
          tagOut.byDomain = res.byDomain;
          tagOut.missingDomains = res.missingDomains;
          for (const [d, list] of Object.entries(res.byDomain)) log(`  ${d}: ${list.length} account(s)`);
          if (res.missingDomains.length) log(`  ⚠️ no accounts found for: ${res.missingDomains.join(', ')}`);
          emails = [...new Set([...emails, ...res.emails])];
        }

        if (emails.length) {
          await assignTagToAccounts(client, tag.id, emails);
          tagOut.taggedAccounts = emails;
          log(`Applied tag to ${emails.length} account(s); verifying…`);
          const check = await verifyTagOnAccounts(client, tag.id, emails);
          tagOut.verified = check;
          if (check.ok) {
            log(`✅ Verified tag on all ${check.verifiedCount} account(s).`);
          } else {
            log(`❌ Verification FAILED: ${check.missing.length} account(s) missing the tag (e.g. ${check.missing.slice(0, 3).join(', ')}).`);
          }
        } else {
          log('No account emails resolved to tag (provide domains or account emails).');
        }
      }
    }
  }

  return {
    parsed, brand, stateName, timezone,
    signatureAddress: oneLineAddress(parsed.businessAddress),
    apolloUrl, campaigns, tag: tagOut,
    created: !!opts.create,
    createdAt: new Date().toISOString(),
  };
}

module.exports = {
  parseOnboarding, buildApolloUrl, oneLineAddress, stateNameFromAddress, resolveTimezone,
  runOnboard, APOLLO_TITLES, INSTANTLY_TZ_BY_STATE,
  instantlyClient, ensureTag, assignTagToAccounts, verifyTagOnAccounts,
  resolveAccountsByDomains, listAllAccounts, normalizeDomain, domainOf,
  tagAccountsByDomain, searchTags,
};
