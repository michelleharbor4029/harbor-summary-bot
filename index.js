const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const pdf = require('pdf-parse');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function summarizeWithClaude(content, type) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are summarizing documents for a commercial real estate private equity firm. Analyze this document and provide a concise summary. Use plain bullet points only - no markdown headers, no bold text, no asterisks, no hashtags. If it contains deals, include per deal: asset type, location, size, price, buyer and seller, cap rate if mentioned. Keep each deal to 2-3 bullets max. If it contains market data, include only the most notable stats. If it contains people news, one bullet per person max. Total summary should be scannable in under 60 seconds.\n\n${content}`
  });
  return message.content[0].text;
}

app.event('message', async ({ event, client }) => {
  try {
    if (event.files && event.files.length > 0) {
      for (const file of event.files) {
        if (!file.url_private) continue;

        const response = await fetch(file.url_private, {
          headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
        });

        let text = '';
        if (file.mimetype === 'application/pdf') {
          const buffer = Buffer.from(await response.arrayBuffer());
          const parsed = await pdf(buffer);
          text = parsed.text;
        } else {
          text = await response.text();
        }

        if (!text || text.length < 50) continue;

        const summary = await summarizeWithClaude(text.slice(0, 8000), 'document');
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.ts,
          text: `*Summary of ${file.name}:*\n${summary}`
        });
      }
    }

    if (event.attachments && event.attachments.length > 0) {
      for (const attachment of event.attachments) {
        const content = [attachment.title, attachment.text, attachment.pretext]
          .filter(Boolean).join('\n');
        if (!content || content.length < 50) continue;

        const summary = await summarizeWithClaude(content, 'linked content');
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.ts,
          text: `*Summary:*\n${summary}`
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
