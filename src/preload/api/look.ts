import { ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants/ipc-channels';
import type { ElectronAPI } from '../../shared/types';
import type { LookData } from '../../shared/types/look';
import { createSubscription } from '../createSubscription';

export const lookAPI: Pick<ElectronAPI, 'getLook' | 'setLook' | 'onLookChanged'> = {
    getLook: () => ipcRenderer.invoke(IPC_CHANNELS.LOOK_GET),
    setLook: (look) => ipcRenderer.send(IPC_CHANNELS.LOOK_SET, look),
    onLookChanged: createSubscription<LookData>(IPC_CHANNELS.LOOK_CHANGED),
};
