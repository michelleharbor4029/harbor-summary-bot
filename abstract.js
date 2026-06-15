// Structured deal abstraction: ask Claude to extract a normalized schema from a
// document, then render it for Slack. Prompting + model config live here so the
// Slack wiring in index.js stays untouched.

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const ABSTRACT_MAX_TOKENS = 4096; // structured JSON for a full lease can be large
const FALLBACK_MAX_TOKENS = 2048;

// JSON Schema for structured outputs. Every object sets additionalProperties:false
// and lists all properties in `required` (strict structured-output requirement);
// the model emits "" / [] for anything the document does not contain.
const PAIR = {
  type: 'object',
  additionalProperties: false,
  properties: { label: { type: 'string' }, value: { type: 'string' } },
  required: ['label', 'value'],
};

const DEAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    documentType: {
      type: 'string',
      description:
        'Best-fit type, e.g. Lease, PSA, LOI, Lease Amendment, Estoppel, SNDA, Term Sheet, ' +
        'Operating Agreement, Title Commitment, Phase I ESA, PCA, Appraisal, Rent Roll, T-12, ' +
        'Pro Forma, Budget, Draw Schedule, Invoice, COI, Email, or Other.',
    },
    summary: { type: 'string', description: 'One or two plain sentences: what this document is and its headline terms.' },
    parties: {
      type: 'array',
      description: 'Each named party with its role (Landlord, Tenant, Buyer, Seller, Lender, Borrower, etc.).',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { role: { type: 'string' }, name: { type: 'string' } },
        required: ['role', 'name'],
      },
    },
    property: {
      type: 'object',
      additionalProperties: false,
      properties: {
        address: { type: 'string' },
        size: { type: 'string', description: 'e.g. "12,500 SF", "3.2 acres" — keep units as written.' },
        propertyType: { type: 'string', description: 'e.g. Industrial, Office, Retail, Multifamily, Land.' },
      },
      required: ['address', 'size', 'propertyType'],
    },
    financials: {
      type: 'array',
      description: 'Money terms: Purchase Price, Base Rent, Earnest Money, NOI, Cap Rate, TI Allowance, etc.',
      items: PAIR,
    },
    keyDates: {
      type: 'array',
      description: 'Dated milestones: Closing, DD Expiration, Earnest Money Go-Hard, Commencement, Expiration, Option Notice Deadline, Loan Maturity, etc.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { label: { type: 'string' }, date: { type: 'string' } },
        required: ['label', 'date'],
      },
    },
    keyTerms: {
      type: 'array',
      description: 'Other material terms: escalations, free rent, options, contingencies, NNN vs gross, assignment rights, etc.',
      items: PAIR,
    },
    redlineChanges: {
      type: 'array',
      description: 'Tracked changes / redline edits, phrased as "ADDED: ...", "DELETED: ...", or "CHANGED: ...".',
      items: { type: 'string' },
    },
    riskFlags: {
      type: 'array',
      description: 'Notable or off-market terms worth analyst attention: below-market rent, short WALT, early termination, co-tenancy, environmental RECs, deferred maintenance, unusual indemnities, etc.',
      items: { type: 'string' },
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: [
    'documentType', 'summary', 'parties', 'property', 'financials',
    'keyDates', 'keyTerms', 'redlineChanges', 'riskFlags', 'confidence',
  ],
};

const ABSTRACT_PROMPT = `You are abstracting a document for Harbor Capital, a commercial real estate private equity firm focused on industrial assets. Extract the deal terms into the provided schema for an acquisitions / asset-management analyst.

Rules:
- Extract ONLY what is actually in the document. Use "" for unknown strings and [] for unknown arrays. Never invent or infer values that are not present.
- The text may include tagged extras — treat them as authoritative:
  - [FIELD name: value] = a filled-in form field (often the key deal terms on TAR/TREC/AIR forms)
  - [COMMENT: ...] = a reviewer comment or markup/redline note from a PDF
  - ADDED: / DELETED: lines under "TRACKED CHANGES" = Word redline edits (put these in redlineChanges)
- Put money terms in financials, dated milestones in keyDates, and other material terms in keyTerms.
- Use riskFlags for anything off-market or worth flagging to an analyst.
- Set confidence to "low" if the document was hard to read or mostly missing data.`;

const FALLBACK_PROMPT = `Summarize this document for Harbor Capital (commercial real estate private equity, industrial focus).
Extract key facts only — parties, property, size, term, rents/prices, earnest money, key dates, and any redline changes.
Start each line with a dash. No markdown, no headers, no bold. Skip fields that are not present; do not invent anything.`;

async function abstractDocument(anthropic, content) {
  const message = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: ABSTRACT_MAX_TOKENS,
    messages: [{ role: 'user', content: ABSTRACT_PROMPT + '\n\nDOCUMENT:\n' + content }],
    output_config: { format: { type: 'json_schema', schema: DEAL_SCHEMA } },
  });
  if (message.stop_reason === 'refusal') throw new Error('model declined to process the document');
  const block = message.content.find((b) => b.type === 'text');
  if (!block) throw new Error('no structured output returned');
  return JSON.parse(block.text);
}

async function summarizeFallback(anthropic, content) {
  const message = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: FALLBACK_MAX_TOKENS,
    messages: [{ role: 'user', content: FALLBACK_PROMPT + '\n\n' + content }],
  });
  const block = message.content.find((b) => b.type === 'text');
  return block ? block.text : '(no summary produced)';
}

function propertyLine(property) {
  if (!property) return '';
  return [property.address, property.size, property.propertyType]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(' · ');
}

function section(title, lines) {
  const filtered = (lines || []).filter(Boolean);
  if (filtered.length === 0) return '';
  return '\n\n' + title + '\n' + filtered.map((l) => '- ' + l).join('\n');
}

function renderAbstract(abstract, fileName, truncated) {
  const a = abstract || {};
  const header = `Summary of ${fileName} (${a.documentType || 'Document'} · confidence: ${a.confidence || 'n/a'}):`;
  const body =
    (a.summary ? '\n' + a.summary : '') +
    section('PARTIES', (a.parties || []).map((p) => `${p.role}: ${p.name}`)) +
    section('PROPERTY', [propertyLine(a.property)]) +
    section('FINANCIALS', (a.financials || []).map((f) => `${f.label}: ${f.value}`)) +
    section('KEY DATES', (a.keyDates || []).map((d) => `${d.label}: ${d.date}`)) +
    section('KEY TERMS', (a.keyTerms || []).map((t) => `${t.label}: ${t.value}`)) +
    section('TRACKED CHANGES / REDLINES', a.redlineChanges) +
    section('RISK FLAGS', a.riskFlags);
  const note = truncated ? '\n\n(Note: document was long; this summary covers the first part.)' : '';
  return header + body + note;
}

module.exports = {
  CLAUDE_MODEL,
  DEAL_SCHEMA,
  abstractDocument,
  summarizeFallback,
  renderAbstract,
  propertyLine,
};
