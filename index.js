const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const { getDocument } = require('pdfjs-dist/legacy/build/pdf.mjs');
const JSZip = require('jszip');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const REQUIRED_ENV = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'ANTHROPIC_API_KEY'];
const CLAUDE_MODEL = 'claude-sonnet-4-6'; // drop-in for retired claude-sonnet-4-20250514
const CLAUDE_MAX_TOKENS = 2048;
const MIN_TEXT_LENGTH = 50; // below this, extraction effectively failed
const MAX_CONTENT_CHARS = 24000; // ~6-8k tokens; long docs are truncated with a note
const MAX_DEDUPE_ENTRIES = 1000;
const DEFAULT_PORT = 3000;

// .docx parts that can contain body text and tracked changes
const DOCX_TEXT_PARTS = /(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

const log = (...args) => console.log('[harbor-bot]', ...args);
const logError = (...args) => console.error('[harbor-bot]', ...args);

const PROMPT = `Summarize this document for Harbor Capital.

Extract key facts. Skip blank or empty fields entirely.

For contracts/leases: Landlord/Seller, Tenant/Buyer, Property address, SF, Term, Rent/Price, Earnest money, Closing date, Key terms
For due diligence: Property, Date, Consultant, Findings, Recommendations, Costs
For financials: Property, Date, Key totals, NOI, Returns
For invoices/estimates: Vendor, Amount, Description, Due date

The extracted text may include tagged extras. Treat these as authoritative content and include them:
- [FIELD name: value] = a filled-in form field (often the key deal terms on TAR/TREC forms)
- [COMMENT: ...] = a reviewer comment or markup/redline note from the PDF
- ADDED: / DELETED: lines under "TRACKED CHANGES" = Word redline edits

If this document contains REDLINES or TRACK CHANGES:
- First summarize the current/clean version of the document
- Then list the key changes that were redlined, added, or deleted
- Format changes as: "CHANGED: [what was modified]" or "ADDED: [new text]" or "DELETED: [removed text]"

FORMAT RULES:
- Start each line with a dash (-)
- NO headers, NO bold, NO asterisks, NO markdown
- Skip empty fields - do not say "not specified" or "blank"
- Just plain facts, one per line`;

// ---------------------------------------------------------------------------
// File-type routing
// ---------------------------------------------------------------------------
function getFileKind(file) {
  const name = (file.name || '').toLowerCase();
  const mime = file.mimetype || '';
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (mime.includes('wordprocessingml') || name.endsWith('.docx')) return 'docx';
  if (mime.startsWith('text/') || /\.(txt|csv|md|json|xml|html?|log)$/.test(name)) return 'text';
  return 'unsupported';
}

// ---------------------------------------------------------------------------
// PDF extraction: body text + form-field values ("blue text") + comments/redlines
// ---------------------------------------------------------------------------
function formatFieldValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(formatFieldValue).filter(Boolean).join(', ');
  const str = String(value).trim();
  if (!str || str === 'Off') return ''; // unchecked checkbox / empty
  return str;
}

async function extractPdfFormFields(doc) {
  const parts = [];
  const fieldObjects = await doc.getFieldObjects().catch(() => null);
  if (fieldObjects) {
    for (const [name, instances] of Object.entries(fieldObjects)) {
      for (const field of instances) {
        const value = formatFieldValue(field.value);
        if (value) parts.push('[FIELD ' + name + ': ' + value + ']');
      }
    }
  }
  return { parts, hasFieldObjects: Boolean(fieldObjects) };
}

async function extractPdfAnnotations(doc, hasFieldObjects) {
  const parts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const annotations = await page.getAnnotations();
    for (const annot of annotations) {
      // Fall back to widget values only when getFieldObjects gave us nothing
      if (!hasFieldObjects && annot.fieldValue) {
        const value = formatFieldValue(annot.fieldValue);
        if (value) parts.push('[FIELD ' + (annot.fieldName || '') + ': ' + value + ']');
      }
      // Sticky-note / markup comments — i.e. PDF redline notes
      if (annot.contents) parts.push('[COMMENT: ' + String(annot.contents).trim() + ']');
    }
  }
  return parts;
}

async function extractPdfText(buffer) {
  const parts = [];

  try {
    const parsed = await pdf(buffer);
    if (parsed.text) parts.push(parsed.text);
  } catch (e) {
    logError('pdf-parse failed:', e.message);
  }

  try {
    const doc = await getDocument({ data: new Uint8Array(buffer) }).promise;
    const fields = await extractPdfFormFields(doc);
    parts.push(...fields.parts);
    parts.push(...(await extractPdfAnnotations(doc, fields.hasFieldObjects)));
  } catch (e) {
    logError('pdfjs extraction failed:', e.message);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// DOCX extraction: clean text + tracked changes (redlines)
// ---------------------------------------------------------------------------
function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function textFromTags(xml, tag) {
  const pattern = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'g');
  let out = '';
  for (const match of xml.matchAll(pattern)) out += match[1];
  return decodeXmlEntities(out);
}

function collectTrackedChanges(xml) {
  const changes = [];
  for (const match of xml.matchAll(/<w:ins\b[^>]*>([\s\S]*?)<\/w:ins>/g)) {
    const text = textFromTags(match[1], 'w:t').trim();
    if (text) changes.push('ADDED: ' + text);
  }
  for (const match of xml.matchAll(/<w:del\b[^>]*>([\s\S]*?)<\/w:del>/g)) {
    const text = textFromTags(match[1], 'w:delText').trim();
    if (text) changes.push('DELETED: ' + text);
  }
  return changes;
}

async function extractDocxText(buffer) {
  let cleanText = '';
  try {
    const result = await mammoth.extractRawText({ buffer });
    cleanText = result.value || '';
  } catch (e) {
    logError('mammoth failed:', e.message);
  }

  let changes = [];
  try {
    const zip = await JSZip.loadAsync(buffer);
    const parts = Object.keys(zip.files).filter(
      (p) => p.startsWith('word/') && DOCX_TEXT_PARTS.test(p)
    );
    for (const part of parts) {
      const xml = await zip.file(part).async('string');
      changes = changes.concat(collectTrackedChanges(xml));
    }
  } catch (e) {
    logError('docx track-change parse failed:', e.message);
  }

  if (changes.length === 0) return cleanText;
  return cleanText + '\n\n--- TRACKED CHANGES ---\n' + changes.join('\n');
}

async function extractByKind(kind, buffer) {
  if (kind === 'pdf') return extractPdfText(buffer);
  if (kind === 'docx') return extractDocxText(buffer);
  return buffer.toString('utf8'); // text
}

function clampContent(text) {
  if (text.length <= MAX_CONTENT_CHARS) return { content: text, truncated: false };
  return { content: text.slice(0, MAX_CONTENT_CHARS), truncated: true };
}

// ---------------------------------------------------------------------------
// Slack file download (single body read; detects auth/HTML fallback pages)
// ---------------------------------------------------------------------------
async function downloadFile(file) {
  const response = await fetch(file.url_private, {
    headers: { Authorization: 'Bearer ' + process.env.SLACK_BOT_TOKEN },
  });
  if (!response.ok) {
    throw new Error('Slack download failed: ' + response.status + ' ' + response.statusText);
  }
  const contentType = response.headers.get('content-type') || '';
  const buffer = Buffer.from(await response.arrayBuffer());
  if (contentType.includes('text/html')) {
    throw new Error('Slack returned an HTML page instead of the file — check the bot token has the files:read scope');
  }
  return buffer;
}

function assertEnv() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error('Missing required environment variables: ' + missing.join(', '));
  }
}

module.exports = {
  getFileKind,
  formatFieldValue,
  decodeXmlEntities,
  textFromTags,
  collectTrackedChanges,
  extractDocxText,
  extractPdfText,
  extractByKind,
  clampContent,
};

// ---------------------------------------------------------------------------
// Runtime (only when executed directly, so the helpers above stay testable)
// ---------------------------------------------------------------------------
function main() {
  assertEnv();

  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: false,
  });
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const processedEvents = new Set();

  async function summarizeWithClaude(content) {
    const message = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      messages: [{ role: 'user', content: PROMPT + '\n\n' + content }],
    });
    const block = message.content.find((b) => b.type === 'text');
    return block ? block.text : '(no summary produced)';
  }

  async function reply(client, event, text) {
    await client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text });
  }

  async function handleFile(file, event, client) {
    if (!file.url_private) {
      log('skip (no url_private):', file.name);
      return;
    }

    const kind = getFileKind(file);
    if (kind === 'unsupported') {
      await reply(client, event, `I can't read "${file.name}" yet — I support PDF, Word (.docx), and text files.`);
      return;
    }

    log('processing', file.name, file.mimetype, file.size);
    const buffer = await downloadFile(file);
    const text = await extractByKind(kind, buffer);

    if (!text || text.trim().length < MIN_TEXT_LENGTH) {
      await reply(
        client,
        event,
        `I downloaded "${file.name}" but couldn't extract readable text. If it's a scanned/image PDF, run OCR (or export a text-based PDF) and re-upload.`
      );
      return;
    }

    const { content, truncated } = clampContent(text);
    const summary = await summarizeWithClaude(content);
    const note = truncated ? '\n\n(Note: document was long; this summary covers the first part.)' : '';
    await reply(client, event, `Summary of ${file.name}:\n${summary}${note}`);
  }

  app.event('message', async ({ event, client }) => {
    // Ignore edits/deletions/joins/bot posts and messages without files
    if (event.subtype && event.subtype !== 'file_share') return;
    if (event.bot_id) return;
    if (!event.files || event.files.length === 0) return;

    // Dedupe: Slack can redeliver the same event
    const dedupeKey = event.client_msg_id || event.channel + ':' + event.ts;
    if (processedEvents.has(dedupeKey)) return;
    if (processedEvents.size > MAX_DEDUPE_ENTRIES) processedEvents.clear();
    processedEvents.add(dedupeKey);

    for (const file of event.files) {
      try {
        await handleFile(file, event, client);
      } catch (err) {
        logError('error processing', file && file.name, err);
        await reply(
          client,
          event,
          `Sorry — I hit an error reading "${(file && file.name) || 'that file'}": ${err.message}`
        ).catch(() => {});
      }
    }
  });

  (async () => {
    await app.start(process.env.PORT || DEFAULT_PORT);
    log('Harbor Summary Bot is running');
  })();
}

if (require.main === module) {
  main();
}
