// New version notice: on startup, compares the installed version with the latest GitHub release
// and shows a banner with a direct download for this platform. Also used by "Acerca de" (menu.js).
document.addEventListener('DOMContentLoaded', () => {
    const { androidBridge } = window.ClipSaverUI;
    const RELEASES_API = 'https://api.github.com/repos/cdmarin/downloader/releases/latest';
    const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const CACHE_KEY = 'clipsaver.latestRelease';
    const DISMISSED_KEY = 'clipsaver.dismissedVersion';

    // localStorage can be unavailable (private mode, blocked storage): then just skip the cache
    const storage = {
        get(key) {
            try {
                return JSON.parse(localStorage.getItem(key));
            } catch (e) {
                return null;
            }
        },
        set(key, value) {
            try {
                localStorage.setItem(key, JSON.stringify(value));
            } catch (e) { /* not saved */ }
        }
    };

    // { version, platform, variant } of this install
    let installedPromise = null;
    function installedVersion() {
        if (!installedPromise) {
            installedPromise = (async () => {
                if (androidBridge) {
                    return {
                        version: androidBridge.appVersion(),
                        platform: 'Android',
                        abi: typeof androidBridge.cpuAbi === 'function' ? androidBridge.cpuAbi() : ''
                    };
                }
                try {
                    const info = await (await fetch('/api/info')).json();
                    return info.app || {};
                } catch (e) {
                    return {};
                }
            })();
        }
        return installedPromise;
    }

    // Latest release from GitHub; asked at most once a day unless `fresh` is requested
    async function latestRelease({ fresh = false } = {}) {
        const cached = storage.get(CACHE_KEY);
        if (!fresh && cached && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) return cached.release;
        const response = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const release = {
            tag: data.tag_name,
            url: data.html_url,
            assets: (data.assets || []).map(asset => ({ name: asset.name, url: asset.browser_download_url }))
        };
        storage.set(CACHE_KEY, { checkedAt: Date.now(), release });
        return release;
    }

    // "v1.4" / "1.4.0" -> [1, 4, 0]; null when it is not a version number (e.g. a local build)
    function parseVersion(text) {
        const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(text || '').trim());
        return match ? [1, 2, 3].map(i => Number(match[i] || 0)) : null;
    }

    function isNewer(latestTag, currentVersion) {
        const latest = parseVersion(latestTag);
        const current = parseVersion(currentVersion);
        if (!latest || !current) return false;
        for (let i = 0; i < 3; i++) {
            if (latest[i] !== current[i]) return latest[i] > current[i];
        }
        return false;
    }

    // The file to download for this platform, or the release page when there is none
    function downloadFor(release, installed) {
        const find = pattern => release.assets.find(asset => pattern.test(asset.name));
        let asset = null;
        if (installed.platform === 'Android') {
            const abi = installed.abi || 'arm64-v8a';
            asset = find(new RegExp(`-${abi.replace(/[^\w-]/g, '')}-release\\.apk$`, 'i')) || find(/-universal-release\.apk$/i);
        } else if (installed.platform === 'Windows') {
            asset = find(installed.variant === 'setup' ? /-Setup-[\d.]+\.exe$/i : /-portable-[\d.]+\.exe$/i);
        }
        return asset ? { url: asset.url, isFile: true } : { url: release.url, isFile: false };
    }

    window.ClipSaverUpdates = { installedVersion, latestRelease, isNewer, downloadFor };

    // ----- Banner -----

    const banner = document.getElementById('update-banner');
    const downloadLink = document.getElementById('update-download');

    async function checkOnStartup() {
        const installed = await installedVersion();
        if (!parseVersion(installed.version)) return; // local/dev build: nothing to compare
        let release;
        try {
            release = await latestRelease();
        } catch (e) {
            return; // offline or GitHub unreachable: say nothing
        }
        if (!isNewer(release.tag, installed.version) || storage.get(DISMISSED_KEY) === release.tag) return;

        const download = downloadFor(release, installed);
        document.getElementById('update-version').textContent = release.tag;
        downloadLink.href = download.url;
        downloadLink.textContent = download.isFile ? 'Descargar' : 'Ver novedades';
        banner.classList.remove('hidden');

        downloadLink.addEventListener('click', () => {
            if (!download.isFile) return;
            document.getElementById('update-text').textContent = installed.platform === 'Android'
                ? 'Cuando termine la descarga, abre el archivo para instalar la actualización.'
                : 'Cuando termine la descarga, abre el archivo para usar la versión nueva.';
        });
        document.getElementById('update-dismiss').addEventListener('click', () => {
            storage.set(DISMISSED_KEY, release.tag); // shown again only for a newer version
            banner.classList.add('hidden');
        });
    }

    checkOnStartup();
});
