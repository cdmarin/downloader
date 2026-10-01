document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('download-form');
    const urlInput = document.getElementById('video-url');
    const submitBtn = document.getElementById('submit-btn');
    const resultContainer = document.getElementById('result-container');

    // Mobile Modal Elements
    const mobileBtn = document.getElementById('mobile-btn');
    const mobileModal = document.getElementById('mobile-modal');
    const closeModalBtn = document.getElementById('close-modal-btn');
    const qrImage = document.getElementById('qr-image');
    const mobileUrlInput = document.getElementById('mobile-url-input');
    const copyUrlBtn = document.getElementById('copy-url-btn');

    // Trim Elements
    const toggleTrimBtn = document.getElementById('toggle-trim-btn');
    const trimControls = document.getElementById('trim-controls');
    const trimStartInput = document.getElementById('trim-start');
    const trimEndInput = document.getElementById('trim-end');

    let mobileUrl = '';

    // Inside the Android app, downloads go through a native bridge instead of the local server
    const androidBridge = window.ClipSaverAndroid || null;
    if (androidBridge) {
        document.body.classList.add('android-app');
    }

    // Toggle Trim Section
    if (toggleTrimBtn && trimControls) {
        toggleTrimBtn.addEventListener('click', () => {
            const isHidden = trimControls.classList.toggle('hidden');
            toggleTrimBtn.classList.toggle('active', !isHidden);
            if (!isHidden && trimStartInput) {
                trimStartInput.focus();
            }
        });
    }

    // Fetch local network info on load (only meaningful when served from the PC)
    if (!androidBridge) {
        fetch('/api/info')
            .then(res => res.json())
            .then(data => {
                if (data.mobileUrl) {
                    mobileUrl = data.mobileUrl;
                    mobileUrlInput.value = mobileUrl;
                    qrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(mobileUrl)}`;
                }
            })
            .catch(err => console.log('Info fetch error:', err));
    }

    // Links shared to the Android app ("Compartir" > ClipSaver) prefill the input
    window.clipSaverReceiveUrl = function(url) {
        if (!url) return;
        urlInput.value = url;
        urlInput.focus();
    };
    if (androidBridge) {
        window.clipSaverReceiveUrl(androidBridge.consumeSharedUrl());
    }

    // Open/Close Mobile Modal
    if (mobileBtn) {
        mobileBtn.addEventListener('click', () => {
            mobileModal.classList.remove('hidden');
        });
    }

    if (closeModalBtn) {
        closeModalBtn.addEventListener('click', () => {
            mobileModal.classList.add('hidden');
        });
    }

    if (mobileModal) {
        mobileModal.addEventListener('click', (e) => {
            if (e.target === mobileModal) {
                mobileModal.classList.add('hidden');
            }
        });
    }

    // Copy URL to Clipboard
    if (copyUrlBtn) {
        copyUrlBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(mobileUrlInput.value);
                const originalHtml = copyUrlBtn.innerHTML;
                copyUrlBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
                setTimeout(() => {
                    copyUrlBtn.innerHTML = originalHtml;
                }, 2000);
            } catch (e) {
                mobileUrlInput.select();
                document.execCommand('copy');
            }
        });
    }

    // Helper: Parse time string (mm:ss, hh:mm:ss or seconds) to seconds
    function parseTimeToSeconds(timeStr) {
        if (!timeStr) return null;
        const str = timeStr.trim();
        if (!str) return null;
        if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
        const parts = str.split(':').map(Number);
        if (parts.some(isNaN)) return null;
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        return null;
    }

    // Form Submit Handler
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const url = urlInput.value.trim();
        if (!url) return;
        
        const format = document.querySelector('input[name="format"]:checked').value;
        const trimStart = trimStartInput ? trimStartInput.value.trim() : '';
        const trimEnd = trimEndInput ? trimEndInput.value.trim() : '';

        // Validation for trim inputs
        const startSec = parseTimeToSeconds(trimStart);
        const endSec = parseTimeToSeconds(trimEnd);

        if (trimStart && startSec === null) {
            showError('Formato de inicio inválido. Usa mm:ss (ej: 00:30) o segundos.');
            return;
        }
        if (trimEnd && endSec === null) {
            showError('Formato de fin inválido. Usa mm:ss (ej: 01:45) o segundos.');
            return;
        }
        if (startSec !== null && endSec !== null && startSec >= endSec) {
            showError('El tiempo de inicio debe ser menor que el tiempo final.');
            return;
        }

        // Reset and show loading state
        setLoadingState(true);
        resultContainer.innerHTML = '';
        resultContainer.classList.add('hidden');

        try {
            const data = await startDownload({
                url: url,
                format: format,
                trimStart: trimStart || undefined,
                trimEnd: trimEnd || undefined
            });

            showProgress(null);
            const result = await waitForJob(data.jobId);
            showSuccess(result);

        } catch (error) {
            showError(error.message || 'Error de conexión con el servidor local.');
        } finally {
            setLoadingState(false);
        }
    });

    // Start a download job on the local server or on the Android bridge
    async function startDownload(payload) {
        let data;
        if (androidBridge) {
            data = JSON.parse(androidBridge.startDownload(JSON.stringify(payload)));
        } else {
            const response = await fetch('/api/download', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload)
            });
            data = await response.json();
            if (!response.ok && !data.error) data.error = 'Error al procesar la descarga.';
        }
        if (data.error) {
            throw new Error(data.error);
        }
        return data;
    }

    async function fetchProgress(jobId) {
        if (androidBridge) {
            const progress = JSON.parse(androidBridge.getProgress(jobId));
            if (progress.error && !progress.status) throw new Error(progress.error);
            return progress;
        }
        const res = await fetch(`/api/progress/${jobId}`);
        const progress = await res.json();
        if (!res.ok) throw new Error(progress.error || 'Descarga no encontrada.');
        return progress;
    }

    function setLoadingState(isLoading) {
        if (isLoading) {
            submitBtn.classList.add('loading');
            submitBtn.disabled = true;
            urlInput.disabled = true;
            if (trimStartInput) trimStartInput.disabled = true;
            if (trimEndInput) trimEndInput.disabled = true;
        } else {
            submitBtn.classList.remove('loading');
            submitBtn.disabled = false;
            urlInput.disabled = false;
            if (trimStartInput) trimStartInput.disabled = false;
            if (trimEndInput) trimEndInput.disabled = false;
        }
    }

    // Poll the server until the download job finishes, updating the progress panel
    async function waitForJob(jobId) {
        let failures = 0;
        while (true) {
            await new Promise(resolve => setTimeout(resolve, 500));
            let progress;
            try {
                progress = await fetchProgress(jobId);
                failures = 0;
            } catch (err) {
                // Tolerate brief network hiccups (e.g. on mobile Wi-Fi)
                if (++failures >= 10) throw err;
                continue;
            }

            if (progress.status === 'done') return progress.result;
            if (progress.status === 'error') throw new Error(progress.error);
            showProgress(progress);
        }
    }

    function formatBytes(bytes) {
        if (bytes === null || bytes === undefined) return '—';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = bytes;
        let i = 0;
        while (value >= 1024 && i < units.length - 1) {
            value /= 1024;
            i++;
        }
        return `${value.toFixed(i === 0 ? 0 : value < 10 ? 2 : 1)} ${units[i]}`;
    }

    function formatEta(seconds) {
        if (seconds === null || seconds === undefined) return '';
        const s = Math.round(seconds);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = String(s % 60).padStart(2, '0');
        return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
    }

    function showProgress(progress) {
        let card = resultContainer.querySelector('.progress-card');
        if (!card) {
            resultContainer.innerHTML = `
                <div class="result-card glass-panel progress-card">
                    <div>
                        <h3 class="progress-title">Preparando descarga...</h3>
                        <p class="progress-sub">Obteniendo información del enlace</p>
                    </div>
                    <div class="progress-track indeterminate"><div class="progress-fill"></div></div>
                    <div class="progress-stats">
                        <span class="progress-bytes"></span>
                        <span class="progress-speed"></span>
                    </div>
                </div>
            `;
            resultContainer.classList.remove('hidden');
            card = resultContainer.querySelector('.progress-card');
        }
        if (!progress) return;

        const title = card.querySelector('.progress-title');
        const sub = card.querySelector('.progress-sub');
        const track = card.querySelector('.progress-track');
        const fill = card.querySelector('.progress-fill');
        const bytesEl = card.querySelector('.progress-bytes');
        const speedEl = card.querySelector('.progress-speed');

        const { status, downloadedBytes, totalBytes, speed, eta } = progress;

        if (status === 'processing') {
            title.textContent = 'Procesando archivo...';
            sub.textContent = 'Uniendo / convirtiendo con FFmpeg';
            track.classList.add('indeterminate');
            fill.style.width = '';
            bytesEl.textContent = `${formatBytes(downloadedBytes)} descargados`;
            speedEl.textContent = '';
            return;
        }

        if (status !== 'downloading') return;

        title.textContent = 'Descargando...';
        if (totalBytes) {
            const pct = Math.min(100, (downloadedBytes / totalBytes) * 100);
            track.classList.remove('indeterminate');
            fill.style.width = `${pct}%`;
            sub.textContent = `${pct.toFixed(1)}%`;
            bytesEl.textContent = `${formatBytes(downloadedBytes)} de ~${formatBytes(totalBytes)}`;
        } else {
            track.classList.add('indeterminate');
            fill.style.width = '';
            sub.textContent = 'Tamaño total desconocido';
            bytesEl.textContent = `${formatBytes(downloadedBytes)} descargados`;
        }

        const speedText = speed ? `${formatBytes(speed)}/s` : '';
        const etaText = eta ? `quedan ${formatEta(eta)}` : '';
        speedEl.textContent = [speedText, etaText].filter(Boolean).join(' · ');
    }

    function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    function showSuccess(data) {
        const filename = escapeHtml(data.filename || 'Archivo descargado');
        const downloadUrl = data.downloadUrl;
        const isAudio = /\.(mp3|m4a|wav|aac|ogg|opus|flac)$/i.test(filename);
        const fileIcon = isAudio ? 'fa-file-audio' : 'fa-file-video';

        let downloadButtonHtml = '';
        if (androidBridge && data.jobId) {
            downloadButtonHtml = `
                <button class="download-file-btn" onclick="ClipSaverAndroid.openFile('${escapeHtml(data.jobId)}')">
                    <i class="fa-solid fa-play"></i>
                    Abrir archivo
                </button>
            `;
        } else if (downloadUrl) {
            downloadButtonHtml = `
                <a href="${downloadUrl}" class="download-file-btn" download>
                    <i class="fa-solid fa-download"></i>
                    Guardar en este dispositivo
                </a>
            `;
        }

        resultContainer.innerHTML = `
            <div class="result-card glass-panel">
                <i class="fa-solid fa-circle-check success-icon"></i>
                <div>
                    <h3>¡Descarga Completada!</h3>
                    <p>${escapeHtml(data.message || 'El archivo se procesó con éxito.')}</p>
                </div>
                <div class="file-badge">
                    <i class="fa-regular ${fileIcon}"></i> ${filename}
                </div>
                <div class="action-buttons">
                    ${downloadButtonHtml}
                    <button class="try-again-btn" onclick="resetApp()">Descargar otro</button>
                </div>
            </div>
        `;
        resultContainer.classList.remove('hidden');
    }

    function showError(message) {
        resultContainer.innerHTML = `
            <div class="result-card glass-panel">
                <i class="fa-solid fa-circle-xmark error-icon"></i>
                <div>
                    <h3>Error</h3>
                    <p>${escapeHtml(message)}</p>
                </div>
                <button class="try-again-btn" onclick="resetApp()">Intentar nuevamente</button>
            </div>
        `;
        resultContainer.classList.remove('hidden');
    }

    // Reopening the Android app while a download is still running shows its progress again
    async function resumeJob(jobId) {
        setLoadingState(true);
        showProgress(null);
        try {
            showSuccess(await waitForJob(jobId));
        } catch (error) {
            showError(error.message || 'Error al procesar la descarga.');
        } finally {
            setLoadingState(false);
        }
    }

    if (androidBridge) {
        const activeJobId = androidBridge.activeJobId();
        if (activeJobId) resumeJob(activeJobId);
    }

    // Expose resetApp globally for inline onclick handlers
    window.resetApp = function() {
        resultContainer.classList.add('hidden');
        resultContainer.innerHTML = '';
        urlInput.value = '';
        if (trimStartInput) trimStartInput.value = '';
        if (trimEndInput) trimEndInput.value = '';
        urlInput.focus();
    };
});
