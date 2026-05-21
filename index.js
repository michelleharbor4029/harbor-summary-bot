const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PROMPT = `Summarize this document for Harbor Capital, a commercial real estate PE firm.

Read the ENTIRE document carefully. Look for LLC names, entity names, company names, addresses, dollar amounts, dates, and key terms.

Identify the document type and extract the key facts:

PSA: Buyer (full entity name), Seller (full entity name), Property address, Purchase price, Earnest money, Effective date, DD period, Closing date, Contingencies

LOI: Landlord, Tenant (full entity name), Property + SF, Rate, Term, TI, Free rent, Escalations, Options

LEASE/TAR LEASE/COMMERCIAL CONTRACT: Landlord (full entity name), Tenant (full entity name), Property + SF, Term dates, Rent + escalations, TI, Security deposit, NNN or gross, Options

TERM SHEET: Lender, Borrower (full entity name), Loan amount, LTV, Rate, Term, IO period, Prepayment, Guaranty

PHASE I ESA: Property, Date, Consultant, RECs found (yes/no), Recommendations

PCA: Property, Date, Consultant, Immediate repairs + cost, Short-term repairs + cost

APPRAISAL: Property, Date, As-is value, As-stabilized value, Cap rate

RENT ROLL: Property, Date, Total SF, Occupancy, Tenant list with SF and rent

INVOICE: Vendor, Invoice #, Amount, Description, Due date

ESTIMATE: Vendor, Scope, Total cost

COI: Insured (full entity name), Carrier, Policy #, Coverage limits

For any other document: Extract type, date, parties (full entity names), key terms, amounts, deadlines

FORMAT RULES - FOLLOW EXACTLY:
- Plain bullet points with dash (-)
- NO headers, NO bold, NO markdown, NO asterisks
- ONLY include fields that are actually in the document
- DO NOT write "not specified" or "not provided" - just skip missing fields
- DO NOT add notes or commentary
- Extract full LLC/entity names exactly as written`;

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
          console.log('Skipping file - no url_private:', file.name);
          continue;
        }

        console.log('Processing file:', file.name, 'Type:', file.mimetype, 'Size:', file.size);

        const response = await fetch(file.url_private, {
          headers: { Authorization: 'Bearer ' + process.env.SLACK_BOT_TOKEN }
        });

        let text = '';

        if (file.mimetype === 'application/pdf') {
          const buffer = Buffer.from(await response.arrayBuffer());
          const parsed = await pdf(buffer);
          text = parsed.text;
          console.log('PDF extracted text length:', text.length);
        } else if (
          file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
          file.name.endsWith('.docx')
        ) {
          const buffer = Buffer.from(await response.arrayBuffer());
          const result = await mammoth.extractRawText({ buffer });
          text = result.value;
          console.log('DOCX extracted text length:', text.length);
        } else {
          text = await response.text();
          console.log('Text file length:', text.length);
        }

        if (!text || text.length < 50) {
          console.log('Skipping file - text too short:', text.length, 'chars');
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
    console.error('Error processing file:', err);
  }
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('Harbor Summary Bot is running');
})();
