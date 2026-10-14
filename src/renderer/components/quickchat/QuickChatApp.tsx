/**
 * Quick Chat Application Component
 *
 * A macOS Spotlight-inspired floating input. Each prompt goes either to a Gemini
 * web tab (as before) or to the local agent CLI, as decided by the Quick Chat
 * router; a chip next to the send button shows the route and lets the user
 * switch it. Agent answers stream into a panel under the input, and the window
 * grows to fit it.
 *
 * The camera button attaches a screenshot to the next prompt (H10): Quick Chat
 * hides, the main process takes it, and the Gemini tab or the agent gets the image
 * with the prompt. Shift+click (or Ctrl+Shift+S / Cmd+Shift+S for the whole
 * screen) picks an area first where the desktop offers it.
 *
 * Keys: Enter sends to the shown route, Ctrl+Enter (Cmd+Enter on macOS) to the
 * other one, Tab accepts a text prediction, Escape dismisses a prediction, stops
 * a running agent, or hides Quick Chat.
 *
 * @module QuickChatApp
 */

import React, { useState, useEffect, useRef, useCallback, useMemo, useReducer } from 'react';

import { AgentPanel } from './AgentPanel';
import { agentRunReducer, buildContinueInGeminiPrompt, INITIAL_AGENT_RUN_STATE, isRunActive } from './agentRunState';
import { CameraIcon, SearchIcon, SendIcon } from './Icons';
import { RouteChip } from './RouteChip';
import { createRendererLogger } from '../../utils';
import { QUICK_CHAT_TEST_IDS } from '../../utils/testIds';
import { forceRoute, otherRoute, parseRoutePrefix, routePrompt } from '../../../shared/utils/quickChatRouter';
import type {
    AgentEngineStatus,
    AgentRunEvent,
    AgentSettings,
    QuickChatRoute,
    QuickChatRoutingMode,
    RouteDecision,
} from '../../../shared/types/agent';
import type { ScreenshotMode, ScreenshotPreview } from '../../../shared/types/screenshot';
import './QuickChat.css';

/** Logger for Quick Chat component. Never pass prompt text or agent output to it. */
const logger = createRendererLogger('[QuickChat]');

/** Debounce delay for text prediction requests in milliseconds */
const PREDICTION_DEBOUNCE_MS = 300;

/** Window height with only the input showing (matches QUICK_CHAT_HEIGHT in the main process). */
export const QUICK_CHAT_COMPACT_HEIGHT = 80;

/** Padding around the container inside the transparent window (#root padding, top + bottom). */
const WINDOW_VERTICAL_PADDING = 16;

/** Debounce for window resize requests while the panel changes size. */
const RESIZE_DEBOUNCE_MS = 30;

/** How long Stop waits for the CLI's done event before the panel treats the run as stopped. */
export const STOP_TIMEOUT_MS = 5000;

/** How long after a screenshot Quick Chat's own hide and show events are still ignored. */
export const CAPTURE_SETTLE_MS = 1000;

/** How long a screenshot error stays under the input. */
export const SCREENSHOT_ERROR_MS = 8000;

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : 'Could not start the agent.';
}

/**
 * Main Quick Chat component.
 * Renders a Spotlight-like floating input with submit functionality.
 */
function QuickChatApp(): React.ReactElement {
    const [inputValue, setInputValue] = useState('');

    // Text prediction state
    const [prediction, setPrediction] = useState<string | null>(null);
    const [_isLoadingPrediction, setIsLoadingPrediction] = useState(false);
    const [isPredictionEnabled, setIsPredictionEnabled] = useState(false);
    const [isModelReady, setIsModelReady] = useState(false);

    // Routing state
    const [routingMode, setRoutingMode] = useState<QuickChatRoutingMode>('auto');
    const [agentStatus, setAgentStatus] = useState<AgentEngineStatus | null>(null);
    const [routeOverride, setRouteOverride] = useState<QuickChatRoute | null>(null);

    // Agent run state
    const [run, dispatch] = useReducer(agentRunReducer, INITIAL_AGENT_RUN_STATE);
    const runIdRef = useRef<string | null>(null);
    const startingRef = useRef(false);
    const startTokenRef = useRef(0);
    const bufferedEventsRef = useRef<AgentRunEvent[]>([]);
    const stopRequestedRef = useRef(false);
    const runActiveRef = useRef(false);
    const runStateRef = useRef(run);
    const inputValueRef = useRef('');
    const resetPanelRef = useRef<() => void>(() => {});

    // Screenshot attached to the next prompt (H10)
    const [screenshot, setScreenshot] = useState<ScreenshotPreview | null>(null);
    const [capturing, setCapturing] = useState(false);
    const [screenshotError, setScreenshotError] = useState<string | null>(null);
    const screenshotRef = useRef<ScreenshotPreview | null>(null);
    /** True while a screenshot is taken and shortly after: Quick Chat's hide and show are its own. */
    const capturingRef = useRef(false);
    const captureInFlightRef = useRef(false);
    const captureSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Ref for debounce timeout
    const predictionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const isMac = window.electronAPI?.platform === 'darwin';
    const runActive = isRunActive(run);
    const panelVisible = run.phase !== 'idle';
    const expanded = panelVisible || Boolean(screenshotError);

    useEffect(() => {
        runActiveRef.current = runActive;
        runStateRef.current = run;
        inputValueRef.current = inputValue;
        screenshotRef.current = screenshot;
    }, [runActive, run, inputValue, screenshot]);

    // Sync text prediction enabled state and model readiness from settings
    useEffect(() => {
        // Get initial prediction status
        logger.log('Loading initial prediction status...');
        window.electronAPI?.getTextPredictionStatus().then((settings) => {
            logger.log('Initial prediction status:', {
                enabled: settings.enabled,
                status: settings.status,
                isReady: settings.status === 'ready',
            });
            setIsPredictionEnabled(settings.enabled);
            setIsModelReady(settings.status === 'ready');
        });

        // Subscribe to status changes
        const unsubscribe = window.electronAPI?.onTextPredictionStatusChanged((settings) => {
            logger.log('Prediction status changed:', {
                enabled: settings.enabled,
                status: settings.status,
                isReady: settings.status === 'ready',
            });
            setIsPredictionEnabled(settings.enabled);
            setIsModelReady(settings.status === 'ready');
        });

        return () => {
            unsubscribe?.();
        };
    }, []);

    // Load the routing settings and the agent status; refresh the status whenever the window gains focus
    useEffect(() => {
        const controller = new AbortController();
        const api = window.electronAPI;

        const refreshStatus = () => {
            if (typeof api?.getAgentStatus !== 'function') {
                return;
            }
            api.getAgentStatus()
                .then((status) => {
                    if (!controller.signal.aborted) {
                        setAgentStatus(status);
                    }
                })
                .catch((error: unknown) => logger.error('Failed to load agent status:', error));
        };

        if (typeof api?.getAgentSettings === 'function') {
            api.getAgentSettings()
                .then((settings) => {
                    if (!controller.signal.aborted && settings) {
                        setRoutingMode(settings.quickChatRoutingMode);
                    }
                })
                .catch((error: unknown) => logger.error('Failed to load agent settings:', error));
        }
        refreshStatus();

        const unsubscribe =
            typeof api?.onAgentSettingsChanged === 'function'
                ? api.onAgentSettingsChanged((settings: AgentSettings) => {
                      setRoutingMode(settings.quickChatRoutingMode);
                      refreshStatus();
                  })
                : undefined;

        window.addEventListener('focus', refreshStatus);
        return () => {
            controller.abort();
            unsubscribe?.();
            window.removeEventListener('focus', refreshStatus);
        };
    }, []);

    // Agent events: buffer them while runAgent has not returned the runId yet, and ignore other runs
    useEffect(() => {
        const api = window.electronAPI;
        if (typeof api?.onAgentEvent !== 'function') {
            return;
        }
        return api.onAgentEvent((event) => {
            if (startingRef.current) {
                bufferedEventsRef.current.push(event);
                return;
            }
            if (event.runId === runIdRef.current) {
                dispatch({ type: 'event', event });
            }
        });
    }, []);

    // Grow the window to fit the panel (or a screenshot error) while it is showing
    const wasExpandedRef = useRef(false);
    useEffect(() => {
        if (!expanded) {
            if (wasExpandedRef.current) {
                wasExpandedRef.current = false;
                window.electronAPI?.resizeQuickChat?.(QUICK_CHAT_COMPACT_HEIGHT);
            }
            return;
        }
        wasExpandedRef.current = true;
        const element = containerRef.current;
        if (!element) {
            return;
        }
        let lastHeight = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const measure = () => {
            const height = Math.max(
                QUICK_CHAT_COMPACT_HEIGHT,
                Math.ceil(element.getBoundingClientRect().height + WINDOW_VERTICAL_PADDING)
            );
            if (height !== lastHeight) {
                lastHeight = height;
                window.electronAPI?.resizeQuickChat?.(height);
            }
        };
        measure();
        if (typeof ResizeObserver === 'undefined') {
            return;
        }
        const observer = new ResizeObserver(() => {
            if (timer) {
                clearTimeout(timer);
            }
            timer = setTimeout(measure, RESIZE_DEBOUNCE_MS);
        });
        observer.observe(element);
        return () => {
            observer.disconnect();
            if (timer) {
                clearTimeout(timer);
            }
        };
    }, [expanded]);

    // A screenshot error goes away after a while
    useEffect(() => {
        if (!screenshotError) {
            return;
        }
        const timer = setTimeout(() => setScreenshotError(null), SCREENSHOT_ERROR_MS);
        return () => clearTimeout(timer);
    }, [screenshotError]);

    // If the CLI never confirms a stop, treat the run as stopped after a few seconds
    useEffect(() => {
        if (run.phase !== 'stopping') {
            return;
        }
        const timer = setTimeout(() => dispatch({ type: 'stopTimedOut' }), STOP_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [run.phase]);

    // Quick Chat hides on blur. When it is shown again with an answer the user already saw and an
    // empty input, start compact. An answer that finished while Quick Chat was hidden stays, so it
    // can be read, and so does a plan still waiting for Apply, so the user can look at the files first.
    useEffect(() => {
        let wasHidden = false;
        let doneWhenHidden = false;
        const markHidden = () => {
            // Quick Chat hides itself while a screenshot is taken; that is not the user leaving.
            if (capturingRef.current) {
                return;
            }
            // Never keep a screenshot around for a later, unrelated prompt.
            const attached = screenshotRef.current;
            if (attached) {
                screenshotRef.current = null;
                window.electronAPI?.discardQuickChatScreenshot?.(attached.id);
                setScreenshot(null);
            }
            if (!wasHidden) {
                doneWhenHidden = runStateRef.current.phase === 'done';
            }
            wasHidden = true;
        };
        const maybeReset = () => {
            if (!wasHidden || document.visibilityState === 'hidden') {
                return;
            }
            wasHidden = false;
            if (!doneWhenHidden) {
                return;
            }
            const state = runStateRef.current;
            const planWaiting =
                state.planState === 'pending' || state.planState === 'applying' || state.planState === 'undoing';
            if (state.phase === 'done' && !planWaiting && !inputValueRef.current.trim()) {
                resetPanelRef.current();
            }
        };
        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                markHidden();
            } else {
                maybeReset();
            }
        };
        window.addEventListener('blur', markHidden);
        window.addEventListener('focus', maybeReset);
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            window.removeEventListener('blur', markHidden);
            window.removeEventListener('focus', maybeReset);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, []);

    // Cleanup timeout on unmount
    useEffect(() => {
        return () => {
            if (predictionTimeoutRef.current) {
                clearTimeout(predictionTimeoutRef.current);
            }
        };
    }, []);

    // Auto-focus input on mount
    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const canFollowUp = run.phase === 'done' && Boolean(run.conversationId);

    const decision: RouteDecision = useMemo(() => {
        if (routeOverride) {
            return forceRoute(inputValue, routeOverride);
        }
        return routePrompt(inputValue, {
            mode: routingMode,
            agentAvailable: agentStatus?.available ?? false,
            followUp: canFollowUp,
        });
    }, [inputValue, routeOverride, routingMode, agentStatus, canFollowUp]);

    /** Clear the panel, forget the conversation and shrink the window back to the input. */
    const resetPanel = useCallback(() => {
        if (runIdRef.current && runActiveRef.current) {
            window.electronAPI?.cancelAgent(runIdRef.current);
        }
        startTokenRef.current += 1;
        startingRef.current = false;
        bufferedEventsRef.current = [];
        runIdRef.current = null;
        stopRequestedRef.current = false;
        dispatch({ type: 'reset' });
        window.electronAPI?.resizeQuickChat?.(QUICK_CHAT_COMPACT_HEIGHT);
    }, []);

    useEffect(() => {
        resetPanelRef.current = resetPanel;
    }, [resetPanel]);

    const clearInput = useCallback(() => {
        setInputValue('');
        setPrediction(null);
        setRouteOverride(null);
    }, []);

    /** The attached screenshot's id for the prompt being sent; the screenshot leaves Quick Chat. */
    const takeAttachedScreenshot = useCallback((): string | undefined => {
        const attached = screenshotRef.current;
        screenshotRef.current = null;
        setScreenshot(null);
        setScreenshotError(null);
        return attached?.id;
    }, []);

    const removeScreenshot = useCallback(() => {
        const id = takeAttachedScreenshot();
        if (id) {
            window.electronAPI?.discardQuickChatScreenshot?.(id);
        }
        inputRef.current?.focus();
    }, [takeAttachedScreenshot]);

    const takeScreenshot = useCallback(async (mode: ScreenshotMode) => {
        const api = window.electronAPI;
        if (captureInFlightRef.current || typeof api?.captureQuickChatScreenshot !== 'function') {
            return;
        }
        captureInFlightRef.current = true;
        capturingRef.current = true;
        if (captureSettleTimerRef.current) {
            clearTimeout(captureSettleTimerRef.current);
            captureSettleTimerRef.current = null;
        }
        setCapturing(true);
        setScreenshotError(null);
        try {
            const result = await api.captureQuickChatScreenshot(mode);
            if (result.status === 'captured') {
                // The main process keeps only the latest screenshot.
                screenshotRef.current = result.preview;
                setScreenshot(result.preview);
            } else if (result.status === 'error') {
                setScreenshotError(result.error);
            }
        } catch (error) {
            logger.error('Failed to take a screenshot:', error);
            setScreenshotError('The screenshot could not be taken.');
        } finally {
            captureInFlightRef.current = false;
            setCapturing(false);
            inputRef.current?.focus();
            // Showing Quick Chat again can hide and show the window once more (GNOME Wayland, L21),
            // and those events may arrive after this answer.
            captureSettleTimerRef.current = setTimeout(() => {
                captureSettleTimerRef.current = null;
                capturingRef.current = false;
            }, CAPTURE_SETTLE_MS);
        }
    }, []);

    const sendToWeb = useCallback(
        (prompt: string) => {
            const screenshotId = takeAttachedScreenshot();
            if (screenshotId) {
                window.electronAPI?.submitQuickChat(prompt, { screenshotId });
            } else {
                window.electronAPI?.submitQuickChat(prompt);
            }
            clearInput();
            if (panelVisible) {
                resetPanel();
            }
        },
        [clearInput, panelVisible, resetPanel, takeAttachedScreenshot]
    );

    const sendToAgent = useCallback(
        async (target: RouteDecision) => {
            const api = window.electronAPI;
            if (!api || runActive) {
                return;
            }
            const category = target.category ?? 'general';
            clearInput();
            const screenshotId = takeAttachedScreenshot();

            if (agentStatus && !agentStatus.available) {
                if (screenshotId) {
                    api.discardQuickChatScreenshot?.(screenshotId);
                }
                dispatch({
                    type: 'setupMissing',
                    prompt: target.prompt,
                    category,
                    error: agentStatus.error ?? 'No agent CLI found.',
                });
                return;
            }

            const token = startTokenRef.current + 1;
            startTokenRef.current = token;
            startingRef.current = true;
            bufferedEventsRef.current = [];
            runIdRef.current = null;
            stopRequestedRef.current = false;
            dispatch({ type: 'start', prompt: target.prompt, category });

            try {
                const { runId } = await api.runAgent({
                    prompt: target.prompt,
                    category,
                    conversationId: run.conversationId ?? undefined,
                    ...(screenshotId ? { screenshotId } : {}),
                });
                if (token !== startTokenRef.current) {
                    // The panel was reset while the run was starting.
                    api.cancelAgent(runId);
                    return;
                }
                runIdRef.current = runId;
                startingRef.current = false;
                dispatch({ type: 'assigned', runId });
                const buffered = bufferedEventsRef.current;
                bufferedEventsRef.current = [];
                for (const event of buffered) {
                    if (event.runId === runId) {
                        dispatch({ type: 'event', event });
                    }
                }
                if (stopRequestedRef.current) {
                    api.cancelAgent(runId);
                }
            } catch (error) {
                if (token !== startTokenRef.current) {
                    return;
                }
                startingRef.current = false;
                logger.error('Failed to start agent run:', error);
                dispatch({ type: 'startFailed', error: errorMessage(error) });
            }
        },
        [agentStatus, clearInput, run.conversationId, runActive, takeAttachedScreenshot]
    );

    const send = useCallback(
        (target: RouteDecision) => {
            if (!target.prompt) {
                return;
            }
            if (target.route === 'web') {
                sendToWeb(target.prompt);
            } else {
                void sendToAgent(target);
            }
        },
        [sendToAgent, sendToWeb]
    );

    /** Enter / send button: the route the chip shows. */
    const handleSubmit = useCallback(() => {
        if (!inputValue.trim()) {
            return;
        }
        send(decision);
    }, [decision, inputValue, send]);

    const stopRun = useCallback(() => {
        if (!isRunActive(run)) {
            return;
        }
        stopRequestedRef.current = true;
        dispatch({ type: 'stopRequested' });
        if (runIdRef.current) {
            window.electronAPI?.cancelAgent(runIdRef.current);
        }
    }, [run]);

    const handleApplyPlan = useCallback(async () => {
        const runId = run.runId;
        const api = window.electronAPI;
        if (!runId || !api) {
            return;
        }
        dispatch({ type: 'planApplying' });
        try {
            const result = await api.applyFilePlan(runId);
            dispatch({ type: 'planApplied', result });
        } catch (error) {
            logger.error('Failed to apply file plan:', error);
            dispatch({ type: 'planFailed', error: `Could not apply the plan: ${errorMessage(error)}` });
        }
    }, [run.runId]);

    const handleUndoPlan = useCallback(async () => {
        const api = window.electronAPI;
        if (!api) {
            return;
        }
        dispatch({ type: 'planUndoing' });
        try {
            const result = await api.undoLastFilePlan();
            dispatch({ type: 'planUndone', result });
        } catch (error) {
            logger.error('Failed to undo file plan:', error);
            dispatch({ type: 'planFailed', error: `Could not undo the plan: ${errorMessage(error)}` });
        }
    }, []);

    const handleNew = useCallback(() => {
        resetPanel();
        inputRef.current?.focus();
    }, [resetPanel]);

    const handleContinueInGemini = useCallback(() => {
        window.electronAPI?.submitQuickChat(buildContinueInGeminiPrompt(run.prompt, run.text));
        clearInput();
        resetPanel();
    }, [clearInput, resetPanel, run.prompt, run.text]);

    /**
     * Keyboard events on the input.
     * Enter = send to the shown route, Ctrl/Cmd+Enter = send to the other route, Tab = accept prediction
     */
    const handleKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLInputElement>) => {
            const modifier = isMac ? event.metaKey : event.ctrlKey;
            if (modifier && event.shiftKey && event.key.toLowerCase() === 's') {
                event.preventDefault();
                void takeScreenshot('screen');
                return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                const swap = isMac ? event.metaKey : event.ctrlKey;
                if (swap) {
                    if (inputValue.trim()) {
                        send(forceRoute(inputValue, otherRoute(decision.route)));
                    }
                } else {
                    handleSubmit();
                }
            } else if (event.key === 'Tab' && prediction) {
                // Accept prediction: append to input and clear prediction
                event.preventDefault();
                logger.log('Tab pressed, accepting prediction');
                setInputValue(inputValue + prediction);
                setPrediction(null);
            }
        },
        [decision.route, handleSubmit, inputValue, isMac, prediction, send, takeScreenshot]
    );

    /** Escape anywhere in Quick Chat: dismiss the prediction, stop the agent, or hide Quick Chat. */
    const handleContainerKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (event.key !== 'Escape') {
                return;
            }
            event.preventDefault();
            if (prediction) {
                logger.log('Escape pressed, dismissing prediction');
                setPrediction(null);
            } else if (run.phase === 'stopping') {
                // A second Escape while the CLI has not confirmed the stop: give up waiting and hide.
                window.electronAPI?.cancelQuickChat();
                resetPanel();
            } else if (isRunActive(run)) {
                stopRun();
            } else {
                const attached = screenshotRef.current;
                if (attached) {
                    screenshotRef.current = null;
                    setScreenshot(null);
                    window.electronAPI?.discardQuickChatScreenshot?.(attached.id);
                }
                window.electronAPI?.cancelQuickChat();
                if (panelVisible) {
                    resetPanel();
                }
            }
        },
        [panelVisible, prediction, resetPanel, run, stopRun]
    );

    /**
     * Handle input value change with debounced prediction requests.
     * Requests prediction 300ms after user stops typing.
     */
    const handleInputChange = useCallback(
        (event: React.ChangeEvent<HTMLInputElement>) => {
            const newValue = event.target.value;
            setInputValue(newValue);
            if (!newValue.trim() || parseRoutePrefix(newValue)) {
                // An empty prompt or a typed routing prefix replaces a route picked with the chip.
                setRouteOverride(null);
            }

            // Cancel any pending prediction request
            if (predictionTimeoutRef.current) {
                clearTimeout(predictionTimeoutRef.current);
                predictionTimeoutRef.current = null;
            }

            // Clear prediction when typing continues
            setPrediction(null);

            // Only request prediction if enabled, model ready, and input has content
            if (!isPredictionEnabled || !isModelReady || !newValue.trim()) {
                setIsLoadingPrediction(false);
                return;
            }

            // Debounce prediction request
            setIsLoadingPrediction(true);
            predictionTimeoutRef.current = setTimeout(async () => {
                try {
                    const result = await window.electronAPI?.predictText(newValue);
                    // Only set prediction if we got a result and input hasn't changed
                    if (result) {
                        setPrediction(result);
                    }
                } catch {
                    // Silently ignore prediction errors
                    logger.log('Prediction request failed');
                } finally {
                    setIsLoadingPrediction(false);
                }
            }, PREDICTION_DEBOUNCE_MS);
        },
        [isPredictionEnabled, isModelReady]
    );

    const hasText = Boolean(inputValue.trim());
    const submitDisabled = !hasText || (decision.route === 'agent' && runActive);
    const placeholder = screenshot
        ? 'Ask about the screenshot…'
        : run.conversationId
          ? 'Ask a follow-up…'
          : 'Ask Gemini...';
    const screenshotTitle = screenshot
        ? 'Take a new screenshot (Shift+click to pick an area)'
        : `Attach a screenshot (${isMac ? 'Cmd' : 'Ctrl'}+Shift+S; Shift+click to pick an area)`;

    return (
        <div
            ref={containerRef}
            className={`quick-chat-container${expanded ? ' quick-chat-container--expanded' : ''}`}
            data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_CONTAINER}
            onKeyDown={handleContainerKeyDown}
        >
            <div className="quick-chat-input-wrapper">
                <div className="quick-chat-icon" aria-hidden="true">
                    <SearchIcon />
                </div>
                {screenshot && (
                    <div
                        className="quick-chat-screenshot-chip"
                        title={`Screenshot attached (${screenshot.width}×${screenshot.height})`}
                        data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_SCREENSHOT_CHIP}
                    >
                        <img src={screenshot.thumbnailDataUrl} alt="Attached screenshot" />
                        <button
                            type="button"
                            className="quick-chat-screenshot-remove"
                            onClick={removeScreenshot}
                            aria-label="Remove screenshot"
                            data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_SCREENSHOT_REMOVE}
                        >
                            ×
                        </button>
                    </div>
                )}
                {/* Ghost text overlay - shows current input + prediction */}
                {prediction && !screenshot && (
                    <div
                        className="quick-chat-ghost-text"
                        aria-hidden="true"
                        data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_GHOST_TEXT}
                    >
                        <span className="quick-chat-ghost-text-typed">{inputValue}</span>
                        <span className="quick-chat-ghost-text-prediction">{prediction}</span>
                    </div>
                )}
                <input
                    ref={inputRef}
                    type="text"
                    className="quick-chat-input"
                    placeholder={placeholder}
                    value={inputValue}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    onBlur={() => {
                        setPrediction(null);
                    }}
                    data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_INPUT}
                    aria-label={placeholder}
                    autoComplete="off"
                    spellCheck={false}
                />
                {hasText && (
                    <RouteChip decision={decision} onToggle={() => setRouteOverride(otherRoute(decision.route))} />
                )}
                <button
                    type="button"
                    className={`quick-chat-screenshot-button${screenshot ? ' quick-chat-screenshot-button--attached' : ''}`}
                    onClick={(event) => void takeScreenshot(event.shiftKey ? 'area' : 'screen')}
                    disabled={capturing}
                    title={screenshotTitle}
                    aria-label={screenshot ? 'Take a new screenshot' : 'Attach a screenshot'}
                    data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_SCREENSHOT_BUTTON}
                >
                    <CameraIcon />
                </button>
                <button
                    type="button"
                    className="quick-chat-submit"
                    onClick={handleSubmit}
                    disabled={submitDisabled}
                    data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_SUBMIT}
                    aria-label="Send message"
                >
                    <SendIcon />
                </button>
            </div>
            {screenshotError && (
                <div
                    className="quick-chat-screenshot-error"
                    role="alert"
                    data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_SCREENSHOT_ERROR}
                >
                    {screenshotError}
                </div>
            )}
            {panelVisible && (
                <AgentPanel
                    state={run}
                    onStop={stopRun}
                    onApplyPlan={handleApplyPlan}
                    onCancelPlan={() => dispatch({ type: 'planCancelled' })}
                    onUndoPlan={handleUndoPlan}
                    onNew={handleNew}
                    onContinueInGemini={handleContinueInGemini}
                />
            )}
        </div>
    );
}

export default QuickChatApp;
