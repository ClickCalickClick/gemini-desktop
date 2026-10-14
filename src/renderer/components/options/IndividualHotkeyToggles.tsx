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
 * @module IndividualHotkeyToggles
 */

import { memo } from 'react';
import { CapsuleToggle } from '../common/CapsuleToggle';
import { useIndividualHotkeys, HotkeyId, DEFAULT_ACCELERATORS } from '../../context/IndividualHotkeysContext';
import { HotkeyAcceleratorInput } from './HotkeyAcceleratorInput';
import { COPILOT_KEY_ACCELERATOR } from '../../../shared/types/hotkeys';
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

    return (
        <div className="individual-hotkey-toggles" data-testid="individual-hotkey-toggles">
            {HOTKEY_CONFIGS.map((config) => (
                <div key={config.id} className="hotkey-row" data-testid={`hotkey-row-${config.id}`}>
                    <div className="hotkey-label-wrapper">
                        <span className="hotkey-label">{config.label}</span>
                        <span className="hotkey-description">{config.description}</span>
                    </div>
                    <div className="hotkey-accelerator-wrapper">
                        <HotkeyAcceleratorInput
                            hotkeyId={config.id}
                            currentAccelerator={accelerators[config.id]}
                            disabled={!settings[config.id]}
                            onAcceleratorChange={setAccelerator}
                            defaultAccelerator={DEFAULT_ACCELERATORS[config.id]}
                        />
                        {config.id === 'quickChat' && offersCopilotKey && (
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
