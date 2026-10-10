const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

// Detect FFmpeg path from ffmpeg-static or environment
let ffmpegPath = null;
try {
    const staticPath = require('ffmpeg-static');
    if (staticPath && fs.existsSync(staticPath)) {
        ffmpegPath = staticPath;
    }
} catch (e) {
    ffmpegPath = null;
}

// Version shown in "Acerca de" for the PC version: the latest release tag of this copy
// of the repository, or package.json when it was downloaded without git
function pcVersion() {
    try {
        return require('child_process').execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
            cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, windowsHide: true
        }).toString().trim().replace(/^v/, '');
    } catch (e) {
        return require('./package.json').version;
    }
}

// Defaults for `node server.js`; the desktop app (desktop/main.js) overrides them via start()
const config = {
    port: 3000,
    host: '0.0.0.0',
    downloadsFolder: path.join(os.homedir(), 'Downloads'),
    ytDlpPath: youtubedl.constants.YOUTUBE_DL_PATH,
    ffmpegPath,
    jsRuntimes: 'node',
    childEnv: process.env,
    desktopApp: false,
    appVersion: pcVersion(),
    platform: 'PC',
    variant: null // Windows app: 'portable' or 'setup', to offer the right download
};

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve the web UI (HTML, CSS, JS)

// Function to detect the local network IP for mobile connection
function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

// Endpoint to provide network info to the frontend
app.get('/api/info', (req, res) => {
    const app = { version: config.appVersion, platform: config.platform, variant: config.variant };
    if (config.desktopApp) {
        // The desktop app only listens on this PC, so there is no mobile link to offer
        return res.json({ desktopApp: true, app });
    }
    const ip = getLocalIp();
    res.json({
        app,
        localIp: ip,
        port: config.port,
        mobileUrl: `http://${ip}:${config.port}`
    });
});

// Endpoint to stream/download the file directly to the device (Mobile or PC)
app.get('/api/file', (req, res) => {
    const filename = req.query.name;
    if (!filename) {
        return res.status(400).send('No file specified');
    }
    const safeFilename = path.basename(filename);
    const filePath = path.join(config.downloadsFolder, safeFilename);

    if (fs.existsSync(filePath)) {
        res.download(filePath, safeFilename);
    } else {
        res.status(404).send('File not found');
    }
});

// Helper to parse time input (seconds or mm:ss or hh:mm:ss)
function parseTimeInput(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return null;
    const str = timeStr.trim();
    if (!str) return null;
    if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
    const parts = str.split(':').map(Number);
    if (parts.some(isNaN)) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
}

// In-memory download jobs so the client can poll progress
const jobs = new Map();
const JOB_TTL_MS = 10 * 60 * 1000;
const PROGRESS_PREFIX = 'NEXPROGRESS';
const TOTAL_PREFIX = 'NEXTOTAL';

function toNumber(value) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
}

// Parse a line produced by our --progress-template and update job counters.
// Video+audio downloads report each stream separately, so bytes of finished
// streams are accumulated to show the overall amount downloaded.
function handleProgressLine(job, line) {
    const [status, downloaded, total, estimate, speed, eta] = line.slice(PROGRESS_PREFIX.length + 1).split(' ');
    const bytes = toNumber(downloaded);
    if (bytes === null) return;

    if (bytes < job.streamBytes) {
        // A new stream started without a "finished" report
        job.completedBytes += job.streamBytes;
    }
    job.streamBytes = bytes;
    job.streamTotal = toNumber(total) ?? toNumber(estimate);
    job.speed = toNumber(speed);
    job.eta = toNumber(eta);
    job.status = 'downloading';

    if (status === 'finished') {
        job.completedBytes += bytes;
        job.streamBytes = 0;
        job.streamTotal = null;
    }
}

function jobSnapshot(job) {
    const downloadedBytes = job.completedBytes + job.streamBytes;
    let totalBytes = job.streamTotal !== null ? job.completedBytes + job.streamTotal : null;
    // Prefer the size announced before downloading (covers video+audio together),
    // unless it is already exceeded because it was only approximate
    if (job.expectedTotal !== null && job.expectedTotal >= downloadedBytes) {
        totalBytes = job.expectedTotal;
    }
    return {
        status: job.status,
        downloadedBytes,
        totalBytes,
        speed: job.speed,
        eta: job.eta,
        percent: job.percent ?? null, // trims/conversions report progress as a percentage instead of bytes
        result: job.result,
        error: job.error
    };
}

// Run yt-dlp directly (no shell) so progress lines can be read as they arrive
function runYtDlp(url, options, job) {
    return new Promise((resolve, reject) => {
        const args = [url].concat(youtubedl.args(options));
        const child = spawn(config.ytDlpPath, args, { windowsHide: true, env: config.childEnv });
        let stderr = '';
        let buffer = '';

        child.stdout.on('data', chunk => {
            buffer += chunk.toString();
            const lines = buffer.split(/\r?\n|\r/);
            buffer = lines.pop();
            for (const line of lines) {
                if (line.startsWith(PROGRESS_PREFIX)) {
                    handleProgressLine(job, line);
                } else if (line.startsWith(TOTAL_PREFIX)) {
                    if (job.useExpectedTotal) {
                        job.expectedTotal = toNumber(line.slice(TOTAL_PREFIX.length + 1));
                    }
                } else if (/^\[(Merger|ExtractAudio|Fixup\w*|VideoConvertor)\]/.test(line)) {
                    job.status = 'processing';
                }
            }
        });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(stderr || `yt-dlp exited with code ${code}`));
        });
    });
}

const YOUTUBE_URL = /^https?:\/\/([\w-]+\.)*(youtube\.com|youtu\.be)\//i;

// Delete the temporary stream files (Title.f399.mp4.part...) that a failed attempt left behind
function removePartialFiles(folder, beforeFiles) {
    for (const file of fs.readdirSync(folder)) {
        if (!beforeFiles.has(file) && /\.f\d+\.\w+(\.part|\.ytdl)?$/.test(file)) {
            fs.rmSync(path.join(folder, file), { force: true });
        }
    }
}

app.get('/api/progress/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
        return res.status(404).json({ error: 'Descarga no encontrada.' });
    }
    res.json(jobSnapshot(job));
});

app.post('/api/download', (req, res) => {
    const { url, format, trimStart, trimEnd } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    console.log(`Starting download for: ${url} (Format: ${format}, Trim: ${trimStart || 'none'} - ${trimEnd || 'none'})`);

    const downloadsFolder = config.downloadsFolder;
    // Output format: Downloads/Title.extension
    const outputPathTemplate = path.join(downloadsFolder, '%(title)s.%(ext)s');

    let options = {
        output: outputPathTemplate,
        noCheckCertificates: true,
        noWarnings: true,
        jsRuntimes: config.jsRuntimes,
        newline: true,
        progress: true,
        progressTemplate: `download:${PROGRESS_PREFIX} %(progress.status)s %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s`,
        // Announce the full size (video+audio) before downloading, when the site provides it.
        // --print implies --quiet, so --no-quiet keeps the progress/postprocessor output
        print: `before_dl:${TOTAL_PREFIX} %(filesize,filesize_approx)s`,
        noQuiet: true
    };

    if (config.ffmpegPath) {
        options.ffmpegLocation = config.ffmpegPath;
    }

    // Handle audio/video format
    if (format === 'mp3') {
        // Extraer y convertir audio a MP3 de alta calidad
        options.extractAudio = true;
        options.audioFormat = 'mp3';
        options.audioQuality = '0'; // 0 = máxima calidad VBR
    } else if (format === 'm4a') {
        // Audio original directo (m4a/aac); si solo hay un formato con video, se extrae su audio
        options.format = 'bestaudio[ext=m4a]/bestaudio/best';
        options.extractAudio = true;
        options.audioFormat = 'm4a';
    } else {
        // Video MP4: máxima calidad disponible (cualquier códec) unida con el mejor audio
        options.format = 'bestvideo+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
        options.mergeOutputFormat = 'mp4';
    }

    // Handle trimming (downloadSections)
    const startSec = parseTimeInput(trimStart);
    const endSec = parseTimeInput(trimEnd);

    if (startSec !== null && endSec !== null && startSec >= endSec) {
        return res.status(400).json({ error: 'El tiempo de inicio debe ser menor que el tiempo final.' });
    }

    if (startSec !== null || endSec !== null) {
        const startVal = startSec !== null ? startSec : 0;
        const endVal = endSec !== null ? endSec : 'inf';
        options.downloadSections = `*${startVal}-${endVal}`;
        options.forceKeyframesAtCuts = true;
        // Sections are fetched by FFmpeg, and YouTube answers 403 to its requests for the
        // high quality streams; the mweb client still offers one (360p) that FFmpeg can read
        options.extractorArgs = 'youtube:player_client=mweb';
        console.log(`Applied trimming section: *${startVal}-${endVal}`);
    }

    const job = {
        id: crypto.randomUUID(),
        status: 'starting',
        completedBytes: 0,
        streamBytes: 0,
        streamTotal: null,
        // The announced size is for the whole video, so it is wrong when trimming
        useExpectedTotal: startSec === null && endSec === null,
        expectedTotal: null,
        speed: null,
        eta: null,
        result: null,
        error: null
    };
    jobs.set(job.id, job);

    // Respond immediately; the client polls /api/progress/:id
    res.json({ jobId: job.id });

    (async () => {
        try {
            // Snapshot files before download to identify the downloaded filename
            const beforeFiles = new Set(fs.existsSync(downloadsFolder) ? fs.readdirSync(downloadsFolder) : []);

            // Execute yt-dlp
            let reducedQuality = false;
            try {
                await runYtDlp(url, options, job);
            } catch (error) {
                // YouTube rejects (403) the high quality streams depending on the yt-dlp version;
                // the mweb client still offers a 360p one, so retry with it instead of failing
                if (options.extractorArgs || !YOUTUBE_URL.test(url)) throw error;
                console.warn('Download failed, retrying with the YouTube mweb client:', error.message.trim());
                removePartialFiles(downloadsFolder, beforeFiles);
                Object.assign(job, { status: 'starting', completedBytes: 0, streamBytes: 0, streamTotal: null, expectedTotal: null });
                await runYtDlp(url, { ...options, extractorArgs: 'youtube:player_client=mweb' }, job);
                reducedQuality = true;
            }

            // Snapshot files after download
            const afterFiles = fs.existsSync(downloadsFolder) ? fs.readdirSync(downloadsFolder) : [];
            const newFiles = afterFiles.filter(f => !beforeFiles.has(f));

            let downloadedFilename = null;
            if (newFiles.length > 0) {
                downloadedFilename = newFiles[0];
            } else if (afterFiles.length > 0) {
                // Fallback: seleccionar el archivo más recientemente modificado en la carpeta
                const sortedFiles = afterFiles
                    .map(file => ({
                        file,
                        mtime: fs.statSync(path.join(downloadsFolder, file)).mtimeMs
                    }))
                    .sort((a, b) => b.mtime - a.mtime);

                if (sortedFiles.length > 0) {
                    downloadedFilename = sortedFiles[0].file;
                }
            }

            console.log('Download completed successfully:', downloadedFilename);
            const isAudio = format === 'mp3' || format === 'm4a';
            let successMessage = isAudio ? 'Audio descargado con éxito.' : 'Video descargado con éxito.';
            if (startSec !== null || endSec !== null) {
                successMessage += ' (Fragmento recortado)';
            }
            if (reducedQuality) {
                successMessage += ' YouTube bloqueó la alta calidad, se descargó en calidad reducida.';
            }

            job.result = {
                success: true,
                message: successMessage,
                filename: downloadedFilename,
                downloadUrl: downloadedFilename ? `/api/file?name=${encodeURIComponent(downloadedFilename)}` : null
            };
            job.status = 'done';
        } catch (error) {
            console.error('Download error:', error);
            job.error = 'No se pudo descargar el archivo. Verifica la URL o tu conexión.';
            job.status = 'error';
        } finally {
            setTimeout(() => jobs.delete(job.id), JOB_TTL_MS);
        }
    })();
});

// ---------------------------------------------------------------------------
// Trimmer: cuts a local audio/video file with FFmpeg (menu > "Recortar audio o vídeo").
// The browser uploads the file (it may be on a phone using the PC version over Wi-Fi);
// the desktop app sends its path instead, since the file is already on this PC.

const uploadsFolder = path.join(os.tmpdir(), 'clipsaver-uploads');

// Codec settings for trims of audio-only files, keyed by input extension
const AUDIO_ENCODERS = {
    mp3: { ext: 'mp3', args: ['-c:a', 'libmp3lame', '-q:a', '0'] },
    m4a: { ext: 'm4a', args: ['-c:a', 'aac', '-b:a', '192k'] },
    aac: { ext: 'm4a', args: ['-c:a', 'aac', '-b:a', '192k'] },
    ogg: { ext: 'ogg', args: ['-c:a', 'libvorbis', '-q:a', '6'] },
    oga: { ext: 'ogg', args: ['-c:a', 'libvorbis', '-q:a', '6'] },
    opus: { ext: 'opus', args: ['-c:a', 'libopus', '-b:a', '160k'] },
    webm: { ext: 'opus', args: ['-c:a', 'libopus', '-b:a', '160k'] },
    wav: { ext: 'wav', args: ['-c:a', 'pcm_s16le'] },
    flac: { ext: 'flac', args: ['-c:a', 'flac'] }
};

// Same rules as DownloadEngine.trimOutputExt()/trimArgs() in the Android app
function trimOutputExt(hasVideo, inputExt) {
    if (hasVideo) return 'mp4';
    return (AUDIO_ENCODERS[inputExt] || AUDIO_ENCODERS.m4a).ext;
}

// Re-encodes the fragment so the cut lands exactly on the requested times
function trimArgs({ input, output, start, duration, hasVideo, inputExt }) {
    const args = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', '-ss', String(start), '-i', input];
    if (duration !== null) args.push('-t', String(duration));
    if (hasVideo) {
        args.push('-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
    } else {
        args.push('-map', '0:a:0', '-vn', ...(AUDIO_ENCODERS[inputExt] || AUDIO_ENCODERS.m4a).args);
    }
    args.push(output);
    return args;
}

// "Mi vídeo.mp4" -> "Mi vídeo (recorte).mp4", or "(recorte 2)" if that name is taken
function uniqueOutputPath(folder, baseName, ext, tag = 'recorte') {
    let candidate = path.join(folder, `${baseName} (${tag}).${ext}`);
    for (let i = 2; fs.existsSync(candidate); i++) {
        candidate = path.join(folder, `${baseName} (${tag} ${i}).${ext}`);
    }
    return candidate;
}

function runFfmpeg(args, job, durationSec) {
    return new Promise((resolve, reject) => {
        const child = spawn(config.ffmpegPath || 'ffmpeg', args, { windowsHide: true });
        let stderr = '';
        let buffer = '';
        child.stdout.on('data', chunk => {
            buffer += chunk.toString();
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop();
            for (const line of lines) {
                const match = /^out_time_(?:us|ms)=(\d+)/.exec(line);
                if (match && durationSec > 0) {
                    job.percent = Math.min(100, (Number(match[1]) / 1e6 / durationSec) * 100);
                }
            }
        });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(stderr || `ffmpeg exited with code ${code}`));
        });
    });
}

function newJob() {
    const job = {
        id: crypto.randomUUID(),
        status: 'starting',
        completedBytes: 0,
        streamBytes: 0,
        streamTotal: null,
        useExpectedTotal: false,
        expectedTotal: null,
        speed: null,
        eta: null,
        percent: null,
        result: null,
        error: null
    };
    jobs.set(job.id, job);
    return job;
}

// Body: the raw file (browser) or nothing (desktop app, which passes ?path=)
app.post('/api/trim', async (req, res) => {
    const { name, path: localPath } = req.query;
    const hasVideo = req.query.hasVideo === '1';
    const start = parseTimeInput(req.query.start) ?? 0;
    const end = parseTimeInput(req.query.end);

    if (end !== null && start >= end) {
        return res.status(400).json({ error: 'El inicio debe ser anterior al final.' });
    }

    let input;
    let uploaded = false;
    let originalName = name;
    if (localPath) {
        // Only the desktop app (listening on 127.0.0.1) may point at files on disk
        if (!config.desktopApp || !fs.existsSync(localPath)) {
            return res.status(400).json({ error: 'No se encuentra el archivo.' });
        }
        input = localPath;
        originalName = path.basename(localPath);
    } else {
        fs.mkdirSync(uploadsFolder, { recursive: true });
        input = path.join(uploadsFolder, `${crypto.randomUUID()}${path.extname(String(name || '')).slice(0, 10)}`);
        try {
            await new Promise((resolve, reject) => {
                const out = fs.createWriteStream(input);
                req.pipe(out);
                out.on('finish', resolve);
                out.on('error', reject);
                req.on('error', reject);
            });
        } catch (e) {
            fs.rm(input, { force: true }, () => {});
            return res.status(500).json({ error: 'No se pudo recibir el archivo.' });
        }
        uploaded = true;
    }

    const safeName = path.basename(String(originalName || 'archivo'));
    const inputExt = path.extname(safeName).slice(1).toLowerCase();
    const baseName = path.basename(safeName, path.extname(safeName)) || 'archivo';
    const duration = end !== null ? end - start : null;
    const job = newJob();
    res.json({ jobId: job.id });

    (async () => {
        try {
            fs.mkdirSync(config.downloadsFolder, { recursive: true });
            const output = uniqueOutputPath(config.downloadsFolder, baseName, trimOutputExt(hasVideo, inputExt));
            const args = trimArgs({ input, output, start, duration, hasVideo, inputExt });
            job.status = 'processing';
            job.percent = 0;
            console.log(`Trimming ${safeName}: ${start}s - ${end ?? 'end'}`);
            await runFfmpeg(args, job, duration ?? Number(req.query.mediaDuration) - start);

            const filename = path.basename(output);
            job.percent = 100;
            job.result = {
                success: true,
                message: hasVideo ? 'Vídeo recortado con éxito.' : 'Audio recortado con éxito.',
                filename,
                downloadUrl: `/api/file?name=${encodeURIComponent(filename)}`
            };
            job.status = 'done';
        } catch (error) {
            console.error('Trim error:', error.message);
            job.error = 'No se pudo recortar el archivo. Comprueba que sea un audio o vídeo válido.';
            job.status = 'error';
        } finally {
            if (uploaded) fs.rm(input, { force: true }, () => {});
            setTimeout(() => jobs.delete(job.id), JOB_TTL_MS);
        }
    })();
});

// ---------------------------------------------------------------------------
// Speed changer: speeds up or slows down a local audio/video file with FFmpeg
// (menu > "Cambiar velocidad").

function buildAtempoFilter(speed) {
    let s = speed;
    const filters = [];
    while (s > 2.0) {
        filters.push('atempo=2.0');
        s /= 2.0;
    }
    while (s < 0.5) {
        filters.push('atempo=0.5');
        s /= 0.5;
    }
    filters.push(`atempo=${s.toFixed(4).replace(/\.?0+$/, '')}`);
    return filters.join(',');
}

function speedArgs({ input, output, speed, hasVideo, inputExt }) {
    const atempo = buildAtempoFilter(speed);
    const setpts = `${(1 / speed).toFixed(6)}*PTS`;
    const args = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', '-i', input];
    if (hasVideo) {
        args.push(
            '-map', '0:v:0', '-map', '0:a?',
            '-filter:v', `setpts=${setpts}`,
            '-filter:a', atempo,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
            '-movflags', '+faststart'
        );
    } else {
        args.push(
            '-map', '0:a:0', '-vn',
            '-filter:a', atempo,
            ...(AUDIO_ENCODERS[inputExt] || AUDIO_ENCODERS.m4a).args
        );
    }
    args.push(output);
    return args;
}

// Body: raw file (browser), JSON with { files, paths, speed } (batch), or nothing (desktop app, which passes ?path=)
app.post('/api/speed', async (req, res) => {
    // 1. Batch speed change (multiple files)
    const isBatch = req.body && (Array.isArray(req.body.files) || Array.isArray(req.body.paths));
    if (isBatch) {
        const { files: uploadedFileIds, paths: localPaths, names = [] } = req.body;
        const speed = parseFloat(req.body.speed) || 1.0;
        if (speed <= 0.1 || speed > 16.0) {
            return res.status(400).json({ error: 'Velocidad no válida.' });
        }

        const items = [];
        const tempFilesToDelete = [];

        if (Array.isArray(localPaths) && localPaths.length > 0) {
            if (!config.desktopApp) {
                return res.status(400).json({ error: 'Rutas locales solo permitidas en la app de escritorio.' });
            }
            for (let i = 0; i < localPaths.length; i++) {
                const p = localPaths[i];
                if (!fs.existsSync(p)) return res.status(400).json({ error: `No se encuentra el archivo: ${path.basename(p)}` });
                const meta = await probeMedia(p);
                items.push({
                    input: p,
                    name: names[i] || path.basename(p),
                    hasVideo: meta.hasVideo,
                    duration: meta.duration
                });
            }
        } else if (Array.isArray(uploadedFileIds) && uploadedFileIds.length > 0) {
            for (let i = 0; i < uploadedFileIds.length; i++) {
                const item = uploadedFileIds[i];
                const fileId = typeof item === 'object' ? item.fileId : item;
                const originalName = (typeof item === 'object' ? item.name : names[i]) || 'archivo';
                const ext = path.extname(originalName).slice(0, 10);
                const filePath = path.join(uploadsFolder, `${fileId}${ext}`);
                if (!fs.existsSync(filePath)) {
                    return res.status(400).json({ error: `Falta el archivo subido: ${originalName}` });
                }
                tempFilesToDelete.push(filePath);
                const meta = await probeMedia(filePath);
                items.push({
                    input: filePath,
                    name: originalName,
                    hasVideo: meta.hasVideo,
                    duration: meta.duration
                });
            }
        } else {
            return res.status(400).json({ error: 'Debes proporcionar al menos un archivo.' });
        }

        const job = newJob();
        res.json({ jobId: job.id });

        (async () => {
            const results = [];
            const speedLabel = speed % 1 === 0 ? `${speed}x` : `${speed}x`;
            fs.mkdirSync(config.downloadsFolder, { recursive: true });

            try {
                job.status = 'processing';
                job.percent = 0;

                for (let i = 0; i < items.length; i++) {
                    const it = items[i];
                    const safeName = path.basename(String(it.name || 'archivo'));
                    const inputExt = path.extname(safeName).slice(1).toLowerCase();
                    const baseName = path.basename(safeName, path.extname(safeName)) || 'archivo';
                    const output = uniqueOutputPath(config.downloadsFolder, baseName, trimOutputExt(it.hasVideo, inputExt), speedLabel);
                    const args = speedArgs({ input: it.input, output, speed, hasVideo: it.hasVideo, inputExt });

                    console.log(`[Batch ${i + 1}/${items.length}] Changing speed of ${safeName} to ${speed}x`);

                    const expectedDuration = Number.isFinite(it.duration) && it.duration > 0 ? it.duration / speed : null;

                    const basePercent = (i / items.length) * 100;
                    const subJob = {
                        set percent(p) {
                            if (p !== null && Number.isFinite(p)) {
                                job.percent = Math.min(100, basePercent + (p / items.length));
                            }
                        }
                    };

                    await runFfmpeg(args, subJob, expectedDuration);

                    const filename = path.basename(output);
                    results.push({
                        filename,
                        downloadUrl: `/api/file?name=${encodeURIComponent(filename)}`,
                        hasVideo: it.hasVideo
                    });
                }

                job.percent = 100;
                job.result = {
                    success: true,
                    message: items.length === 1
                        ? `Archivo modificado a ${speedLabel} con éxito.`
                        : `${items.length} archivos modificados a ${speedLabel} con éxito.`,
                    filename: results[0].filename,
                    downloadUrl: results[0].downloadUrl,
                    files: results,
                    count: items.length
                };
                job.status = 'done';
            } catch (error) {
                console.error('Batch speed change error:', error.message);
                job.error = 'No se pudo cambiar la velocidad de los archivos. Comprueba que sean audios o vídeos válidos.';
                job.status = 'error';
            } finally {
                for (const tempPath of tempFilesToDelete) {
                    fs.rm(tempPath, { force: true }, () => {});
                }
                setTimeout(() => jobs.delete(job.id), JOB_TTL_MS);
            }
        })();
        return;
    }

    // 2. Single file speed change (query params / raw stream)
    const { name, path: localPath } = req.query;
    const hasVideo = req.query.hasVideo === '1';
    const speed = parseFloat(req.query.speed) || 1.0;

    if (speed <= 0.1 || speed > 16.0) {
        return res.status(400).json({ error: 'Velocidad no válida.' });
    }

    let input;
    let uploaded = false;
    let originalName = name;
    if (localPath) {
        if (!config.desktopApp || !fs.existsSync(localPath)) {
            return res.status(400).json({ error: 'No se encuentra el archivo.' });
        }
        input = localPath;
        originalName = path.basename(localPath);
    } else {
        fs.mkdirSync(uploadsFolder, { recursive: true });
        input = path.join(uploadsFolder, `${crypto.randomUUID()}${path.extname(String(name || '')).slice(0, 10)}`);
        try {
            await new Promise((resolve, reject) => {
                const out = fs.createWriteStream(input);
                req.pipe(out);
                out.on('finish', resolve);
                out.on('error', reject);
                req.on('error', reject);
            });
        } catch (e) {
            fs.rm(input, { force: true }, () => {});
            return res.status(500).json({ error: 'No se pudo recibir el archivo.' });
        }
        uploaded = true;
    }

    const safeName = path.basename(String(originalName || 'archivo'));
    const inputExt = path.extname(safeName).slice(1).toLowerCase();
    const baseName = path.basename(safeName, path.extname(safeName)) || 'archivo';
    const speedLabel = speed % 1 === 0 ? `${speed}x` : `${speed}x`;
    const job = newJob();
    res.json({ jobId: job.id });

    (async () => {
        try {
            fs.mkdirSync(config.downloadsFolder, { recursive: true });
            const output = uniqueOutputPath(config.downloadsFolder, baseName, trimOutputExt(hasVideo, inputExt), speedLabel);
            const args = speedArgs({ input, output, speed, hasVideo, inputExt });
            job.status = 'processing';
            job.percent = 0;
            console.log(`Changing speed of ${safeName} to ${speed}x`);
            const mediaDuration = Number(req.query.mediaDuration);
            const expectedDuration = Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration / speed : null;
            await runFfmpeg(args, job, expectedDuration);

            const filename = path.basename(output);
            job.percent = 100;
            job.result = {
                success: true,
                message: hasVideo ? `Vídeo modificado a ${speedLabel} con éxito.` : `Audio modificado a ${speedLabel} con éxito.`,
                filename,
                downloadUrl: `/api/file?name=${encodeURIComponent(filename)}`
            };
            job.status = 'done';
        } catch (error) {
            console.error('Speed change error:', error.message);
            job.error = 'No se pudo cambiar la velocidad del archivo. Comprueba que sea un audio o vídeo válido.';
            job.status = 'error';
        } finally {
            if (uploaded) fs.rm(input, { force: true }, () => {});
            setTimeout(() => jobs.delete(job.id), JOB_TTL_MS);
        }
    })();
});

// ---------------------------------------------------------------------------
// Volume changer: increases or decreases volume of a local audio/video file with FFmpeg
// (menu > "Ajustar volumen").

function volumeArgs({ input, output, volumeFactor, hasVideo, inputExt }) {
    const args = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', '-i', input];
    const volFilter = `volume=${Number(volumeFactor).toFixed(2)}`;
    if (hasVideo) {
        args.push(
            '-c:v', 'copy',
            '-filter:a', volFilter,
            '-c:a', 'aac', '-b:a', '192k',
            '-movflags', '+faststart'
        );
    } else {
        args.push(
            '-map', '0:a:0', '-vn',
            '-filter:a', volFilter,
            ...(AUDIO_ENCODERS[inputExt] || AUDIO_ENCODERS.m4a).args
        );
    }
    args.push(output);
    return args;
}

// Body: raw file (browser) or nothing (desktop app, which passes ?path=)
app.post('/api/volume', async (req, res) => {
    const { name, path: localPath } = req.query;
    const hasVideo = req.query.hasVideo === '1';
    let rawVol = parseFloat(req.query.volume) || 100;
    // Support both percentage (150) and multiplier (1.5)
    let volumePercent = rawVol > 10 ? Math.round(rawVol) : Math.round(rawVol * 100);
    let volumeFactor = rawVol > 10 ? rawVol / 100 : rawVol;

    if (volumeFactor < 0 || volumeFactor > 10.0) {
        return res.status(400).json({ error: 'Nivel de volumen no válido.' });
    }

    let input;
    let uploaded = false;
    let originalName = name;
    if (localPath) {
        if (!config.desktopApp || !fs.existsSync(localPath)) {
            return res.status(400).json({ error: 'No se encuentra el archivo.' });
        }
        input = localPath;
        originalName = path.basename(localPath);
    } else {
        fs.mkdirSync(uploadsFolder, { recursive: true });
        input = path.join(uploadsFolder, `${crypto.randomUUID()}${path.extname(String(name || '')).slice(0, 10)}`);
        try {
            await new Promise((resolve, reject) => {
                const out = fs.createWriteStream(input);
                req.pipe(out);
                out.on('finish', resolve);
                out.on('error', reject);
                req.on('error', reject);
            });
        } catch (e) {
            fs.rm(input, { force: true }, () => {});
            return res.status(500).json({ error: 'No se pudo recibir el archivo.' });
        }
        uploaded = true;
    }

    const safeName = path.basename(String(originalName || 'archivo'));
    const inputExt = path.extname(safeName).slice(1).toLowerCase();
    const baseName = path.basename(safeName, path.extname(safeName)) || 'archivo';
    const volLabel = `volumen ${volumePercent}%`;
    const job = newJob();
    res.json({ jobId: job.id });

    (async () => {
        try {
            fs.mkdirSync(config.downloadsFolder, { recursive: true });
            const output = uniqueOutputPath(config.downloadsFolder, baseName, trimOutputExt(hasVideo, inputExt), volLabel);
            const args = volumeArgs({ input, output, volumeFactor, hasVideo, inputExt });
            job.status = 'processing';
            job.percent = 0;
            console.log(`Changing volume of ${safeName} to ${volumePercent}% (${volumeFactor}x)`);
            const mediaDuration = Number(req.query.mediaDuration);
            const expectedDuration = Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : null;
            await runFfmpeg(args, job, expectedDuration);

            const filename = path.basename(output);
            job.percent = 100;
            job.result = {
                success: true,
                message: hasVideo ? `Vídeo con volumen al ${volumePercent}% guardado con éxito.` : `Audio con volumen al ${volumePercent}% guardado con éxito.`,
                filename,
                downloadUrl: `/api/file?name=${encodeURIComponent(filename)}`
            };
            job.status = 'done';
        } catch (error) {
            console.error('Volume change error:', error.message);
            job.error = 'No se pudo ajustar el volumen del archivo. Comprueba que sea un archivo válido.';
            job.status = 'error';
        } finally {
            if (uploaded) fs.rm(input, { force: true }, () => {});
            setTimeout(() => jobs.delete(job.id), JOB_TTL_MS);
        }
    })();
});

// ---------------------------------------------------------------------------
// File Combiner / Merger: combines multiple audio or video files into one
// (menu > "Combinar archivos").

// Helper to probe streams and duration of a media file
function probeMedia(filePath) {
    return new Promise((resolve) => {
        execFile(config.ffmpegPath || 'ffmpeg', ['-hide_banner', '-i', filePath], (err, stdout, stderr) => {
            const text = (stderr || '') + (stdout || '');
            const hasVideo = /Stream #\d+:\d+.*Video:/.test(text);
            const hasAudio = /Stream #\d+:\d+.*Audio:/.test(text);
            const durMatch = /Duration:\s*(\d+):(\d+):(\d+(\.\d+)?)/.exec(text);
            const duration = durMatch ? (+durMatch[1] * 3600 + +durMatch[2] * 60 + +durMatch[3]) : null;
            resolve({ hasVideo, hasAudio, duration });
        });
    });
}

function mergeArgs({ inputs, output, isAudioOnly }) {
    const args = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats'];
    for (const inp of inputs) {
        args.push('-i', inp.path);
    }
    let dummyIndex = inputs.length;
    const audioInputIndexMap = [];
    for (let i = 0; i < inputs.length; i++) {
        if (!inputs[i].hasAudio && !isAudioOnly) {
            const dur = Math.max(1, Math.round(inputs[i].duration || 2));
            args.push('-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
            audioInputIndexMap.push({ stream: `${dummyIndex}:a` });
            dummyIndex++;
        } else {
            audioInputIndexMap.push({ stream: `${i}:a` });
        }
    }
    const n = inputs.length;
    const filterParts = [];
    if (isAudioOnly) {
        for (let i = 0; i < n; i++) {
            filterParts.push(`[${i}:a]aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`);
        }
        filterParts.push(`${inputs.map((_, i) => `[a${i}]`).join('')}concat=n=${n}:v=0:a=1[outa]`);
        args.push(
            '-filter_complex', filterParts.join(';'),
            '-map', '[outa]',
            '-c:a', 'libmp3lame', '-b:a', '192k'
        );
    } else {
        for (let i = 0; i < n; i++) {
            filterParts.push(`[${i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${i}]`);
            const aSrc = audioInputIndexMap[i].stream;
            filterParts.push(`[${aSrc}]aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`);
        }
        filterParts.push(`${inputs.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${n}:v=1:a=1[outv][outa]`);
        args.push(
            '-filter_complex', filterParts.join(';'),
            '-map', '[outv]',
            '-map', '[outa]',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
            '-c:a', 'aac', '-b:a', '192k',
            '-movflags', '+faststart'
        );
    }
    args.push(output);
    return args;
}

// Upload a single file for multi-file tools (like the merger) in web mode
app.post('/api/upload', async (req, res) => {
    const originalName = req.query.name || 'archivo';
    const fileId = crypto.randomUUID();
    const ext = path.extname(originalName).slice(0, 10);
    fs.mkdirSync(uploadsFolder, { recursive: true });
    const targetPath = path.join(uploadsFolder, `${fileId}${ext}`);
    try {
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(targetPath);
            req.pipe(out);
            out.on('finish', resolve);
            out.on('error', reject);
            req.on('error', reject);
        });
        res.json({ fileId, name: originalName, path: targetPath });
    } catch (e) {
        fs.rm(targetPath, { force: true }, () => {});
        res.status(500).json({ error: 'No se pudo subir el archivo.' });
    }
});

// Merges multiple files: JSON body with { paths, files, names, outputType, totalDuration }
app.post('/api/merge', async (req, res) => {
    const { paths: localPaths, files: uploadedFileIds, names = [], outputType = 'video', totalDuration } = req.body || {};
    const isAudioOnly = outputType === 'audio';
    const inputs = [];
    const tempFilesToDelete = [];

    if (Array.isArray(localPaths) && localPaths.length >= 2) {
        if (!config.desktopApp) {
            return res.status(400).json({ error: 'Rutas locales solo permitidas en la app de escritorio.' });
        }
        for (let i = 0; i < localPaths.length; i++) {
            const p = localPaths[i];
            if (!fs.existsSync(p)) return res.status(400).json({ error: `No se encuentra el archivo: ${path.basename(p)}` });
            const meta = await probeMedia(p);
            inputs.push({
                path: p,
                name: names[i] || path.basename(p),
                hasVideo: meta.hasVideo,
                hasAudio: meta.hasAudio,
                duration: meta.duration
            });
        }
    } else if (Array.isArray(uploadedFileIds) && uploadedFileIds.length >= 2) {
        for (let i = 0; i < uploadedFileIds.length; i++) {
            const item = uploadedFileIds[i];
            const fileId = typeof item === 'object' ? item.fileId : item;
            const originalName = (typeof item === 'object' ? item.name : names[i]) || 'archivo';
            const ext = path.extname(originalName).slice(0, 10);
            const filePath = path.join(uploadsFolder, `${fileId}${ext}`);
            if (!fs.existsSync(filePath)) {
                return res.status(400).json({ error: `Falta el archivo subido: ${originalName}` });
            }
            tempFilesToDelete.push(filePath);
            const meta = await probeMedia(filePath);
            inputs.push({
                path: filePath,
                name: originalName,
                hasVideo: meta.hasVideo,
                hasAudio: meta.hasAudio,
                duration: meta.duration
            });
        }
    } else {
        return res.status(400).json({ error: 'Debes proporcionar al menos 2 archivos para combinar.' });
    }

    const firstInputName = inputs[0].name || 'archivo';
    const baseName = path.basename(firstInputName, path.extname(firstInputName)) || 'archivo';
    const outExt = isAudioOnly ? 'mp3' : 'mp4';
    const job = newJob();
    res.json({ jobId: job.id });

    (async () => {
        try {
            fs.mkdirSync(config.downloadsFolder, { recursive: true });
            const output = uniqueOutputPath(config.downloadsFolder, baseName, outExt, 'combinado');
            const args = mergeArgs({ inputs, output, isAudioOnly });
            job.status = 'processing';
            job.percent = 0;
            console.log(`Merging ${inputs.length} files into ${path.basename(output)} (${outputType})`);

            let expectedDuration = Number(totalDuration);
            if (!Number.isFinite(expectedDuration) || expectedDuration <= 0) {
                expectedDuration = inputs.reduce((sum, inp) => sum + (inp.duration || 0), 0) || null;
            }

            await runFfmpeg(args, job, expectedDuration);

            const filename = path.basename(output);
            job.percent = 100;
            job.result = {
                success: true,
                message: isAudioOnly
                    ? `Audio combinado (${inputs.length} pistas) guardado con éxito.`
                    : `Vídeo combinado (${inputs.length} clips) guardado con éxito.`,
                filename,
                downloadUrl: `/api/file?name=${encodeURIComponent(filename)}`
            };
            job.status = 'done';
        } catch (error) {
            console.error('Merge error:', error.message);
            job.error = 'No se pudieron combinar los archivos seleccionados. Comprueba que sean audios o vídeos válidos.';
            job.status = 'error';
        } finally {
            for (const tempPath of tempFilesToDelete) {
                fs.rm(tempPath, { force: true }, () => {});
            }
            setTimeout(() => jobs.delete(job.id), JOB_TTL_MS);
        }
    })();
});

// Starts the server; resolves with the http.Server once it is listening
function start(overrides = {}) {
    Object.assign(config, overrides);
    return new Promise((resolve, reject) => {
        const server = app.listen(config.port, config.host, () => {
            config.port = server.address().port; // real port when 0 (pick any free one) was requested
            resolve(server);
        });
        server.on('error', reject);
    });
}

module.exports = { start };

if (require.main === module) {
    start().then(() => {
        const localIp = getLocalIp();
        console.log(`========================================================`);
        console.log(`🚀 ClipSaver Server funcionando:`);
        console.log(`💻 En tu PC:            http://localhost:${config.port}`);
        console.log(`📱 En tu Móvil (Wi-Fi): http://${localIp}:${config.port}`);
        console.log(`📂 Carpeta de descargas: ${config.downloadsFolder}`);
        console.log(`🎵 Soporte FFmpeg/MP3:  ${config.ffmpegPath ? 'Habilitado' : 'Usando FFmpeg del sistema'}`);
        console.log(`========================================================`);
    });
}
