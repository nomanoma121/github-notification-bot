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
  reason: string;
  unread: boolean;
  updated_at: string;
  subject: {
    title: string;
    url: string;
    type: string;
  };
  repository: {
    full_name: string;
    html_url: string;
    owner: {
      avatar_url: string;
    };
  };
}

// APIのURLをブラウザで開けるURLに変換
function convertApiUrlToHtmlUrl(apiUrl: string, repoHtmlUrl: string): string {
  // https://api.github.com/repos/owner/repo/issues/1 -> https://github.com/owner/repo/issues/1
  // https://api.github.com/repos/owner/repo/pulls/1 -> https://github.com/owner/repo/pull/1
  const match = apiUrl.match(/repos\/[^/]+\/[^/]+\/(issues|pulls)\/(\d+)/);
  if (match) {
    const type = match[1] === 'pulls' ? 'pull' : 'issues';
    return `${repoHtmlUrl}/${type}/${match[2]}`;
  }
  return repoHtmlUrl;
}

function getReasonLabel(reason: string): string {
  const reasons: Record<string, string> = {
    'assign': 'アサイン',
    'author': '作成者',
    'comment': 'コメント',
    'ci_activity': 'CI',
    'invitation': '招待',
    'manual': '手動購読',
    'mention': 'メンション',
    'review_requested': 'レビュー依頼',
    'security_alert': 'セキュリティ',
    'state_change': '状態変更',
    'subscribed': '購読中',
    'team_mention': 'チームメンション',
  };
  return reasons[reason] || reason;
}

function getColorByType(type: string): number {
  const colors: Record<string, number> = {
    'Issue': 0x238636,   
    'PullRequest': 0x8957e5, 
    'Release': 0x1f6feb,  
    'Discussion': 0xf78166, 
  };
  return colors[type] || 0x0099ff;
}

function getTypeLabel(type: string): string {
  const types: Record<string, string> = {
    'Issue': 'Issue',
    'PullRequest': 'Pull Request',
    'Release': 'Release',
    'Discussion': 'Discussion',
    'Commit': 'Commit',
  };
  return types[type] || type;
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
        const apiUrl = notification.subject.url;
        const type = notification.subject.type;
        const reason = notification.reason;
        const repoName = notification.repository.full_name;
        const repoUrl = notification.repository.html_url;
        const avatarUrl = notification.repository.owner.avatar_url;
        const htmlUrl = convertApiUrlToHtmlUrl(apiUrl, repoUrl);
        const now = new Date().toISOString();

        const existingRecord = db.prepare('SELECT * FROM notifications WHERE thread_id = ?').get(threadId) as NotificationRecord | undefined;

        if (existingRecord) {
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
          const messageId = v6();

          const embed = new EmbedBuilder()
            .setColor(getColorByType(type))
            .setAuthor({ name: repoName, iconURL: avatarUrl, url: repoUrl })
            .setTitle(title)
            .setURL(htmlUrl)
            .addFields(
              { name: 'タイプ', value: getTypeLabel(type), inline: true },
              { name: '理由', value: getReasonLabel(reason), inline: true },
            )
            .setTimestamp(new Date(notification.updated_at))
            .setFooter({ text: 'GitHub Notification' });

          const linkButton = new ButtonBuilder()
            .setLabel('GitHubで開く')
            .setStyle(ButtonStyle.Link)
            .setURL(htmlUrl);

          const doneButton = new ButtonBuilder()
            .setCustomId(messageId)
            .setLabel('完了')
            .setStyle(ButtonStyle.Primary);

          db.prepare(`
            INSERT INTO notifications (thread_id, message_id, title, url, last_reminded_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(threadId, messageId, title, htmlUrl, now);
          console.log(`New notification stored with thread_id: ${threadId}`);

          if (channel?.isSendable()) {
            await channel.send({ 
              embeds: [embed], 
              components: [new ActionRowBuilder<ButtonBuilder>().addComponents(linkButton, doneButton)] 
            });
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

    const disabledButton = new ButtonBuilder()
      .setCustomId(interaction.customId)
      .setLabel('完了済み ✅')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);

    await interaction.message.react('✅');
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
