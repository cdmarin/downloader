// File Combiner / Merger (menu > "Combinar archivos"):
// Pick 2 or more audio/video files, reorder them, choose output format (video/audio),
// and combine them into a single seamless file with FFmpeg.
document.addEventListener('DOMContentLoaded', () => {
    const { androidBridge, desktopBridge, escapeHtml, fileActionsHtml, bindFileActions } = window.ClipSaverUI;
    const POLL_MS = 500;

    const $ = id => document.getElementById(id);
    const fileInput = $('merge-file');
    const addFileInput = $('merge-add-file');
    const drop = $('merge-drop');
    const editor = $('merge-editor');
    const listEl = $('merge-list');
    const countBadge = $('merge-count-badge');
    const totalDurationEl = $('merge-total-duration');
    const clearBtn = $('merge-clear-btn');
    const applyBtn = $('merge-apply-btn');
    const resultBox = $('merge-result');
    const fmtVideoBtn = $('merge-fmt-video');
    const fmtAudioBtn = $('merge-fmt-audio');

    const state = {
        files: [], // Array of { id, file, name, size, type, hasVideo, duration, url }
        outputType: 'video', // 'video' | 'audio'
        formatTouchedByUser: false,
        busy: false
    };

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

    // ----- Loading Files -----

    fileInput.addEventListener('change', () => {
        if (fileInput.files && fileInput.files.length) {
            addFiles(Array.from(fileInput.files));
        }
    });

    addFileInput.addEventListener('change', () => {
        if (addFileInput.files && addFileInput.files.length) {
            addFiles(Array.from(addFileInput.files));
            addFileInput.value = '';
        }
    });

    // Drag & Drop
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

    clearBtn.addEventListener('click', resetMerger);

    async function addFiles(newFiles) {
        resultBox.classList.add('hidden');
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

        updateFormatRecommendation();
        renderList();
        updateSummary();
    }

    function probeItem(item) {
        const tempMedia = document.createElement(item.hasVideo ? 'video' : 'audio');
        tempMedia.preload = 'metadata';
        tempMedia.src = item.url;
        tempMedia.onloadedmetadata = () => {
            item.duration = tempMedia.duration;
            if (item.hasVideo && tempMedia.videoWidth === 0 && tempMedia.videoHeight === 0) {
                // Audio file misclassified or video without stream
                item.hasVideo = false;
            }
            updateSummary();
            renderList();
        };
        tempMedia.onerror = () => {
            // Cannot probe metadata locally; FFmpeg will still process it
            updateSummary();
        };
    }

    function updateFormatRecommendation() {
        if (state.formatTouchedByUser) return;
        const hasAnyVideo = state.files.some(f => f.hasVideo);
        setOutputType(hasAnyVideo ? 'video' : 'audio', false);
    }

    function setOutputType(type, userClicked = true) {
        state.outputType = type;
        if (userClicked) state.formatTouchedByUser = true;
        fmtVideoBtn.classList.toggle('active', type === 'video');
        fmtAudioBtn.classList.toggle('active', type === 'audio');
    }

    fmtVideoBtn.addEventListener('click', () => setOutputType('video', true));
    fmtAudioBtn.addEventListener('click', () => setOutputType('audio', true));

    // ----- UI Rendering -----

    function updateSummary() {
        const count = state.files.length;
        if (count === 0) {
            editor.classList.add('hidden');
            drop.classList.remove('hidden');
            return;
        }

        drop.classList.add('hidden');
        editor.classList.remove('hidden');

        countBadge.textContent = count === 1 ? '1 archivo' : `${count} archivos`;

        let totalSec = 0;
        let allDurationsKnown = true;
        for (const f of state.files) {
            if (f.duration && Number.isFinite(f.duration)) {
                totalSec += f.duration;
            } else {
                allDurationsKnown = false;
            }
        }

        if (totalSec > 0) {
            totalDurationEl.textContent = formatTime(totalSec) + (allDurationsKnown ? '' : '+');
        } else {
            totalDurationEl.textContent = 'Calculando…';
        }
    }

    function renderList() {
        listEl.innerHTML = '';
        state.files.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = 'merge-item glass-panel';
            card.dataset.id = item.id;

            const iconClass = item.hasVideo ? 'fa-file-video' : 'fa-file-audio';
            const sizeStr = formatSize(item.size);
            const durStr = item.duration ? formatTime(item.duration) : '';
            const metaParts = [sizeStr, durStr].filter(Boolean).join(' • ');

            card.innerHTML = `
                <div class="merge-item-handle" title="Posición en la secuencia">
                    <span class="merge-order-badge">#${index + 1}</span>
                </div>
                <div class="merge-item-icon">
                    <i class="fa-regular ${iconClass}"></i>
                </div>
                <div class="merge-item-info">
                    <span class="merge-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
                    <span class="merge-item-meta">${escapeHtml(metaParts || 'Listo')}</span>
                </div>
                <div class="merge-item-controls">
                    <button type="button" class="merge-ctrl-btn move-up" data-action="up" title="Subir" ${index === 0 ? 'disabled' : ''}>
                        <i class="fa-solid fa-arrow-up"></i>
                    </button>
                    <button type="button" class="merge-ctrl-btn move-down" data-action="down" title="Bajar" ${index === state.files.length - 1 ? 'disabled' : ''}>
                        <i class="fa-solid fa-arrow-down"></i>
                    </button>
                    <button type="button" class="merge-ctrl-btn delete" data-action="delete" title="Eliminar de la lista">
                        <i class="fa-regular fa-trash-can"></i>
                    </button>
                </div>
            `;

            card.querySelector('[data-action="up"]').addEventListener('click', () => moveItem(index, -1));
            card.querySelector('[data-action="down"]').addEventListener('click', () => moveItem(index, 1));
            card.querySelector('[data-action="delete"]').addEventListener('click', () => removeItem(index));

            listEl.appendChild(card);
        });
    }

    function moveItem(index, offset) {
        const target = index + offset;
        if (target < 0 || target >= state.files.length) return;
        const [moved] = state.files.splice(index, 1);
        state.files.splice(target, 0, moved);
        renderList();
    }

    function removeItem(index) {
        const [removed] = state.files.splice(index, 1);
        if (removed && removed.url) URL.revokeObjectURL(removed.url);
        updateSummary();
        renderList();
        updateFormatRecommendation();
    }

    // ----- Merging Process -----

    applyBtn.addEventListener('click', async () => {
        if (state.busy) return;
        if (state.files.length < 2) {
            showError('Debes añadir al menos 2 archivos para poder combinarlos.');
            return;
        }

        setBusy(true);
        showProgress('Iniciando combinación…', null);

        let totalDuration = 0;
        for (const f of state.files) {
            if (f.duration && Number.isFinite(f.duration)) totalDuration += f.duration;
        }

        try {
            const jobId = await startMergeJob(totalDuration);
            await pollJob(jobId);
        } catch (e) {
            showError(e.message || 'No se pudieron combinar los archivos.');
        } finally {
            setBusy(false);
        }
    });

    function setBusy(busy) {
        state.busy = busy;
        applyBtn.disabled = busy;
        applyBtn.innerHTML = busy
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Combinando…'
            : '<i class="fa-solid fa-layer-group"></i> Unir archivos';
    }

    async function startMergeJob(totalDuration) {
        const fileNames = state.files.map(f => f.name);

        // 1. Android Native App
        if (androidBridge && androidBridge.startMerge) {
            const payload = {
                files: fileNames,
                outputType: state.outputType,
                mediaDuration: totalDuration > 0 ? totalDuration.toFixed(3) : ''
            };
            const data = JSON.parse(androidBridge.startMerge(JSON.stringify(payload)));
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
                outputType: state.outputType,
                totalDuration: totalDuration > 0 ? totalDuration.toFixed(3) : null
            };
            const res = await fetch('/api/merge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            return data.jobId;
        }

        // 3. Web Browser (upload files first)
        const uploadedFileIds = [];
        for (let i = 0; i < state.files.length; i++) {
            const item = state.files[i];
            const percentStep = (i / state.files.length) * 100;
            showProgress(`Subiendo archivo ${i + 1} de ${state.files.length}: ${item.name}…`, percentStep);

            const uploadRes = await uploadSingleFile(item.file, (loadedRatio) => {
                const currentPercent = ((i + loadedRatio) / state.files.length) * 100;
                showProgress(`Subiendo archivo ${i + 1} de ${state.files.length} (${Math.round(loadedRatio * 100)}%)…`, currentPercent);
            });
            uploadedFileIds.push(uploadRes.fileId);
        }

        showProgress('Combinando pistas en el servidor…', null);
        const payload = {
            files: uploadedFileIds,
            names: fileNames,
            outputType: state.outputType,
            totalDuration: totalDuration > 0 ? totalDuration.toFixed(3) : null
        };
        const res = await fetch('/api/merge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
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
                throw new Error(snapshot.error || 'No se pudieron combinar los archivos.');
            }
            showProgress('Uniendo archivos…', snapshot.percent);
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
        const isAudio = /\.(mp3|m4a|wav|aac|ogg|opus|flac)$/i.test(data.filename || '');
        resultBox.innerHTML = `
            <div class="result-card glass-panel">
                <i class="fa-solid fa-circle-check success-icon"></i>
                <div>
                    <h3>¡Combinación completada!</h3>
                    <p>${escapeHtml(data.message || 'Archivos unidos con éxito.')}</p>
                </div>
                <div class="file-badge">
                    <i class="fa-regular ${isAudio ? 'fa-file-audio' : 'fa-file-video'}"></i> ${escapeHtml(data.filename || '')}
                </div>
                <div class="action-buttons">
                    ${fileActionsHtml(data)}
                    <button type="button" class="try-again-btn" data-merge-again>Combinar otros archivos</button>
                </div>
            </div>
        `;
        bindFileActions(resultBox, data);
        resultBox.querySelector('[data-merge-again]').addEventListener('click', resetMerger);
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

    function resetMerger() {
        for (const item of state.files) {
            if (item.url) URL.revokeObjectURL(item.url);
        }
        state.files = [];
        state.formatTouchedByUser = false;
        if (fileInput) fileInput.value = '';
        if (addFileInput) addFileInput.value = '';
        editor.classList.add('hidden');
        resultBox.classList.add('hidden');
        drop.classList.remove('hidden');
        window.scrollTo(0, 0);
    }
});
