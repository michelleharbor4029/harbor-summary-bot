const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');

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
      content: `Summarize the following ${type} in bullet points. Be concise - key facts, numbers, and decisions only:\n\n${content}`
    }]
  });
  return message.content[0].text;
}

// Handle messages with files
app.event('message', async ({ event, client }) => {
  try {
    // Handle file uploads
    if (event.files && event.files.length > 0) {
      for (const file of event.files) {
        if (!file.url_private) continue;
        
        const response = await fetch(file.url_private, {
          headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
        });
        const text = await response.text();
        if (!text || text.length < 50) continue;

        const summary = await summarizeWithClaude(text.slice(0, 8000), 'document');
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.ts,
          text: `*Summary of ${file.name}:*\n${summary}`
        });
      }
    }

    // Handle messages with links
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
