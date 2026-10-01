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
    const trimSection = document.getElementById('trim-section');
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

    // Inside the Windows app (desktop/), files are already in Downloads and can be opened directly
    const desktopBridge = window.ClipSaverDesktop || null;
    if (desktopBridge) {
        document.body.classList.add('desktop-app');
    }

    // Blocks grow, shrink or collapse smoothly instead of making the page jump
    const blockAnimations = new WeakMap();
    const COLLAPSED = {
        height: '0px', marginTop: '0px', paddingTop: '0px', paddingBottom: '0px',
        borderTopWidth: '0px', borderBottomWidth: '0px', opacity: 0
    };

    function cancelBlockAnimation(el) {
        const running = blockAnimations.get(el);
        if (running) running.cancel();
        blockAnimations.delete(el);
    }

    function animateBlock(el, keyframes, onFinish) {
        cancelBlockAnimation(el);
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        // Animations do not advance while the page is in the background, so skip them there
        if (reduceMotion || document.hidden || !el.animate) {
            if (onFinish) onFinish();
            return;
        }
        const animation = el.animate(
            keyframes.map(frame => ({ ...frame, overflow: 'hidden' })),
            { duration: 350, easing: 'ease' }
        );
        blockAnimations.set(el, animation);
        animation.onfinish = () => {
            blockAnimations.delete(el);
            if (onFinish) onFinish();
        };
    }

    function visibleHeight(el) {
        return el.classList.contains('hidden') ? 0 : el.getBoundingClientRect().height;
    }

    function slideDown(el) {
        cancelBlockAnimation(el);
        el.classList.remove('hidden');
        animateBlock(el, [COLLAPSED, { height: `${visibleHeight(el)}px` }]);
    }

    function slideUp(el, onFinish) {
        if (el.classList.contains('hidden')) {
            if (onFinish) onFinish();
            return;
        }
        cancelBlockAnimation(el);
        animateBlock(el, [{ height: `${visibleHeight(el)}px` }, COLLAPSED], () => {
            el.classList.add('hidden');
            if (onFinish) onFinish();
        });
    }

    // Toggle Trim Section
    if (toggleTrimBtn && trimControls) {
        toggleTrimBtn.addEventListener('click', () => {
            const open = !toggleTrimBtn.classList.contains('active');
            toggleTrimBtn.classList.toggle('active', open);
            if (open) {
                slideDown(trimControls);
                // preventScroll: focusing inside a block that is still clipped would scroll it
                if (trimStartInput) trimStartInput.focus({ preventScroll: true });
            } else {
                slideUp(trimControls);
            }
        });
    }

    // Trimming is only offered for audio: the section shows up when an audio format is selected
    function isAudioFormat(format) {
        return format === 'mp3' || format === 'm4a';
    }

    let trimShown = false;

    function updateTrimVisibility() {
        if (!trimSection) return;
        const format = document.querySelector('input[name="format"]:checked').value;
        const show = isAudioFormat(format);
        if (show === trimShown) return;
        trimShown = show;
        if (show) {
            slideDown(trimSection);
            return;
        }
        trimStartInput.value = '';
        trimEndInput.value = '';
        slideUp(trimSection, () => {
            cancelBlockAnimation(trimControls);
            trimControls.classList.add('hidden');
            toggleTrimBtn.classList.remove('active');
        });
    }

    document.querySelectorAll('input[name="format"]').forEach(radio => {
        radio.addEventListener('change', updateTrimVisibility);
    });
    updateTrimVisibility();

    // Fetch local network info on load (only meaningful when served from the PC)
    if (!androidBridge && !desktopBridge) {
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
        const canTrim = isAudioFormat(format);
        const trimStart = canTrim && trimStartInput ? trimStartInput.value.trim() : '';
        const trimEnd = canTrim && trimEndInput ? trimEndInput.value.trim() : '';

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

        // Show loading state; the progress card replaces any previous result
        setLoadingState(true);
        showProgress(null);

        try {
            const data = await startDownload({
                url: url,
                format: format,
                trimStart: trimStart || undefined,
                trimEnd: trimEnd || undefined
            });

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

    // Swap the result block's content, animating from its current height to the new one
    function setResult(html) {
        const from = visibleHeight(resultContainer);
        cancelBlockAnimation(resultContainer);
        resultContainer.innerHTML = html;
        resultContainer.classList.remove('hidden');
        const to = visibleHeight(resultContainer);
        if (from !== to) {
            animateBlock(resultContainer, [{ height: `${from}px` }, { height: `${to}px` }]);
        }
    }

    function hideResult() {
        const from = visibleHeight(resultContainer);
        animateBlock(resultContainer, [{ height: `${from}px` }, { height: '0px' }], () => {
            resultContainer.classList.add('hidden');
            resultContainer.innerHTML = '';
        });
    }

    function showProgress(progress) {
        let card = resultContainer.querySelector('.progress-card');
        if (!card) {
            setResult(`
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
            `);
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
        } else if (desktopBridge && data.filename) {
            downloadButtonHtml = `
                <button type="button" class="download-file-btn" data-desktop-action="open">
                    <i class="fa-solid fa-play"></i>
                    Abrir archivo
                </button>
                <button type="button" class="try-again-btn" data-desktop-action="show">
                    <i class="fa-regular fa-folder-open"></i>
                    Mostrar en carpeta
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

        setResult(`
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
        `);
        if (desktopBridge && data.filename) {
            resultContainer.querySelectorAll('[data-desktop-action]').forEach(btn => {
                btn.addEventListener('click', () => {
                    if (btn.dataset.desktopAction === 'open') desktopBridge.openFile(data.filename);
                    else desktopBridge.showInFolder(data.filename);
                });
            });
        }
        // The file is served from the PC's Downloads folder: if it was deleted or moved there,
        // say so instead of letting the browser fail silently
        const saveLink = resultContainer.querySelector('a.download-file-btn');
        if (saveLink) {
            saveLink.addEventListener('click', async (e) => {
                e.preventDefault();
                let available = false;
                try {
                    available = (await fetch(downloadUrl, { method: 'HEAD' })).ok;
                } catch (err) { /* server unreachable */ }
                if (available) {
                    window.location.href = downloadUrl;
                } else {
                    resultContainer.querySelector('.result-card p').textContent =
                        'El archivo ya no está en la carpeta Descargas del PC (se borró o se movió). Vuelve a descargarlo.';
                    saveLink.remove();
                }
            });
        }
    }

    function showError(message) {
        setResult(`
            <div class="result-card glass-panel">
                <i class="fa-solid fa-circle-xmark error-icon"></i>
                <div>
                    <h3>Error</h3>
                    <p>${escapeHtml(message)}</p>
                </div>
                <button class="try-again-btn" onclick="resetApp()">Intentar nuevamente</button>
            </div>
        `);
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
        hideResult();
        urlInput.value = '';
        if (trimStartInput) trimStartInput.value = '';
        if (trimEndInput) trimEndInput.value = '';
        urlInput.focus();
    };
});
