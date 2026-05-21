/**
 * GitHub PR verification via the gh CLI.
 * Replaces the Zapier MCP GitHub integration.
 */

import {execSync} from 'child_process';

export interface PRStatus {
    prUrl: string;
    state: string; // OPEN, CLOSED, MERGED
    title: string;
    reviewDecision: string; // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, ""
    isDraft: boolean;
    needsReview: boolean;
}

/**
 * Check the status of a GitHub PR using the gh CLI.
 */
function checkPR(prUrl: string): PRStatus | null {
    try {
        const result = execSync(
            `gh pr view "${prUrl}" --json state,title,reviewDecision,isDraft`,
            {encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe']},
        );
        const data = JSON.parse(result.trim());
        return {
            prUrl,
            state: data.state || 'UNKNOWN',
            title: data.title || '',
            reviewDecision: data.reviewDecision || '',
            isDraft: data.isDraft || false,
            needsReview: data.state === 'OPEN' && data.reviewDecision !== 'APPROVED',
        };
    } catch (e) {
        console.error(`🔍 [github] Failed to check PR ${prUrl}:`, e instanceof Error ? e.message : e);
        return null;
    }
}

/**
 * Verify a list of PR candidates and return only those still needing review.
 * Each candidate should have a `prUrl` field.
 */
export function verifyPRs(prCandidates: Array<{prUrl: string; [key: string]: any}>): Array<{prUrl: string; status: string; title: string; reason: string; [key: string]: any}> {
    console.log(`🔍 [github] Verifying ${prCandidates.length} PRs via gh CLI...`);

    const results = prCandidates
        .map(candidate => {
            const prStatus = checkPR(candidate.prUrl);
            if (!prStatus) {
                // If we can't check, include it as potentially needing review
                return {...candidate, status: 'unknown', title: '', reason: 'Could not verify status'};
            }

            if (!prStatus.needsReview) {
                console.log(`🔍 [github] ${candidate.prUrl} — ${prStatus.state} / ${prStatus.reviewDecision || 'no review'} — skipping`);
                return null;
            }

            const reason = prStatus.isDraft
                ? 'Draft PR, not yet ready but flagged for awareness'
                : prStatus.reviewDecision === 'CHANGES_REQUESTED'
                    ? 'Changes requested, awaiting updates'
                    : 'Open and awaiting review';

            console.log(`🔍 [github] ${candidate.prUrl} — needs review: ${reason}`);
            return {
                ...candidate,
                status: `${prStatus.state.toLowerCase()}${prStatus.isDraft ? ' (draft)' : ''}`,
                title: prStatus.title,
                reason,
            };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

    console.log(`🔍 [github] ${results.length}/${prCandidates.length} PRs still need review`);
    return results;
}
