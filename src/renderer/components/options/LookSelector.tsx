/**
 * LookSelector Component
 *
 * Picks the desktop look: Auto (match the desktop the app runs on), Default (today's look) or a
 * specific desktop. The look changes the titlebar, window controls, fonts, corner radii and colors
 * of every window; light and dark stay with the Theme selector.
 *
 * @module LookSelector
 * @example
 * <LookSelector />
 */

import React, { memo, useCallback } from 'react';
import { useLook } from '../../context/LookContext';
import { createRendererLogger } from '../../utils';
import { getWindowControlsLayout } from '../../utils/windowControlsLayout';
import type { DesktopLook, DesktopLookPreference } from '../../../shared/types/look';
import './LookSelector.css';

const logger = createRendererLogger('[LookSelector]');

// ============================================================================
// Options
// ============================================================================

interface LookOption {
    id: DesktopLookPreference;
    label: string;
    /** Accent shown in the preview */
    accent: string;
}

/** Every look, in the order they are listed. */
// eslint-disable-next-line react-refresh/only-export-components -- option list exported for tests
export const LOOK_OPTIONS: LookOption[] = [
    { id: 'auto', label: 'Auto', accent: '#888888' },
    { id: 'default', label: 'Default', accent: '#8ab4f8' },
    { id: 'gnome', label: 'GNOME', accent: '#3584e4' },
    { id: 'kde', label: 'KDE Plasma', accent: '#3daee9' },
    { id: 'xfce', label: 'Xfce', accent: '#398ee7' },
    { id: 'cinnamon', label: 'Cinnamon', accent: '#35a854' },
    { id: 'mate', label: 'MATE', accent: '#6f9a45' },
    { id: 'budgie', label: 'Budgie', accent: '#1a73e8' },
    { id: 'elementary', label: 'elementary OS', accent: '#3689e6' },
    { id: 'cosmic', label: 'COSMIC', accent: '#63d0df' },
    { id: 'macos', label: 'macOS', accent: '#007aff' },
    { id: 'windows', label: 'Windows', accent: '#0067c0' },
];

/** The text of the Auto card, naming the detected desktop. */
// eslint-disable-next-line react-refresh/only-export-components -- helper exported for tests
export function getAutoLabel(detectedDesktop: string | null): string {
    return detectedDesktop ? `Auto (${detectedDesktop} detected)` : 'Auto';
}

// ============================================================================
// LookCard
// ============================================================================

interface LookCardProps {
    option: LookOption;
    label: string;
    /** The look the preview draws ('auto' draws the look it resolves to) */
    previewLook: DesktopLook;
    isSelected: boolean;
    onSelect: (id: DesktopLookPreference) => void;
}

/** Mini titlebar showing where the window controls sit in this look. */
function ControlsPreview({ look }: { look: DesktopLook }) {
    const layout = getWindowControlsLayout(look);
    const dots = (kinds: string[]) =>
        kinds.map((kind) => <span key={kind} className={`look-card__dot look-card__dot--${kind}`} />);
    return (
        <div className={`look-card__titlebar look-card__titlebar--${look}`} aria-hidden="true">
            <span className="look-card__dots">{dots(layout.left)}</span>
            <span className="look-card__title-line" />
            <span className="look-card__dots">{dots(layout.right)}</span>
        </div>
    );
}

const LookCard = memo(function LookCard({ option, label, previewLook, isSelected, onSelect }: LookCardProps) {
    const handleKeyDown = useCallback(
        (event: React.KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(option.id);
            }
        },
        [onSelect, option.id]
    );

    return (
        <div
            className={`look-card${isSelected ? ' look-card--selected' : ''}`}
            onClick={() => onSelect(option.id)}
            onKeyDown={handleKeyDown}
            role="radio"
            aria-checked={isSelected}
            aria-label={`${label} look`}
            tabIndex={0}
            data-testid={`look-card-${option.id}`}
            style={{ '--look-card-accent': option.accent } as React.CSSProperties}
        >
            <ControlsPreview look={previewLook} />
            <span className="look-card__label">{label}</span>
        </div>
    );
});

// ============================================================================
// LookSelector
// ============================================================================

/**
 * Look selector with one card per look.
 */
export const LookSelector = memo(function LookSelector() {
    const { look, setLook } = useLook();

    const handleSelect = useCallback(
        (id: DesktopLookPreference) => {
            setLook(id);
            logger.log(`Look changed to: ${id}`);
        },
        [setLook]
    );

    // The look Auto resolves to: the option named like the detected desktop (names match the main process)
    const autoLook = (LOOK_OPTIONS.find((option) => option.id !== 'auto' && option.label === look.detectedDesktop)
        ?.id ?? 'default') as DesktopLook;
    const appliedLabel = LOOK_OPTIONS.find((option) => option.id === look.effectiveLook)?.label ?? 'Default';

    return (
        <div className="look-selector-container" data-testid="look-selector">
            <div className="look-selector__header">
                <span className="look-selector__title">Look</span>
                <span className="look-selector__description" data-testid="look-selector-description">
                    Titlebar, window controls, fonts and colors.
                    {look.preference === 'auto' && ` Applied: ${appliedLabel}.`}
                </span>
            </div>
            <div className="look-selector-cards" role="radiogroup" aria-label="Look selection">
                {LOOK_OPTIONS.map((option) => (
                    <LookCard
                        key={option.id}
                        option={option}
                        label={option.id === 'auto' ? getAutoLabel(look.detectedDesktop) : option.label}
                        previewLook={option.id === 'auto' ? autoLook : option.id}
                        isSelected={look.preference === option.id}
                        onSelect={handleSelect}
                    />
                ))}
            </div>
        </div>
    );
});

export default LookSelector;
