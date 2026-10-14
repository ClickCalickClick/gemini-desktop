> Extends [root AGENTS.md](../../AGENTS.md). Read that first.

## Boundary Definition

Renderer runs in Chromium sandbox with no direct Node.js access.
This layer contains React UI, contexts, hooks, and window-specific frontend behavior.

Primary files and folders:

- `src/renderer/App.tsx` — root component
- `src/renderer/main.tsx` — renderer entrypoint
- `src/renderer/components/` — UI components
- `src/renderer/context/` — global React contexts
- `src/renderer/hooks/` — custom hooks
- `src/renderer/windows/` — window-specific UI modules
- `src/renderer/utils/`, `src/renderer/types/`, `src/renderer/assets/`

## React Patterns

Use React Context for global UI state (Theme, Toast, Auth) and local state/reducers for component-local logic.
All system access must flow through preload bridge methods on `window.electronAPI`.
See renderer sections in `docs/ARCHITECTURE.md` for deeper rationale.

## IPC Communication from Renderer

Use only `window.electronAPI.*` APIs exposed by preload.
Subscription APIs return cleanup functions — always call them in `useEffect` cleanup.
For async initialization and subscriptions, use `AbortController` to prevent stale updates after unmount.

## Canonical Example

- `src/renderer/context/ThemeContext.tsx` — `ThemeProvider` and `useTheme`
    - Shows typed context API, `AbortController` guard, IPC subscription cleanup in `useEffect`, `useCallback` setter, and robust fallback/error handling.
    - Pattern aligns to preload `get → set → onChange` APIs.

## Hybrid Quick Chat (Phase H)

- `src/renderer/components/quickchat/QuickChatApp.tsx` routes each prompt with `routePrompt` from `src/shared/utils/quickChatRouter.ts` and shows the result in `RouteChip.tsx` (label, reason as tooltip and `aria-label`; a click switches the route for that prompt). Enter sends to the shown route, Ctrl+Enter (Cmd+Enter on macOS) to the other one. The web route calls `submitQuickChat(prompt)` as before; the agent route calls `runAgent` and keeps the window open.
- Agent events go through the pure reducer in `agentRunState.ts`. Events that arrive before `runAgent` resolves are buffered; events for any other `runId` are ignored. `AgentPanel.tsx` renders progress and Stop, tool steps, the answer, the file plan (Apply, Cancel, Undo), errors with the setup hint, and New and Continue in Gemini.
- Agent output is untrusted: render it only through `renderAgentMarkdown` in `agentMarkdown.ts`, which escapes raw HTML, shows links as text with their address (there is no open-in-browser API, and Quick Chat must not navigate) and replaces images by their alt text. Never log prompts or agent output.
- While the panel shows, a `ResizeObserver` on the container calls `resizeQuickChat(height)`; Escape (when nothing runs), New, a web send and Continue in Gemini reset the panel and call `resizeQuickChat(QUICK_CHAT_COMPACT_HEIGHT)` (80, the main process's `QUICK_CHAT_HEIGHT`). Escape first dismisses a prediction, then stops a running agent (a second Escape while stopping hides Quick Chat and resets; Stop also gives up after `STOP_TIMEOUT_MS`), then hides Quick Chat. Events after a run's `done` are ignored. When Quick Chat is shown again after a blur, a finished panel with an empty input resets to compact, except a plan still waiting for Apply. Screen readers get one status line (`quick-chat-agent-announcer`: working, "Answer ready", "File plan ready" or the error), not a live region on the streaming text.
- Quick Chat colors, radii and fonts are `--qc-*` custom properties defined at the top of `QuickChat.css` (dark defaults, light under `[data-theme='light']`). Desktop looks override those variables; do not hard-code colors in Quick Chat rules.
- Options: `src/renderer/components/options/QuickChatSettings.tsx` (section "Quick Chat") edits `quickChatRoutingMode`, `agentEngine` and `agentModel` through `getAgentSettings`/`setAgentSettings`/`onAgentSettingsChanged`, and shows `getAgentStatus` with install and sign-in hints.
- Tests: `QuickChatApp.agent.test.tsx` (routing, streaming, plans, Stop, Escape, follow-ups), `agentMarkdown.test.ts`, `QuickChatSettings.test.tsx`; they build `window.electronAPI` with `createMockElectronAPI` from `tests/helpers/mocks/renderer/electronAPI.ts`.

## Desktop Looks

- `src/renderer/context/LookContext.tsx` (`LookProvider`, `useLook`) loads the look with `getLook`, follows `onLookChanged`, and sets `data-look="<effectiveLook>"` and `--desktop-accent` on `<html>`. The main window (`App.tsx`), Options (`windows/options/main.tsx`) and Quick Chat (`windows/quickchat/main.tsx`) each wrap their root in it, inside `ThemeProvider`. `useLook()` returns the default look outside a provider, so components stay usable alone.
- Styles live in `src/renderer/looks/`: `index.css` (imported once from `theme.css`), `base.css` with the shared rules under `[data-look]:not([data-look='default'])`, and one file per look that sets `--look-*` and theme variables under `:root[data-look='<look>']` for dark and `[data-theme='light']`. The `default` look matches no rule, so it is the app as before. Quick Chat is styled through its class names (`.quick-chat-container`, `.quick-chat-input`, ...), not by editing `QuickChat.css`.
- Window controls follow the look through `utils/windowControlsLayout.ts` (`WindowControls`, `OptionsWindowTitlebar`): GNOME shows only close, elementary OS puts close left and maximize right, the macOS look puts traffic lights on the left; macOS itself keeps its native controls. A left group renders as `.window-controls--left` (moved first with CSS `order`).
- When adding a look: add it to `DesktopLook` (shared contract), `DESKTOP_LOOKS`/`DESKTOP_NAMES` in `src/main/utils/desktopLook.ts`, `KNOWN_LOOKS` in `context/LookContext.tsx`, `LOOK_OPTIONS` in `components/options/LookSelector.tsx`, a CSS file in `looks/`, and a layout entry if its controls differ.

## Common Mistakes

- Importing Node.js APIs directly in renderer code
- Forgetting to clean up IPC subscriptions in `useEffect` return
- Skipping `GeminiErrorBoundary` around risky UI areas
- Missing `AbortController.abort()` in async cleanup paths

## When You Change Files Here

- If you are working in a newly created git worktree, run `npm install` in that worktree first so local dependencies are present before running the commands below.
- Run `npm run test`
- Run `npm run lint`
