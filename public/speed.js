// Speed Changer (menu > "Cambiar velocidad"): pick a local file, choose playback speed,
// preview in real time, and process with FFmpeg (server.js /api/speed, or the Android bridge).
document.addEventListener('DOMContentLoaded', () => {
    const { androidBridge, desktopBridge, escapeHtml, fileActionsHtml, bindFileActions } = window.ClipSaverUI;
    const POLL_MS = 500;

    const $ = id => document.getElementById(id);
    const fileInput = $('speed-file');
    const drop = $('speed-drop');
    const editor = $('speed-editor');
    const media = $('speed-media');
    const frame = $('speed-media-frame');
    const mediaError = $('speed-media-error');
    const playBtn = $('speed-play-btn');
    const currentTimeEl = $('speed-current-time');
    const totalTimeEl = $('speed-total-time');
    const previewValEl = $('speed-preview-val');
    const presetsContainer = $('speed-presets');
    const slider = $('speed-slider');
    const customInput = $('speed-custom-input');
    const origDurationEl = $('speed-original-duration');
    const newDurationEl = $('speed-new-duration');
    const applyBtn = $('speed-apply-btn');
    const resultBox = $('speed-result');

    const state = {
        file: null,
        url: null,
        duration: null,
        hasVideo: true,
        speed: 1.5,
        busy: false
    };

    function formatDuration(seconds) {
        if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return '--:--';
        const totalMs = Math.round(seconds * 1000);
        const totalSec = Math.floor(totalMs / 1000);
        const s = totalSec % 60;
        const m = Math.floor(totalSec / 60) % 60;
        const h = Math.floor(totalSec / 3600);
        const pad = (n, len = 2) => String(n).padStart(len, '0');
        const base = `${pad(m)}:${pad(s)}`;
        return h > 0 ? `${h}:${base}` : base;
    }

    function setSpeed(speedVal, fromInput = false) {
        const val = Math.max(0.25, Math.min(4.0, Number(speedVal) || 1.0));
        state.speed = val;

        // Apply real-time preview rate on the player
        try {
            media.playbackRate = val;
        } catch (e) { /* ignored if not loaded */ }

        // Update custom input box if not currently being typed into
        if (customInput && !fromInput && document.activeElement !== customInput) {
            customInput.value = val.toFixed(2);
        }

        // Update preview readout
        const formattedSpeed = `${val.toFixed(2)}x`;
        if (previewValEl) previewValEl.textContent = formattedSpeed;

        // Update slider value without looping events
        if (slider && Math.abs(parseFloat(slider.value) - val) > 0.005) {
            slider.value = val;
        }

        // Highlight preset if it closely matches
        if (presetsContainer) {
            presetsContainer.querySelectorAll('.speed-preset-btn').forEach(btn => {
                const btnSpeed = parseFloat(btn.dataset.speed);
                btn.classList.toggle('active', Math.abs(btnSpeed - val) < 0.005);
            });
        }

        // Update estimated duration
        updateDurations();
    }

    function updateDurations() {
        if (state.duration && state.duration > 0) {
            origDurationEl.textContent = formatDuration(state.duration);
            const estSeconds = state.duration / state.speed;
            newDurationEl.textContent = formatDuration(estSeconds);
        } else {
            origDurationEl.textContent = '—';
            newDurationEl.textContent = '—';
        }
    }

    // ----- Loading a file -----

    if (fileInput) {
        fileInput.addEventListener('change', () => {
            if (fileInput.files && fileInput.files[0]) loadFile(fileInput.files[0]);
        });
    }

    if (drop) {
        ['dragenter', 'dragover'].forEach(type => drop.addEventListener(type, event => {
            event.preventDefault();
            drop.classList.add('dragging');
        }));
        ['dragleave', 'drop'].forEach(type => drop.addEventListener(type, () => drop.classList.remove('dragging')));
        drop.addEventListener('drop', event => {
            event.preventDefault();
            const file = event.dataTransfer.files && event.dataTransfer.files[0];
            if (file) loadFile(file);
        });
    }

    const changeFileBtn = $('speed-change-file');
    if (changeFileBtn) {
        changeFileBtn.addEventListener('click', () => fileInput && fileInput.click());
    }

    function loadFile(file) {
        media.pause();
        if (state.url) URL.revokeObjectURL(state.url);
        Object.assign(state, {
            file,
            url: URL.createObjectURL(file),
            duration: null,
            hasVideo: !file.type.startsWith('audio/')
        });

        $('speed-file-name').textContent = file.name;
        $('speed-file-icon').className = `fa-regular ${state.hasVideo ? 'fa-file-video' : 'fa-file-audio'}`;
        mediaError.classList.add('hidden');
        frame.classList.toggle('audio-only', !state.hasVideo);
        drop.classList.add('hidden');
        editor.classList.remove('hidden');
        resultBox.classList.add('hidden');

        media.src = state.url;
        setSpeed(state.speed);
        renderPlayer();
    }

    media.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(media.duration) && media.duration > 0) {
            state.duration = media.duration;
        }
        state.hasVideo = media.videoWidth > 0;
        frame.classList.toggle('audio-only', !state.hasVideo);
        $('speed-file-icon').className = `fa-regular ${state.hasVideo ? 'fa-file-video' : 'fa-file-audio'}`;
        try {
            media.playbackRate = state.speed;
        } catch (e) {}
        updateDurations();
        renderPlayer();
    });

    media.addEventListener('error', () => {
        if (!state.file) return;
        mediaError.classList.remove('hidden');
        frame.classList.add('audio-only');
        updateDurations();
        renderPlayer();
    });

    // ----- Player controls & synchronization -----

    function renderPlayer() {
        totalTimeEl.textContent = formatDuration(state.duration || 0);
        currentTimeEl.textContent = formatDuration(media.currentTime || 0);
        playBtn.innerHTML = `<i class="fa-solid ${media.paused ? 'fa-play' : 'fa-pause'}"></i>`;
        playBtn.setAttribute('aria-label', media.paused ? 'Reproducir' : 'Pausar');
    }

    playBtn.addEventListener('click', () => {
        if (media.paused) {
            media.play().catch(() => {});
        } else {
            media.pause();
        }
    });

    media.addEventListener('play', renderPlayer);
    media.addEventListener('pause', renderPlayer);
    media.addEventListener('timeupdate', renderPlayer);
    media.addEventListener('ended', renderPlayer);

    // ----- Presets and slider listeners -----

    if (presetsContainer) {
        presetsContainer.addEventListener('click', event => {
            const btn = event.target.closest('.speed-preset-btn');
            if (btn && btn.dataset.speed) {
                setSpeed(parseFloat(btn.dataset.speed));
            }
        });
    }

    if (slider) {
        slider.addEventListener('input', () => {
            setSpeed(parseFloat(slider.value));
        });
    }

    // Manual speed typing (two decimals, e.g. 1.15)
    if (customInput) {
        customInput.addEventListener('input', () => {
            const raw = customInput.value.replace(',', '.').trim();
            const num = parseFloat(raw);
            if (Number.isFinite(num) && num > 0) {
                state.speed = num;
                try {
                    media.playbackRate = Math.min(16, Math.max(0.0625, num));
                } catch (e) {}

                if (previewValEl) previewValEl.textContent = `${num.toFixed(2)}x`;
                if (slider && num >= 0.25 && num <= 4.0) slider.value = num;

                if (presetsContainer) {
                    presetsContainer.querySelectorAll('.speed-preset-btn').forEach(btn => {
                        const btnSpeed = parseFloat(btn.dataset.speed);
                        btn.classList.toggle('active', Math.abs(btnSpeed - num) < 0.005);
                    });
                }
                updateDurations();
            }
        });

        customInput.addEventListener('blur', () => {
            const raw = customInput.value.replace(',', '.').trim();
            let num = parseFloat(raw);
            if (!Number.isFinite(num) || num < 0.25) num = 0.25;
            if (num > 4.0) num = 4.0;
            setSpeed(num);
        });

        customInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                customInput.blur();
            }
        });
    }

    // ----- Processing & execution -----

    applyBtn.addEventListener('click', async () => {
        if (state.busy || !state.file) return;

        // Catch typed value if blur hasn't fired yet
        if (customInput) {
            const raw = customInput.value.replace(',', '.').trim();
            const typed = parseFloat(raw);
            if (Number.isFinite(typed) && typed >= 0.1 && typed <= 16.0) {
                state.speed = typed;
            }
        }

        media.pause();
        const speedValue = Number(state.speed) || 1.0;
        const params = {
            speed: speedValue.toFixed(2),
            hasVideo: state.hasVideo ? '1' : '0',
            mediaDuration: state.duration ? state.duration.toFixed(3) : '',
            name: state.file.name
        };

        setBusy(true);
        showProgress('Preparando archivo…', null);

        try {
            const jobId = await startJob(params);
            await pollJob(jobId);
        } catch (e) {
            showError(e.message || 'No se pudo cambiar la velocidad del archivo.');
        } finally {
            setBusy(false);
        }
    });

    function setBusy(busy) {
        state.busy = busy;
        applyBtn.disabled = busy;
        applyBtn.innerHTML = busy
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Procesando…'
            : '<i class="fa-solid fa-gauge-high"></i> Cambiar velocidad';
    }

    async function startJob(params) {
        if (androidBridge && androidBridge.startSpeed) {
            const data = JSON.parse(androidBridge.startSpeed(JSON.stringify(params)));
            if (data.error) throw new Error(data.error);
            return data.jobId;
        }

        // Electron desktop app passes local path; browser uploads via multipart/stream
        const localPath = desktopBridge && desktopBridge.getPathForFile ? desktopBridge.getPathForFile(state.file) : '';
        const query = new URLSearchParams(localPath ? { ...params, path: localPath } : params);
        const data = localPath
            ? await (await fetch(`/api/speed?${query}`, { method: 'POST' })).json()
            : await upload(`/api/speed?${query}`, state.file);
        if (data.error) throw new Error(data.error);
        return data.jobId;
    }

    function upload(url, file) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', url);
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            xhr.upload.onprogress = event => {
                if (event.lengthComputable) showProgress('Subiendo el archivo…', (event.loaded / event.total) * 100);
            };
            xhr.onload = () => {
                try {
                    resolve(JSON.parse(xhr.responseText));
                } catch (e) {
                    reject(new Error('Respuesta inesperada del servidor.'));
                }
            };
            xhr.onerror = () => reject(new Error('No se pudo enviar el archivo. ¿Sigue conectado ClipSaver?'));
            xhr.send(file);
        });
    }

    async function pollJob(jobId) {
        let failures = 0;
        for (;;) {
            let snapshot;
            try {
                snapshot = androidBridge
                    ? JSON.parse(androidBridge.getProgress(jobId))
                    : await (await fetch(`/api/progress/${encodeURIComponent(jobId)}`)).json();
                failures = 0;
            } catch (e) {
                if (++failures > 10) throw new Error('Se perdió la conexión con ClipSaver.');
                await sleep(POLL_MS * 2);
                continue;
            }
            if (snapshot.status === 'done') return showSuccess({ ...snapshot.result, jobId });
            if (snapshot.status === 'error' || (snapshot.error && !snapshot.status)) {
                throw new Error(snapshot.error || 'No se pudo cambiar la velocidad.');
            }
            showProgress('Cambiando velocidad…', snapshot.percent);
            await sleep(POLL_MS);
        }
    }

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    // ----- Results -----

    function showProgress(title, percent) {
        const known = percent !== null && percent !== undefined && Number.isFinite(percent);
        let card = resultBox.querySelector('.progress-card');
        if (!card) {
            resultBox.innerHTML = `
                <div class="result-card glass-panel progress-card">
                    <h3></h3>
                    <div class="progress-track"><div class="progress-fill"></div></div>
                    <p class="progress-sub"></p>
                </div>
            `;
            card = resultBox.querySelector('.progress-card');
        }
        card.querySelector('h3').textContent = title;
        card.querySelector('.progress-track').classList.toggle('indeterminate', !known);
        card.querySelector('.progress-fill').style.width = known ? `${percent.toFixed(1)}%` : '';
        card.querySelector('.progress-sub').textContent = known ? `${percent.toFixed(0)}%` : 'Un momento…';
        resultBox.classList.remove('hidden');
    }

    function showSuccess(data) {
        const isAudio = /\.(mp3|m4a|wav|aac|ogg|opus|flac)$/i.test(data.filename || '');
        resultBox.innerHTML = `
            <div class="result-card glass-panel">
                <i class="fa-solid fa-circle-check success-icon"></i>
                <div>
                    <h3>¡Archivo listo!</h3>
                    <p>${escapeHtml(data.message || 'Velocidad modificada con éxito.')}</p>
                </div>
                <div class="file-badge">
                    <i class="fa-regular ${isAudio ? 'fa-file-audio' : 'fa-file-video'}"></i> ${escapeHtml(data.filename || '')}
                </div>
                <div class="action-buttons">
                    ${fileActionsHtml(data)}
                    <button type="button" class="try-again-btn" data-speed-again>Modificar otro archivo</button>
                </div>
            </div>
        `;
        bindFileActions(resultBox, data);
        resultBox.querySelector('[data-speed-again]').addEventListener('click', resetSpeed);
        resultBox.classList.remove('hidden');
        resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function showError(message) {
        resultBox.innerHTML = `
            <div class="result-card glass-panel">
                <i class="fa-solid fa-circle-xmark error-icon"></i>
                <div>
                    <h3>Error</h3>
                    <p>${escapeHtml(message)}</p>
                </div>
            </div>
        `;
        resultBox.classList.remove('hidden');
    }

    function resetSpeed() {
        media.pause();
        media.removeAttribute('src');
        media.load();
        if (state.url) URL.revokeObjectURL(state.url);
        Object.assign(state, { file: null, url: null, duration: null });
        if (fileInput) fileInput.value = '';
        editor.classList.add('hidden');
        resultBox.classList.add('hidden');
        drop.classList.remove('hidden');
        window.scrollTo(0, 0);
    }

    setSpeed(1.5);
});
