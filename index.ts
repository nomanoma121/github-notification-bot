import { Client, Events, GatewayIntentBits, ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } from 'discord.js';
import Database from 'better-sqlite3';
import { Cron } from 'croner';
import { v6 } from 'uuid';
import { token, channelId } from './config.json'

const GITHUB_NOTIFICATIONS_URL = 'https://api.github.com/notifications';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const db = new Database('database.sqlite');

db.prepare(`
  CREATE TABLE IF NOT EXISTS notifications (
    thread_id TEXT PRIMARY KEY,
    message_id TEXT,
    title TEXT,
    url TEXT,
    last_reminded_at TEXT 
  )
`).run();

client.once(Events.ClientReady, async (readyClient) => {
	console.log(`Ready! Logged in as ${readyClient.user.tag}`);
  const channel = await client.channels.fetch(channelId);

	new Cron('*/5 * * * *', async () => {
    const res = await fetch(GITHUB_NOTIFICATIONS_URL, {
      headers: {
        'Authorization': `token YOUR_GITHUB_TOKEN`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    const notifications = await res.json();

    for (const notification of notifications) {
      const threadId = notification.id;
      const messageId = v6();
      const title = notification.subject.title;
      const url = notification.subject.url;
      const now = new Date().toISOString();

      const embed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle(title)
        .setURL(url)
        .setDescription('New GitHub Notification');

      const button = new ButtonBuilder()
        .setCustomId(messageId)
        .setLabel('✅Done')
        .setStyle(ButtonStyle.Link)
        .setURL(url);

      db.prepare(`
        INSERT OR REPLACE INTO notifications (thread_id, message_id, title, url, last_reminded_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(threadId, messageId, title, url, now);

      if (channel?.isSendable()) {
        await channel.send({ embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)] });
      }

      // 2時間以上経過した通知に対してリマインドを送る
      const record = db.prepare('SELECT * FROM notifications WHERE thread_id = ?').get(threadId);
      if (record) {
        const lastRemindedAt = new Date(record.last_reminded_at);
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        if (lastRemindedAt < twoHoursAgo) {
          if (channel?.isSendable()) {
            const remindMessage = await channel.send({ content: `Reminder: ${title}`, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)] });
            db.prepare('UPDATE notifications SET last_reminded_at = ? WHERE thread_id = ?').run(now, threadId);
          }
        }
      }
    }
	});
});

client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isButton()) return;
  try {
    db.prepare('DELETE FROM notifications WHERE message_id = ?').run(interaction.customId);
    await interaction.message.react('✅');
  } catch (error) {
    console.error('Error deleting notification:', error);
  }
});

client.login(token);
