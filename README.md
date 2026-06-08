# Onboarder Web

Paste a client onboarding form → get a parsed client record, an Apollo
people-search URL for every serviceable city, and (optionally) duplicated
Instantly campaigns (Apollo "Industry Specific" + "(GMaps)") with **only the
company name + signature swapped**. Also ensures an **account-scoped** Instantly
tag (for the sending accounts, not the campaigns).

## Run locally

```bash
npm install
INSTANTLY_API_KEY=xxxxx npm start      # http://localhost:3000
# or CLI:
INSTANTLY_API_KEY=xxxxx node cli.js -i form.txt -s "ABS ... Industry Specific" --gmaps-source "Regal ... (GMaps)" --brand "ACBC" --create
```

## Web UI

- **Preview** — parse + Apollo link + campaign signature swap, creates nothing.
- **Create in Instantly** — creates the campaigns **paused** and ensures the tag.

## Env

- `INSTANTLY_API_KEY` (required) — Instantly V2 API key.
- `PORT` (optional) — defaults to 3000 (Render sets this automatically).

## Notes

- Sender name comes from the Instantly **sending account**, not the email body.
- Campaign schedule timezone is set from the client's state. Instantly's timezone
  enum is curated (Pacific = `America/Dawson`, Mountain = `America/Boise`,
  Central = `America/Chicago`, Eastern = `America/Detroit`).
- The cloned campaign drops the template's sender accounts/tags and is created paused.
