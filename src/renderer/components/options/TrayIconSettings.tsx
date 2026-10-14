import { memo, useCallback, useEffect, useState } from 'react';

import { DEFAULT_TRAY_CLICK_ACTION, isTrayClickAction } from '../../../shared/types/tray';
import type { TrayClickAction } from '../../../shared/types/tray';
import { TRAY_ICON_SETTINGS_TEST_IDS } from '../../utils/testIds';
import './TrayIconSettings.css';

const CLICK_ACTION_OPTIONS: ReadonlyArray<{ value: TrayClickAction; label: string }> = [
    { value: 'quickChat', label: 'Quick Chat' },
    { value: 'mainWindow', label: 'Main window' },
];

const SELECT_ID = 'tray-click-action';

/**
 * Options row for what clicking the tray icon opens.
 */
export const TrayIconSettings = memo(function TrayIconSettings() {
    const [clickAction, setClickAction] = useState<TrayClickAction>(DEFAULT_TRAY_CLICK_ACTION);

    useEffect(() => {
        let isMounted = true;

        const load = async () => {
            try {
                const getTrayClickAction = window.electronAPI?.getTrayClickAction;
                if (typeof getTrayClickAction !== 'function') {
                    return;
                }
                const saved = await getTrayClickAction();
                if (isMounted && isTrayClickAction(saved)) {
                    setClickAction(saved);
                }
            } catch (error) {
                console.error('Failed to load the tray click action:', error);
            }
        };

        void load();

        return () => {
            isMounted = false;
        };
    }, []);

    const handleChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
        const next = event.target.value;
        if (!isTrayClickAction(next)) {
            return;
        }
        setClickAction(next);

        try {
            const setTrayClickAction = window.electronAPI?.setTrayClickAction;
            if (typeof setTrayClickAction === 'function') {
                setTrayClickAction(next);
            }
        } catch (error) {
            console.error('Failed to set the tray click action:', error);
        }
    }, []);

    return (
        <div className="tray-icon-settings" data-testid={TRAY_ICON_SETTINGS_TEST_IDS.TRAY_ICON_SETTINGS}>
            <div className="tray-icon-settings__row">
                <div className="tray-icon-settings__text">
                    <label className="tray-icon-settings__label" htmlFor={SELECT_ID}>
                        Tray icon opens
                    </label>
                    <span className="tray-icon-settings__description" id={`${SELECT_ID}-description`}>
                        What clicking the tray icon opens. On GNOME a single click shows the menu and a double click
                        opens this.
                    </span>
                </div>
                <div className="tray-icon-settings__control">
                    <select
                        id={SELECT_ID}
                        className="tray-icon-settings__select"
                        value={clickAction}
                        onChange={handleChange}
                        aria-describedby={`${SELECT_ID}-description`}
                        data-testid={TRAY_ICON_SETTINGS_TEST_IDS.TRAY_CLICK_ACTION}
                    >
                        {CLICK_ACTION_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                </div>
            </div>
        </div>
    );
});

export default TrayIconSettings;
