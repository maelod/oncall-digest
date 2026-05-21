/**
 * Direct Slite API client for creating handoff documents.
 * The Zapier MCP doesn't have a create_note tool, so we use the REST API.
 *
 * Requires SLITE_API_KEY environment variable.
 * Generate one at: https://glossgenius.slite.com/app/settings/api
 */

const SLITE_BASE_URL = 'https://api.slite.com/v1';

// The Growth On-Call Handoff parent doc ID (from the URL)
const HANDOFF_PARENT_NOTE_ID = 'hNke50mcj454f5';

async function sliteFetch(path: string, options: RequestInit = {}): Promise<any> {
    const apiKey = process.env.SLITE_API_KEY;
    if (!apiKey) {
        throw new Error('SLITE_API_KEY environment variable is not set. Generate one at https://glossgenius.slite.com/app/settings/api');
    }

    const response = await fetch(`${SLITE_BASE_URL}${path}`, {
        ...options,
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...options.headers,
        },
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Slite API error: ${response.status} ${response.statusText} — ${body}`);
    }

    return response.json();
}

/**
 * Convert Slack-formatted text to Slite markdown.
 * Slite uses standard markdown, not Slack's mrkdwn format.
 */
function slackToMarkdown(text: string): string {
    return text
        // Slack bold *text* → markdown **text**
        .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '**$1**')
        // Slack italic _text_ → markdown *text*
        .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '*$1*')
        // Slack links <url|label> → markdown [label](url)
        .replace(/<([^|>]+)\|([^>]+)>/g, '[$2]($1)')
        // Slack links <url> → markdown [url](url)
        .replace(/<([^|>]+)>/g, '[$1]($1)')
        // Slack channel <#CHANNEL_ID|name> → #name
        .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
        // Slack user <@USER_ID> → @USER_ID (best we can do)
        .replace(/<@([A-Z0-9]+)>/g, '@$1')
        // Bullet points • → -
        .replace(/^•/gm, '-')
        // Section dividers
        .replace(/^---$/gm, '\n---\n');
}

/**
 * Create a new Slite note under the Growth On-Call Handoff parent doc.
 * Returns the URL of the created note.
 */
export async function createHandoffNote(title: string, content: string): Promise<string> {
    console.log(`📝 [slite-api] Creating note: "${title}"`);

    try {
        const markdownContent = slackToMarkdown(content);

        const note = await sliteFetch('/notes', {
            method: 'POST',
            body: JSON.stringify({
                title,
                markdown: markdownContent,
                parentNoteId: HANDOFF_PARENT_NOTE_ID,
            }),
        });

        const noteUrl = note.url || `https://glossgenius.slite.com/app/docs/${note.id}`;
        console.log(`📝 [slite-api] Created note: ${noteUrl}`);
        return noteUrl;
    } catch (e) {
        console.error('📝 [slite-api] Failed to create note:', e);

        // If parent note approach fails, try without parent
        try {
            console.log('📝 [slite-api] Retrying without parent note...');
            const markdownContent = slackToMarkdown(content);
            const note = await sliteFetch('/notes', {
                method: 'POST',
                body: JSON.stringify({
                    title,
                    markdown: markdownContent,
                }),
            });
            const noteUrl = note.url || `https://glossgenius.slite.com/app/docs/${note.id}`;
            console.log(`📝 [slite-api] Created note (no parent): ${noteUrl}`);
            return noteUrl;
        } catch (e2) {
            console.error('📝 [slite-api] Retry also failed:', e2);
            return '';
        }
    }
}
