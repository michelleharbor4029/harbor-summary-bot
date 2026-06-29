// Unit tests for the pure logic (extraction, abstraction rendering, sheet
// mapping). No network, no Slack, no Anthropic calls. Run with: npm test
const assert = require('assert');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');
const extract = require('./index.js');
const abstract = require('./abstract.js');
const sheets = require('./sheets.js');

let passed = 0;
function check(name, cond) {
  assert.ok(cond, 'FAILED: ' + name);
  passed++;
  console.log('  ok -', name);
}

(async () => {
  // ---- file-type routing ----
  check('pdf by mimetype', extract.getFileKind({ mimetype: 'application/pdf' }) === 'pdf');
  check('pdf by extension', extract.getFileKind({ name: 'Deal.PDF' }) === 'pdf');
  check('docx by mimetype', extract.getFileKind({ mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }) === 'docx');
  check('docx by extension', extract.getFileKind({ name: 'lease.docx' }) === 'docx');
  check('text file', extract.getFileKind({ name: 'notes.txt' }) === 'text');
  check('csv is text', extract.getFileKind({ name: 'rentroll.csv' }) === 'text');
  check('xlsx by extension', extract.getFileKind({ name: 'budget.xlsx' }) === 'xlsx');
  check('xlsx by mimetype', extract.getFileKind({ mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }) === 'xlsx');
  check('png is image', extract.getFileKind({ name: 'site.PNG' }) === 'image');
  check('jpg is image', extract.getFileKind({ name: 'photo.jpg' }) === 'image');
  check('image by mimetype', extract.getFileKind({ mimetype: 'image/jpeg' }) === 'image');
  check('legacy .xls unsupported', extract.getFileKind({ name: 'old.xls' }) === 'unsupported');

  // ---- image media-type mapping (for Claude vision) ----
  check('png media type', extract.imageMediaType({ name: 'scan.png' }) === 'image/png');
  check('jpg media type', extract.imageMediaType({ name: 'photo.JPG' }) === 'image/jpeg');
  check('jpeg by mime', extract.imageMediaType({ mimetype: 'image/jpeg' }) === 'image/jpeg');
  check('webp media type', extract.imageMediaType({ name: 'pic.webp' }) === 'image/webp');

  // ---- PDF form-field value formatting ("blue text") ----
  check('off checkbox empty', extract.formatFieldValue('Off') === '');
  check('trims value', extract.formatFieldValue('  Acme LLC ') === 'Acme LLC');
  check('array joins', extract.formatFieldValue(['A', 'B']) === 'A, B');
  check('null empty', extract.formatFieldValue(null) === '');

  // ---- XML helpers ----
  check('decodes entities', extract.decodeXmlEntities('a &amp; b &lt;c&gt;') === 'a & b <c>');
  check('textFromTags keeps spacing', extract.textFromTags('<w:t xml:space="preserve"> $5.00 </w:t>', 'w:t') === ' $5.00 ');

  // ---- tracked-change collection (redlines) ----
  const xml = '<w:ins w:id="1"><w:r><w:t>added text</w:t></w:r></w:ins>' +
              '<w:del w:id="2"><w:r><w:delText>removed text</w:delText></w:r></w:del>';
  const changes = extract.collectTrackedChanges(xml);
  check('detects insertion', changes.includes('ADDED: added text'));
  check('detects deletion', changes.includes('DELETED: removed text'));
  check('ignores w:tab in w:ins', extract.collectTrackedChanges('<w:ins><w:r><w:tab/></w:r></w:ins>').length === 0);

  // ---- content clamping ----
  const clamped = extract.clampContent('x'.repeat(30000));
  check('truncates long', clamped.truncated === true && clamped.content.length === 24000);
  check('keeps short', extract.clampContent('short').truncated === false);

  // ---- text extraction reads buffer once ----
  const t = await extract.extractByKind('text', Buffer.from('hello harbor capital lease document'));
  check('text extraction', t === 'hello harbor capital lease document');

  // ---- DOCX end-to-end: real .docx with tracked changes ----
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>');
  zip.folder('_rels').file('.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>');
  zip.folder('word').file('document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:t>Base rent is</w:t></w:r>' +
    '<w:ins w:id="1" w:author="A"><w:r><w:t> $5.00/SF</w:t></w:r></w:ins>' +
    '<w:del w:id="2" w:author="A"><w:r><w:delText> $4.50/SF</w:delText></w:r></w:del></w:p>' +
    '<w:p><w:r><w:t>Industrial lease at 123 Main Street with plenty of body text here.</w:t></w:r></w:p>' +
    '</w:body></w:document>');
  const docxBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  const docxText = await extract.extractDocxText(docxBuffer);
  check('docx tracked-changes section', docxText.includes('--- TRACKED CHANGES ---'));
  check('docx redline ADDED', docxText.includes('ADDED: $5.00/SF'));
  check('docx redline DELETED', docxText.includes('DELETED: $4.50/SF'));
  check('docx body text present', docxText.includes('Industrial lease at 123 Main Street'));

  // ---- abstraction rendering (structured -> Slack text) ----
  const sample = {
    documentType: 'Lease',
    summary: 'Industrial NNN lease at 123 Main St.',
    parties: [{ role: 'Landlord', name: 'Harbor Industrial LLC' }, { role: 'Tenant', name: 'Acme Logistics' }],
    property: { address: '123 Main St', size: '50,000 SF', propertyType: 'Industrial' },
    financials: [{ label: 'Base Rent', value: '$6.50/SF/YR' }, { label: 'Security Deposit', value: '$50,000' }],
    keyDates: [{ label: 'Commencement', date: '2026-07-01' }, { label: 'Expiration', date: '2031-06-30' }],
    keyTerms: [{ label: 'Escalations', value: '3% annual' }],
    redlineChanges: ['ADDED: early termination option in year 3'],
    riskFlags: ['Early termination right reduces WALT'],
    confidence: 'high',
  };
  const rendered = abstract.renderAbstract(sample, 'lease.pdf', false);
  check('render has header with type+confidence', rendered.startsWith('Summary of lease.pdf (Lease · confidence: high):'));
  check('render shows party', rendered.includes('Landlord: Harbor Industrial LLC'));
  check('render shows property line', rendered.includes('123 Main St · 50,000 SF · Industrial'));
  check('render shows financial', rendered.includes('Base Rent: $6.50/SF/YR'));
  check('render shows key date', rendered.includes('Commencement: 2026-07-01'));
  check('render shows redline', rendered.includes('ADDED: early termination option in year 3'));
  check('render shows risk flag', rendered.includes('Early termination right reduces WALT'));

  // empty sections are omitted, not shown as blank headers
  const sparse = {
    documentType: 'Invoice', summary: 'Vendor invoice.', parties: [],
    property: { address: '', size: '', propertyType: '' },
    financials: [{ label: 'Amount', value: '$1,200' }],
    keyDates: [], keyTerms: [], redlineChanges: [], riskFlags: [], confidence: 'medium',
  };
  const sparseOut = abstract.renderAbstract(sparse, 'inv.pdf', false);
  check('omits empty PARTIES section', !sparseOut.includes('PARTIES'));
  check('omits empty PROPERTY section', !sparseOut.includes('PROPERTY'));
  check('keeps populated FINANCIALS', sparseOut.includes('FINANCIALS') && sparseOut.includes('Amount: $1,200'));
  check('truncation note appended', abstract.renderAbstract(sparse, 'inv.pdf', true).includes('covers the first part'));

  // ---- XLSX cell reading (incl. cached formula results, dates, rich text) ----
  check('cellToString plain number', extract.cellToString({ value: 1000000 }) === '1000000');
  check('cellToString formula cached result', extract.cellToString({ value: { formula: 'B2*2', result: 2000000 } }) === '2000000');
  check('cellToString formula without result is empty', extract.cellToString({ value: { formula: 'A1' } }) === '');
  check('cellToString rich text', extract.cellToString({ value: { richText: [{ text: 'Ac' }, { text: 'me LLC' }] } }) === 'Acme LLC');
  check('cellToString date as ISO', extract.cellToString({ value: new Date(Date.UTC(2026, 6, 15)) }) === '2026-07-15');
  check('cellToString empty', extract.cellToString({ value: null }) === '');

  // real .xlsx round-trip: build a workbook, read the actual cells back
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Deal');
  ws.addRow(['Purchase Price', 1000000]);
  ws.addRow(['Cap Rate', 0.065]);
  ws.getCell('A3').value = 'Total Value';
  ws.getCell('B3').value = { formula: 'B1*2', result: 2000000 };
  const xlsxBuffer = Buffer.from(await wb.xlsx.writeBuffer());
  const xlsxText = await extract.extractXlsxText(xlsxBuffer);
  check('xlsx names the sheet', xlsxText.includes('--- SHEET: Deal ---'));
  check('xlsx reads label + numeric cell', xlsxText.includes('Purchase Price\t1000000'));
  check('xlsx reads second row', xlsxText.includes('Cap Rate\t0.065'));
  check('xlsx reads cached formula result', xlsxText.includes('Total Value\t2000000'));

  // ---- image transcription via Claude vision — fake Anthropic client, no network ----
  let visionCall = null;
  const fakeVision = {
    messages: {
      create: async (params) => {
        visionCall = params;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Lease for 123 Main St, base rent $6.50/SF.' }] };
      },
    },
  };
  const imgText = await abstract.transcribeWithVision(fakeVision, Buffer.from('PNGBYTES'), 'image/png');
  check('vision returns transcribed text', imgText.includes('123 Main St'));
  const imgContent = visionCall.messages[0].content;
  check('vision sends an image block for an image', imgContent[0].type === 'image' && imgContent[0].source.media_type === 'image/png');
  check('vision base64-encodes the buffer', imgContent[0].source.data === Buffer.from('PNGBYTES').toString('base64'));
  check('vision source precedes the text instruction', imgContent[0].type === 'image' && imgContent[1].type === 'text');

  // source-block type is chosen by media type: pdf -> document, image -> image
  check('visionSourceBlock pdf is a document block', abstract.visionSourceBlock(Buffer.from('x'), 'application/pdf').type === 'document');
  check('visionSourceBlock image is an image block', abstract.visionSourceBlock(Buffer.from('x'), 'image/jpeg').type === 'image');

  // ---- PDF OCR fallback (scanned/image PDFs) — fake Anthropic client, no network ----
  const fakePdf = Buffer.from('%PDF-1.4 fake scanned bytes');
  let ocrCall = null;
  const fakeAnthropic = {
    messages: {
      create: async (params) => {
        ocrCall = params;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: '[FIELD Buyer: Acme LLC] Purchase price $1,000,000.' }] };
      },
    },
  };
  const ocrText = await abstract.ocrPdf(fakeAnthropic, fakePdf);
  check('ocr returns transcribed text', ocrText.includes('Purchase price $1,000,000'));
  const ocrContent = ocrCall.messages[0].content;
  const docBlock = ocrContent.find((b) => b.type === 'document');
  check('ocr sends a PDF document block', docBlock && docBlock.source.media_type === 'application/pdf');
  check('ocr base64-encodes the buffer', docBlock.source.type === 'base64' && docBlock.source.data === fakePdf.toString('base64'));
  check('ocr document block precedes the text instruction', ocrContent[0].type === 'document' && ocrContent[1].type === 'text');

  // refusal path throws rather than silently returning empty text
  const refusingAnthropic = { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } };
  let ocrThrew = false;
  try { await abstract.ocrPdf(refusingAnthropic, fakePdf); } catch (e) { ocrThrew = true; }
  check('ocr throws on model refusal', ocrThrew === true);

  // ---- schema validity (strict structured-output rules) ----
  function assertStrict(node, path) {
    if (node.type === 'object') {
      assert.strictEqual(node.additionalProperties, false, 'additionalProperties must be false at ' + path);
      const props = Object.keys(node.properties || {});
      assert.deepStrictEqual([...(node.required || [])].sort(), props.sort(), 'required must list all props at ' + path);
      for (const [k, v] of Object.entries(node.properties || {})) assertStrict(v, path + '.' + k);
    } else if (node.type === 'array') {
      assertStrict(node.items, path + '[]');
    }
  }
  assertStrict(abstract.DEAL_SCHEMA, 'root');
  check('DEAL_SCHEMA passes strict structured-output rules', true);

  // ---- sheets row mapping (no network) ----
  const row = sheets.abstractToRow(sample, 'lease.pdf', '2026-06-15T00:00:00Z');
  check('sheet row has all columns', row.length === sheets.HEADERS.length);
  check('sheet row timestamp', row[0] === '2026-06-15T00:00:00Z');
  check('sheet row file', row[1] === 'lease.pdf');
  check('sheet row joins parties', row[5] === 'Landlord: Harbor Industrial LLC\nTenant: Acme Logistics');
  check('sheet row financials', row[9] === 'Base Rent: $6.50/SF/YR\nSecurity Deposit: $50,000');
  check('sheets disabled without env', sheets.isEnabled() === false);

  console.log('\nAll ' + passed + ' checks passed.');
})().catch((e) => {
  console.error('\n' + e.message);
  process.exit(1);
});
