/**
 * Unit tests for TrayIconSettings: loading the saved tray click action and saving a new one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TrayIconSettings } from './TrayIconSettings';
import { TRAY_ICON_SETTINGS_TEST_IDS } from '../../utils/testIds';

const getSelect = () => screen.getByTestId(TRAY_ICON_SETTINGS_TEST_IDS.TRAY_CLICK_ACTION) as HTMLSelectElement;

describe('TrayIconSettings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(window.electronAPI.getTrayClickAction).mockResolvedValue('quickChat');
    });

    afterEach(() => {
        vi.mocked(window.electronAPI.getTrayClickAction).mockResolvedValue('quickChat');
    });

    it('renders the label, description and both choices', async () => {
        render(<TrayIconSettings />);

        expect(screen.getByLabelText('Tray icon opens')).toBe(getSelect());
        expect(
            screen.getByText(
                'What clicking the tray icon opens. On GNOME a single click shows the menu and a double click opens this.'
            )
        ).toBeTruthy();
        const options = Array.from(getSelect().options).map((option) => [option.value, option.textContent]);
        expect(options).toEqual([
            ['quickChat', 'Quick Chat'],
            ['mainWindow', 'Main window'],
        ]);
        await waitFor(() => expect(window.electronAPI.getTrayClickAction).toHaveBeenCalled());
    });

    it('defaults to Quick Chat', async () => {
        render(<TrayIconSettings />);
        await waitFor(() => expect(window.electronAPI.getTrayClickAction).toHaveBeenCalled());
        expect(getSelect().value).toBe('quickChat');
    });

    it('shows the saved action', async () => {
        vi.mocked(window.electronAPI.getTrayClickAction).mockResolvedValue('mainWindow');
        render(<TrayIconSettings />);
        await waitFor(() => expect(getSelect().value).toBe('mainWindow'));
    });

    it('ignores an invalid saved value', async () => {
        vi.mocked(window.electronAPI.getTrayClickAction).mockResolvedValue('bogus' as never);
        render(<TrayIconSettings />);
        await waitFor(() => expect(window.electronAPI.getTrayClickAction).toHaveBeenCalled());
        expect(getSelect().value).toBe('quickChat');
    });

    it('keeps the default when loading fails', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.mocked(window.electronAPI.getTrayClickAction).mockRejectedValue(new Error('no main process'));
        render(<TrayIconSettings />);
        await waitFor(() => expect(consoleError).toHaveBeenCalled());
        expect(getSelect().value).toBe('quickChat');
        consoleError.mockRestore();
    });

    it('saves a new choice', async () => {
        render(<TrayIconSettings />);
        await waitFor(() => expect(window.electronAPI.getTrayClickAction).toHaveBeenCalled());

        fireEvent.change(getSelect(), { target: { value: 'mainWindow' } });

        expect(window.electronAPI.setTrayClickAction).toHaveBeenCalledWith('mainWindow');
        expect(getSelect().value).toBe('mainWindow');
    });
});
