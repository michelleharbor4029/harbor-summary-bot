// Optional Google Sheets export. Appends one row per abstracted document to a
// deal-tracker sheet. Entirely opt-in: if the env vars are absent or the API
// errors, this no-ops and the caller's Slack reply is unaffected.
//
// Setup:
//   GOOGLE_SERVICE_ACCOUNT_KEY  = the service-account JSON (stringified), with
//                                 the Sheets API enabled and the sheet shared
//                                 to the service account's client_email.
//   DEAL_SHEET_ID               = the spreadsheet ID from its URL.
//   DEAL_SHEET_TAB              = optional tab name (default "Deals").

const DEFAULT_TAB = 'Deals';

const HEADERS = [
  'Timestamp', 'File', 'Doc Type', 'Confidence', 'Summary',
  'Parties', 'Address', 'Size', 'Property Type',
  'Financials', 'Key Dates', 'Key Terms', 'Redlines', 'Risk Flags',
];

function isEnabled() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_KEY && process.env.DEAL_SHEET_ID);
}

function joinPairs(arr, keyA, keyB) {
  return (arr || []).map((x) => `${x[keyA]}: ${x[keyB]}`).join('\n');
}

function abstractToRow(abstract, fileName, timestamp) {
  const a = abstract || {};
  const p = a.property || {};
  return [
    timestamp,
    fileName,
    a.documentType || '',
    a.confidence || '',
    a.summary || '',
    (a.parties || []).map((x) => `${x.role}: ${x.name}`).join('\n'),
    p.address || '',
    p.size || '',
    p.propertyType || '',
    joinPairs(a.financials, 'label', 'value'),
    joinPairs(a.keyDates, 'label', 'date'),
    joinPairs(a.keyTerms, 'label', 'value'),
    (a.redlineChanges || []).join('\n'),
    (a.riskFlags || []).join('\n'),
  ];
}

let cachedClient = null;

async function getSheetsClient() {
  if (cachedClient) return cachedClient;
  // Lazy require so the dependency is only needed when the feature is used.
  const { google } = require('googleapis');
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  cachedClient = google.sheets({ version: 'v4', auth });
  return cachedClient;
}

// Ensure the header row exists exactly once (first write to an empty tab).
async function ensureHeaders(sheets, spreadsheetId, tab) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A1:N1`,
  });
  if (!res.data.values || res.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    });
  }
}

// Returns true on success, false if disabled or on any error (logged, never thrown).
async function appendDealRow(abstract, fileName, timestamp, log = console) {
  if (!isEnabled()) return false;
  try {
    const sheets = await getSheetsClient();
    const spreadsheetId = process.env.DEAL_SHEET_ID;
    const tab = process.env.DEAL_SHEET_TAB || DEFAULT_TAB;
    await ensureHeaders(sheets, spreadsheetId, tab);
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tab}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [abstractToRow(abstract, fileName, timestamp)] },
    });
    return true;
  } catch (e) {
    (log.error || console.error)('[harbor-bot] Google Sheets export failed:', e.message);
    return false;
  }
}

module.exports = { isEnabled, abstractToRow, appendDealRow, HEADERS };
