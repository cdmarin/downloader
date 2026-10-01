// Exposed to public/script.js and public/trimmer.js as `window.ClipSaverDesktop`
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ClipSaverDesktop', {
    openFile: name => ipcRenderer.invoke('open-file', name),
    showInFolder: name => ipcRenderer.invoke('show-in-folder', name),
    // Real path of a file chosen in the page, so the trimmer can read it without copying it
    getPathForFile: file => webUtils.getPathForFile(file)
});
