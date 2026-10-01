// Trimmer (menu > "Recortar audio o vídeo"): pick a local file, choose the start/end on the
// timeline or by typing mm:ss.mmm, and cut it with FFmpeg (server.js /api/trim, or the
// Android bridge). The result is saved next to the downloads.
document.addEventListener('DOMContentLoaded', () => {
    const { androidBridge, desktopBridge, escapeHtml, fileActionsHtml, bindFileActions } = window.ClipSaverUI;
    const MIN_GAP = 0.05; // shortest cut, in seconds
    const POLL_MS = 500;

    const $ = id => document.getElementById(id);
    const fileInput = $('trim-file');
    const drop = $('trim-drop');
    const editor = $('trim-editor');
    const media = $('trim-media');
    const frame = $('media-frame');
    const mediaError = $('media-error');
    const timeline = $('timeline');
    const range = $('timeline-range');
    const playhead = $('timeline-playhead');
    const handles = { start: $('handle-start'), end: $('handle-end') };
    const inputs = { start: $('cut-start'), end: $('cut-end') };
    const playBtn = $('play-btn');
    const cutBtn = $('cut-btn');
    const resultBox = $('trim-result');

    const state = {
        file: null,
        url: null,
        duration: null, // seconds, null while unknown (file the browser cannot preview)
        hasVideo: true,
        start: 0,
        end: null,
        selectionOnly: false, // "Escuchar selección" stops at the end mark
        busy: false
    };

    // ----- Time text: "mm:ss.mmm" (or "h:mm:ss.mmm" for long files) <-> seconds -----

    function formatTime(seconds) {
        if (seconds === null || !Number.isFinite(seconds)) return '';
        const totalMs = Math.round(Math.max(0, seconds) * 1000);
        const ms = totalMs % 1000;
        const totalSec = Math.floor(totalMs / 1000);
        const s = totalSec % 60;
        const m = Math.floor(totalSec / 60) % 60;
        const h = Math.floor(totalSec / 3600);
        const pad = (n, len = 2) => String(n).padStart(len, '0');
        const base = `${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
        return h > 0 || (state.duration || 0) >= 3600 ? `${h}:${base}` : base;
    }

    // Accepts "10", "10.5", "1:05", "01:05,250", "1:02:03.5"
    function parseTime(text) {
        const str = String(text || '').trim().replace(',', '.');
        if (!str) return null;
        const parts = str.split(':');
        if (parts.length > 3 || !parts.every(p => /^\d+(\.\d+)?$/.test(p))) return null;
        return parts.reduce((total, part) => total * 60 + parseFloat(part), 0);
    }

    // ----- Loading a file -----

    fileInput.addEventListener('change', () => {
        if (fileInput.files && fileInput.files[0]) loadFile(fileInput.files[0]);
    });

    // Drag & drop on the PC
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

    $('trim-change-file').addEventListener('click', () => fileInput.click());

    function loadFile(file) {
        media.pause();
        if (state.url) URL.revokeObjectURL(state.url);
        Object.assign(state, {
            file,
            url: URL.createObjectURL(file),
            duration: null,
            hasVideo: !file.type.startsWith('audio/'),
            start: 0,
            end: null,
            selectionOnly: false
        });
        $('trim-file-name').textContent = file.name;
        $('trim-file-icon').className = `fa-regular ${state.hasVideo ? 'fa-file-video' : 'fa-file-audio'}`;
        mediaError.classList.add('hidden');
        frame.classList.toggle('audio-only', !state.hasVideo);
        drop.classList.add('hidden');
        editor.classList.remove('hidden');
        resultBox.classList.add('hidden');
        timeline.classList.add('disabled');
        media.src = state.url;
        render();
    }

    media.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(media.duration) && media.duration > 0) {
            state.duration = media.duration;
            state.end = media.duration;
            timeline.classList.remove('disabled');
        }
        state.hasVideo = media.videoWidth > 0;
        frame.classList.toggle('audio-only', !state.hasVideo);
        $('trim-file-icon').className = `fa-regular ${state.hasVideo ? 'fa-file-video' : 'fa-file-audio'}`;
        render();
    });

    media.addEventListener('error', () => {
        if (!state.file) return;
        // e.g. a format this browser/phone cannot play: cutting still works, without preview
        mediaError.classList.remove('hidden');
        frame.classList.add('audio-only');
        timeline.classList.add('disabled');
        render();
    });

    // ----- Drawing -----

    function render() {
        const d = state.duration;
        $('total-time').textContent = d ? formatTime(d) : '--:--.---';
        $('current-time').textContent = formatTime(media.currentTime || 0) || '00:00.000';
        for (const key of ['start', 'end']) {
            if (document.activeElement !== inputs[key]) inputs[key].value = formatTime(state[key]);
        }
        const length = state.end !== null ? state.end - state.start : null;
        $('cut-length').textContent = length !== null ? formatTime(length) : '—';

        if (d) {
            const pct = t => `${(t / d) * 100}%`;
            handles.start.style.left = pct(state.start);
            handles.end.style.left = pct(state.end);
            range.style.left = pct(state.start);
            range.style.width = pct(state.end - state.start);
            playhead.style.left = pct(Math.min(media.currentTime || 0, d));
            handles.start.setAttribute('aria-valuetext', formatTime(state.start));
            handles.end.setAttribute('aria-valuetext', formatTime(state.end));
        }
        playBtn.innerHTML = `<i class="fa-solid ${media.paused ? 'fa-play' : 'fa-pause'}"></i>`;
        playBtn.setAttribute('aria-label', media.paused ? 'Reproducir' : 'Pausar');
    }

    // Keeps start < end and both inside the file
    function setMark(which, seconds, { seek = true } = {}) {
        const d = state.duration;
        let value = Math.max(0, seconds);
        if (d) value = Math.min(value, d);
        if (which === 'start') {
            if (state.end !== null) value = Math.min(value, state.end - MIN_GAP);
            state.start = Math.max(0, value);
        } else {
            state.end = Math.max(value, state.start + MIN_GAP);
            if (d) state.end = Math.min(state.end, d);
        }
        if (seek && d) seekTo(state[which]);
        render();
    }

    function seekTo(seconds) {
        try {
            media.currentTime = seconds;
        } catch (e) { /* not seekable yet */ }
    }

    // ----- Timeline: drag the nearest handle, or tap elsewhere to move the playhead -----

    let dragging = null;
    let frameRequested = false;

    function timeAt(clientX) {
        const rect = timeline.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        return ratio * state.duration;
    }

    timeline.addEventListener('pointerdown', event => {
        if (!state.duration) return;
        event.preventDefault();
        const rect = timeline.getBoundingClientRect();
        const x = event.clientX;
        const distance = key => Math.abs(rect.left + (state[key] / state.duration) * rect.width - x);
        const grabRadius = event.pointerType === 'touch' ? 28 : 16;
        let nearest = distance('start') <= distance('end') ? 'start' : 'end';
        if (distance('start') <= grabRadius && distance('end') <= grabRadius) {
            // Handles on top of each other: grab the end one when pressing on their right side
            nearest = x > rect.left + (state.start / state.duration) * rect.width ? 'end' : 'start';
        }
        dragging = distance(nearest) <= grabRadius ? nearest : 'playhead';
        timeline.setPointerCapture(event.pointerId);
        timeline.classList.add('dragging');
        if (dragging !== 'playhead') handles[dragging].focus({ preventScroll: true });
        moveDrag(x);
    });

    timeline.addEventListener('pointermove', event => {
        if (!dragging) return;
        const x = event.clientX;
        if (frameRequested) return;
        frameRequested = true;
        requestAnimationFrame(() => {
            frameRequested = false;
            moveDrag(x);
        });
    });

    function endDrag() {
        dragging = null;
        timeline.classList.remove('dragging');
    }
    timeline.addEventListener('pointerup', endDrag);
    timeline.addEventListener('pointercancel', endDrag);

    function moveDrag(clientX) {
        const t = timeAt(clientX);
        if (dragging === 'playhead') {
            seekTo(t);
            render();
        } else if (dragging) {
            setMark(dragging, t);
        }
    }

    // Keyboard: arrows move 0.1 s (Shift: 1 s)
    for (const key of ['start', 'end']) {
        handles[key].addEventListener('keydown', event => {
            const step = event.shiftKey ? 1 : 0.1;
            const moves = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step };
            if (event.key in moves) setMark(key, state[key] + moves[event.key]);
            else if (event.key === 'Home') setMark(key, 0);
            else if (event.key === 'End') setMark(key, state.duration || state[key]);
            else return;
            event.preventDefault();
        });
    }

    // ----- Typing the times -----

    for (const key of ['start', 'end']) {
        const input = inputs[key];
        const commit = () => {
            const value = parseTime(input.value);
            if (value === null) {
                if (input.value.trim() !== '' || key === 'start') {
                    input.classList.add('invalid');
                    setTimeout(() => input.classList.remove('invalid'), 600);
                }
                render();
                return;
            }
            setMark(key, value);
        };
        input.addEventListener('change', commit);
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                commit();
                input.blur();
            }
        });
        input.addEventListener('blur', render);
    }

    document.querySelectorAll('.nudge-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.target;
            const base = state[key] ?? (key === 'end' ? state.duration || 0 : 0);
            setMark(key, base + Number(btn.dataset.step));
        });
    });

    document.querySelectorAll('.set-here-btn').forEach(btn => {
        btn.addEventListener('click', () => setMark(btn.dataset.target, media.currentTime || 0, { seek: false }));
    });

    // ----- Playback -----

    playBtn.addEventListener('click', () => {
        if (!state.duration) return;
        state.selectionOnly = false;
        if (media.paused) media.play().catch(() => {});
        else media.pause();
    });

    $('play-selection-btn').addEventListener('click', () => {
        if (!state.duration) return;
        state.selectionOnly = true;
        seekTo(state.start);
        media.play().catch(() => {});
    });

    function tick() {
        if (state.selectionOnly && state.end !== null && media.currentTime >= state.end) {
            media.pause();
            state.selectionOnly = false;
            seekTo(state.end);
        }
        render();
        if (!media.paused) requestAnimationFrame(tick);
    }
    media.addEventListener('play', () => requestAnimationFrame(tick));
    ['pause', 'seeked', 'timeupdate'].forEach(type => media.addEventListener(type, render));

    // ----- Mode -----

    const fastMode = $('fast-mode');
    fastMode.addEventListener('change', () => $('mode-hint').classList.toggle('hidden', !fastMode.checked));

    // ----- Cutting -----

    cutBtn.addEventListener('click', async () => {
        if (state.busy || !state.file) return;
        // Pick up a time typed but not confirmed yet
        for (const key of ['start', 'end']) {
            const typed = parseTime(inputs[key].value);
            if (typed !== null && Math.abs(typed - (state[key] ?? -1)) > 0.0005) setMark(key, typed, { seek: false });
        }
        if (state.end !== null && state.end - state.start < MIN_GAP) {
            showError('El final debe ser posterior al inicio.');
            return;
        }
        if (state.end === null && !state.duration) {
            showError('Escribe el tiempo final del recorte.');
            return;
        }

        media.pause();
        const params = {
            start: state.start.toFixed(3),
            // Cutting up to the very end: let FFmpeg read to the end of the file
            end: state.end !== null && !(state.duration && state.duration - state.end < 0.0005) ? state.end.toFixed(3) : '',
            mode: fastMode.checked ? 'fast' : 'exact',
            hasVideo: state.hasVideo ? '1' : '0',
            mediaDuration: state.duration ? state.duration.toFixed(3) : '',
            name: state.file.name
        };

        setBusy(true);
        showProgress('Preparando…', null);
        try {
            const jobId = await startJob(params);
            await pollJob(jobId);
        } catch (e) {
            showError(e.message || 'No se pudo recortar el archivo.');
        } finally {
            setBusy(false);
        }
    });

    function setBusy(busy) {
        state.busy = busy;
        cutBtn.disabled = busy;
        cutBtn.innerHTML = busy
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Recortando…'
            : '<i class="fa-solid fa-scissors"></i> Recortar';
    }

    async function startJob(params) {
        if (androidBridge) {
            const data = JSON.parse(androidBridge.startTrim(JSON.stringify(params)));
            if (data.error) throw new Error(data.error);
            return data.jobId;
        }

        // The Windows app reads the file where it is; the browser uploads it to the PC
        const localPath = desktopBridge && desktopBridge.getPathForFile ? desktopBridge.getPathForFile(state.file) : '';
        const query = new URLSearchParams(localPath ? { ...params, path: localPath } : params);
        const data = localPath
            ? await (await fetch(`/api/trim?${query}`, { method: 'POST' })).json()
            : await upload(`/api/trim?${query}`, state.file);
        if (data.error) throw new Error(data.error);
        return data.jobId;
    }

    function upload(url, file) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', url);
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            xhr.upload.onprogress = event => {
                if (event.lengthComputable) showProgress('Enviando el archivo…', (event.loaded / event.total) * 100);
            };
            xhr.onload = () => {
                try {
                    resolve(JSON.parse(xhr.responseText));
                } catch (e) {
                    reject(new Error('Respuesta inesperada del servidor.'));
                }
            };
            xhr.onerror = () => reject(new Error('No se pudo enviar el archivo. ¿Sigue abierto ClipSaver en el PC?'));
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
                throw new Error(snapshot.error || 'No se pudo recortar el archivo.');
            }
            showProgress('Recortando…', snapshot.percent);
            await sleep(POLL_MS);
        }
    }

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    // ----- Result area -----

    // Updates the card in place: re-inserting it every poll would replay its entrance animation
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
                    <h3>¡Recorte listo!</h3>
                    <p>${escapeHtml(data.message || 'Archivo recortado.')}</p>
                </div>
                <div class="file-badge">
                    <i class="fa-regular ${isAudio ? 'fa-file-audio' : 'fa-file-video'}"></i> ${escapeHtml(data.filename || '')}
                </div>
                <div class="action-buttons">
                    ${fileActionsHtml(data)}
                    <button type="button" class="try-again-btn" data-trim-again>Recortar otro archivo</button>
                </div>
            </div>
        `;
        bindFileActions(resultBox, data);
        resultBox.querySelector('[data-trim-again]').addEventListener('click', resetTrimmer);
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

    function resetTrimmer() {
        media.pause();
        media.removeAttribute('src');
        media.load();
        if (state.url) URL.revokeObjectURL(state.url);
        Object.assign(state, { file: null, url: null, duration: null, start: 0, end: null });
        fileInput.value = '';
        editor.classList.add('hidden');
        resultBox.classList.add('hidden');
        drop.classList.remove('hidden');
        window.scrollTo(0, 0);
    }

    render();
});
