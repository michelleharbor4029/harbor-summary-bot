const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const { getDocument } = require('pdfjs-dist/legacy/build/pdf.mjs');
const JSZip = require('jszip');
const { parseStringPromise } = require('xml2js');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PROMPT = `Summarize this document for Harbor Capital.

Extract key facts. Skip blank or empty fields entirely.

For contracts/leases: Landlord/Seller, Tenant/Buyer, Property address, SF, Term, Rent/Price, Earnest money, Closing date, Key terms
For due diligence: Property, Date, Consultant, Findings, Recommendations, Costs
For financials: Property, Date, Key totals, NOI, Returns
For invoices/estimates: Vendor, Amount, Description, Due date

If this document contains REDLINES or TRACK CHANGES:
- First summarize the current/clean version of the document
- Then list the key changes that were redlined, added, or deleted
- Format changes as: "CHANGED: [what was modified]" or "ADDED: [new text]" or "DELETED: [removed text]"

FORMAT RULES:
- Start each line with a dash (-)
- NO headers, NO bold, NO asterisks, NO markdown
- Skip empty fields - do not say "not specified" or "blank"
- Just plain facts, one per line`;

// Extract PDF text including form field values
async function extractPdfText(buffer) {
  let text = '';
  
  // Regular pdf-parse for main text
  try {
    const parsed = await pdf(buffer);
    text = parsed.text;
  } catch (e) {
    console.log('pdf-parse failed:', e.message);
  }

  // Also extract form field values (the blue filled-in text)
  try {
    const data = new Uint8Array(buffer);
    const doc = await getDocument({ data }).promise;
    
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const annotations = await page.getAnnotations();
      
      for (const annot of annotations) {
        if (annot.fieldType && annot.fieldValue) {
          text += '\n[FORM FIELD: ' + annot.fieldValue + ']';
        }
      }
    }
  } catch (e) {
    console.log('pdfjs form extraction failed:', e.message);
  }

  return text;
}

// Extract Word doc text WITH track changes/redlines
async function extractDocxWithRedlines(buffer) {
  let cleanText = '';
  let redlineInfo = '';
  
  try {
    // Get clean text using mammoth
    const result = await mammoth.extractRawText({ buffer });
    cleanText = result.value;
    
    // Parse the docx XML to find track changes
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    
    if (documentXml) {
      // Find insertions (w:ins)
      const insertions = documentXml.match(/<w:ins[^>]*>[\s\S]*?<\/w:ins>/g) || [];
      for (const ins of insertions) {
        const textMatch = ins.match(/<w:t[^>]*>([^<]*)<\/w:t>/g);
        if (textMatch) {
          const texts = textMatch.map(t => t.replace(/<[^>]+>/g, '')).join('');
          if (texts.trim()) {
            redlineInfo += '\n[ADDED: ' + texts.trim() + ']';
          }
        }
      }
      
      // Find deletions (w:del)
      const deletions = documentXml.match(/<w:del[^>]*>[\s\S]*?<\/w:del>/g) || [];
      for (const del of deletions) {
        const textMatch = del.match(/<w:delText[^>]*>([^<]*)<\/w:delText>/g);
        if (textMatch) {
          const texts = textMatch.map(t => t.replace(/<[^>]+>/g, '')).join('');
          if (texts.trim()) {
            redlineInfo += '\n[DELETED: ' + texts.trim() + ']';
          }
        }
      }
    }
  } catch (e) {
    console.log('docx redline extraction failed:', e.message);
  }
  
  if (redlineInfo) {
    return cleanText + '\n\n--- REDLINE CHANGES ---' + redlineInfo;
  }
  return cleanText;
}

async function summarizeWithClaude(content) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: PROMPT + '\n\n' + content
    }]
  });
  return message.content[0].text;
}

app.event('message', async ({ event, client }) => {
  try {
    if (event.files && event.files.length > 0) {
      for (const file of event.files) {
        if (!file.url_private) {
          console.log('Skipping - no url:', file.name);
          continue;
        }

        console.log('Processing:', file.name, file.mimetype, file.size);

        const response = await fetch(file.url_private, {
          headers: { Authorization: 'Bearer ' + process.env.SLACK_BOT_TOKEN }
        });

        let text = '';
        const buffer = Buffer.from(await response.arrayBuffer());

        if (file.mimetype === 'application/pdf') {
          text = await extractPdfText(buffer);
          console.log('PDF text length:', text.length);
        } else if (
          file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
          file.name.endsWith('.docx')
        ) {
          text = await extractDocxWithRedlines(buffer);
          console.log('DOCX text length:', text.length);
        } else {
          text = await response.text();
        }

        if (!text || text.length < 50) {
          console.log('Skipping - text too short:', text.length);
          continue;
        }

        const summary = await summarizeWithClaude(text.slice(0, 8000));
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.ts,
          text: 'Summary of ' + file.name + ':\n' + summary
        });
      }
    }
  } catch (err) {
    console.error('Error:', err);
  }
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('Harbor Summary Bot is running');
})();
