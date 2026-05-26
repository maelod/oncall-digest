/**
 * Direct Slack API client for sending messages.
 * Replaces Zapier MCP for all send operations.
 *
 * Note: search.messages requires a user token (xoxp-), not a bot token (xoxb-).
 * Slack search still uses Zapier MCP.
 *
 * Requires SLACK_BOT_TOKEN environment variable.
 */

const SLACK_API_BASE = 'https://slack.com/api';

async function slackFetch(method: string, body: Record<string, any>, retries = 2): Promise<any> {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
        throw new Error('SLACK_BOT_TOKEN environment variable is not set');
    }

    const response = await fetch(`${SLACK_API_BASE}/${method}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    const data = await response.json();
    if (!data.ok) {
        // Retry on rate limit
        if (data.error === 'ratelimited' && retries > 0) {
            const retryAfter = parseInt(response.headers.get('Retry-After') || '3', 10);
            console.log(`💬 [slack-api] Rate limited on ${method}, retrying in ${retryAfter}s...`);
            await new Promise(r => setTimeout(r, retryAfter * 1000));
            return slackFetch(method, body, retries - 1);
        }
        throw new Error(`Slack API error (${method}): ${data.error}`);
    }
    return data;
}

/**
 * Send a message to a Slack channel.
 */
export async function sendChannelMessage(channelId: string, text: string): Promise<{ok: boolean; ts: string}> {
    console.log(`💬 [slack-api] Sending message to channel ${channelId} (${text.length} chars)...`);
    const data = await slackFetch('chat.postMessage', {
        channel: channelId,
        text,
        unfurl_links: false,
        unfurl_media: false,
    });
    console.log(`💬 [slack-api] Message sent to channel, ts=${data.ts}`);
    return {ok: true, ts: data.ts};
}

/**
 * Send a direct message to a Slack user by their user ID.
 */
export async function sendDirectMessage(userId: string, text: string): Promise<{ok: boolean; ts: string}> {
    console.log(`💬 [slack-api] Sending DM to user ${userId} (${text.length} chars)...`);

    // Open a DM conversation first
    const conv = await slackFetch('conversations.open', {users: userId});
    const channelId = conv.channel.id;

    // Send the message to the DM channel
    const data = await slackFetch('chat.postMessage', {
        channel: channelId,
        text,
        unfurl_links: false,
        unfurl_media: false,
    });
    console.log(`💬 [slack-api] DM sent, ts=${data.ts}`);
    return {ok: true, ts: data.ts};
}

/**
 * Look up a Slack channel ID by name.
 * Searches both public and private channels the bot has access to.
 */
export async function findChannelByName(name: string): Promise<string | null> {
    const cleanName = name.replace(/^#/, '');
    console.log(`💬 [slack-api] Looking up channel: ${cleanName}`);

    let cursor = '';
    do {
        const params: Record<string, any> = {
            limit: 200,
            types: 'public_channel,private_channel',
        };
        if (cursor) params.cursor = cursor;

        const data = await slackFetch('conversations.list', params);
        for (const ch of data.channels || []) {
            if (ch.name === cleanName) {
                console.log(`💬 [slack-api] Found channel ${cleanName}: ${ch.id}`);
                return ch.id;
            }
        }
        cursor = data.response_metadata?.next_cursor || '';
    } while (cursor);

    console.error(`💬 [slack-api] Channel "${cleanName}" not found. Bot may need to be invited.`);
    return null;
}

/**
 * Look up a Slack user by name or email.
 */
export async function findUserByName(name: string): Promise<{id: string; name: string} | null> {
    console.log(`💬 [slack-api] Looking up user: ${name}`);

    // Try by email first if it looks like an email
    if (name.includes('@')) {
        try {
            const data = await slackFetch('users.lookupByEmail', {email: name});
            return {id: data.user.id, name: data.user.real_name || data.user.name};
        } catch {
            // Fall through to list search
        }
    }

    // Search through users list
    let cursor = '';
    const searchName = name.replace(/^@/, '').toLowerCase();
    do {
        const params: Record<string, any> = {limit: 200};
        if (cursor) params.cursor = cursor;

        const data = await slackFetch('users.list', params);
        for (const user of data.members || []) {
            const realName = (user.real_name || '').toLowerCase();
            const displayName = (user.profile?.display_name || '').toLowerCase();
            const userName = (user.name || '').toLowerCase();
            if (realName.includes(searchName) || displayName.includes(searchName) || userName === searchName) {
                console.log(`💬 [slack-api] Found user ${name}: ${user.id} (${user.real_name})`);
                return {id: user.id, name: user.real_name || user.name};
            }
        }
        cursor = data.response_metadata?.next_cursor || '';
    } while (cursor);

    console.error(`💬 [slack-api] User "${name}" not found`);
    return null;
}
