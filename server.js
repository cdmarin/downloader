const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

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

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Serve static files (HTML, CSS, JS)

// Helper to determine the standard Downloads folder
const downloadsFolder = path.join(os.homedir(), 'Downloads');

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
    const ip = getLocalIp();
    res.json({
        localIp: ip,
        port: PORT,
        mobileUrl: `http://${ip}:${PORT}`
    });
});

// Endpoint to stream/download the file directly to the device (Mobile or PC)
app.get('/api/file', (req, res) => {
    const filename = req.query.name;
    if (!filename) {
        return res.status(400).send('No file specified');
    }
    const safeFilename = path.basename(filename);
    const filePath = path.join(downloadsFolder, safeFilename);

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
        result: job.result,
        error: job.error
    };
}

// Run yt-dlp directly (no shell) so progress lines can be read as they arrive
function runYtDlp(url, options, job) {
    return new Promise((resolve, reject) => {
        const args = [url].concat(youtubedl.args(options));
        const child = spawn(youtubedl.constants.YOUTUBE_DL_PATH, args, { windowsHide: true });
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

    // Output format: Downloads/Title.extension
    const outputPathTemplate = path.join(downloadsFolder, '%(title)s.%(ext)s');

    let options = {
        output: outputPathTemplate,
        noCheckCertificates: true,
        noWarnings: true,
        jsRuntimes: 'node',
        extractorArgs: 'youtube:player_client=mweb',
        newline: true,
        progress: true,
        progressTemplate: `download:${PROGRESS_PREFIX} %(progress.status)s %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s`,
        // Announce the full size (video+audio) before downloading, when the site provides it.
        // --print implies --quiet, so --no-quiet keeps the progress/postprocessor output
        print: `before_dl:${TOTAL_PREFIX} %(filesize,filesize_approx)s`,
        noQuiet: true
    };

    if (ffmpegPath) {
        options.ffmpegLocation = ffmpegPath;
    }

    // Handle audio/video format
    if (format === 'mp3') {
        // Extraer y convertir audio a MP3 de alta calidad
        options.extractAudio = true;
        options.audioFormat = 'mp3';
        options.audioQuality = '0'; // 0 = máxima calidad VBR
    } else if (format === 'm4a') {
        // Audio original directo (m4a/aac)
        options.format = 'bestaudio[ext=m4a]/bestaudio/best';
    } else {
        // Video MP4: unificar mejor video y mejor audio con merge si hay ffmpeg
        options.format = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
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
            await runYtDlp(url, options, job);

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

app.listen(PORT, '0.0.0.0', () => {
    const localIp = getLocalIp();
    console.log(`========================================================`);
    console.log(`🚀 ClipSaver Server funcionando:`);
    console.log(`💻 En tu PC:            http://localhost:${PORT}`);
    console.log(`📱 En tu Móvil (Wi-Fi): http://${localIp}:${PORT}`);
    console.log(`📂 Carpeta de descargas: ${downloadsFolder}`);
    console.log(`🎵 Soporte FFmpeg/MP3:  ${ffmpegPath ? 'Habilitado' : 'Usando FFmpeg del sistema'}`);
    console.log(`========================================================`);
});
