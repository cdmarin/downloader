// Top-left menu: switches between the downloader and the tools, and shows the "About" box.
document.addEventListener('DOMContentLoaded', () => {
    const { androidBridge, escapeHtml } = window.ClipSaverUI;

    const menu = document.getElementById('app-menu');
    const menuBtn = document.getElementById('menu-btn');
    const aboutModal = document.getElementById('about-modal');
    const views = {
        trimmer: document.getElementById('trimmer-view'),
        speed: document.getElementById('speed-view'),
        volume: document.getElementById('volume-view'),
        merge: document.getElementById('merge-view')
    };

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

    async function openAbout() {
        const { installedVersion, latestRelease, isNewer, downloadFor } = window.ClipSaverUpdates;
        aboutModal.classList.remove('hidden');
        const versionEl = document.getElementById('about-version');
        const platformEl = document.getElementById('about-platform');
        const updateEl = document.getElementById('about-update');
        updateEl.className = 'about-update';
        updateEl.textContent = 'Buscando actualizaciones…';

        const installed = await installedVersion();
        const { version, platform } = installed;
        versionEl.textContent = version ? `v${String(version).replace(/^v/, '')}` : 'Desconocida';
        const platformName = platform === 'PC' ? 'PC (navegador)' : platform;
        platformEl.textContent = platformName ? `ClipSaver para ${platformName}` : '';

        try {
            const release = await latestRelease({ fresh: true });
            if (isNewer(release.tag, version)) {
                const download = downloadFor(release, installed);
                updateEl.classList.add('has-update');
                updateEl.innerHTML = `Hay una versión nueva: <strong>${escapeHtml(release.tag)}</strong>
                    <a href="${escapeHtml(download.url)}" target="_blank" rel="noopener" class="update-link">${download.isFile ? 'Descargar' : 'Ver novedades'}</a>`;
            } else if (/^v?\d+(\.\d+)*$/.test(String(version || '').trim())) {
                updateEl.classList.add('up-to-date');
                updateEl.innerHTML = '<i class="fa-solid fa-circle-check"></i> Tienes la última versión';
            } else {
                updateEl.textContent = `Última versión publicada: ${release.tag}`;
            }
        } catch (e) {
            updateEl.textContent = 'No se pudo comprobar si hay versiones nuevas (¿sin conexión?).';
        }
    }
});
