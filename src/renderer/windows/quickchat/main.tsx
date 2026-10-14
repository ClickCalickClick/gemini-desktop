/**
 * Entry point for the Quick Chat window.
 *
 * This is the React entry point for the quickchat.html page.
 * It renders the QuickChatApp component which provides a
 * Spotlight-like floating prompt input.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import QuickChatApp from '@/components/quickchat/QuickChatApp';
import { ThemeProvider } from '@/context/ThemeContext';
import { LookProvider } from '@/context/LookContext';
import '@/theme.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <ThemeProvider>
            <LookProvider>
                <QuickChatApp />
            </LookProvider>
        </ThemeProvider>
    </React.StrictMode>
);
