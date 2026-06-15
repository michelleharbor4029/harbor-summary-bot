# harbor-summary-bot

Slack bot for Harbor Capital. Drop a document into a channel and the bot
downloads it, extracts the real content (including filled PDF form fields and
redlines), and posts a structured deal abstraction back in-thread.

## What it extracts

- **PDF** — body text, filled form-field values ("blue text" on TAR/TREC/AIR
  forms), and PDF comment/markup annotations (redline notes).
- **Word (.docx)** — body text plus tracked changes (ADDED / DELETED), across
  the document body, headers, and footers.
- **Text** — `.txt`, `.csv`, `.md`, `.json`, `.xml`, `.html`, `.log`.

Scanned/image PDFs and unsupported types get a clear message in-thread instead
of failing silently.

## Output

For each file the bot replies with a structured abstraction (document type,
parties, property, financials, key dates, key terms, redlines, risk flags, and
a confidence rating). If structured extraction ever fails it automatically
falls back to a plain prose summary, so the bot never goes silent.

## Setup

```bash
npm install
npm start          # listens on $PORT or 3000
```

### Required environment variables

| Variable | Purpose |
|---|---|
| `SLACK_BOT_TOKEN` | Slack bot token (needs the `files:read` scope) |
| `SLACK_SIGNING_SECRET` | Slack request signing secret |
| `ANTHROPIC_API_KEY` | Anthropic API key |

The bot validates these at startup and exits with a clear error if any are missing.

### Optional: Google Sheets deal tracker

If these are set, every abstracted document also appends a row to a deal-tracker
spreadsheet (one row per file). Leave them unset to disable — the Slack reply is
unaffected either way, and any Sheets error is logged without breaking the reply.

| Variable | Purpose |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Service-account JSON (stringified). Enable the Google Sheets API and share the sheet with the service account's `client_email`. |
| `DEAL_SHEET_ID` | Spreadsheet ID (from its URL) |
| `DEAL_SHEET_TAB` | Optional tab name (default `Deals`) |

The header row is created automatically on first write.

## Tests

```bash
npm test           # pure logic: extraction, redlines, rendering, sheet mapping
```

No network, Slack, or Anthropic calls — runs offline.

## Layout

| File | Responsibility |
|---|---|
| `index.js` | Slack wiring, file download, extraction routing, runtime |
| `abstract.js` | Claude prompting, JSON schema, structured → Slack rendering |
| `sheets.js` | Optional Google Sheets export |
| `test.js` | Offline unit tests |
