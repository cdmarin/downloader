// ClipSaver for Windows: runs the same server.js + web UI as the PC version inside its own window,
// with yt-dlp, FFmpeg and a JavaScript runtime bundled so nothing has to be installed.
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Binaries cannot run from inside app.asar, electron-builder unpacks them next to it (asarUnpack)
function unpacked(p) {
    return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

// yt-dlp is copied to the user's data folder so it can update itself (the install folder
// may be read-only, and the portable .exe is extracted to a new temp folder on every run)
function prepareYtDlp() {
    const bundled = unpacked(require('youtube-dl-exec').constants.YOUTUBE_DL_PATH);
    const binDir = path.join(app.getPath('userData'), 'bin');
    const target = path.join(binDir, path.basename(bundled));
    try {
        if (!fs.existsSync(target)) {
            fs.mkdirSync(binDir, { recursive: true });
            fs.copyFileSync(bundled, target);
        }
        return target;
    } catch (e) {
        console.error('Could not copy yt-dlp, using the bundled one:', e);
        return bundled;
    }
}

// Sites change often, so keep yt-dlp current (at most once a day, in the background)
function updateYtDlp(ytDlpPath) {
    const stampFile = path.join(app.getPath('userData'), 'yt-dlp-updated');
    try {
        if (Date.now() - fs.statSync(stampFile).mtimeMs < UPDATE_INTERVAL_MS) return;
    } catch (e) { /* never updated */ }
    execFile(ytDlpPath, ['-U'], { windowsHide: true, timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
        if (err) {
            console.error('yt-dlp update failed:', stderr || err.message);
            return;
        }
        console.log(stdout.trim());
        fs.writeFileSync(stampFile, new Date().toISOString());
    });
}

function downloadedFile(name) {
    return path.join(app.getPath('downloads'), path.basename(String(name)));
}

let mainWindow = null;

async function createWindow() {
    const ytDlpPath = prepareYtDlp();
    updateYtDlp(ytDlpPath);

    const ffmpegStatic = require('ffmpeg-static');
    // Packaged: server.js and public/ are copied into the app. `npm start`: use the repo's copies
    const { start } = require(app.isPackaged ? './server' : '../server');
    const server = await start({
        port: 0,              // any free port, so it never clashes with `node server.js` on 3000
        host: '127.0.0.1',    // only this PC (no firewall prompt)
        downloadsFolder: app.getPath('downloads'),
        ytDlpPath,
        ffmpegPath: ffmpegStatic ? unpacked(ffmpegStatic) : null,
        // YouTube needs a JavaScript runtime: this same executable acts as Node.js
        // when ELECTRON_RUN_AS_NODE is set, so the user does not need Node installed
        jsRuntimes: `node:${process.execPath}`,
        childEnv: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        desktopApp: true
    });
    const appUrl = `http://127.0.0.1:${server.address().port}/`;

    mainWindow = new BrowserWindow({
        width: 960,
        height: 820,
        minWidth: 360,
        minHeight: 560,
        title: 'ClipSaver',
        backgroundColor: '#0b0f19',
        icon: path.join(__dirname, 'build', 'icon.png'),
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            sandbox: true
        }
    });
    mainWindow.once('ready-to-show', () => mainWindow.show());

    // Links to other sites open in the normal browser, never inside the app
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(appUrl)) {
            event.preventDefault();
            if (/^https?:\/\//.test(url)) shell.openExternal(url);
        }
    });

    mainWindow.loadURL(appUrl);
}

ipcMain.handle('open-file', (event, name) => shell.openPath(downloadedFile(name)));
ipcMain.handle('show-in-folder', (event, name) => shell.showItemInFolder(downloadedFile(name)));

// A second launch just brings the existing window to the front
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
        Menu.setApplicationMenu(null);
        return createWindow();
    }).catch(err => {
        console.error(err);
        require('electron').dialog.showErrorBox('ClipSaver', `No se pudo iniciar ClipSaver:\n${err.message}`);
        app.quit();
    });

    app.on('window-all-closed', () => app.quit());
}
