/**
 * Unit tests for TrayIconSettings: loading the saved tray click action, saving a new one,
 * and the per-platform description.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TrayIconSettings, getTrayClickDescription } from './TrayIconSettings';
import { TRAY_ICON_SETTINGS_TEST_IDS } from '../../utils/testIds';
import { setMockPlatform } from '../../../../tests/unit/renderer/test/setup';
import type { TrayClickAction } from '../../../shared/types/tray';

const GNOME_DESCRIPTION =
    'What clicking the tray icon opens. On GNOME a single click shows the menu and a double click opens this.';

const getSelect = () => screen.getByTestId(TRAY_ICON_SETTINGS_TEST_IDS.TRAY_CLICK_ACTION) as HTMLSelectElement;
const findSelect = async () =>
    (await screen.findByTestId(TRAY_ICON_SETTINGS_TEST_IDS.TRAY_CLICK_ACTION)) as HTMLSelectElement;

describe('TrayIconSettings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockPlatform('linux');
        vi.mocked(window.electronAPI.getTrayClickAction).mockResolvedValue('quickChat');
    });

    afterEach(() => {
        setMockPlatform('win32');
        vi.mocked(window.electronAPI.getTrayClickAction).mockResolvedValue('quickChat');
    });

    // The select only appears once the saved value has loaded, so a late load cannot undo a choice
    it('shows a loading placeholder, without the select, until the saved value arrives', async () => {
        let resolve: (value: TrayClickAction) => void = () => {};
        vi.mocked(window.electronAPI.getTrayClickAction).mockReturnValue(
            new Promise<TrayClickAction>((r) => {
                resolve = r;
            })
        );
        render(<TrayIconSettings />);

        expect(screen.getByTestId(TRAY_ICON_SETTINGS_TEST_IDS.TRAY_ICON_SETTINGS_LOADING)).toBeTruthy();
        expect(screen.queryByTestId(TRAY_ICON_SETTINGS_TEST_IDS.TRAY_CLICK_ACTION)).toBeNull();

        resolve('mainWindow');
        expect((await findSelect()).value).toBe('mainWindow');
        expect(screen.queryByTestId(TRAY_ICON_SETTINGS_TEST_IDS.TRAY_ICON_SETTINGS_LOADING)).toBeNull();
    });

    it('renders the label, the GNOME description on Linux and both choices', async () => {
        render(<TrayIconSettings />);

        const select = await findSelect();
        expect(screen.getByLabelText('Tray icon opens')).toBe(select);
        expect(screen.getByText(GNOME_DESCRIPTION)).toBeTruthy();
        const options = Array.from(select.options).map((option) => [option.value, option.textContent]);
        expect(options).toEqual([
            ['quickChat', 'Quick Chat'],
            ['mainWindow', 'Main window'],
        ]);
    });

    it('uses a neutral description on Windows', async () => {
        setMockPlatform('win32');
        render(<TrayIconSettings />);

        await findSelect();
        expect(screen.getByText('What clicking the tray icon opens.')).toBeTruthy();
        expect(screen.queryByText(GNOME_DESCRIPTION)).toBeNull();
    });

    it('describes the menu bar on macOS', () => {
        expect(getTrayClickDescription('darwin')).toBe(
            'What clicking the menu bar icon opens. The click also shows its menu.'
        );
        expect(getTrayClickDescription('linux')).toBe(GNOME_DESCRIPTION);
        expect(getTrayClickDescription(undefined)).toBe('What clicking the tray icon opens.');
    });

    it('defaults to Quick Chat', async () => {
        render(<TrayIconSettings />);
        expect((await findSelect()).value).toBe('quickChat');
    });

    it('shows the saved action', async () => {
        vi.mocked(window.electronAPI.getTrayClickAction).mockResolvedValue('mainWindow');
        render(<TrayIconSettings />);
        expect((await findSelect()).value).toBe('mainWindow');
    });

    it('ignores an invalid saved value', async () => {
        vi.mocked(window.electronAPI.getTrayClickAction).mockResolvedValue('bogus' as never);
        render(<TrayIconSettings />);
        expect((await findSelect()).value).toBe('quickChat');
    });

    it('keeps the default when loading fails', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.mocked(window.electronAPI.getTrayClickAction).mockRejectedValue(new Error('no main process'));
        render(<TrayIconSettings />);
        expect((await findSelect()).value).toBe('quickChat');
        expect(consoleError).toHaveBeenCalled();
        consoleError.mockRestore();
    });

    it('saves a new choice', async () => {
        render(<TrayIconSettings />);
        const select = await findSelect();

        fireEvent.change(select, { target: { value: 'mainWindow' } });

        expect(window.electronAPI.setTrayClickAction).toHaveBeenCalledWith('mainWindow');
        expect(getSelect().value).toBe('mainWindow');
    });
});
