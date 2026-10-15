// Never cache authenticated data, tokens, source code or conversations.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response('<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AvityOne hors ligne</title><body style="font:18px system-ui;padding:2rem;background:#121212;color:white"><h1>Connexion indisponible</h1><p>Reconnecte-toi au serveur pour retrouver tes sessions.</p><button onclick="location.reload()">Réessayer</button></body></html>', { headers: { 'content-type': 'text/html;charset=utf-8' } })));
});
