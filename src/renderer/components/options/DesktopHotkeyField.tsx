/**
 * DesktopHotkeyField Component
 *
 * Shows the key the desktop bound for a global hotkey on Wayland, where the desktop (GNOME, KDE)
 * owns the keys: it keeps what the user approved and ignores a key the app suggests later.
 * "Change…" opens the desktop's own dialog, where the user presses the key they want, so keys the
 * desktop names differently from the app (such as the Copilot key) are picked up exactly.
 *
 * @module DesktopHotkeyField
 */

import React, { useCallback, useState } from 'react';
import { Keycap } from './HotkeyAcceleratorInput';
import { parseDesktopTrigger } from './hotkeyRecording';
import type { HotkeyId } from '../../context/IndividualHotkeysContext';
import './hotkeyAcceleratorInput.css';

interface DesktopHotkeyFieldProps {
    /** The hotkey ID this field is for */
    hotkeyId: HotkeyId;
    /** The desktop's description of the bound key, if it reported one */
    desktopTrigger: string | undefined;
    /** Whether the hotkey is turned off */
    disabled: boolean;
}

export function DesktopHotkeyField({ hotkeyId, desktopTrigger, disabled }: DesktopHotkeyFieldProps) {
    const [message, setMessage] = useState<string | null>(null);
    const keyParts = parseDesktopTrigger(desktopTrigger);

    const openDesktopDialog = useCallback(async () => {
        setMessage(null);
        const opened = await window.electronAPI?.changeHotkeysInDesktop?.();
        if (opened) {
            // GNOME's editor saves nothing for modifiers alone, such as Alt+Super
            setMessage(
                'Click the pencil next to the shortcut, then press the keys. Include a regular key such as Space.'
            );
        } else {
            setMessage('Your desktop could not open its shortcut dialog. Change the keys in its Settings, under Apps.');
        }
    }, []);

    return (
        <div className="hotkey-accelerator-field">
            <div className={`hotkey-accelerator-input ${disabled ? 'disabled' : ''}`}>
                <div
                    className="keycap-container desktop-owned"
                    data-testid={`hotkey-desktop-trigger-${hotkeyId}`}
                    aria-label={
                        keyParts.length > 0 ? `Keyboard shortcut: ${keyParts.join(' + ')}` : 'No keyboard shortcut set'
                    }
                >
                    {keyParts.length > 0 ? (
                        <div className="keycaps">
                            {keyParts.map((part, index) => (
                                <React.Fragment key={index}>
                                    {index > 0 && <span className="key-separator">+</span>}
                                    <Keycap keyLabel={part} isModifier={index < keyParts.length - 1} />
                                </React.Fragment>
                            ))}
                        </div>
                    ) : (
                        <span className="recording-prompt">Not set</span>
                    )}
                </div>
            </div>
            <button
                type="button"
                className="hotkey-preset-button"
                data-testid={`hotkey-change-in-desktop-${hotkeyId}`}
                onClick={openDesktopDialog}
                disabled={disabled}
                title="Opens your desktop's shortcut settings. Press the key you want there, such as the Copilot key."
            >
                Change…
            </button>
            {message && (
                <p className="hotkey-recorder-message" role="status">
                    {message}
                </p>
            )}
        </div>
    );
}
