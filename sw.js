/* Minimal service worker: exists so the portal is installable as a home-screen
   app. Network passthrough — never caches API responses. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function () { /* passthrough */ });
