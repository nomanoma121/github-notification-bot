import { Client, Events, GatewayIntentBits, ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } from 'discord.js';
import { Database } from 'bun:sqlite';
import { Cron } from 'croner';
import { v6 } from 'uuid';

const token = process.env.DISCORD_TOKEN!;
const channelId = process.env.DISCORD_CHANNEL_ID!;
const githubToken = process.env.GITHUB_TOKEN!;

const GITHUB_NOTIFICATIONS_URL = 'https://api.github.com/notifications';

interface GitHubNotification {
  id: string;
  subject: {
    title: string;
    url: string;
  };
}

interface NotificationRecord {
  thread_id: string;
  message_id: string;
  title: string;
  url: string;
  last_reminded_at: string;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const db = new Database('database.db');

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
    console.log(`[${new Date().toISOString()}] Checking GitHub notifications...`);
    try {
      const res = await fetch(GITHUB_NOTIFICATIONS_URL, {
        headers: {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github+json'
        }
      });
      const notifications = await res.json() as GitHubNotification[];

      for (const notification of notifications) {
        const threadId = notification.id;
        const title = notification.subject.title;
        const url = notification.subject.url;
        const now = new Date().toISOString();

        // 既存の通知をチェック
        const existingRecord = db.prepare('SELECT * FROM notifications WHERE thread_id = ?').get(threadId) as NotificationRecord | undefined;

        if (existingRecord) {
          // 2時間以上経過した通知に対してリマインドを送る
          const lastRemindedAt = new Date(existingRecord.last_reminded_at);
          const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
          if (lastRemindedAt < twoHoursAgo) {
            const button = new ButtonBuilder()
              .setCustomId(existingRecord.message_id)
              .setLabel('完了')
              .setStyle(ButtonStyle.Premium);

            if (channel?.isSendable()) {
              console.log(`Sending reminder for notification with thread_id: ${threadId}`);
              await channel.send({ content: `Reminder: ${title}`, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)] });
              db.prepare('UPDATE notifications SET last_reminded_at = ? WHERE thread_id = ?').run(now, threadId);
            }
          }
        } else {
          // 新規通知
          const messageId = v6();

          const embed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle(title)
            .setURL(url)
            .setDescription('New GitHub Notification');

          const button = new ButtonBuilder()
            .setCustomId(messageId)
            .setLabel('完了')
            .setStyle(ButtonStyle.Primary);

          db.prepare(`
            INSERT INTO notifications (thread_id, message_id, title, url, last_reminded_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(threadId, messageId, title, url, now);
          console.log(`New notification stored with thread_id: ${threadId}`);

          if (channel?.isSendable()) {
            await channel.send({ embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)] });
          }
        }
      }
    } catch (error) {
      console.error('Error fetching notifications:', error);
    }
	});
});

client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isButton()) return;
  try {
    db.prepare('DELETE FROM notifications WHERE message_id = ?').run(interaction.customId);

    // 通知を既読にする
    await fetch(`${GITHUB_NOTIFICATIONS_URL}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github+json'
      }
    });

    // ボタンを無効化して更新
    const disabledButton = new ButtonBuilder()
      .setCustomId(interaction.customId)
      .setLabel('完了済み ✅')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);

    await interaction.update({
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(disabledButton)]
    });
    console.log(`Deleted notification with message_id: ${interaction.customId}`);
  } catch (error) {
    console.error('Error deleting notification:', error);
    await interaction.deferUpdate();
  }
});

client.login(token);
