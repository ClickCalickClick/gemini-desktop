/**
 * Route chip: shows where Quick Chat will send the prompt ("Gemini" or
 * "Agent · Files") and why. Clicking it switches the route for this prompt.
 *
 * @module RouteChip
 */

import React from 'react';

import { describeRoute } from '../../../shared/utils/quickChatRouter';
import { QUICK_CHAT_TEST_IDS } from '../../utils/testIds';
import type { RouteDecision } from '../../../shared/types/agent';

interface RouteChipProps {
    decision: RouteDecision;
    onToggle: () => void;
}

export function RouteChip({ decision, onToggle }: RouteChipProps): React.ReactElement {
    const label = describeRoute(decision);
    const other = decision.route === 'web' ? 'the agent' : 'Gemini';
    return (
        <button
            type="button"
            className={`quick-chat-route-chip quick-chat-route-chip--${decision.route}${decision.forced ? ' quick-chat-route-chip--forced' : ''}`}
            onClick={onToggle}
            onMouseDown={(event) => event.preventDefault()}
            title={`${label}: ${decision.reason}. Click to send to ${other} instead.`}
            aria-label={`Sends to ${label} (${decision.reason}). Click to send to ${other} instead.`}
            data-route={decision.route}
            data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_ROUTE_CHIP}
        >
            {label}
        </button>
    );
}

export default RouteChip;
