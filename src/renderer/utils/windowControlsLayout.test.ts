/**
 * Unit tests for the window control layout per desktop look.
 */

import { describe, it, expect } from 'vitest';
import { getWindowControlsLayout } from './windowControlsLayout';
import type { DesktopLook } from '../../shared/types/look';

describe('getWindowControlsLayout', () => {
    it('GNOME: only close, on the right', () => {
        expect(getWindowControlsLayout('gnome')).toEqual({ left: [], right: ['close'] });
    });

    it('elementary OS: close on the left, maximize on the right', () => {
        expect(getWindowControlsLayout('elementary')).toEqual({ left: ['close'], right: ['maximize'] });
    });

    it('macOS: traffic lights on the left', () => {
        expect(getWindowControlsLayout('macos')).toEqual({ left: ['close', 'minimize', 'maximize'], right: [] });
    });

    it.each(['default', 'kde', 'windows', 'xfce', 'cinnamon', 'mate', 'budgie', 'cosmic'] as DesktopLook[])(
        '%s: minimize, maximize and close on the right',
        (look) => {
            expect(getWindowControlsLayout(look)).toEqual({ left: [], right: ['minimize', 'maximize', 'close'] });
        }
    );
});
