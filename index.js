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

const PROMPT = `You are summarizing documents for Harbor Capital, a commercial real estate private equity firm focused on industrial assets.

STEP 1: Identify the document type and extract ONLY the relevant fields:

PSA: Buyer, Seller, Property address, Purchase price, Earnest money (amount + refundability), Effective date, DD period + expiration, Closing date, Contingencies, Assignment rights

LOI: Landlord/Tenant, Property address + SF, Rate ($/SF/YR or MO), Term, TI allowance, Free rent, Escalations, Options (renewal/expansion/termination/ROFR), Conditions

LEASE (including TAR Commercial Lease, TAR Industrial Lease, TAR forms, AIR forms, standard lease agreements): Landlord, Tenant, Address + SF, Commencement date, Rent commencement, Expiration, Base rent + escalations, TI, Free rent months, Security deposit/LOC, NNN or gross, Options

COMMERCIAL CONTRACT (including TAR Commercial Contract, Earnest Money Contract, TREC forms): Buyer, Seller, Property address, Purchase price, Earnest money, DD period, Closing date, Title company, Contingencies

LEASE AMENDMENT: Parties, Original lease date, Amendment effective date, What changed, New terms

ESTOPPEL: Tenant, Lease dates, Current rent, Security deposit, Defaults/disputes, Options remaining

SNDA: Lender, Tenant, Landlord, Property address, Key terms

TERM SHEET: Lender, Borrower, Loan amount, LTV/LTC, Rate + structure, Term + amortization, IO period, Prepayment, Covenants (DSCR), Guaranty, Reserves

PHASE I ESA: Property, Date, Consultant, RECs (yes/no + list), Recommendations

PCA: Property, Date, Consultant, Immediate repairs (list + cost), Short-term repairs (list + cost), Total reserve

APPRAISAL: Property, Date, Appraiser, As-is value, As-stabilized value, Cap rate, Key assumptions

RENT ROLL: Property, As-of date, Total SF, Occupancy rate, Tenant list with SF + rent + lease dates

PRO FORMA: Property, Date, Hold period, Acquisition price, Debt assumptions, Exit cap, Returns (IRR, MOIC)

T-12: Property, Period, GPR, Vacancy, EGI, Expenses by category, NOI

INVOICE: Vendor, Invoice # + date, Amount, Description, Due date

ESTIMATE/BID: Vendor, Date, Scope, Total cost, Timeline

COI: Insured, Carrier, Policy #, Period, Coverage types + limits, Additional insureds

ARTICLE/MARKET RESEARCH: Publication, Date, Author, Key stats, Trends, Market discussed

For any other document type: Extract document type, date, parties, key terms, amounts, deadlines, action items

STEP 2: Format your response:
- Use plain bullet points starting with a dash (-)
- No markdown, no bold, no headers, no emojis
- Only extract what is actually in the document
- Skip fields that are not present
- Do not add outside knowledge or make anything up`;

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
    // ONLY process actual uploaded files - not email previews or link unfurls
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
    // REMOVED: event.attachments handler - was causing it to summarize email previews instead of actual files
  } catch (err) {
    console.error('Error processing file:', err);
  }
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('Harbor Summary Bot is running');
})();
