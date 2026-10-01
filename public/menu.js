// Top-left menu: switches between the downloader and the tools, and shows the "About" box.
document.addEventListener('DOMContentLoaded', () => {
    const { androidBridge, escapeHtml } = window.ClipSaverUI;
    const RELEASES_API = 'https://api.github.com/repos/cdmarin/downloader/releases/latest';

    const menu = document.getElementById('app-menu');
    const menuBtn = document.getElementById('menu-btn');
    const aboutModal = document.getElementById('about-modal');
    const views = { trimmer: document.getElementById('trimmer-view') };

    function setMenuOpen(open) {
        menu.classList.toggle('open', open);
        menuBtn.setAttribute('aria-expanded', String(open));
    }

    menuBtn.addEventListener('click', event => {
        event.stopPropagation();
        setMenuOpen(!menu.classList.contains('open'));
    });
    document.addEventListener('click', event => {
        if (!menu.contains(event.target)) setMenuOpen(false);
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        setMenuOpen(false);
        aboutModal.classList.add('hidden');
    });

    // Each tool is a "page" in the history, so the phone's back button returns to the downloader
    function showView(name) {
        const current = Object.keys(views).find(key => !views[key].classList.contains('hidden')) || 'home';
        if (current === name) return;
        for (const [key, el] of Object.entries(views)) el.classList.toggle('hidden', key !== name);
        document.body.classList.toggle('tool-open', name !== 'home');
        window.scrollTo(0, 0);
    }

    function openView(name) {
        if (name === 'home') {
            if (history.state && history.state.view) history.back();
            else showView('home');
            return;
        }
        if (history.state && history.state.view) history.replaceState({ view: name }, '');
        else history.pushState({ view: name }, '');
        showView(name);
    }

    window.addEventListener('popstate', event => showView((event.state && event.state.view) || 'home'));

    document.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            setMenuOpen(false);
            const action = btn.dataset.action;
            if (action === 'about') openAbout();
            else openView(action);
        });
    });

    // ----- About -----
    aboutModal.addEventListener('click', event => {
        if (event.target === aboutModal || event.target.closest('[data-close-modal]')) {
            aboutModal.classList.add('hidden');
        }
    });

    async function installedVersion() {
        if (androidBridge) return { version: androidBridge.appVersion(), platform: 'Android' };
        try {
            const info = await (await fetch('/api/info')).json();
            return info.app || {};
        } catch (e) {
            return {};
        }
    }

    // "v1.4" / "1.4.0" -> [1, 4, 0]; null when it is not a version number (e.g. a local build)
    function parseVersion(text) {
        const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(text || '').trim());
        return match ? [1, 2, 3].map(i => Number(match[i] || 0)) : null;
    }

    function isNewer(latest, current) {
        for (let i = 0; i < 3; i++) {
            if (latest[i] !== current[i]) return latest[i] > current[i];
        }
        return false;
    }

    async function openAbout() {
        aboutModal.classList.remove('hidden');
        const versionEl = document.getElementById('about-version');
        const platformEl = document.getElementById('about-platform');
        const updateEl = document.getElementById('about-update');
        updateEl.className = 'about-update';
        updateEl.textContent = 'Buscando actualizaciones…';

        const { version, platform } = await installedVersion();
        versionEl.textContent = version ? `v${String(version).replace(/^v/, '')}` : 'Desconocida';
        const platformName = platform === 'PC' ? 'PC (navegador)' : platform;
        platformEl.textContent = platformName ? `ClipSaver para ${platformName}` : '';

        try {
            const response = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const release = await response.json();
            const latest = parseVersion(release.tag_name);
            const current = parseVersion(version);
            if (latest && current && isNewer(latest, current)) {
                updateEl.classList.add('has-update');
                updateEl.innerHTML = `Hay una versión nueva: <strong>${escapeHtml(release.tag_name)}</strong>
                    <a href="${escapeHtml(release.html_url)}" target="_blank" rel="noopener" class="update-link">Descargar</a>`;
            } else if (latest && current) {
                updateEl.classList.add('up-to-date');
                updateEl.innerHTML = '<i class="fa-solid fa-circle-check"></i> Tienes la última versión';
            } else {
                updateEl.textContent = `Última versión publicada: ${release.tag_name}`;
            }
        } catch (e) {
            updateEl.textContent = 'No se pudo comprobar si hay versiones nuevas (¿sin conexión?).';
        }
    }
});
