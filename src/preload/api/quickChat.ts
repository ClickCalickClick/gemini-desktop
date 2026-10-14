import { ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants/ipc-channels';
import type { ElectronAPI } from '../../shared/types';
import { createSubscription } from '../createSubscription';

export const quickChatAPI: Pick<
    ElectronAPI,
    | 'submitQuickChat'
    | 'hideQuickChat'
    | 'cancelQuickChat'
    | 'onQuickChatExecute'
    | 'resizeQuickChat'
    | 'captureQuickChatScreenshot'
    | 'discardQuickChatScreenshot'
> = {
    submitQuickChat: (text, options) =>
        options
            ? ipcRenderer.send(IPC_CHANNELS.QUICK_CHAT_SUBMIT, text, options)
            : ipcRenderer.send(IPC_CHANNELS.QUICK_CHAT_SUBMIT, text),
    hideQuickChat: () => ipcRenderer.send(IPC_CHANNELS.QUICK_CHAT_HIDE),
    cancelQuickChat: () => ipcRenderer.send(IPC_CHANNELS.QUICK_CHAT_CANCEL),
    onQuickChatExecute: createSubscription<string>(IPC_CHANNELS.QUICK_CHAT_EXECUTE),
    resizeQuickChat: (height) => ipcRenderer.send(IPC_CHANNELS.QUICK_CHAT_RESIZE, height),
    captureQuickChatScreenshot: (mode) => ipcRenderer.invoke(IPC_CHANNELS.QUICK_CHAT_SCREENSHOT_CAPTURE, mode),
    discardQuickChatScreenshot: (id) => ipcRenderer.send(IPC_CHANNELS.QUICK_CHAT_SCREENSHOT_DISCARD, id),
};
