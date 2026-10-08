// Volume Changer (menu > "Ajustar volumen"): pick a local file, choose volume level,
// preview in real time (with Web Audio gain boost), and process with FFmpeg (server.js /api/volume, or Android bridge).
document.addEventListener('DOMContentLoaded', () => {
    const { androidBridge, desktopBridge, escapeHtml, fileActionsHtml, bindFileActions } = window.ClipSaverUI;
    const POLL_MS = 500;

    const $ = id => document.getElementById(id);
    const fileInput = $('volume-file');
    const drop = $('volume-drop');
    const editor = $('volume-editor');
    const media = $('volume-media');
    const frame = $('volume-media-frame');
    const mediaError = $('volume-media-error');
    const playBtn = $('volume-play-btn');
    const currentTimeEl = $('volume-current-time');
    const totalTimeEl = $('volume-total-time');
    const previewValEl = $('volume-preview-val');
    const presetsContainer = $('volume-presets');
    const slider = $('volume-slider');
    const customInput = $('volume-custom-input');
    const effectLabel = $('volume-effect-label');
    const dbLabel = $('volume-db-label');
    const applyBtn = $('volume-apply-btn');
    const resultBox = $('volume-result');

    const state = {
        file: null,
        url: null,
        duration: null,
        hasVideo: true,
        volume: 150,
        busy: false
    };

    let audioCtx = null;
    let gainNode = null;
    let mediaSourceNode = null;

    function initAudioNodes() {
        if (gainNode) return;
        try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) {
                audioCtx = new AudioContextClass();
                mediaSourceNode = audioCtx.createMediaElementSource(media);
                gainNode = audioCtx.createGain();
                mediaSourceNode.connect(gainNode);
                gainNode.connect(audioCtx.destination);
            }
        } catch (e) {
            // Already connected or browser restrictions
        }
    }

    function applyPreviewVolume(volPercent) {
        const factor = volPercent / 100;
        initAudioNodes();
        if (gainNode && audioCtx) {
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => {});
            }
            try {
                gainNode.gain.setValueAtTime(factor, audioCtx.currentTime);
            } catch (e) {}
        } else {
            media.volume = Math.max(0, Math.min(1.0, factor));
        }
    }

    function formatTime(seconds) {
        if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return '00:00';
        const totalMs = Math.round(seconds * 1000);
        const totalSec = Math.floor(totalMs / 1000);
        const s = totalSec % 60;
        const m = Math.floor(totalSec / 60) % 60;
        const h = Math.floor(totalSec / 3600);
        const pad = (n, len = 2) => String(n).padStart(len, '0');
        const base = `${pad(m)}:${pad(s)}`;
        return h > 0 ? `${h}:${base}` : base;
    }

    function calculateDb(volPercent) {
        if (volPercent <= 0) return '-∞ dB (Silencio)';
        const factor = volPercent / 100;
        const db = 20 * Math.log10(factor);
        if (Math.abs(db) < 0.05) return '0.0 dB (Original)';
        const sign = db > 0 ? '+' : '';
        return `${sign}${db.toFixed(1)} dB`;
    }

    function updateVolumeInfo(volPercent) {
        if (dbLabel) dbLabel.textContent = calculateDb(volPercent);
        if (effectLabel) {
            if (volPercent === 100) {
                effectLabel.textContent = 'Original (100%)';
            } else if (volPercent > 100) {
                effectLabel.textContent = `Aumento (+${volPercent - 100}%)`;
            } else if (volPercent === 0) {
                effectLabel.textContent = 'Silenciado (0%)';
            } else {
                effectLabel.textContent = `Reducción (-${100 - volPercent}%)`;
            }
        }
    }

    function setVolume(volVal, fromInput = false) {
        const val = Math.max(0, Math.min(1000, Math.round(Number(volVal) || 100)));
        state.volume = val;

        applyPreviewVolume(val);

        if (customInput && !fromInput && document.activeElement !== customInput) {
            customInput.value = val;
        }

        if (previewValEl) previewValEl.textContent = `${val}%`;

        if (slider && Math.abs(parseInt(slider.value, 10) - val) > 0) {
            if (val <= 400) slider.value = val;
        }

        if (presetsContainer) {
            presetsContainer.querySelectorAll('.speed-preset-btn').forEach(btn => {
                const btnVol = parseInt(btn.dataset.vol, 10);
                btn.classList.toggle('active', btnVol === val);
            });
        }

        updateVolumeInfo(val);
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

    const changeFileBtn = $('volume-change-file');
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

        $('volume-file-name').textContent = file.name;
        $('volume-file-icon').className = `fa-regular ${state.hasVideo ? 'fa-file-video' : 'fa-file-audio'}`;
        mediaError.classList.add('hidden');
        frame.classList.toggle('audio-only', !state.hasVideo);
        drop.classList.add('hidden');
        editor.classList.remove('hidden');
        resultBox.classList.add('hidden');

        media.src = state.url;
        setVolume(state.volume);
        renderPlayer();
    }

    media.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(media.duration) && media.duration > 0) {
            state.duration = media.duration;
        }
        state.hasVideo = media.videoWidth > 0;
        frame.classList.toggle('audio-only', !state.hasVideo);
        $('volume-file-icon').className = `fa-regular ${state.hasVideo ? 'fa-file-video' : 'fa-file-audio'}`;
        applyPreviewVolume(state.volume);
        renderPlayer();
    });

    media.addEventListener('error', () => {
        if (!state.file) return;
        mediaError.classList.remove('hidden');
        frame.classList.add('audio-only');
        renderPlayer();
    });

    // ----- Player controls -----

    function renderPlayer() {
        totalTimeEl.textContent = formatTime(state.duration || 0);
        currentTimeEl.textContent = formatTime(media.currentTime || 0);
        playBtn.innerHTML = `<i class="fa-solid ${media.paused ? 'fa-play' : 'fa-pause'}"></i>`;
        playBtn.setAttribute('aria-label', media.paused ? 'Reproducir' : 'Pausar');
    }

    playBtn.addEventListener('click', () => {
        initAudioNodes();
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
        }
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

    // ----- Presets and input listeners -----

    if (presetsContainer) {
        presetsContainer.addEventListener('click', event => {
            const btn = event.target.closest('.speed-preset-btn');
            if (btn && btn.dataset.vol) {
                setVolume(parseInt(btn.dataset.vol, 10));
            }
        });
    }

    if (slider) {
        slider.addEventListener('input', () => {
            setVolume(parseInt(slider.value, 10));
        });
    }

    if (customInput) {
        customInput.addEventListener('input', () => {
            const raw = customInput.value.trim();
            const num = parseInt(raw, 10);
            if (Number.isFinite(num) && num >= 0) {
                state.volume = num;
                applyPreviewVolume(num);
                if (previewValEl) previewValEl.textContent = `${num}%`;
                if (slider && num <= 400) slider.value = num;
                if (presetsContainer) {
                    presetsContainer.querySelectorAll('.speed-preset-btn').forEach(btn => {
                        const btnVol = parseInt(btn.dataset.vol, 10);
                        btn.classList.toggle('active', btnVol === num);
                    });
                }
                updateVolumeInfo(num);
            }
        });

        customInput.addEventListener('blur', () => {
            const raw = customInput.value.trim();
            let num = parseInt(raw, 10);
            if (!Number.isFinite(num) || num < 0) num = 100;
            if (num > 1000) num = 1000;
            setVolume(num);
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

        if (customInput) {
            const raw = customInput.value.trim();
            const typed = parseInt(raw, 10);
            if (Number.isFinite(typed) && typed >= 0 && typed <= 1000) {
                state.volume = typed;
            }
        }

        media.pause();
        const volValue = Math.max(0, Math.min(1000, state.volume));
        const params = {
            volume: String(volValue),
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
            showError(e.message || 'No se pudo ajustar el volumen del archivo.');
        } finally {
            setBusy(false);
        }
    });

    function setBusy(busy) {
        state.busy = busy;
        applyBtn.disabled = busy;
        applyBtn.innerHTML = busy
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Procesando…'
            : '<i class="fa-solid fa-volume-high"></i> Ajustar volumen';
    }

    async function startJob(params) {
        if (androidBridge && androidBridge.startVolume) {
            const data = JSON.parse(androidBridge.startVolume(JSON.stringify(params)));
            if (data.error) throw new Error(data.error);
            return data.jobId;
        }

        const localPath = desktopBridge && desktopBridge.getPathForFile ? desktopBridge.getPathForFile(state.file) : '';
        const query = new URLSearchParams(localPath ? { ...params, path: localPath } : params);
        const data = localPath
            ? await (await fetch(`/api/volume?${query}`, { method: 'POST' })).json()
            : await upload(`/api/volume?${query}`, state.file);
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
                throw new Error(snapshot.error || 'No se pudo ajustar el volumen.');
            }
            showProgress('Ajustando volumen…', snapshot.percent);
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
                    <p>${escapeHtml(data.message || 'Volumen ajustado con éxito.')}</p>
                </div>
                <div class="file-badge">
                    <i class="fa-regular ${isAudio ? 'fa-file-audio' : 'fa-file-video'}"></i> ${escapeHtml(data.filename || '')}
                </div>
                <div class="action-buttons">
                    ${fileActionsHtml(data)}
                    <button type="button" class="try-again-btn" data-volume-again>Ajustar otro archivo</button>
                </div>
            </div>
        `;
        bindFileActions(resultBox, data);
        resultBox.querySelector('[data-volume-again]').addEventListener('click', resetVolume);
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

    function resetVolume() {
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

    setVolume(150);
});
