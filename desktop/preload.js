// Exposed to public/script.js as `window.ClipSaverDesktop`
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ClipSaverDesktop', {
    openFile: name => ipcRenderer.invoke('open-file', name),
    showInFolder: name => ipcRenderer.invoke('show-in-folder', name)
});
