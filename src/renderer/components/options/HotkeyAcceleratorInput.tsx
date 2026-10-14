/**
 * HotkeyAcceleratorInput Component
 *
 * An input component for editing hotkey accelerators with a recording mode.
 * Displays keys as individual styled "keycaps" for a polished, professional look.
 *
 * @module HotkeyAcceleratorInput
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { getRecordingMessage, keyEventToAccelerator, parseAcceleratorParts } from './hotkeyRecording';
import type { HotkeyId } from '../../context/IndividualHotkeysContext';
import './hotkeyAcceleratorInput.css';

// ============================================================================
// Types
// ============================================================================

interface HotkeyAcceleratorInputProps {
    /** The hotkey ID this input is for */
    hotkeyId: HotkeyId;
    /** Current accelerator string */
    currentAccelerator: string;
    /** Whether the input is disabled (hotkey is disabled) */
    disabled: boolean;
    /** Callback when the accelerator changes */
    onAcceleratorChange: (id: HotkeyId, accelerator: string) => void;
    /** Default accelerator for reset functionality */
    defaultAccelerator: string;
}

// ============================================================================
// Keycap Component
// ============================================================================

interface KeycapProps {
    keyLabel: string;
    isModifier?: boolean;
}

function Keycap({ keyLabel, isModifier = false }: KeycapProps) {
    const isSymbol = /^[⌘⌃⌥⇧␣]$/.test(keyLabel);
    return <kbd className={`keycap ${isModifier ? 'modifier' : ''} ${isSymbol ? 'symbol' : ''}`}>{keyLabel}</kbd>;
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * Input component for editing hotkey accelerators.
 *
 * Features:
 * - Recording mode for capturing key combinations
 * - Keycap-style display with individual key elements
 * - Platform-aware display formatting
 * - Reset to default functionality
 */
export function HotkeyAcceleratorInput({
    hotkeyId,
    currentAccelerator,
    disabled,
    onAcceleratorChange,
    defaultAccelerator,
}: HotkeyAcceleratorInputProps) {
    const [isRecording, setIsRecording] = useState(false);
    const [recordingMessage, setRecordingMessage] = useState<string | null>(null);
    const inputRef = useRef<HTMLDivElement>(null);
    const platform = window.electronAPI?.platform;

    // Focus the input when entering recording mode
    useEffect(() => {
        if (isRecording && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isRecording]);

    // Handle key down during recording
    const handleKeyDown = useCallback(
        (event: React.KeyboardEvent) => {
            if (!isRecording) return;

            event.preventDefault();
            event.stopPropagation();

            // Escape cancels recording
            if (event.key === 'Escape') {
                setIsRecording(false);
                setRecordingMessage(null);
                return;
            }

            const result = keyEventToAccelerator(event, platform);
            if (result.kind === 'accelerator') {
                onAcceleratorChange(hotkeyId, result.accelerator);
                setIsRecording(false);
                setRecordingMessage(null);
                return;
            }
            if (result.kind !== 'pending') {
                // Keep recording, and say why the key was not taken
                setRecordingMessage(getRecordingMessage(result, platform));
            }
        },
        [isRecording, hotkeyId, onAcceleratorChange, platform]
    );

    // Handle blur - stop recording
    const handleBlur = useCallback(() => {
        setIsRecording(false);
    }, []);

    // Start recording
    const startRecording = useCallback(() => {
        if (!disabled) {
            setRecordingMessage(null);
            setIsRecording(true);
        }
    }, [disabled]);

    // Reset to default
    const resetToDefault = useCallback(() => {
        if (!disabled && currentAccelerator !== defaultAccelerator) {
            onAcceleratorChange(hotkeyId, defaultAccelerator);
        }
    }, [disabled, currentAccelerator, defaultAccelerator, hotkeyId, onAcceleratorChange]);

    const keyParts = parseAcceleratorParts(currentAccelerator, platform);
    const isDefault = currentAccelerator === defaultAccelerator;

    return (
        <div className="hotkey-accelerator-field">
            <div className={`hotkey-accelerator-input ${disabled ? 'disabled' : ''}`}>
                {!isDefault && (
                    <button
                        className="reset-button"
                        onClick={resetToDefault}
                        disabled={disabled}
                        aria-label="Reset to default"
                        title="Reset to default"
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                        >
                            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                            <path d="M3 3v5h5" />
                        </svg>
                    </button>
                )}
                <div
                    ref={inputRef}
                    className={`keycap-container ${isRecording ? 'recording' : ''}`}
                    onClick={startRecording}
                    onKeyDown={handleKeyDown}
                    onBlur={handleBlur}
                    tabIndex={disabled ? -1 : 0}
                    role="button"
                    aria-label={`Keyboard shortcut: ${keyParts.join(' + ')}. Click to change.`}
                    aria-disabled={disabled}
                >
                    {isRecording ? (
                        <span className="recording-prompt">
                            <span className="recording-dot" />
                            Press keys...
                        </span>
                    ) : (
                        <div className="keycaps">
                            {keyParts.map((part, index) => (
                                <React.Fragment key={index}>
                                    {index > 0 && <span className="key-separator">+</span>}
                                    <Keycap keyLabel={part} isModifier={index < keyParts.length - 1} />
                                </React.Fragment>
                            ))}
                        </div>
                    )}
                </div>
            </div>
            {recordingMessage && (
                <p
                    className="hotkey-recorder-message"
                    role="status"
                    data-testid={`hotkey-recorder-message-${hotkeyId}`}
                >
                    {recordingMessage}
                </p>
            )}
        </div>
    );
}
