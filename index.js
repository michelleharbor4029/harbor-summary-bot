const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const pdf = require('pdf-parse');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PROMPT = 'Summarize this document in 5-7 bullet points for a commercial real estate firm. Each bullet starts with a dash (-). No markdown, no bold, no headers. Cover only the most important deals, data, or news. Be brief.';

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
