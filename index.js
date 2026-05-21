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

LEASE: Landlord, Tenant, Address + SF, Commencement date, Rent commencement, Expiration, Base rent + escalations, TI, Free rent months, Security deposit/LOC, NNN or gross, Options

LEASE AMENDMENT: Parties, Original lease date, Amendment effective date, What changed, New terms

ESTOPPEL: Tenant, Lease dates, Current rent, Security deposit, Defaults/disputes, Options remaining

SNDA: Lender, Tenant, Landlord, Property address, Key terms

COMMENCEMENT LETTER: Tenant, Commencement date, Rent commencement, Expiration, Delivery condition

TERM SHEET: Lender, Borrower, Loan amount, LTV/LTC, Rate + structure, Term + amortization, IO period, Prepayment, Covenants (DSCR), Guaranty, Reserves

PROMISSORY NOTE: Borrower, Lender, Principal, Interest rate, Payment schedule, Maturity, Default provisions

OPERATING AGREEMENT: Entity name, Members + ownership %, Manager, Capital contributions, Distribution waterfall, Voting rights

PPM: Issuer, Offering amount, Minimum investment, Use of proceeds, Sponsor fees, Distribution policy

K-1: Entity, Tax year, Partner name, Ordinary income/loss, Distributions, Capital account

TITLE COMMITMENT: Property, Date, Title company, Proposed insured + amount, Schedule B-I requirements, Schedule B-II exceptions

ALTA SURVEY: Property, Date, Surveyor, Acreage/SF, Easements, Encroachments, Flood zone

PHASE I ESA: Property, Date, Consultant, RECs (yes/no + list), Recommendations

PHASE II ESA: Property, Date, Sampling results, Contaminants found, Remediation recommendations

PCA: Property, Date, Consultant, Immediate repairs (list + cost), Short-term repairs (list + cost), Total reserve

APPRAISAL: Property, Date, Appraiser, As-is value, As-stabilized value, Cap rate, Key assumptions

ROOF REPORT: Property, Date, Roof type + age, Condition rating, Remaining life, Repairs + cost

BOV: Property, Date, Broker, Estimated value, Cap rate assumption

RENT ROLL: Property, As-of date, Total SF, Occupancy rate, Tenant list with SF + rent + lease dates

PRO FORMA: Property, Date, Hold period, Acquisition price, Debt assumptions, Exit cap, Returns (IRR, MOIC)

T-12: Property, Period, GPR, Vacancy, EGI, Expenses by category, NOI

BUDGET: Property, Year, Revenue projections, Expense projections, NOI projection, Capex budget

DRAW SCHEDULE: Project, Draw number, Date, Amount requested, Cumulative to date, Budget vs actual, Remaining

LOAN STATEMENT: Borrower, Lender, Property, Date, Principal balance, Rate, Payment due, Escrow

A/R REPORT: Property, As-of date, Total receivables, Aging buckets (current/30/60/90+), Tenants with balances

INVOICE: Vendor, Invoice # + date, Amount, Description, Due date

ESTIMATE/BID: Vendor, Date, Scope, Total cost, Timeline, Exclusions

SELLER STATEMENT: Property, Seller, Purchase price, Prorations, Credits/debits, Net proceeds

BUYER STATEMENT: Property, Buyer, Purchase price, Prorations, Closing costs, Total funds required

COI: Insured, Carrier, Policy #, Period, Coverage types + limits, Additional insureds

LANDLORD WAIVER: Landlord, Tenant, Lender, Property, Assets covered, Key terms

COURT DOCS: Case name + number, Court, Filing date, Document type, Relief requested/ruling, Next hearing

CONSTRUCTION CONTRACT: Owner, Contractor, Project, Contract sum + type, Scope, Completion date, Retainage

CHANGE ORDER: Project, Contractor, CO number, Description, Cost impact, Schedule impact

PMA: Owner, Manager, Property, Management fee, Term, Scope, Termination provisions

PUNCH LIST: Project, Date, Total items, Items by category, Target completion

LIEN WAIVER: Project, Contractor, Waiver type, Amount covered, Through date

CO/CERTIFICATE: Property, Issue date, Issuing authority, Permitted use, Conditions

BUILDING PERMIT: Property, Permit #, Issue date, Scope, Expiration

LEASING FLYER: Property, Available SF, Asking rate, Building specs, Contact info

OM (FOR SALE): Property, Asking price, Cap rate, NOI, Highlights, Tenant summary

W-9: Name, Business name, Tax classification, Address, TIN/EIN

1099: Payer, Recipient, Tax year, Type, Amount reported

WIRE INSTRUCTIONS: Recipient, Bank, Routing #, Account #, Reference

EMAIL: From, To, Date, Subject, Key decisions/commitments, Action items, Deadlines

TENANT NOTICE: From, To, Property, Date, Purpose, Effective date, Required action

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
    if (event.files && event.files.length > 0) {
      for (const file of event.files) {
        if (!file.url_private) continue;

        const response = await fetch(file.url_private, {
          headers: { Authorization: 'Bearer ' + process.env.SLACK_BOT_TOKEN }
        });

        let text = '';

        if (file.mimetype === 'application/pdf') {
          const buffer = Buffer.from(await response.arrayBuffer());
          const parsed = await pdf(buffer);
          text = parsed.text;
        } else if (
          file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
          file.name.endsWith('.docx')
        ) {
          const buffer = Buffer.from(await response.arrayBuffer());
          const result = await mammoth.extractRawText({ buffer });
          text = result.value;
        } else {
          text = await response.text();
        }

        if (!text || text.length < 50) continue;

        const summary = await summarizeWithClaude(text.slice(0, 8000));
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.ts,
          text: 'Summary of ' + file.name + ':\n' + summary
        });
      }
    }

    if (event.attachments && event.attachments.length > 0) {
      for (const attachment of event.attachments) {
        const content = [attachment.title, attachment.text, attachment.pretext]
          .filter(Boolean).join('\n');
        if (!content || content.length < 50) continue;

        const summary = await summarizeWithClaude(content);
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.ts,
          text: 'Summary:\n' + summary
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
