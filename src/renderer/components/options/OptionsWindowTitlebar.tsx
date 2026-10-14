/**
 * Options window titlebar component.
 *
 * A simplified titlebar for secondary windows that displays only:
 * - Window title
 * - Drag region
 * - Window controls (minimize, maximize, close)
 *
 * Unlike the main window titlebar, this does NOT include a menu bar.
 * This component is designed to be reusable for other secondary windows.
 *
 * Memoized to prevent unnecessary re-renders.
 *
 * @module OptionsWindowTitlebar
 */

import { memo } from 'react';
import type { ReactNode } from 'react';
import { useWindowControls } from '../../hooks/useWindowControls';
import { useLook } from '../../context/LookContext';
import { getWindowControlsLayout } from '../../utils/windowControlsLayout';
import { TITLEBAR_TEST_IDS } from '../../utils/testIds';
import { isMacOS } from '../../utils/platform';
import icon from '@/assets/icon.png';
import './options-window.css';

/** The controls a secondary window has (it cannot be maximized). */
type OptionsControlKind = 'minimize' | 'close';

const CONTROLS: Record<OptionsControlKind, { label: string; title: string; testId: string; icon: ReactNode }> = {
    minimize: {
        label: 'Minimize window',
        title: 'Minimize',
        testId: 'options-minimize-button',
        icon: (
            <svg width="10" height="1" viewBox="0 0 10 1">
                <rect width="10" height="1" fill="currentColor" />
            </svg>
        ),
    },
    close: {
        label: 'Close window',
        title: 'Close',
        testId: 'options-close-button',
        icon: (
            <svg width="10" height="10" viewBox="0 0 10 10">
                <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2" />
                <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2" />
            </svg>
        ),
    },
};

const isOptionsControl = (kind: string): kind is OptionsControlKind => kind === 'minimize' || kind === 'close';

interface OptionsWindowTitlebarProps {
    /** Title to display in the titlebar */
    title?: string;
}

/**
 * Titlebar component for secondary windows (options, settings, etc.)
 *
 * Features:
 * - Draggable region for window movement
 * - Title display centered in the titlebar
 * - Window controls on the right (Windows/Linux only)
 * - macOS uses native traffic light controls
 *
 * On Windows and Linux the controls follow the desktop look like the main window's
 * (GNOME: close only; elementary OS and the macOS look: on the left).
 */
export const OptionsWindowTitlebar = memo(function OptionsWindowTitlebar({
    title = 'Options',
}: OptionsWindowTitlebarProps) {
    const { minimize, close } = useWindowControls();
    const {
        look: { effectiveLook },
    } = useLook();

    // On macOS the controls keep their usual place; elsewhere they follow the look
    const fullLayout = getWindowControlsLayout(isMacOS() ? 'default' : effectiveLook);
    const layout = {
        left: fullLayout.left.filter(isOptionsControl),
        right: fullLayout.right.filter(isOptionsControl),
    };
    const actions: Record<OptionsControlKind, () => void> = { minimize, close };

    const renderButton = (kind: OptionsControlKind) => {
        const control = CONTROLS[kind];
        return (
            <button
                key={kind}
                className={`options-window-control-button ${kind}`}
                onClick={actions[kind]}
                aria-label={control.label}
                title={control.title}
                data-testid={control.testId}
            >
                {control.icon}
            </button>
        );
    };

    return (
        <header className={`options-titlebar${isMacOS() ? ' macos' : ''}`} data-testid="options-titlebar">
            {/* Icon - Left justified */}
            <div className="options-titlebar-icon">
                <img
                    src={icon}
                    alt="App Icon"
                    data-testid={TITLEBAR_TEST_IDS.APP_ICON}
                    style={{ width: 16, height: 16 }}
                />
            </div>

            {/* Drag region - Centered title */}
            <div className="options-titlebar-drag-region">
                <span className="options-titlebar-title" data-testid="options-titlebar-title">
                    {title}
                </span>
            </div>

            {/* Window controls - always shown for consistent UX and testability */}
            {layout.left.length > 0 && (
                <div
                    className="options-window-controls options-window-controls--left"
                    data-testid="options-window-controls-left"
                >
                    {layout.left.map(renderButton)}
                </div>
            )}
            <div className="options-window-controls" data-testid="options-window-controls">
                {layout.right.map(renderButton)}
            </div>
        </header>
    );
});
