/**
 * Direct Rootly API client for on-call schedules and incident data.
 * Bypasses the Zapier MCP which doesn't support schedule lookups.
 */

const ROOTLY_BASE_URL = 'https://api.rootly.com/v1';

// Grommerce schedule IDs (from Rootly API)
const GROMMERCE_PRIMARY_SCHEDULE_ID = '061e6181-5f71-4f24-9894-77d82eaac09d';
const GROMMERCE_SECONDARY_SCHEDULE_ID = '26b4a52b-539c-48bc-87a6-5c1fff4be92d';

export interface RootlyUser {
    id: string;
    name: string;
    email: string;
    slackId: string | null;
}

interface RootlyShift {
    id: string;
    userId: number;
    startsAt: string;
    endsAt: string;
    isOverride: boolean;
}

interface OnCallResult {
    primary: RootlyUser | null;
    secondary: RootlyUser | null;
}

export interface RootlyActionItem {
    summary: string;
    status: string; // "open", "done", "in_progress"
    priority: string | null;
    dueAt: string | null;
}

export interface RootlyIncident {
    id: string;
    slug: string;
    title: string;
    status: string;
    severity: string | null;
    summary: string | null;
    url: string;
    slackChannelId: string | null;
    slackChannelName: string | null;
    slackChannelUrl: string | null;
    startedAt: string | null;
    resolvedAt: string | null;
    createdAt: string;
    actionItems: RootlyActionItem[];
    labels: string[];
}

async function rootlyFetch(path: string): Promise<any> {
    const apiKey = process.env.ROOTLY_API_KEY;
    if (!apiKey) {
        throw new Error('ROOTLY_API_KEY environment variable is not set');
    }

    const response = await fetch(`${ROOTLY_BASE_URL}${path}`, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/vnd.api+json',
        },
    });

    if (!response.ok) {
        throw new Error(`Rootly API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
}

function extractUserFromIncluded(included: any[], userId: number): RootlyUser | null {
    const user = included?.find((item: any) => item.type === 'users' && item.id === String(userId));
    if (!user) return null;

    return {
        id: user.id,
        name: user.attributes.name || user.attributes.full_name,
        email: user.attributes.email,
        slackId: user.attributes.slack_id || null,
    };
}

/**
 * Get current on-call for a specific schedule.
 */
async function getCurrentOnCall(scheduleId: string): Promise<{user: RootlyUser | null; shift: RootlyShift | null}> {
    try {
        const data = await rootlyFetch(`/schedules/${scheduleId}/shifts?include=user`);

        if (!data.data || data.data.length === 0) {
            return {user: null, shift: null};
        }

        const now = new Date();
        const activeShift = data.data.find((s: any) => {
            const start = new Date(s.attributes.starts_at);
            const end = new Date(s.attributes.ends_at);
            return start <= now && now <= end;
        }) || data.data[0];

        const shift: RootlyShift = {
            id: activeShift.id,
            userId: activeShift.attributes.user_id,
            startsAt: activeShift.attributes.starts_at,
            endsAt: activeShift.attributes.ends_at,
            isOverride: activeShift.attributes.is_override,
        };

        const user = extractUserFromIncluded(data.included, shift.userId);
        return {user, shift};
    } catch (e) {
        console.error(`Failed to get on-call for schedule ${scheduleId}:`, e);
        return {user: null, shift: null};
    }
}

/**
 * Get current on-call for both Grommerce Primary and Secondary schedules.
 */
export async function getGrommerceOnCall(): Promise<OnCallResult> {
    const [primaryResult, secondaryResult] = await Promise.all([
        getCurrentOnCall(GROMMERCE_PRIMARY_SCHEDULE_ID),
        getCurrentOnCall(GROMMERCE_SECONDARY_SCHEDULE_ID),
    ]);

    console.log(`📅 [rootly-api] Primary on-call: ${primaryResult.user?.name || 'unknown'} (slack: ${primaryResult.user?.slackId || '?'})`);
    console.log(`📅 [rootly-api] Secondary on-call: ${secondaryResult.user?.name || 'unknown'} (slack: ${secondaryResult.user?.slackId || '?'})`);

    return {
        primary: primaryResult.user,
        secondary: secondaryResult.user,
    };
}

/**
 * Fetch action items for a specific incident.
 */
async function getIncidentActionItems(incidentId: string): Promise<RootlyActionItem[]> {
    try {
        const data = await rootlyFetch(`/incidents/${incidentId}/action_items`);
        return (data.data || []).map((ai: any) => ({
            summary: ai.attributes.summary || '',
            status: ai.attributes.status || 'open',
            priority: ai.attributes.priority || null,
            dueAt: ai.attributes.due_at || null,
        }));
    } catch (e) {
        console.error(`Failed to get action items for incident ${incidentId}:`, e);
        return [];
    }
}

/**
 * Get recent incidents from Rootly, optionally filtered by date range.
 * Fetches action items for each incident in parallel.
 */
export async function getRecentIncidents(since: string, until?: string): Promise<RootlyIncident[]> {
    console.log(`📋 [rootly-api] Fetching incidents since ${since}${until ? ` until ${until}` : ''}...`);

    try {
        // Fetch recent incidents sorted by newest first
        let path = `/incidents?sort=-created_at&page%5Bsize%5D=20`;
        // Filter by created_at range
        path += `&filter%5Bcreated_at_gte%5D=${encodeURIComponent(since)}`;
        if (until) {
            path += `&filter%5Bcreated_at_lte%5D=${encodeURIComponent(until)}`;
        }

        const data = await rootlyFetch(path);
        const rawIncidents = data.data || [];
        console.log(`📋 [rootly-api] Found ${rawIncidents.length} incidents`);

        // Fetch action items for each incident in parallel
        const incidents: RootlyIncident[] = await Promise.all(
            rawIncidents.map(async (inc: any) => {
                const attrs = inc.attributes;
                const severity = attrs.severity?.data?.attributes?.name || null;
                const actionItems = await getIncidentActionItems(inc.id);

                return {
                    id: inc.id,
                    slug: attrs.slug,
                    title: attrs.title,
                    status: attrs.status,
                    severity,
                    summary: attrs.summary || null,
                    url: attrs.url,
                    slackChannelId: attrs.slack_channel_id || null,
                    slackChannelName: attrs.slack_channel_name || null,
                    slackChannelUrl: attrs.slack_channel_url || null,
                    startedAt: attrs.started_at || null,
                    resolvedAt: attrs.resolved_at || null,
                    createdAt: attrs.created_at,
                    actionItems,
                    labels: (attrs.labels || []).map((l: any) => l.name || l),
                };
            }),
        );

        const withActionItems = incidents.filter(i => i.actionItems.length > 0).length;
        console.log(`📋 [rootly-api] ${withActionItems}/${incidents.length} incidents have action items`);

        return incidents;
    } catch (e) {
        console.error('📋 [rootly-api] Failed to fetch incidents:', e);
        return [];
    }
}
