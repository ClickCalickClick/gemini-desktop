import { ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants/ipc-channels';
import type { ElectronAPI } from '../../shared/types';
import type { PlatformHotkeyStatus } from '../../shared/types/hotkeys';
import { createSubscription } from '../createSubscription';

export const platformAPI: Pick<
    ElectronAPI,
    'platform' | 'isElectron' | 'getPlatformHotkeyStatus' | 'onPlatformHotkeyStatusChanged' | 'changeHotkeysInDesktop'
> = {
    platform: process.platform,
    isElectron: true,
    getPlatformHotkeyStatus: () => ipcRenderer.invoke(IPC_CHANNELS.PLATFORM_HOTKEY_STATUS_GET),
    onPlatformHotkeyStatusChanged: createSubscription<PlatformHotkeyStatus>(
        IPC_CHANNELS.PLATFORM_HOTKEY_STATUS_CHANGED
    ),
    changeHotkeysInDesktop: () => ipcRenderer.invoke(IPC_CHANNELS.HOTKEYS_CHANGE_IN_DESKTOP),
};
