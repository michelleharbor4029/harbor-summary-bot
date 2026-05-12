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

const PROMPT = 'Summarize only what is actually in this document. Do not add outside knowledge or make anything up. Use plain bullet points starting with a dash (-). No markdown, no bold, no headers. Keep it concise - only the most important facts, numbers, names, and decisions. If it is a legal or contract document, summarize the key deal terms, parties, dates, amounts, and obligations only.';

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
})();
