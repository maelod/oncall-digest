import {createStep, createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
import {mcpTools} from '../agents/oncall-digest-agent';
import {getGrommerceOnCall} from '../utils/rootly-api';

// Growth team services for filtering
const GROWTH_SERVICES = [
    'marketing-assets',
    'webflow-marketing-site',
    'shopify-site',
    'core-businesses',
];

// Slack channels to monitor
const GROWTH_SLACK_CHANNELS = [
    'team-grommerce-alerts',
];

// Input schema for the workflow
const workflowInputSchema = z.object({
    recipientSlackId: z.string().describe('Slack user ID or handle to send the digest to'),
    recipientName: z.string().describe('Name of the recipient'),
});

// Helper to get date strings with Tuesday-based shifts
function getDateContext() {
    const today = new Date();
    const currentYear = today.getFullYear();

    // Find the most recent Tuesday (current shift start)
    const dayOfWeek = today.getDay(); // 0=Sunday, 1=Monday, 2=Tuesday, etc.
    const daysSinceTuesday = (dayOfWeek + 5) % 7; // Days since last Tuesday (Tuesday=0)
    const currentShiftStart = new Date(today);
    currentShiftStart.setDate(today.getDate() - daysSinceTuesday);
    currentShiftStart.setHours(0, 0, 0, 0);

    // Previous shift start is one week before current shift start
    const previousShiftStart = new Date(currentShiftStart);
    previousShiftStart.setDate(currentShiftStart.getDate() - 7);

    // Current shift end is next Tuesday
    const currentShiftEnd = new Date(currentShiftStart);
    currentShiftEnd.setDate(currentShiftStart.getDate() + 7);

    // Previous shift end is current shift start
    const previousShiftEnd = new Date(currentShiftStart);

    return {
        today: today.toISOString().split('T')[0],
        currentYear,
        // Current shift (Tuesday to Tuesday)
        currentShiftStart: currentShiftStart.toISOString().split('T')[0],
        currentShiftEnd: currentShiftEnd.toISOString().split('T')[0],
        // Previous/last shift (the one we're handing off FROM)
        previousShiftStart: previousShiftStart.toISOString().split('T')[0],
        previousShiftEnd: previousShiftEnd.toISOString().split('T')[0],
    };
}

// ============================================================================
// PARALLEL DATA GATHERING STEPS (all take workflow input, run concurrently)
// ============================================================================

// Step: Get Rootly on-call schedule via direct API (also passes through recipient info)
const getRootlyScheduleStep = createStep({
    id: 'get-rootly-schedule',
    description: 'Gets on-call schedule from Rootly API for Grommerce team',
    inputSchema: workflowInputSchema,
    outputSchema: z.object({
        recipientSlackId: z.string(),
        recipientName: z.string(),
        primary: z.string(),
        primarySlackId: z.string(),
        primaryDisplayName: z.string(),
        secondary: z.string(),
        secondarySlackId: z.string(),
        secondaryDisplayName: z.string(),
        shiftStart: z.string(),
        shiftEnd: z.string(),
        previousShiftStart: z.string(),
        previousShiftEnd: z.string(),
    }),
    execute: async ({inputData}) => {
        console.log('📅 [Parallel] Getting Rootly on-call schedule via direct API...');
        const dates = getDateContext();

        try {
            const onCall = await getGrommerceOnCall();

            const primaryName = onCall.primary?.name || 'unknown';
            const primarySlackId = onCall.primary?.slackId || '';
            const primaryMention = primarySlackId ? `<@${primarySlackId}>` : `@${primaryName}`;

            const secondaryName = onCall.secondary?.name || 'unknown';
            const secondarySlackId = onCall.secondary?.slackId || '';
            const secondaryMention = secondarySlackId ? `<@${secondarySlackId}>` : `@${secondaryName}`;

            return {
                recipientSlackId: inputData.recipientSlackId,
                recipientName: inputData.recipientName,
                primary: primaryMention,
                primarySlackId,
                primaryDisplayName: primaryName,
                secondary: secondaryMention,
                secondarySlackId,
                secondaryDisplayName: secondaryName,
                shiftStart: dates.currentShiftStart,
                shiftEnd: dates.currentShiftEnd,
                previousShiftStart: dates.previousShiftStart,
                previousShiftEnd: dates.previousShiftEnd,
            };
        } catch (e) {
            console.error('Rootly API error:', e);
            return {
                recipientSlackId: inputData.recipientSlackId,
                recipientName: inputData.recipientName,
                primary: '@unknown',
                primarySlackId: '',
                primaryDisplayName: 'unknown',
                secondary: '@unknown',
                secondarySlackId: '',
                secondaryDisplayName: 'unknown',
                shiftStart: dates.currentShiftStart,
                shiftEnd: dates.currentShiftEnd,
                previousShiftStart: dates.previousShiftStart,
                previousShiftEnd: dates.previousShiftEnd,
            };
        }
    },
});

// Step: Get incidents from Slack
const getIncidentsStep = createStep({
    id: 'get-incidents',
    description: 'Gets incidents from the LAST on-call shift',
    inputSchema: workflowInputSchema,
    outputSchema: z.object({
        incidents: z.string(), // JSON string
    }),
    execute: async ({inputData, mastra}) => {
        console.log('🔥 [get-incidents] Starting...');
        const dates = getDateContext();
        console.log('🔥 [get-incidents] Date context:', JSON.stringify(dates, null, 2));

        const agent = mastra.getAgent('oncallDigestAgent');

        const prompt = `Search for incidents in Slack #incidents channel from ${dates.previousShiftStart} to ${dates.previousShiftEnd}.

CONTEXT:
- All messages in #incidents are posted by a Rootly bot
- Include bot messages in your search
- PRIORITIZE the most recent incidents first
- Prefer incidents related to Growth team services (${GROWTH_SERVICES.join(', ')}), but include ALL recent incidents from the shift period — recency is more important than team filtering

TOOL: Use zapier_slack_find_message with:
- query: "in:incidents after:${dates.previousShiftStart} before:${dates.previousShiftEnd}"
- include_bot_messages: "yes"

CRITICAL OUTPUT REQUIREMENT:
You MUST end your response with ONLY a valid JSON array. No explanations, no thinking, no additional text.
After you finish searching and have the results, output ONLY the JSON array.

For each incident found, extract:
- slug: incident ID (e.g., "#inc-12345-description")
- severity: SEV-1, SEV-2, etc.
- status: Resolved, Active, etc.
- summary: brief description
- involved: array of @mentions
- date: YYYY-MM-DD format
- growthRelated: true/false (whether it involves Growth team services)

YOUR FINAL OUTPUT MUST BE EXACTLY THIS FORMAT (no other text):
[{"slug": "#inc-...", "severity": "SEV-X", "status": "...", "summary": "...", "involved": ["@person"], "date": "YYYY-MM-DD", "growthRelated": true}]

If no incidents found or tool calls fail, output exactly: []`;

        console.log('🔥 [get-incidents] Prompt being sent to agent:');
        console.log('---PROMPT START---');
        console.log(prompt);
        console.log('---PROMPT END---');

        try {
            console.log('🔥 [get-incidents] Calling agent.generate()...');
            const {text} = await agent.generate([{role: 'user', content: prompt}]);

            console.log('🔥 [get-incidents] Agent raw response:');
            console.log('---RESPONSE START---');
            console.log(text);
            console.log('---RESPONSE END---');

            const match = text.match(/\[[\s\S]*\]/);
            console.log('🔥 [get-incidents] Regex match result:', match ? 'FOUND' : 'NOT FOUND');

            const result = match ? match[0] : '[]';
            console.log('🔥 [get-incidents] Final result:', result);

            return {incidents: result};
        } catch (e) {
            console.error('🔥 [get-incidents] ERROR:', e);
            return {incidents: '[]'};
        }
    },
});

// Step: Get team channel activity (finds PRs, help requests, etc. from Slack)
const getTeamChannelActivityStep = createStep({
    id: 'get-team-activity',
    description: 'Gets PR links, help requests, and discussions from team Slack channels',
    inputSchema: workflowInputSchema,
    outputSchema: z.object({
        prCandidates: z.string(), // PRs to check - will be verified in next step
        helpRequests: z.string(),
        infraUpdates: z.string(),
        discussions: z.string(),
    }),
    execute: async ({inputData, mastra}) => {
        console.log('💬 [Parallel] Getting team channel activity from Slack...');
        const dates = getDateContext();
        const agent = mastra.getAgent('oncallDigestAgent');

        const prompt = `Use the zapier_slack_find_message tool to search this Slack channel: ${GROWTH_SLACK_CHANNELS.join(', ')}

IMPORTANT DATE CONTEXT:
- Last on-call shift: ${dates.previousShiftStart} to ${dates.previousShiftEnd}
- Look back up to 30 days for old items

TOOL USAGE:
Use zapier_slack_find_message multiple times with different queries:
1. For PR reviews: query="in:team-grommerce-alerts github.com OR gitlab.com after:${dates.previousShiftStart}"
2. For help requests: query="in:team-grommerce-alerts help OR need OR assist after:${dates.previousShiftStart}"
3. For infrastructure: query="in:team-grommerce-alerts database OR RDS OR migration OR upgrade after:${dates.previousShiftStart}"
4. For discussions: query="in:team-grommerce-alerts after:${dates.previousShiftStart} before:${dates.previousShiftEnd}"

=== 1. PR REVIEW REQUESTS ===
Find ALL GitHub/GitLab PR links posted by OTHER teams asking Growth to review.
- Look for PR links posted more than 7 days ago (before ${dates.previousShiftStart})
- Just find the PRs - we will verify their status in a separate step

=== 2. HELP REQUESTS ===
Messages from other teams asking Growth for help.
- Only include if Growth hasn't responded OR issue isn't resolved
- Look back 30 days

=== 3. INFRASTRUCTURE ===
Messages about: database, RDS, migration, upgrade, maintenance, deployment
- Include any scheduled or upcoming changes
- Look back 30 days

=== 4. ONGOING DISCUSSIONS ===
Active threads from the LAST SHIFT (${dates.previousShiftStart} to ${dates.previousShiftEnd}) without clear resolution.

Reply with ONLY this JSON (use empty arrays if nothing found):
{
  "prCandidates": [{"prUrl": "https://github.com/...", "from": "team/person", "channel": "channel-name", "postedDate": "YYYY-MM-DD", "slackThreadUrl": "https://..."}],
  "helpRequests": [{"request": "description", "from": "team/person", "channel": "channel-name", "resolved": false}],
  "infraUpdates": [{"description": "what", "when": "date or TBD", "channel": "channel-name"}],
  "discussions": [{"topic": "what", "channel": "channel-name", "threadLink": "https://..."}]
}`;

        try {
            const {text} = await agent.generate([{role: 'user', content: prompt}]);
            const match = text.match(/\{[\s\S]*\}/);
            const data = match ? JSON.parse(match[0]) : {};

            return {
                prCandidates: JSON.stringify(data.prCandidates || []),
                helpRequests: JSON.stringify(data.helpRequests || []),
                infraUpdates: JSON.stringify(data.infraUpdates || []),
                discussions: JSON.stringify(data.discussions || []),
            };
        } catch (e) {
            console.error('Team activity error:', e);
            return {
                prCandidates: '[]',
                helpRequests: '[]',
                infraUpdates: '[]',
                discussions: '[]',
            };
        }
    },
});

// Step: Get Linear tickets from the Growth team
const getLinearTicketsStep = createStep({
    id: 'get-linear-tickets',
    description: 'Gets pending and recently resolved issues from the Growth team in Linear',
    inputSchema: workflowInputSchema,
    outputSchema: z.object({
        bugs: z.string(),
    }),
    execute: async ({inputData, mastra}) => {
        console.log('🐛 [get-linear-tickets] Starting...');
        const dates = getDateContext();
        console.log('🐛 [get-linear-tickets] Date context:', JSON.stringify(dates, null, 2));

        const agent = mastra.getAgent('oncallDigestAgent');

        const prompt = `Search Linear for issues in the Growth team.

TOOL: Use the Linear tool available via Zapier MCP to search for issues in the "Growth" team.

SEARCH 1 - Pending tickets (not done):
- Search for issues in the Growth team that are NOT completed/done
- Focus on bugs, on-call work, and urgent items
- EXCLUDE any tickets with "[TIMEBOX]" in the title (e.g., "[TIMEBOX] Growth On Call") — these are just story point placeholders

SEARCH 2 - Recently resolved (optional, only if first search works):
- Search for issues in the Growth team that were completed/resolved since ${dates.previousShiftStart}
- EXCLUDE any tickets with "[TIMEBOX]" in the title

CRITICAL OUTPUT REQUIREMENT:
You MUST end your response with ONLY a valid JSON object. No explanations, no thinking, no additional text.
After you finish searching, output ONLY the JSON object.

For each ticket found, extract:
- ticket: the issue identifier (e.g., "GRO-123")
- summary: the issue title/summary
- status: current status
- url: the Linear issue URL (e.g., "https://linear.app/glossgenius/issue/GRO-123")

YOUR FINAL OUTPUT MUST BE EXACTLY THIS FORMAT (no other text):
{"pendingTickets": [{"ticket": "GRO-XXXXX", "summary": "...", "status": "To Do", "url": "https://linear.app/glossgenius/issue/GRO-XXXXX"}], "resolvedBugs": [{"ticket": "GRO-XXXXX", "summary": "...", "resolvedDate": "YYYY-MM-DD", "url": "https://linear.app/glossgenius/issue/GRO-XXXXX"}]}

If no tickets found or tool calls fail, output exactly: {"pendingTickets": [], "resolvedBugs": []}`;

        console.log('🐛 [get-linear-tickets] Prompt being sent to agent:');
        console.log('---PROMPT START---');
        console.log(prompt);
        console.log('---PROMPT END---');

        try {
            console.log('🐛 [get-linear-tickets] Calling agent.generate()...');
            const {text} = await agent.generate([{role: 'user', content: prompt}]);

            console.log('🐛 [get-linear-tickets] Agent raw response:');
            console.log('---RESPONSE START---');
            console.log(text);
            console.log('---RESPONSE END---');

            const match = text.match(/\{[\s\S]*\}/);
            console.log('🐛 [get-linear-tickets] Regex match result:', match ? 'FOUND' : 'NOT FOUND');

            if (match) {
                console.log('🐛 [get-linear-tickets] Final result:', match[0]);
                return {bugs: match[0]};
            }
            console.log('🐛 [get-linear-tickets] No match, returning empty');
            return {bugs: '{"pendingTickets": [], "resolvedBugs": []}'};
        } catch (e) {
            console.error('🐛 [get-linear-tickets] ERROR:', e);
            return {bugs: '{"pendingTickets": [], "resolvedBugs": []}'};
        }
    },
});

// Step: Get Slite documentation
const getSliteDocsStep = createStep({
    id: 'get-slite-docs',
    description: 'Gets runbook updates, last updated date, and incident guidelines from Slite',
    inputSchema: workflowInputSchema,
    outputSchema: z.object({
        runbookUpdates: z.string(),
        runbookLastUpdated: z.string(),
        runbookUpdateSuggestions: z.string(), // JSON array of suggestions if stale
        incidentGuidelines: z.string(),
        previousHandoffNotes: z.string(), // Content from the previous on-call handoff doc
    }),
    execute: async ({inputData, mastra}) => {
        console.log('📚 [get-slite] Starting...');
        const dates = getDateContext();
        const agent = mastra.getAgent('oncallDigestAgent');

        const defaultGuidelines = {
            severityDefinitions: 'See Slite docs',
            communicationCadence: 'See Slite docs',
            escalationProcedures: 'See Slite docs',
            postIncidentProcess: 'See Slite docs',
        };

        // --- Call 0: Fetch previous on-call handoff notes (CRITICAL for context) ---
        let previousHandoffNotes = '';
        const handoffPrompt = `Search Slite for the most recent Growth on-call handoff document.

TOOL USAGE: Use zapier_slite_search_docs with:
- query: "Growth On-Call Handoff"

The Growth On-Call Handoff table is at: https://glossgenius.slite.com/app/docs/hNke50mcj454f5/Growth-On-Call-Handoff

Find the MOST RECENT handoff document (the one from the previous week's handoff).
Extract the full content, paying special attention to:
- The "Hand-off Notes (for next person)" section
- Any ongoing issues or things to watch out for
- Any follow-up items that were flagged

Reply with ONLY the text content of the previous handoff document. If you can't find it, reply with "No previous handoff notes found."`;

        try {
            console.log('📚 [get-slite] Fetching previous handoff notes...');
            const {text} = await agent.generate([{role: 'user', content: handoffPrompt}]);
            previousHandoffNotes = text;
            console.log('📚 [get-slite] Previous handoff notes length:', previousHandoffNotes.length);
        } catch (e) {
            console.error('📚 [get-slite] Previous handoff fetch error:', e);
        }

        // --- Call 1: Runbook search (fast — uses zapier_slite_search_docs) ---
        let runbookData: any = {};
        const runbookPrompt = `Use the zapier_slite_search_docs tool to search Slite.

TOOL USAGE: Use zapier_slite_search_docs with:
- query: "Growth Runbook"
- Get the document metadata including the lastUpdated/updatedAt date

Growth Runbook URL: https://glossgenius.slite.com/api/s/n55ep5xAlnZ5EQ/Runbooks

Search for:

1. *RUNBOOK METADATA*: Find the main Growth Runbook document and get:
   - The lastUpdated or updatedAt date from the document metadata
   - If the runbook is more than 30 days old (today is ${dates.today}), suggest what sections might need updating based on:
     - Recent incident patterns
     - New alerting configurations
     - Changes to the services (${GROWTH_SERVICES.join(', ')})

2. *RUNBOOK UPDATES*: Recently updated runbooks (last 7-14 days) for Growth services:
   ${GROWTH_SERVICES.join(', ')}
   Look for updates to the Growth runbook, and generate a summary of what was updated.

Reply with ONLY this JSON:
{
  "runbookLastUpdated": "YYYY-MM-DD",
  "runbookUpdateSuggestions": ["Add section on new alerting", "Update DB access procedures"],
  "runbookUpdates": [{"title": "Runbook name", "change": "what was updated"}]
}

IMPORTANT for runbookUpdateSuggestions:
- Only populate if runbook is >30 days old
- If runbook is recently updated, use an empty array []
- Suggestions should be specific and actionable

If nothing found, use empty arrays.`;

        try {
            console.log('📚 [get-slite] Fetching runbook metadata...');
            const {text} = await agent.generate([{role: 'user', content: runbookPrompt}]);
            const match = text.match(/\{[\s\S]*\}/);
            if (match) runbookData = JSON.parse(match[0]);
            console.log('📚 [get-slite] Runbook data:', JSON.stringify(runbookData, null, 2));
        } catch (e) {
            console.error('📚 [get-slite] Runbook search error:', e);
        }

        // --- Call 2: Incident guidelines (slow — uses zapier_slite_ask_question) ---
        let incidentGuidelines = defaultGuidelines;
        const guidelinesPrompt = `Use the zapier_slite_ask_question tool with:
- question: "What are the incident severity definitions, communication cadence, and escalation procedures?"

Extract:
- Severity definitions (SEV-1, SEV-2, etc.)
- Communication cadence during incidents
- Escalation procedures
- Post-incident requirements

Reply with ONLY this JSON:
{
  "severityDefinitions": "brief summary",
  "communicationCadence": "how often to update",
  "escalationProcedures": "when/how to escalate",
  "postIncidentProcess": "post-mortem requirements"
}

If nothing found, use "See Slite docs" for each field.`;

        try {
            console.log('📚 [get-slite] Fetching incident guidelines...');
            const {text} = await agent.generate([{role: 'user', content: guidelinesPrompt}]);
            const match = text.match(/\{[\s\S]*\}/);
            if (match) incidentGuidelines = JSON.parse(match[0]);
            console.log('📚 [get-slite] Guidelines data:', JSON.stringify(incidentGuidelines, null, 2));
        } catch (e) {
            console.error('📚 [get-slite] Guidelines fetch error (using defaults):', e);
        }

        return {
            runbookUpdates: JSON.stringify(runbookData.runbookUpdates || []),
            runbookLastUpdated: runbookData.runbookLastUpdated || 'Unknown',
            runbookUpdateSuggestions: JSON.stringify(runbookData.runbookUpdateSuggestions || []),
            incidentGuidelines: JSON.stringify(incidentGuidelines),
            previousHandoffNotes,
        };
    },
});

// Step: Get alerts from #team-grommerce-alerts channel
const getAlertsStep = createStep({
    id: 'get-alerts',
    description: 'Gets alerts from #team-grommerce-alerts during last shift',
    inputSchema: workflowInputSchema,
    outputSchema: z.object({
        alerts: z.string(), // JSON string of alert counts
    }),
    execute: async ({inputData, mastra}) => {
        console.log('🚨 [get-alerts] Starting...');
        const dates = getDateContext();
        console.log('🚨 [get-alerts] Date context:', JSON.stringify(dates, null, 2));

        const agent = mastra.getAgent('oncallDigestAgent');

        const prompt = `Search for alerts in Slack #team-grommerce-alerts channel from ${dates.previousShiftStart} to ${dates.previousShiftEnd}.

CONTEXT:
- Messages in #team-grommerce-alerts are posted by alerting/monitoring bots (Datadog, Eppo, Hex)
- Include bot messages in your search
- Growth services: ${GROWTH_SERVICES.join(', ')}

TOOL: Use zapier_slack_find_message with:
- query: "in:team-grommerce-alerts after:${dates.previousShiftStart} before:${dates.previousShiftEnd}"
- include_bot_messages: "yes"

TASK:
1. Search for all alerts/monitor notifications in #team-grommerce-alerts during the last shift
2. Group alerts by their name/type (e.g., "marketing-assets latency", "core-businesses error rate")
3. Count how many times each unique alert fired
4. Note the last time each alert was triggered
5. Based on the alert patterns, suggest which runbook sections might be relevant

CRITICAL OUTPUT REQUIREMENT:
You MUST end your response with ONLY a valid JSON object. No explanations after the JSON.

For each unique alert found, extract:
- name: the alert/monitor name
- source: which tool it came from (Datadog, Eppo, or Hex)
- count: how many times it fired during the shift
- lastTriggered: date of most recent occurrence (YYYY-MM-DD)
- suggestion: brief AI suggestion referencing relevant runbook section or action

YOUR FINAL OUTPUT MUST BE EXACTLY THIS FORMAT (no other text):
{"alerts": [{"name": "alert name", "source": "Datadog", "count": 5, "lastTriggered": "2026-05-15", "suggestion": "Review relevant runbook section"}]}

If no alerts found or tool calls fail, output exactly: {"alerts": []}`;

        console.log('🚨 [get-alerts] Prompt being sent to agent:');
        console.log('---PROMPT START---');
        console.log(prompt);
        console.log('---PROMPT END---');

        try {
            console.log('🚨 [get-alerts] Calling agent.generate()...');
            const {text} = await agent.generate([{role: 'user', content: prompt}]);

            console.log('🚨 [get-alerts] Agent raw response:');
            console.log('---RESPONSE START---');
            console.log(text);
            console.log('---RESPONSE END---');

            const match = text.match(/\{[\s\S]*\}/);
            console.log('🚨 [get-alerts] Regex match result:', match ? 'FOUND' : 'NOT FOUND');

            if (match) {
                const data = JSON.parse(match[0]);
                const alertsJson = JSON.stringify(data.alerts || []);
                console.log('🚨 [get-alerts] Final result:', alertsJson);
                return {alerts: alertsJson};
            }
            console.log('🚨 [get-alerts] No match, returning empty');
            return {alerts: '[]'};
        } catch (e) {
            console.error('🚨 [get-alerts] ERROR:', e);
            return {alerts: '[]'};
        }
    },
});

// ============================================================================
// COMBINE STEP (merges parallel results)
// ============================================================================

const combineParallelResultsStep = createStep({
    id: 'combine-results',
    description: 'Combines results from all parallel data gathering steps',
    inputSchema: z.object({
        'get-rootly-schedule': z.object({
            recipientSlackId: z.string(),
            recipientName: z.string(),
            primary: z.string(),
            primarySlackId: z.string(),
            primaryDisplayName: z.string(),
            secondary: z.string(),
            secondarySlackId: z.string(),
            secondaryDisplayName: z.string(),
            shiftStart: z.string(),
            shiftEnd: z.string(),
            previousShiftStart: z.string(),
            previousShiftEnd: z.string(),
        }),
        'get-incidents': z.object({
            incidents: z.string(),
        }),
        'get-team-activity': z.object({
            prCandidates: z.string(),
            helpRequests: z.string(),
            infraUpdates: z.string(),
            discussions: z.string(),
        }),
        'get-linear-tickets': z.object({
            bugs: z.string(),
        }),
        'get-slite-docs': z.object({
            runbookUpdates: z.string(),
            runbookLastUpdated: z.string(),
            runbookUpdateSuggestions: z.string(),
            incidentGuidelines: z.string(),
            previousHandoffNotes: z.string(),
        }),
        'get-alerts': z.object({
            alerts: z.string(),
        }),
    }),
    outputSchema: z.object({
        recipientSlackId: z.string(),
        recipientName: z.string(),
        primary: z.string(),
        primaryDisplayName: z.string(),
        secondary: z.string(),
        secondaryDisplayName: z.string(),
        shiftStart: z.string(),
        shiftEnd: z.string(),
        previousShiftStart: z.string(),
        previousShiftEnd: z.string(),
        incidents: z.string(),
        alerts: z.string(),
        prCandidates: z.string(),
        helpRequests: z.string(),
        infraUpdates: z.string(),
        discussions: z.string(),
        linearData: z.string(),
        runbookUpdates: z.string(),
        runbookLastUpdated: z.string(),
        runbookUpdateSuggestions: z.string(),
        incidentGuidelines: z.string(),
        previousHandoffNotes: z.string(),
    }),
    execute: async ({inputData}) => {
        console.log('🔄 Combining parallel results...');

        const schedule = inputData['get-rootly-schedule'];
        const inc = inputData['get-incidents'];
        const team = inputData['get-team-activity'];
        const linear = inputData['get-linear-tickets'];
        const slite = inputData['get-slite-docs'];
        const alertsData = inputData['get-alerts'];

        return {
            // Recipient info from Rootly schedule step
            recipientSlackId: schedule.recipientSlackId,
            recipientName: schedule.recipientName,
            // Rootly schedule (Slack mentions already resolved via direct API)
            primary: schedule.primary,
            primaryDisplayName: schedule.primaryDisplayName,
            secondary: schedule.secondary,
            secondaryDisplayName: schedule.secondaryDisplayName,
            shiftStart: schedule.shiftStart,
            shiftEnd: schedule.shiftEnd,
            previousShiftStart: schedule.previousShiftStart,
            previousShiftEnd: schedule.previousShiftEnd,
            // Incidents
            incidents: inc.incidents,
            // Alerts
            alerts: alertsData.alerts,
            // Team activity (PRs need verification in next step)
            prCandidates: team.prCandidates,
            helpRequests: team.helpRequests,
            infraUpdates: team.infraUpdates,
            discussions: team.discussions,
            // Linear
            linearData: linear.bugs,
            // Slite
            runbookUpdates: slite.runbookUpdates,
            runbookLastUpdated: slite.runbookLastUpdated,
            runbookUpdateSuggestions: slite.runbookUpdateSuggestions,
            incidentGuidelines: slite.incidentGuidelines,
            previousHandoffNotes: slite.previousHandoffNotes,
        };
    },
});

// ============================================================================
// RESOLVE SLACK USER IDS STEP (converts @username → <@SLACK_ID>)
// ============================================================================

// Shared schema for the combined data flowing through sequential steps
const combinedDataSchema = z.object({
    recipientSlackId: z.string(),
    recipientName: z.string(),
    primary: z.string(),
    primaryDisplayName: z.string(),
    secondary: z.string(),
    secondaryDisplayName: z.string(),
    shiftStart: z.string(),
    shiftEnd: z.string(),
    previousShiftStart: z.string(),
    previousShiftEnd: z.string(),
    incidents: z.string(),
    alerts: z.string(),
    prCandidates: z.string(),
    helpRequests: z.string(),
    infraUpdates: z.string(),
    discussions: z.string(),
    linearData: z.string(),
    runbookUpdates: z.string(),
    runbookLastUpdated: z.string(),
    runbookUpdateSuggestions: z.string(),
    incidentGuidelines: z.string(),
    previousHandoffNotes: z.string(),
});

const resolveSlackUserIdsStep = createStep({
    id: 'resolve-slack-users',
    description: 'Resolves incident @usernames to Slack user IDs for real @mentions',
    inputSchema: combinedDataSchema,
    outputSchema: combinedDataSchema.extend({
        userMap: z.string(),
    }),
    execute: async ({inputData, mastra}) => {
        console.log('👤 [resolve-slack-users] Starting...');
        const agent = mastra.getAgent('oncallDigestAgent');

        // On-call people already have Slack IDs from the Rootly API.
        // Only resolve usernames from incident involved arrays.
        const usernames = new Set<string>();
        const cleanUsername = (name: string) => name.replace(/^@/, '').trim();

        let incidents = [];
        try {
            incidents = JSON.parse(inputData.incidents);
        } catch {}
        for (const inc of incidents) {
            if (Array.isArray(inc.involved)) {
                for (const person of inc.involved) {
                    const cleaned = cleanUsername(person);
                    if (cleaned && cleaned !== 'unknown') usernames.add(cleaned);
                }
            }
            if (Array.isArray(inc.actionItems)) {
                for (const item of inc.actionItems) {
                    if (item.owner) {
                        const cleaned = cleanUsername(item.owner);
                        if (cleaned && cleaned !== 'unknown') usernames.add(cleaned);
                    }
                }
            }
        }

        const uniqueUsers = Array.from(usernames);
        console.log(`👤 [resolve-slack-users] Resolving ${uniqueUsers.length} incident users: ${uniqueUsers.join(', ')}`);

        if (uniqueUsers.length === 0) {
            return {
                ...inputData,
                userMap: '{}',
            };
        }

        const prompt = `Look up Slack user IDs for these usernames. For EACH username, use the zapier_slack_find_user tool.

Usernames to look up:
${uniqueUsers.map((u, i) => `${i + 1}. ${u}`).join('\n')}

For each user, search by their name or username. The tool may accept a "search" or "name" parameter.

Reply with ONLY a JSON object mapping each username to their Slack user ID:
{${uniqueUsers.map(u => `"${u}": "U12345678"`).join(', ')}}

If you cannot find a user, use null for their value.`;

        let userMap: Record<string, string | null> = {};
        try {
            const {text} = await agent.generate([{role: 'user', content: prompt}]);
            const match = text.match(/\{[\s\S]*\}/);
            if (match) {
                userMap = JSON.parse(match[0]);
            }
        } catch (e) {
            console.error('👤 [resolve-slack-users] Error resolving users:', e);
        }

        return {
            ...inputData,
            userMap: JSON.stringify(userMap),
        };
    },
});

// ============================================================================
// GITHUB PR VERIFICATION STEP (checks each PR candidate)
// ============================================================================

const resolvedDataSchema = combinedDataSchema.extend({
    userMap: z.string(),
});

const verifyPRsInGitHubStep = createStep({
    id: 'verify-prs-github',
    description: 'Checks each PR candidate in GitHub to see if it needs review',
    inputSchema: resolvedDataSchema,
    outputSchema: resolvedDataSchema.omit({prCandidates: true}).extend({
        prReviews: z.string(), // Verified PRs that still need review
    }),
    execute: async ({inputData, mastra}) => {
        console.log('🔍 Verifying PRs in GitHub...');
        const agent = mastra.getAgent('oncallDigestAgent');

        // Parse PR candidates
        let prCandidates = [];
        try {
            prCandidates = JSON.parse(inputData.prCandidates);
        } catch {
        }

        // If no PRs to check, skip
        if (prCandidates.length === 0) {
            console.log('   No PR candidates to verify');
            const {prCandidates: _, ...rest} = inputData;
            return {
                ...rest,
                prReviews: '[]',
            };
        }

        const prUrls = prCandidates.map((p: any) => p.prUrl).filter(Boolean);

        const prompt = `Check these GitHub PRs to see if they still need review from the Growth team:

PR URLs to check:
${prUrls.map((url: string, i: number) => `${i + 1}. ${url}`).join('\n')}

PR Details from Slack:
${JSON.stringify(prCandidates, null, 2)}

For EACH PR, use GitHub tools via Zapier to check:
1. Is the PR still open? (not merged or closed)
2. Has it been approved?
3. Are there review comments from Growth team members?
4. What is the current review status?

Return ONLY PRs that:
- Are still OPEN (not merged/closed)
- Have NOT been approved yet
- Do NOT have substantive review comments from Growth team

Reply with ONLY a JSON array of PRs that STILL NEED REVIEW:
[{
  "prUrl": "https://github.com/...",
  "from": "team/person who requested",
  "channel": "where it was posted",
  "postedDate": "YYYY-MM-DD",
  "status": "open - needs review",
  "reason": "why it still needs review"
}]

If ALL PRs have been reviewed/merged/closed, return: []`;

        try {
            const {text} = await agent.generate([{role: 'user', content: prompt}]);
            const match = text.match(/\[[\s\S]*\]/);
            const verifiedPRs = match ? match[0] : '[]';

            const {prCandidates: _, ...rest} = inputData;
            return {
                ...rest,
                prReviews: verifiedPRs,
            };
        } catch (e) {
            console.error('GitHub PR verification error:', e);
            // On error, return the candidates as-is (better to show potentially stale data than nothing)
            const {prCandidates: _, ...rest} = inputData;
            return {
                ...rest,
                prReviews: inputData.prCandidates,
            };
        }
    },
});

// ============================================================================
// ROOTLY ENRICHMENT STEP (enriches incidents with details)
// ============================================================================

const verifiedDataSchema = resolvedDataSchema.omit({prCandidates: true}).extend({
    prReviews: z.string(),
});

const getRootlyDetailsStep = createStep({
    id: 'get-rootly-details',
    description: 'Enriches incidents with Rootly details (duration, action items, etc.)',
    inputSchema: verifiedDataSchema,
    outputSchema: verifiedDataSchema,
    execute: async ({inputData, mastra}) => {
        console.log('📋 Getting Rootly incident details...');
        const dates = getDateContext();
        const agent = mastra.getAgent('oncallDigestAgent');

        // Parse existing incidents
        let incidents: any[] = [];
        try {
            incidents = JSON.parse(inputData.incidents);
        } catch {
        }

        // If no incidents, skip Rootly lookup
        if (incidents.length === 0) {
            console.log('   No incidents to enrich, skipping Rootly');
            return inputData;
        }

        // Step 1: Call Rootly MCP tool directly for each incident (parallel, no LLM)
        // Find the Rootly tool — name may vary across Zapier MCP versions
        const rootlyToolName = Object.keys(mcpTools).find(k => k.toLowerCase().includes('rootly'));
        const rootlyTool = rootlyToolName ? mcpTools[rootlyToolName] : null;
        if (!rootlyTool?.execute) {
            console.error(`📋 Rootly tool not found (available: ${Object.keys(mcpTools).filter(k => k.includes('rootly')).join(', ') || 'none'}), skipping enrichment`);
            return inputData;
        }

        // Log the tool's input schema to understand expected params
        console.log(`📋 Using tool: ${rootlyToolName}`);

        console.log(`📋 Fetching ${incidents.length} incidents from Rootly directly (parallel)...`);
        const rawResults = await Promise.all(
            incidents.map(async (incident: any) => {
                const slug = (incident.slug || '').replace(/^#/, '');
                try {
                    // Pass slug as the search/query parameter — Zapier Rootly actions
                    // typically accept a search term or incident identifier
                    const result = await rootlyTool.execute!({search: slug, slug, query: slug}, {} as any);
                    console.log(`📋 Got Rootly data for ${slug}`);
                    return {slug: incident.slug, rawData: result, original: incident};
                } catch (e) {
                    console.error(`📋 Rootly fetch failed for ${slug}:`, e);
                    return {slug: incident.slug, rawData: null, original: incident};
                }
            }),
        );

        // Step 2: Single LLM call to structure ALL raw Rootly data
        const successfulResults = rawResults.filter(r => r.rawData != null);
        if (successfulResults.length === 0) {
            console.log('📋 No Rootly data retrieved, using original incidents');
            return inputData;
        }

        const prompt = `Extract structured incident details from the raw Rootly API data below.

DATE CONTEXT:
- Last shift: ${dates.previousShiftStart} to ${dates.previousShiftEnd}

RAW ROOTLY DATA (one entry per incident):
${rawResults.map(r => `--- ${r.slug} ---\n${r.rawData ? JSON.stringify(r.rawData) : 'NO DATA (use original below)'}\nOriginal: ${JSON.stringify(r.original)}`).join('\n\n')}

For EACH incident, extract:
1. Summary of what happened
2. Duration (how long it lasted, or "ongoing")
3. Root cause (if identified)
4. Resolution summary
5. Action items with status (Done/Pending) and owner
6. Slack channel ID and link (https://glossgenius.slack.com/archives/CHANNEL_ID)
7. Team members involved

Reply with ONLY a JSON array:
[{
  "slug": "#inc-...",
  "channelId": "C12345678",
  "channelLink": "https://glossgenius.slack.com/archives/C12345678",
  "severity": "SEV-X",
  "status": "Resolved/Active",
  "duration": "3h 15m",
  "summary": "Brief summary",
  "rootCause": "Why it happened (or null)",
  "resolution": "How it was fixed (or null)",
  "actionItems": [{"task": "description", "status": "Done/Pending", "owner": "@person"}],
  "involved": ["@person1", "@person2"]
}]`;

        try {
            const {text} = await agent.generate([{role: 'user', content: prompt}]);
            const match = text.match(/\[[\s\S]*\]/);
            const enrichedIncidents = match ? match[0] : inputData.incidents;
            return {...inputData, incidents: enrichedIncidents};
        } catch (e) {
            console.error('📋 Rootly structuring error:', e);
            return inputData;
        }
    },
});

// ============================================================================
// GENERATE DIGEST STEP
// ============================================================================

const generateDigestStep = createStep({
    id: 'generate-digest',
    description: 'Generates the formatted handoff document',
    inputSchema: verifiedDataSchema,
    outputSchema: z.object({
        recipientSlackId: z.string(),
        recipientName: z.string(),
        digestContent: z.string(),
        shiftStart: z.string(),
        shiftEnd: z.string(),
        previousShiftStart: z.string(),
        previousShiftEnd: z.string(),
    }),
    execute: async ({inputData, mastra}) => {
        console.log('📝 Generating digest...');
        const agent = mastra.getAgent('oncallDigestAgent');

        // Parse JSON strings
        let incidents = [], alerts = [], prReviews = [], helpRequests = [], infraUpdates = [];
        let discussions = [], linearData: any = {}, runbookUpdates = [], incidentGuidelines = {};
        let runbookUpdateSuggestions: string[] = [];
        try {
            incidents = JSON.parse(inputData.incidents);
        } catch {
        }
        try {
            alerts = JSON.parse(inputData.alerts);
        } catch {
        }
        try {
            prReviews = JSON.parse(inputData.prReviews);
        } catch {
        }
        try {
            helpRequests = JSON.parse(inputData.helpRequests);
        } catch {
        }
        try {
            infraUpdates = JSON.parse(inputData.infraUpdates);
        } catch {
        }
        try {
            discussions = JSON.parse(inputData.discussions);
        } catch {
        }
        try {
            linearData = JSON.parse(inputData.linearData);
        } catch {
        }
        try {
            runbookUpdates = JSON.parse(inputData.runbookUpdates);
        } catch {
        }
        try {
            runbookUpdateSuggestions = JSON.parse(inputData.runbookUpdateSuggestions);
        } catch {
        }
        try {
            incidentGuidelines = JSON.parse(inputData.incidentGuidelines);
        } catch {
        }

        const pendingTickets = linearData.pendingTickets || [];
        const resolvedBugs = linearData.resolvedBugs || [];

        // Calculate runbook age
        let runbookAgeText = '';
        if (inputData.runbookLastUpdated && inputData.runbookLastUpdated !== 'Unknown') {
            const lastUpdated = new Date(inputData.runbookLastUpdated);
            const today = new Date();
            const daysDiff = Math.floor((today.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24));
            runbookAgeText = `(${daysDiff} days ago)`;
        }

        // 3c: Programmatic @username → <@SLACK_ID> substitution
        let userMap: Record<string, string | null> = {};
        try {
            userMap = JSON.parse(inputData.userMap);
        } catch {}

        const replaceUsernames = (obj: any): any => {
            if (typeof obj === 'string') {
                let result = obj;
                for (const [username, slackId] of Object.entries(userMap)) {
                    if (slackId) {
                        result = result.replace(new RegExp(`@${username}\\b`, 'g'), `<@${slackId}>`);
                    }
                }
                return result;
            }
            if (Array.isArray(obj)) return obj.map(replaceUsernames);
            if (obj && typeof obj === 'object') {
                const out: any = {};
                for (const [k, v] of Object.entries(obj)) {
                    out[k] = replaceUsernames(v);
                }
                return out;
            }
            return obj;
        };

        // Replace @usernames in incident involved arrays and action item owners
        incidents = replaceUsernames(incidents);

        const prompt = `Generate a CONCISE on-call handoff document for Slack. Use *bold*, _italic_, and \`code\` formatting.

HYPERLINK & FORMATTING RULES (CRITICAL — never output raw URLs):
1. *PR links*: Format as \`<https://github.com/org/repo/pull/123|org/repo#123>\`
2. *Linear tickets*: Format as \`<https://linear.app/glossgenius/issue/GRO-XXXXX|GRO-XXXXX>\` — construct URL from ticket identifier
3. *Slack threads*: Format as \`<https://thread-url|View thread>\`
4. *Incident channels*: Format as \`<#CHANNEL_ID|inc-slug>\` when channelId is available
5. *People mentions*: Already formatted as \`<@SLACK_ID>\` — pass them through as-is, do NOT wrap in extra formatting
6. Keep everything scannable — short descriptions, no long paragraphs
7. Use \`backticks\` for alert/monitor names and technical terms
8. NEVER output a bare URL — every URL must be inside \`<url|label>\` syntax
9. For section dividers, use dashes (---) NOT unicode box-drawing characters

DATE CONTEXT:
- Current shift: ${inputData.shiftStart} to ${inputData.shiftEnd}
- Last shift (being handed off): ${inputData.previousShiftStart} to ${inputData.previousShiftEnd}

ON-CALL:
- Primary: ${inputData.primary} (${inputData.primaryDisplayName})
- Secondary: ${inputData.secondary} (${inputData.secondaryDisplayName})
- Previous: Check the previous handoff notes below for who was on-call last week

PREVIOUS HANDOFF NOTES:
${inputData.previousHandoffNotes || 'None available'}

DATA:
- Incidents: ${JSON.stringify(incidents)}
- Alerts: ${JSON.stringify(alerts)}
- Resolved Bugs: ${JSON.stringify(resolvedBugs)}
- Pending Tickets (Growth team): ${JSON.stringify(pendingTickets)}
- PR Reviews: ${JSON.stringify(prReviews)}
- Help Requests: ${JSON.stringify(helpRequests)}
- Infrastructure: ${JSON.stringify(infraUpdates)}
- Discussions: ${JSON.stringify(discussions)}
- Runbook Last Updated: ${inputData.runbookLastUpdated} ${runbookAgeText}
- Runbook Suggestions: ${JSON.stringify(runbookUpdateSuggestions)}
- Runbook Updates: ${JSON.stringify(runbookUpdates)}
- Incident Guidelines: ${JSON.stringify(incidentGuidelines)}

OUTPUT FORMAT — Follow this exact section structure. For sections with no data, write "N/A" on one line.
Use plain text descriptions (like the example below), NOT bullet-point lists of JSON fields.

---
*ON-CALL HANDOFF* | Growth Team | ${inputData.shiftStart} - ${inputData.shiftEnd}
${inputData.primary} (secondary: ${inputData.secondary})
---

*Alerts/Pages*
Describe each alert/page that fired during the shift with context about what happened and what was done about it.
Include the monitor name in backticks, when it fired, and any actions taken.
Example style:
The \`Subscription Webhooks Endpoint is erroring at a high rate\` monitor in Datadog is very sensitive
The \`Triggered: [Synthetics] Marketing Website: Get a free trial test\` monitor went off on Wednesday May 6th from a change to the marketing site.

*Incidents*
List any incidents that occurred. If none, write "N/A".

*Improvements*
List any improvements made during the shift - monitor updates, new monitors created, config changes, etc.

*Bug Triage*
List any bugs triaged or fixed. If none, write "N/A".

*Backlog Burndown*
List any backlog cleanup work done (old tickets cleaned up, tickets associated with projects, etc.). If none, write "N/A".

*Other Notes or Events*
Any other notable items - team offsites, ongoing work by other teams, etc. If none, write "N/A".

*Hand-off Notes (for next person)*
IMPORTANT: This is the most critical section. Include:
- Anything the next on-call person should watch out for
- Ongoing issues that need monitoring
- Follow-ups from the previous handoff (reference PREVIOUS HANDOFF NOTES above and note status of items mentioned there)
- Any context the next person needs to be effective
If there are items from the previous handoff notes, explicitly mention whether they are resolved or still ongoing.

IMPORTANT:
- Keep descriptions concise but informative — a sentence or two per item, not single-word bullets
- Every URL must be a Slack hyperlink: <url|label>
- Use dashes (---) for dividers, NOT unicode characters like ═
- Write in a natural, conversational tone (see the example format above)

Generate the complete document now. Output ONLY the formatted text.`;

        try {
            const {text} = await agent.generate([{role: 'user', content: prompt}]);
            return {
                recipientSlackId: inputData.recipientSlackId,
                recipientName: inputData.recipientName,
                digestContent: text,
                shiftStart: inputData.shiftStart,
                shiftEnd: inputData.shiftEnd,
                previousShiftStart: inputData.previousShiftStart,
                previousShiftEnd: inputData.previousShiftEnd,
            };
        } catch (e) {
            console.error('Generate error:', e);
            throw new Error('Failed to generate digest');
        }
    },
});

// ============================================================================
// CREATE SLITE HANDOFF ENTRY STEP
// ============================================================================

const createSliteHandoffEntryStep = createStep({
    id: 'create-slite-handoff-entry',
    description: 'Creates a new Slite doc entry in the Growth On-Call Handoff table',
    inputSchema: z.object({
        recipientSlackId: z.string(),
        recipientName: z.string(),
        digestContent: z.string(),
        shiftStart: z.string(),
        shiftEnd: z.string(),
        previousShiftStart: z.string(),
        previousShiftEnd: z.string(),
    }),
    outputSchema: z.object({
        recipientSlackId: z.string(),
        recipientName: z.string(),
        digestContent: z.string(),
        sliteDocUrl: z.string(),
    }),
    execute: async ({inputData, mastra}) => {
        console.log('📝 [create-slite-handoff] Creating Slite handoff entry...');
        const agent = mastra.getAgent('oncallDigestAgent');

        const prompt = `Create a new Slite document for this on-call handoff and add it to the Growth On-Call Handoff table.

HANDOFF TABLE DOC: https://glossgenius.slite.com/app/docs/hNke50mcj454f5/Growth-On-Call-Handoff

Use the Slite tool (via Zapier) to create a new note/document with:
- Title: "Growth On-Call Handoff ${inputData.previousShiftStart} to ${inputData.shiftEnd}"
- Content: The digest below (formatted for Slite/markdown)
- Parent/collection: Link it to the Growth On-Call Handoff doc if possible

DIGEST CONTENT:
${inputData.digestContent}

After creating the doc, reply with ONLY a JSON object:
{"sliteDocUrl": "https://glossgenius.slite.com/app/docs/..."}

If creation fails, reply with:
{"sliteDocUrl": ""}`;

        let sliteDocUrl = '';
        try {
            const {text} = await agent.generate([{role: 'user', content: prompt}]);
            const match = text.match(/\{[\s\S]*\}/);
            if (match) {
                const data = JSON.parse(match[0]);
                sliteDocUrl = data.sliteDocUrl || '';
            }
            console.log(`📝 [create-slite-handoff] Created doc: ${sliteDocUrl || 'failed'}`);
        } catch (e) {
            console.error('📝 [create-slite-handoff] Error:', e);
        }

        return {
            recipientSlackId: inputData.recipientSlackId,
            recipientName: inputData.recipientName,
            digestContent: sliteDocUrl
                ? `${inputData.digestContent}\n\n_Handoff doc: <${sliteDocUrl}|View in Slite>_`
                : inputData.digestContent,
            sliteDocUrl,
        };
    },
});

// ============================================================================
// SEND SLACK DM STEP
// ============================================================================

const sendSlackDMStep = createStep({
    id: 'send-slack-dm',
    description: 'Sends the digest as a Slack DM',
    inputSchema: z.object({
        recipientSlackId: z.string(),
        recipientName: z.string(),
        digestContent: z.string(),
        sliteDocUrl: z.string(),
    }),
    outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        recipientSlackId: z.string(),
    }),
    execute: async ({inputData, mastra}) => {
        console.log('💬 [send-slack-dm] Starting...');
        console.log(`💬 [send-slack-dm] Recipient: ${inputData.recipientSlackId} (${inputData.recipientName})`);
        console.log(`💬 [send-slack-dm] Digest length: ${inputData.digestContent.length} chars`);

        // Try to find the Slack DM tool directly in MCP tools
        const slackDmToolName = Object.keys(mcpTools).find(
            k => k.toLowerCase().includes('slack') && k.toLowerCase().includes('direct_message'),
        );
        const slackSendToolName = Object.keys(mcpTools).find(
            k => k.toLowerCase().includes('slack') && k.toLowerCase().includes('send') && !k.toLowerCase().includes('direct'),
        );

        console.log(`💬 [send-slack-dm] Available Slack tools: ${Object.keys(mcpTools).filter(k => k.toLowerCase().includes('slack')).join(', ')}`);
        console.log(`💬 [send-slack-dm] DM tool: ${slackDmToolName || 'not found'}`);
        console.log(`💬 [send-slack-dm] Send tool: ${slackSendToolName || 'not found'}`);

        // Attempt 1: Direct MCP tool call (fastest, most reliable)
        const dmTool = slackDmToolName ? mcpTools[slackDmToolName] : null;
        if (dmTool?.execute) {
            try {
                console.log(`💬 [send-slack-dm] Calling ${slackDmToolName} directly...`);
                const result = await dmTool.execute({
                    user: inputData.recipientSlackId,
                    message: inputData.digestContent,
                    text: inputData.digestContent,
                    channel: inputData.recipientSlackId,
                }, {} as any);

                console.log(`💬 [send-slack-dm] Direct tool result:`, JSON.stringify(result).slice(0, 500));

                // Check if result indicates success
                const resultStr = JSON.stringify(result);
                if (resultStr.includes('error') || resultStr.includes('invalid') || resultStr.includes('not_found')) {
                    console.error(`💬 [send-slack-dm] Direct tool returned error: ${resultStr.slice(0, 300)}`);
                } else {
                    return {
                        success: true,
                        message: `Sent via direct tool to ${inputData.recipientSlackId}`,
                        recipientSlackId: inputData.recipientSlackId,
                    };
                }
            } catch (e) {
                console.error(`💬 [send-slack-dm] Direct tool call failed:`, e);
            }
        }

        // Attempt 2: Fall back to agent-based approach with better prompting
        console.log('💬 [send-slack-dm] Falling back to agent-based approach...');
        const agent = mastra.getAgent('oncallDigestAgent');

        const prompt = `You MUST use a Slack tool to send a direct message. This is critical — do NOT just describe what you would do, actually call the tool.

Available Slack tools: ${Object.keys(mcpTools).filter(k => k.toLowerCase().includes('slack')).join(', ')}

Send a direct message to user "${inputData.recipientSlackId}" with the following content.
Try the tool with these parameter variations:
- user/channel: "${inputData.recipientSlackId}"
- message/text: The digest content below

DIGEST TO SEND:
${inputData.digestContent}

After calling the tool, report the EXACT result. Did it succeed or fail? Include any error messages.`;

        try {
            const {text} = await agent.generate([{role: 'user', content: prompt}]);
            console.log('💬 [send-slack-dm] Agent response:', text.slice(0, 500));

            // More specific success detection — avoid matching generic word "message"
            const hasError = /error|failed|couldn't|unable|not found|invalid/i.test(text);
            const hasSuccess = /sent successfully|delivered|message sent|DM sent/i.test(text);
            const success = hasSuccess && !hasError;

            return {
                success,
                message: success
                    ? `Sent to ${inputData.recipientSlackId}`
                    : `May have failed. Agent response: ${text.slice(0, 300)}`,
                recipientSlackId: inputData.recipientSlackId,
            };
        } catch (e) {
            console.error('💬 [send-slack-dm] Agent error:', e);
            return {
                success: false,
                message: `Failed: ${e}`,
                recipientSlackId: inputData.recipientSlackId,
            };
        }
    },
});

// ============================================================================
// MAIN WORKFLOW
// ============================================================================

export const oncallDigestWorkflow = createWorkflow({
    id: 'oncall-digest-workflow',
    description: 'Generates and sends an on-call handoff digest for Growth team via Slack DM',
    inputSchema: workflowInputSchema,
    outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        recipientSlackId: z.string(),
    }),
})
    // Run data gathering in parallel
    .parallel([
        getRootlyScheduleStep,
        getIncidentsStep,
        getTeamChannelActivityStep,
        getLinearTicketsStep,
        getSliteDocsStep,
        getAlertsStep,
    ])
    // Combine parallel results
    .then(combineParallelResultsStep)
    // Resolve incident @usernames to Slack user IDs
    .then(resolveSlackUserIdsStep)
    // Verify PRs in GitHub (sequential - needs PR candidates from combine)
    .then(verifyPRsInGitHubStep)
    // Enrich incidents with Rootly details
    .then(getRootlyDetailsStep)
    // Generate the digest
    .then(generateDigestStep)
    // Create Slite handoff entry
    .then(createSliteHandoffEntryStep)
    // Send via Slack
    .then(sendSlackDMStep)
    .commit();
