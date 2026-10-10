// Speed Changer (menu > "Cambiar velocidad"): pick one or multiple local files,
// choose playback speed (with manual decimal typing, presets, and slider),
// preview in real time, and batch process with FFmpeg (server.js /api/speed, or Android bridge).
document.addEventListener('DOMContentLoaded', () => {
    const { androidBridge, desktopBridge, escapeHtml, fileActionsHtml, bindFileActions } = window.ClipSaverUI;
    const POLL_MS = 500;

    const $ = id => document.getElementById(id);
    const fileInput = $('speed-file');
    const addFileInput = $('speed-add-file');
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

    const countBadge = $('speed-count-badge');
    const activeNameEl = $('speed-file-name');
    const clearBtn = $('speed-clear-btn');
    const filesListEl = $('speed-files-list');

    const state = {
        files: [], // Array of { id, file, name, size, type, hasVideo, duration, url }
        activeIndex: 0,
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

    function formatSize(bytes) {
        if (!bytes || bytes <= 0) return '';
        const units = ['B', 'KB', 'MB', 'GB'];
        let idx = 0;
        let sz = bytes;
        while (sz >= 1024 && idx < units.length - 1) {
            sz /= 1024;
            idx++;
        }
        return `${sz.toFixed(1)} ${units[idx]}`;
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
        const activeItem = state.files[state.activeIndex];
        if (activeItem && activeItem.duration && activeItem.duration > 0) {
            origDurationEl.textContent = formatDuration(activeItem.duration);
            const estSeconds = activeItem.duration / state.speed;
            newDurationEl.textContent = formatDuration(estSeconds);
        } else {
            origDurationEl.textContent = '—';
            newDurationEl.textContent = '—';
        }
    }

    // ----- Loading files -----

    if (fileInput) {
        fileInput.addEventListener('change', () => {
            if (fileInput.files && fileInput.files.length) {
                addFiles(Array.from(fileInput.files));
            }
        });
    }

    if (addFileInput) {
        addFileInput.addEventListener('change', () => {
            if (addFileInput.files && addFileInput.files.length) {
                addFiles(Array.from(addFileInput.files));
                addFileInput.value = '';
            }
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', resetSpeed);
    }

    if (drop) {
        ['dragenter', 'dragover'].forEach(type => drop.addEventListener(type, event => {
            event.preventDefault();
            drop.classList.add('dragging');
        }));
        ['dragleave', 'drop'].forEach(type => drop.addEventListener(type, () => drop.classList.remove('dragging')));
        drop.addEventListener('drop', event => {
            event.preventDefault();
            const droppedFiles = event.dataTransfer.files;
            if (droppedFiles && droppedFiles.length) {
                addFiles(Array.from(droppedFiles));
            }
        });
    }

    function addFiles(newFiles) {
        resultBox.classList.add('hidden');
        const startEmpty = state.files.length === 0;

        for (const file of newFiles) {
            const isAudio = file.type.startsWith('audio/');
            const item = {
                id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                file,
                name: file.name,
                size: file.size,
                type: file.type,
                hasVideo: !isAudio,
                duration: null,
                url: URL.createObjectURL(file)
            };
            state.files.push(item);
            probeItem(item);
        }

        if (startEmpty && state.files.length > 0) {
            state.activeIndex = 0;
            loadActiveMedia();
        }

        updateUI();
    }

    function probeItem(item) {
        const tempMedia = document.createElement(item.hasVideo ? 'video' : 'audio');
        tempMedia.preload = 'metadata';
        tempMedia.src = item.url;
        tempMedia.onloadedmetadata = () => {
            item.duration = tempMedia.duration;
            if (item.hasVideo && tempMedia.videoWidth === 0 && tempMedia.videoHeight === 0) {
                item.hasVideo = false;
            }
            updateDurations();
            renderFilesList();
        };
    }

    function setActiveFile(index) {
        if (index < 0 || index >= state.files.length) return;
        state.activeIndex = index;
        loadActiveMedia();
        updateUI();
    }

    function loadActiveMedia() {
        const item = state.files[state.activeIndex];
        if (!item) return;

        media.pause();
        mediaError.classList.add('hidden');
        frame.classList.toggle('audio-only', !item.hasVideo);

        media.src = item.url;
        setSpeed(state.speed);
        renderPlayer();
    }

    function removeFile(index) {
        const [removed] = state.files.splice(index, 1);
        if (removed && removed.url) URL.revokeObjectURL(removed.url);

        if (state.files.length === 0) {
            resetSpeed();
            return;
        }

        if (state.activeIndex >= state.files.length) {
            state.activeIndex = state.files.length - 1;
            loadActiveMedia();
        } else if (state.activeIndex === index) {
            loadActiveMedia();
        }

        updateUI();
    }

    function updateUI() {
        const count = state.files.length;
        if (count === 0) {
            editor.classList.add('hidden');
            drop.classList.remove('hidden');
            return;
        }

        drop.classList.add('hidden');
        editor.classList.remove('hidden');

        // Update count badge & active name
        if (countBadge) {
            countBadge.textContent = count === 1 ? '1 archivo' : `${count} archivos`;
        }

        const activeItem = state.files[state.activeIndex];
        if (activeNameEl && activeItem) {
            activeNameEl.textContent = activeItem.name;
        }

        // Apply button text
        if (applyBtn) {
            applyBtn.innerHTML = count > 1
                ? `<i class="fa-solid fa-gauge-high"></i> Cambiar velocidad a los ${count} archivos`
                : '<i class="fa-solid fa-gauge-high"></i> Cambiar velocidad';
        }

        // Show files list if more than 1 file
        if (filesListEl) {
            filesListEl.classList.toggle('hidden', count <= 1);
            renderFilesList();
        }

        updateDurations();
    }

    function renderFilesList() {
        if (!filesListEl) return;
        filesListEl.innerHTML = '';

        state.files.forEach((item, index) => {
            const row = document.createElement('div');
            const isActive = index === state.activeIndex;
            row.className = `speed-file-item ${isActive ? 'active' : ''}`;

            const iconClass = item.hasVideo ? 'fa-file-video' : 'fa-file-audio';
            const sizeStr = formatSize(item.size);
            const durStr = item.duration ? formatDuration(item.duration) : '';
            const metaParts = [sizeStr, durStr].filter(Boolean).join(' • ');

            row.innerHTML = `
                <div class="speed-file-item-icon">
                    <i class="fa-regular ${iconClass}"></i>
                </div>
                <div class="speed-file-item-info">
                    <span class="speed-file-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
                    <span class="speed-file-item-meta">${escapeHtml(metaParts || 'Cargando…')}</span>
                </div>
                <div class="speed-file-item-actions">
                    <button type="button" class="speed-file-remove-btn" data-action="delete" title="Eliminar este archivo">
                        <i class="fa-regular fa-trash-can"></i>
                    </button>
                </div>
            `;

            row.addEventListener('click', (e) => {
                if (e.target.closest('[data-action="delete"]')) return;
                setActiveFile(index);
            });

            row.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
                e.stopPropagation();
                removeFile(index);
            });

            filesListEl.appendChild(row);
        });
    }

    // Media listeners for active file
    media.addEventListener('loadedmetadata', () => {
        const activeItem = state.files[state.activeIndex];
        if (activeItem) {
            if (Number.isFinite(media.duration) && media.duration > 0) {
                activeItem.duration = media.duration;
            }
            activeItem.hasVideo = media.videoWidth > 0;
            frame.classList.toggle('audio-only', !activeItem.hasVideo);
        }
        try {
            media.playbackRate = state.speed;
        } catch (e) {}
        updateDurations();
        renderPlayer();
        renderFilesList();
    });

    media.addEventListener('error', () => {
        mediaError.classList.remove('hidden');
        frame.classList.add('audio-only');
        updateDurations();
        renderPlayer();
    });

    // ----- Player controls & synchronization -----

    function renderPlayer() {
        const activeItem = state.files[state.activeIndex];
        const dur = (activeItem && activeItem.duration) || media.duration || 0;
        totalTimeEl.textContent = formatDuration(dur);
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
        if (state.busy || state.files.length === 0) return;

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
        setBusy(true);
        showProgress('Preparando archivos…', null);

        try {
            const jobId = await startSpeedJob(speedValue);
            await pollJob(jobId);
        } catch (e) {
            showError(e.message || 'No se pudo cambiar la velocidad de los archivos.');
        } finally {
            setBusy(false);
        }
    });

    function setBusy(busy) {
        state.busy = busy;
        applyBtn.disabled = busy;
        const count = state.files.length;
        applyBtn.innerHTML = busy
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Procesando…'
            : (count > 1
                ? `<i class="fa-solid fa-gauge-high"></i> Cambiar velocidad a los ${count} archivos`
                : '<i class="fa-solid fa-gauge-high"></i> Cambiar velocidad');
    }

    async function startSpeedJob(speedValue) {
        const count = state.files.length;
        const fileNames = state.files.map(f => f.name);

        // 1. Android Native App
        if (androidBridge && androidBridge.startSpeed) {
            const activeItem = state.files[state.activeIndex];
            const payload = {
                files: fileNames,
                speed: speedValue.toFixed(2),
                hasVideo: activeItem && activeItem.hasVideo ? '1' : '0',
                mediaDuration: activeItem && activeItem.duration ? activeItem.duration.toFixed(3) : '',
                name: activeItem ? activeItem.name : ''
            };
            const data = JSON.parse(androidBridge.startSpeed(JSON.stringify(payload)));
            if (data.error) throw new Error(data.error);
            return data.jobId;
        }

        // 2. Desktop Electron App
        const isDesktop = desktopBridge && desktopBridge.getPathForFile;
        if (isDesktop) {
            const localPaths = state.files.map(f => desktopBridge.getPathForFile(f.file));
            const payload = {
                paths: localPaths,
                names: fileNames,
                speed: speedValue
            };
            const res = await fetch('/api/speed', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            return data.jobId;
        }

        // 3. Web Browser: upload files first if multiple or batch
        if (count > 1) {
            const uploadedFileIds = [];
            for (let i = 0; i < count; i++) {
                const item = state.files[i];
                const percentStep = (i / count) * 100;
                showProgress(`Subiendo archivo ${i + 1} de ${count}: ${item.name}…`, percentStep);

                const uploadRes = await uploadSingleFile(item.file, (ratio) => {
                    const currentPercent = ((i + ratio) / count) * 100;
                    showProgress(`Subiendo archivo ${i + 1} de ${count} (${Math.round(ratio * 100)}%)…`, currentPercent);
                });
                uploadedFileIds.push(uploadRes.fileId);
            }

            showProgress('Modificando velocidad en el servidor…', null);
            const payload = {
                files: uploadedFileIds,
                names: fileNames,
                speed: speedValue
            };
            const res = await fetch('/api/speed', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            return data.jobId;
        }

        // Single file in browser
        const singleItem = state.files[0];
        const params = {
            speed: speedValue.toFixed(2),
            hasVideo: singleItem.hasVideo ? '1' : '0',
            mediaDuration: singleItem.duration ? singleItem.duration.toFixed(3) : '',
            name: singleItem.name
        };
        const query = new URLSearchParams(params);
        const data = await uploadSingleFileToUrl(`/api/speed?${query}`, singleItem.file);
        if (data.error) throw new Error(data.error);
        return data.jobId;
    }

    function uploadSingleFile(file, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const url = `/api/upload?name=${encodeURIComponent(file.name)}`;
            xhr.open('POST', url);
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            xhr.upload.onprogress = event => {
                if (event.lengthComputable && onProgress) {
                    onProgress(event.loaded / event.total);
                }
            };
            xhr.onload = () => {
                try {
                    const json = JSON.parse(xhr.responseText);
                    if (json.error) reject(new Error(json.error));
                    else resolve(json);
                } catch (e) {
                    reject(new Error('Respuesta inesperada al subir el archivo.'));
                }
            };
            xhr.onerror = () => reject(new Error('No se pudo enviar el archivo al servidor.'));
            xhr.send(file);
        });
    }

    function uploadSingleFileToUrl(url, file) {
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
            xhr.onerror = () => reject(new Error('No se pudo enviar el archivo.'));
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
        card.querySelector('.progress-sub').textContent = known ? `${percent.toFixed(0)}%` : 'Procesando…';
        resultBox.classList.remove('hidden');
    }

    function showSuccess(data) {
        const isBatch = Array.isArray(data.files) && data.files.length > 1;

        if (isBatch) {
            let itemsHtml = '';
            for (const item of data.files) {
                const isAudio = /\.(mp3|m4a|wav|aac|ogg|opus|flac)$/i.test(item.filename || '');
                itemsHtml += `
                    <div class="speed-batch-result-item">
                        <span class="speed-batch-result-name">
                            <i class="fa-regular ${isAudio ? 'fa-file-audio' : 'fa-file-video'}"></i> ${escapeHtml(item.filename)}
                        </span>
                        <div class="speed-batch-result-btns">
                            <a href="${item.downloadUrl}" download class="link-btn" title="Descargar"><i class="fa-solid fa-download"></i> Descargar</a>
                        </div>
                    </div>
                `;
            }

            resultBox.innerHTML = `
                <div class="result-card glass-panel">
                    <i class="fa-solid fa-circle-check success-icon"></i>
                    <div>
                        <h3>¡Lote completado!</h3>
                        <p>${escapeHtml(data.message || `${data.files.length} archivos modificados con éxito.`)}</p>
                    </div>
                    <div class="speed-batch-result-list">
                        ${itemsHtml}
                    </div>
                    <div class="action-buttons">
                        <button type="button" class="try-again-btn" data-speed-again>Modificar otros archivos</button>
                    </div>
                </div>
            `;
        } else {
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
                        <button type="button" class="try-again-btn" data-speed-again>Modificar otros archivos</button>
                    </div>
                </div>
            `;
            bindFileActions(resultBox, data);
        }

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
        for (const f of state.files) {
            if (f.url) URL.revokeObjectURL(f.url);
        }
        state.files = [];
        state.activeIndex = 0;
        if (fileInput) fileInput.value = '';
        if (addFileInput) addFileInput.value = '';
        editor.classList.add('hidden');
        resultBox.classList.add('hidden');
        drop.classList.remove('hidden');
        window.scrollTo(0, 0);
    }

    setSpeed(1.5);
});
