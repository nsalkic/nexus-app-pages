// NEXUS web service worker (replaces the one Godot exports; installed by tools/web/build_web.sh).
// Why: Godot's default worker serves index.html / index.pck / index.wasm cache-first and waits for every
// tab to close before a new version takes over, so a returning visitor (especially on iPhone / iPad Safari
// or the home-screen app, where tabs are rarely closed) could stay on an old build forever.
// This worker:
//  - takes over at once (skipWaiting + clients.claim),
//  - always asks the network first, revalidating with the server (cheap 304s), so a page and its
//    index.pck / index.wasm always come from the same build; the content packs (packs/*.pck?v=build)
//    are never touched here and use the normal browser cache,
//  - keeps only the small offline page in Cache Storage, shown when there is no connection,
//  - on taking over from any older worker (Godot's cache-first one or an older NEXUS build), deletes its
//    caches and reloads open pages once, so a tab left open across a release moves to the new build.
const CACHE_VERSION = '1795124712|3275488';
const CACHE_PREFIX = 'NEXUS-sw-cache-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const OFFLINE_URL = 'index.offline.html';
const BUILD_FILES = ['index.html', 'index.js', 'index.wasm', 'index.pck', 'index.audio.worklet.js',
	'index.audio.position.worklet.js', 'index.manifest.json', 'index.service.worker.js'];

self.addEventListener('install', (event) => {
	self.skipWaiting();
	event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'no-cache' }))).catch(() => {}));
});

self.addEventListener('activate', (event) => {
	const ready = (async () => {
		let trapped = false;
		for (const key of await caches.keys()) {
			if (!key.startsWith(CACHE_PREFIX) || key === CACHE_NAME) {
				continue;
			}
			// Any older NEXUS cache means a page may still be running an older build (Godot's cache-first worker,
			// or a tab left open across a release, common on iPhone Safari): reload those pages once.
			trapped = true;
			await caches.delete(key);
		}
		if ('navigationPreload' in self.registration) {
			try { await self.registration.navigationPreload.disable(); } catch (e) { /* not supported */ }
		}
		await self.clients.claim();
		return trapped;
	})();
	event.waitUntil(ready);
	// Reload pages that were running an old build, but only after activation has finished: the reload's
	// own request is handled by this worker, which cannot answer it while still activating.
	ready.then((trapped) => {
		if (trapped) {
			setTimeout(async () => {
				for (const client of await self.clients.matchAll({ type: 'window' })) {
					try { await client.navigate(client.url); } catch (e) { /* it gets the new build on its next load */ }
				}
			}, 0);
		}
	});
});

function buildFile(url) {
	const scope = self.registration.scope;
	if (!url.startsWith(scope)) {
		return '';
	}
	const rest = url.slice(scope.length).split('?')[0].split('#')[0];
	return BUILD_FILES.includes(rest) ? rest : '';
}

self.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') {
		return;
	}
	const isNavigate = req.mode === 'navigate';
	if (!isNavigate && !buildFile(req.url)) {
		return; // packs, icons, everything else: straight to the network / browser cache
	}
	event.respondWith((async () => {
		try {
			// Revalidate with the server so html, js, wasm and pck always match one build.
			return await fetch(isNavigate ? new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : new Request(req, { cache: 'no-cache' }));
		} catch (e) {
			if (isNavigate) {
				const offline = await caches.match(OFFLINE_URL);
				if (offline) {
					return offline;
				}
			}
			throw e;
		}
	})());
});

self.addEventListener('message', (event) => {
	if (event.origin !== self.origin) {
		return;
	}
	if (event.data === 'claim' || event.data === 'update') {
		event.waitUntil(self.skipWaiting().then(() => self.clients.claim()));
	} else if (event.data === 'clear') {
		event.waitUntil(caches.delete(CACHE_NAME));
	}
});
