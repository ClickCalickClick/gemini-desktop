/**
 * IndividualHotkeyToggles Component
 *
 * Container component that renders toggle switches for each individual hotkey feature.
 * Allows users to enable/disable hotkeys independently and customize their keyboard shortcuts.
 *
 * ## Hotkeys
 * - **Always on Top**: Toggle window always-on-top
 * - **Peek and Hide**: Toggle hide to/restore from system tray
 * - **Quick Chat**: Open quick chat overlay
 *
 * Where the desktop owns the global hotkey keys (Wayland portal with a shortcut dialog), those rows
 * show the desktop's key and open its dialog instead of recording a key in the app.
 *
 * @module IndividualHotkeyToggles
 */

import { memo, useEffect, useState } from 'react';
import { CapsuleToggle } from '../common/CapsuleToggle';
import { useIndividualHotkeys, HotkeyId, DEFAULT_ACCELERATORS } from '../../context/IndividualHotkeysContext';
import { HotkeyAcceleratorInput } from './HotkeyAcceleratorInput';
import { DesktopHotkeyField } from './DesktopHotkeyField';
import { COPILOT_KEY_ACCELERATOR, isGlobalHotkey } from '../../../shared/types/hotkeys';
import type { PlatformHotkeyStatus } from '../../../shared/types/hotkeys';
import './individualHotkeyToggles.css';

// ============================================================================
// Types
// ============================================================================

interface HotkeyConfig {
    id: HotkeyId;
    label: string;
    description: string;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for each hotkey toggle.
 * This array is the source of truth for adding new hotkeys.
 */
const HOTKEY_CONFIGS: HotkeyConfig[] = [
    {
        id: 'alwaysOnTop',
        label: 'Always on Top',
        description: 'Toggle window always-on-top',
    },
    {
        id: 'peekAndHide',
        label: 'Peek and Hide',
        description: 'Toggle hide to/restore from system tray',
    },
    {
        id: 'quickChat',
        label: 'Quick Chat',
        description: 'Open floating chat overlay',
    },
    {
        id: 'voiceChat',
        label: 'Voice Chat',
        description: 'Toggle Gemini microphone input from anywhere',
    },
    {
        id: 'printToPdf',
        label: 'Print to PDF',
        description: 'Save current conversation as PDF',
    },
];

// ============================================================================
// Hooks
// ============================================================================

/** The platform hotkey status, kept up to date as the desktop binds or changes keys */
function usePlatformHotkeyStatus(): PlatformHotkeyStatus | null {
    const [status, setStatus] = useState<PlatformHotkeyStatus | null>(null);

    useEffect(() => {
        let active = true;
        const unsubscribe = window.electronAPI?.onPlatformHotkeyStatusChanged?.((next) => setStatus(next));
        window.electronAPI
            ?.getPlatformHotkeyStatus?.()
            .then((next) => {
                if (active) setStatus(next ?? null);
            })
            .catch(() => {
                // No status: the app records keys itself
            });
        return () => {
            active = false;
            unsubscribe?.();
        };
    }, []);

    return status;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Individual hotkey toggle component.
 * Renders all hotkey toggles with editable keyboard shortcuts.
 */
export const IndividualHotkeyToggles = memo(function IndividualHotkeyToggles() {
    const { settings, accelerators, setEnabled, setAccelerator } = useIndividualHotkeys();
    // Copilot keys are on Windows laptops, which also run Linux; Macs have none
    const platform = window.electronAPI?.platform;
    const offersCopilotKey = platform === 'linux' || platform === 'win32';
    const platformStatus = usePlatformHotkeyStatus();
    const desktopOwnsKeys = platformStatus?.canChangeInDesktop === true;
    const desktopTriggers = new Map(
        (platformStatus?.registrationResults ?? []).map((result) => [result.hotkeyId, result.desktopTrigger])
    );

    return (
        <div className="individual-hotkey-toggles" data-testid="individual-hotkey-toggles">
            {HOTKEY_CONFIGS.map((config) => (
                <div key={config.id} className="hotkey-row" data-testid={`hotkey-row-${config.id}`}>
                    <div className="hotkey-label-wrapper">
                        <span className="hotkey-label">{config.label}</span>
                        <span className="hotkey-description">{config.description}</span>
                    </div>
                    <div className="hotkey-accelerator-wrapper">
                        {desktopOwnsKeys && isGlobalHotkey(config.id) ? (
                            <DesktopHotkeyField
                                hotkeyId={config.id}
                                desktopTrigger={desktopTriggers.get(config.id)}
                                disabled={!settings[config.id]}
                            />
                        ) : (
                            <HotkeyAcceleratorInput
                                hotkeyId={config.id}
                                currentAccelerator={accelerators[config.id]}
                                disabled={!settings[config.id]}
                                onAcceleratorChange={setAccelerator}
                                defaultAccelerator={DEFAULT_ACCELERATORS[config.id]}
                            />
                        )}
                        {config.id === 'quickChat' && offersCopilotKey && !desktopOwnsKeys && (
                            <button
                                type="button"
                                className="hotkey-preset-button"
                                data-testid="hotkey-copilot-preset"
                                onClick={() => setAccelerator('quickChat', COPILOT_KEY_ACCELERATOR)}
                                disabled={!settings.quickChat || accelerators.quickChat === COPILOT_KEY_ACCELERATOR}
                                title="Open Quick Chat with the Copilot key (Shift+Super+F23)"
                            >
                                Use Copilot key
                            </button>
                        )}
                    </div>
                    <div className="hotkey-toggle-wrapper">
                        <CapsuleToggle
                            checked={settings[config.id]}
                            onChange={(enabled) => setEnabled(config.id, enabled)}
                            label=""
                            description=""
                            testId={`hotkey-toggle-${config.id}`}
                        />
                    </div>
                </div>
            ))}
        </div>
    );
});

export default IndividualHotkeyToggles;
