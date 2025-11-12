// Online-only, no caching.
// Keep the SW minimal to satisfy PWA install criteria without serving offline.

self.addEventListener('install', _event => {
	// Activate new SW immediately
	// @ts-expect-error
	self.skipWaiting?.()
})

self.addEventListener('activate', event => {
	event.waitUntil(
		Promise.all([
			// Claim clients so this version takes effect right away
			// @ts-expect-error
			self.clients?.claim?.(),
			// Remove any caches left by previous versions
			caches
				.keys()
				.then(keys => Promise.all(keys.map(key => caches.delete(key))))
				.catch(() => {})
		])
	)
})
