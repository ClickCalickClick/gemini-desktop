import { ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants/ipc-channels';
import type { ElectronAPI } from '../../shared/types';

export const trayAPI: Pick<ElectronAPI, 'getTrayClickAction' | 'setTrayClickAction'> = {
    getTrayClickAction: () => ipcRenderer.invoke(IPC_CHANNELS.TRAY_CLICK_ACTION_GET),
    setTrayClickAction: (action) => ipcRenderer.send(IPC_CHANNELS.TRAY_CLICK_ACTION_SET, action),
};
