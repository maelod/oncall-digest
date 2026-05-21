/**
 * Direct Rootly API client for on-call schedule queries.
 * Bypasses the Zapier MCP which doesn't support schedule lookups.
 */

const ROOTLY_BASE_URL = 'https://api.rootly.com/v1';

// Grommerce schedule IDs (from Rootly API)
const GROMMERCE_PRIMARY_SCHEDULE_ID = '061e6181-5f71-4f24-9894-77d82eaac09d';
const GROMMERCE_SECONDARY_SCHEDULE_ID = '26b4a52b-539c-48bc-87a6-5c1fff4be92d';

interface RootlyUser {
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
 * The shifts endpoint returns the active/upcoming shift by default.
 */
async function getCurrentOnCall(scheduleId: string): Promise<{user: RootlyUser | null; shift: RootlyShift | null}> {
    try {
        const data = await rootlyFetch(`/schedules/${scheduleId}/shifts?include=user`);

        if (!data.data || data.data.length === 0) {
            return {user: null, shift: null};
        }

        // Find the shift that covers "now" (or the most recent/upcoming one)
        const now = new Date();
        const activeShift = data.data.find((s: any) => {
            const start = new Date(s.attributes.starts_at);
            const end = new Date(s.attributes.ends_at);
            return start <= now && now <= end;
        }) || data.data[0]; // Fall back to first shift if none covers "now"

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
 * Returns user info including Slack IDs (no need for separate Slack user resolution).
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
