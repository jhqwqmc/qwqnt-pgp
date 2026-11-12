/// <reference types="vite/client" />

import type { PgpApi } from './preload/index';

declare global {
  interface Window {
    /** preload 暴露的插件 API（走 ipcMain） */
    QwQNTPgp: PgpApi;
    app?: Record<string, unknown>;
    [key: string]: unknown;
  }
}

export {};
