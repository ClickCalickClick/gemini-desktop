import { memo } from 'react';
import type { ReactNode } from 'react';
import { usesCustomWindowControls } from '../../utils';
import { useWindowControls } from '../../hooks/useWindowControls';
import { useLook } from '../../context/LookContext';
import { getWindowControlsLayout } from '../../utils/windowControlsLayout';
import type { WindowControlKind } from '../../utils/windowControlsLayout';
import { TITLEBAR_TEST_IDS } from '../../utils/testIds';
import './titlebar.css';

/** Labels, test ids and icons of each control. */
const CONTROLS: Record<WindowControlKind, { label: string; title: string; testId: string; icon: ReactNode }> = {
    minimize: {
        label: 'Minimize window',
        title: 'Minimize',
        testId: TITLEBAR_TEST_IDS.MINIMIZE_BUTTON,
        icon: (
            <svg width="10" height="1" viewBox="0 0 10 1">
                <rect width="10" height="1" fill="currentColor" />
            </svg>
        ),
    },
    maximize: {
        label: 'Maximize window',
        title: 'Maximize',
        testId: TITLEBAR_TEST_IDS.MAXIMIZE_BUTTON,
        icon: (
            <svg width="10" height="10" viewBox="0 0 10 10">
                <rect width="9" height="9" x="0.5" y="0.5" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
        ),
    },
    close: {
        label: 'Close window',
        title: 'Close',
        testId: TITLEBAR_TEST_IDS.CLOSE_BUTTON,
        icon: (
            <svg width="10" height="10" viewBox="0 0 10 10">
                <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2" />
                <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2" />
            </svg>
        ),
    },
};

/**
 * Window control buttons component (minimize, maximize, close).
 * Uses CSS for styling with hover effects.
 *
 * The buttons and their sides follow the desktop look (see `getWindowControlsLayout`):
 * GNOME shows only close, elementary OS puts close on the left and maximize on the right, and
 * the macOS look puts traffic lights on the left. The left group is moved to the start of the
 * titlebar with CSS `order`.
 *
 * The `-webkit-app-region: no-drag` ensures buttons are clickable
 * even when placed within the draggable titlebar region.
 *
 * Memoized to prevent unnecessary re-renders.
 */
export const WindowControls = memo(function WindowControls() {
    const { minimize, maximize, close } = useWindowControls();
    const {
        look: { effectiveLook },
    } = useLook();

    // On macOS, we use the native traffic lights provided by 'titleBarStyle: Overlay'
    // So we hide these custom controls.
    if (!usesCustomWindowControls()) {
        return null;
    }

    const actions: Record<WindowControlKind, () => void> = { minimize, maximize, close };
    const layout = getWindowControlsLayout(effectiveLook);

    const renderButton = (kind: WindowControlKind) => {
        const control = CONTROLS[kind];
        return (
            <button
                key={kind}
                className={`window-control-button ${kind}`}
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
        <>
            {layout.left.length > 0 && (
                <div className="window-controls window-controls--left" data-testid="window-controls-left">
                    {layout.left.map(renderButton)}
                </div>
            )}
            {layout.right.length > 0 && <div className="window-controls">{layout.right.map(renderButton)}</div>}
        </>
    );
});
