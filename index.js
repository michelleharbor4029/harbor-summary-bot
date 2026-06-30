const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const { getDocument } = require('pdfjs-dist/legacy/build/pdf.mjs');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');
const { abstractDocument, summarizeFallback, ocrPdf, renderAbstract } = require('./abstract');
const sheets = require('./sheets');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const REQUIRED_ENV = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'ANTHROPIC_API_KEY'];
const MIN_TEXT_LENGTH = 50; // below this, extraction effectively failed
const MAX_CONTENT_CHARS = 24000; // ~6-8k tokens; long docs are truncated with a note
const MAX_VISION_BYTES = 30 * 1024 * 1024; // Anthropic's request limit is 32MB; stay under it for PDF OCR + images
const MAX_DEDUPE_ENTRIES = 1000;
const DEFAULT_PORT = 3000;

// .docx parts that can contain body text and tracked changes
const DOCX_TEXT_PARTS = /(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

const log = (...args) => console.log('[harbor-bot]', ...args);
const logError = (...args) => console.error('[harbor-bot]', ...args);

// ---------------------------------------------------------------------------
// File-type routing
// ---------------------------------------------------------------------------
function getFileKind(file) {
  const name = (file.name || '').toLowerCase();
  const mime = file.mimetype || '';
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (mime.includes('wordprocessingml') || name.endsWith('.docx')) return 'docx';
  if (mime.includes('spreadsheetml') || /\.xlsx$/.test(name)) return 'xlsx';
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/.test(name)) return 'image';
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

// ---------------------------------------------------------------------------
// XLSX extraction: read actual cell values (incl. cached formula results) sheet
// by sheet, as tab-separated rows so the LLM sees the real numbers and labels.
// ---------------------------------------------------------------------------
function formatExcelDate(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD — what an analyst wants
}

function cellToString(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return formatExcelDate(v);
  if (typeof v === 'object') {
    if (v.result !== null && v.result !== undefined) {
      return v.result instanceof Date ? formatExcelDate(v.result) : String(v.result); // formula w/ cached result
    }
    if (v.formula !== undefined) return ''; // formula, no cached value
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if (v.text !== undefined) return String(v.text); // hyperlink
    if (v.error) return String(v.error);
    return cell.text || '';
  }
  return String(v);
}

async function extractXlsxText(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheets = [];
  workbook.eachSheet((sheet) => {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      // includeEmpty:true fills internal gaps so columns stay aligned within a row
      row.eachCell({ includeEmpty: true }, (cell) => cells.push(cellToString(cell)));
      const line = cells.join('\t');
      if (line.trim()) rows.push(line);
    });
    if (rows.length) sheets.push('--- SHEET: ' + sheet.name + ' ---\n' + rows.join('\n'));
  });
  return sheets.join('\n\n');
}

async function extractByKind(kind, buffer) {
  if (kind === 'pdf') return extractPdfText(buffer);
  if (kind === 'docx') return extractDocxText(buffer);
  if (kind === 'xlsx') return extractXlsxText(buffer);
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
  extractXlsxText,
  cellToString,
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

  // Returns { text } for the Slack reply, and { abstract } when structured
  // extraction succeeded (used for the optional Sheets export). Falls back to a
  // prose summary so the bot never goes silent if structured output fails.
  async function summarizeContent(content, fileName, truncated) {
    try {
      const abstract = await abstractDocument(anthropic, content);
      return { text: renderAbstract(abstract, fileName, truncated), abstract };
    } catch (e) {
      logError('structured abstraction failed, using prose fallback:', e.message);
      const prose = await summarizeFallback(anthropic, content);
      const note = truncated ? '\n\n(Note: document was long; this summary covers the first part.)' : '';
      return { text: `Summary of ${fileName}:\n${prose}${note}`, abstract: null };
    }
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

    // Images are intentionally ignored — the bot does not reply to image uploads.
    if (kind === 'image') {
      log('skip (image upload, not replying):', file.name);
      return;
    }

    if (kind === 'unsupported') {
      await reply(
        client,
        event,
        `I can't read "${file.name}" yet — I support PDF, Word (.docx), Excel (.xlsx), and text files.`
      );
      return;
    }

    if (kind !== 'text' && file.size > MAX_VISION_BYTES) {
      await reply(
        client,
        event,
        `I downloaded "${file.name}" but it's too large (${Math.round(file.size / 1024 / 1024)}MB) for me to process. Please split it or send a smaller file.`
      );
      return;
    }

    log('processing', file.name, file.mimetype, file.size);
    const buffer = await downloadFile(file);
    let text = await extractByKind(kind, buffer);

    // Scanned / image-only PDFs have no embedded text layer. Rather than asking
    // the user to OCR and re-upload, OCR it ourselves via Claude's vision.
    if (kind === 'pdf' && (!text || text.trim().length < MIN_TEXT_LENGTH)) {
      log('no embedded text; running OCR via Claude:', file.name);
      try {
        text = await ocrPdf(anthropic, buffer);
      } catch (e) {
        logError('OCR failed:', e.message);
      }
    }

    if (!text || text.trim().length < MIN_TEXT_LENGTH) {
      await reply(
        client,
        event,
        `I downloaded "${file.name}" but couldn't read any usable content from it${kind === 'pdf' ? ', even with OCR' : ''}. It may be empty, corrupted, or password-protected.`
      );
      return;
    }

    const { content, truncated } = clampContent(text);
    const { text: summaryText, abstract } = await summarizeContent(content, file.name, truncated);

    // Slack reply (unchanged interface)
    await reply(client, event, summaryText);

    // Optional: append the structured row to the deal-tracker sheet. Never
    // blocks or breaks the Slack path — appendDealRow no-ops if disabled and
    // swallows its own errors.
    if (abstract && sheets.isEnabled()) {
      const wrote = await sheets.appendDealRow(abstract, file.name, new Date().toISOString(), { error: logError });
      if (wrote) log('appended to deal sheet:', file.name);
    }
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
