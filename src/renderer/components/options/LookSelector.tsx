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

import React, { memo, useCallback, useRef } from 'react';
import { useLook } from '../../context/LookContext';
import { createRendererLogger } from '../../utils';
import { getWindowControlsLayout } from '../../utils/windowControlsLayout';
import { DESKTOP_LOOK_NAMES, DESKTOP_LOOKS } from '../../../shared/constants/looks';
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

/** The default accent each look's preview shows. */
const PREVIEW_ACCENTS: Record<DesktopLookPreference, string> = {
    auto: '#888888',
    default: '#8ab4f8',
    gnome: '#3584e4',
    kde: '#3daee9',
    xfce: '#398ee7',
    cinnamon: '#35a854',
    mate: '#6f9a45',
    budgie: '#1a73e8',
    elementary: '#3689e6',
    cosmic: '#63d0df',
    macos: '#007aff',
    windows: '#0067c0',
};

/** Auto, then every look in the shared order. */
// eslint-disable-next-line react-refresh/only-export-components -- option list exported for tests
export const LOOK_OPTIONS: LookOption[] = [
    { id: 'auto', label: 'Auto', accent: PREVIEW_ACCENTS.auto },
    ...DESKTOP_LOOKS.map((look) => ({ id: look, label: DESKTOP_LOOK_NAMES[look], accent: PREVIEW_ACCENTS[look] })),
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
    /** 0 for the one card in the tab order (roving tabindex), -1 for the others */
    tabIndex: 0 | -1;
    onSelect: (id: DesktopLookPreference) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>, id: DesktopLookPreference) => void;
    cardRef: (element: HTMLDivElement | null) => void;
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

const LookCard = memo(function LookCard({
    option,
    label,
    previewLook,
    isSelected,
    tabIndex,
    onSelect,
    onKeyDown,
    cardRef,
}: LookCardProps) {
    return (
        <div
            className={`look-card${isSelected ? ' look-card--selected' : ''}`}
            onClick={() => onSelect(option.id)}
            onKeyDown={(event) => onKeyDown(event, option.id)}
            ref={cardRef}
            role="radio"
            aria-checked={isSelected}
            aria-label={`${label} look`}
            tabIndex={tabIndex}
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
 *
 * Follows the WAI-ARIA radio group pattern: one tab stop (the selected card, or the first card
 * when none is), Arrow keys move focus and select (Left/Up previous, Right/Down next, wrapping),
 * Home and End go to the first and last card, Enter and Space select.
 */
export const LookSelector = memo(function LookSelector() {
    const { look, setLook } = useLook();
    const cardRefs = useRef<Array<HTMLDivElement | null>>([]);

    const handleSelect = useCallback(
        (id: DesktopLookPreference) => {
            setLook(id);
            logger.log(`Look changed to: ${id}`);
        },
        [setLook]
    );

    const handleKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>, id: DesktopLookPreference) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handleSelect(id);
                return;
            }
            const index = LOOK_OPTIONS.findIndex((option) => option.id === id);
            const last = LOOK_OPTIONS.length - 1;
            let next: number;
            switch (event.key) {
                case 'ArrowLeft':
                case 'ArrowUp':
                    next = index <= 0 ? last : index - 1;
                    break;
                case 'ArrowRight':
                case 'ArrowDown':
                    next = index >= last ? 0 : index + 1;
                    break;
                case 'Home':
                    next = 0;
                    break;
                case 'End':
                    next = last;
                    break;
                default:
                    return;
            }
            event.preventDefault();
            const nextOption = LOOK_OPTIONS[next];
            if (nextOption) {
                cardRefs.current[next]?.focus();
                handleSelect(nextOption.id);
            }
        },
        [handleSelect]
    );

    const hasSelection = LOOK_OPTIONS.some((option) => option.id === look.preference);

    // The look Auto resolves to: the option named like the detected desktop (names match the main process)
    const autoLook: DesktopLook =
        DESKTOP_LOOKS.find(
            (candidate) => candidate !== 'default' && DESKTOP_LOOK_NAMES[candidate] === look.detectedDesktop
        ) ?? 'default';
    const appliedLabel = DESKTOP_LOOK_NAMES[look.effectiveLook];

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
                {LOOK_OPTIONS.map((option, index) => (
                    <LookCard
                        key={option.id}
                        cardRef={(element) => {
                            cardRefs.current[index] = element;
                        }}
                        tabIndex={(hasSelection ? look.preference === option.id : index === 0) ? 0 : -1}
                        onKeyDown={handleKeyDown}
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
