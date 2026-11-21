interface Env {
  ASSETS?: {
    fetch(request: Request): Promise<Response>;
  };
  STATIC_ORIGIN?: string;
  GOOGLE_MAPS_API_KEY?: string;
}

type GoogleSessionType = 'hybrid' | 'satellite' | 'streets';

interface CachedGoogleSession {
  token: string;
  expiresAtMs: number;
}

const DEFAULT_STATIC_ORIGIN =
  'https://raw.githubusercontent.com/Edwinlogo/maps-webxr/gh-pages';

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function mimeForPath(pathname: string): string {
  const idx = pathname.lastIndexOf('.');
  if (idx === -1) return 'text/html; charset=utf-8';
  return STATIC_MIME[pathname.slice(idx).toLowerCase()] ?? 'application/octet-stream';
}

function jsonResponse(data: unknown, status = 200, maxAge = 60): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': maxAge > 0 ? `public, max-age=${maxAge}` : 'no-store',
    },
  });
}

function resolveGoogleKey(request: Request, env: Env): { key: string; source: 'server' | 'client' | 'none' } {
  const serverKey = env.GOOGLE_MAPS_API_KEY?.trim();
  if (serverKey) return { key: serverKey, source: 'server' };
  const headerKey = request.headers.get('X-Google-Maps-Key')?.trim();
  if (headerKey) return { key: headerKey, source: 'client' };
  const urlKey = new URL(request.url).searchParams.get('gkey')?.trim();
  if (urlKey) return { key: urlKey, source: 'client' };
  return { key: '', source: 'none' };
}

function isGoogleRequested(request: Request): boolean {
  return request.headers.get('X-Use-Google-Maps') === '1';
}

function googleSessionPayload(type: GoogleSessionType): Record<string, unknown> {
  switch (type) {
    case 'hybrid':
      return {
        mapType: 'satellite',
        language: 'es',
        region: 'CO',
        layerTypes: ['layerRoadmap'],
        overlay: false,
      };
    case 'satellite':
      return { mapType: 'satellite', language: 'es', region: 'CO' };
    case 'streets':
      return { mapType: 'roadmap', language: 'es', region: 'CO' };
  }
}

async function hashKeyPrefix(apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(apiKey);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest).slice(0, 8);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function getGoogleSessionToken(
  apiKey: string,
  type: GoogleSessionType,
  forceRefresh = false
): Promise<{ token?: string; error?: string }> {
  const keyHash = await hashKeyPrefix(apiKey);
  const cacheUrl = `https://maps-session-cache.internal/v1/${keyHash}/${type}`;
  const cache = (caches as unknown as { default?: Cache }).default;

  if (!forceRefresh && cache) {
    try {
      const hit = await cache.match(cacheUrl);
      if (hit) {
        const cached = (await hit.json()) as CachedGoogleSession;
        if (cached.token && cached.expiresAtMs > Date.now() + 60_000) {
          return { token: cached.token };
        }
      }
    } catch {
      // ignore
    }
  }

  const res = await fetch(
    `https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(googleSessionPayload(type)),
    }
  );

  const data = (await res.json()) as {
    session?: string;
    expiry?: string;
    error?: { message?: string };
  };

  if (!res.ok || !data.session) {
    return { error: data.error?.message || `Google Map Tiles session error (${res.status})` };
  }

  let expiresAtMs = Date.now() + 6 * 3600 * 1000;
  if (data.expiry) {
    const num = Number(data.expiry);
    if (Number.isFinite(num) && num > 1_000_000_000) {
      expiresAtMs = num * 1000;
    } else {
      const parsed = Date.parse(data.expiry);
      if (Number.isFinite(parsed)) expiresAtMs = parsed;
    }
  }

  if (cache) {
    const ttlSec = Math.max(300, Math.min(43200, Math.floor((expiresAtMs - Date.now()) / 1000) - 120));
    try {
      await cache.put(
        cacheUrl,
        new Response(JSON.stringify({ token: data.session, expiresAtMs }), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${ttlSec}`,
          },
        })
      );
    } catch {
      // ignore
    }
  }

  return { token: data.session };
}

async function handleGoogle2DTile(
  request: Request,
  env: Env,
  layer: string,
  z: string,
  x: string,
  y: string
): Promise<Response> {
  const validLayers: GoogleSessionType[] = ['hybrid', 'satellite', 'streets'];
  if (!validLayers.includes(layer as GoogleSessionType)) {
    return jsonResponse({ error: 'Invalid map layer' }, 400, 0);
  }
  if (!/^\d+$/.test(z) || !/^\d+$/.test(x) || !/^\d+$/.test(y)) {
    return jsonResponse({ error: 'Invalid tile coordinates' }, 400, 0);
  }

  const { key } = resolveGoogleKey(request, env);
  if (!key) return jsonResponse({ error: 'Google Maps API key not configured' }, 401, 0);

  const sessionType = layer as GoogleSessionType;
  let sess = await getGoogleSessionToken(key, sessionType, false);
  if (!sess.token) {
    return jsonResponse({ error: sess.error || 'Could not initialize Google Map Tiles session' }, 502, 0);
  }

  const fetchTile = (token: string) =>
    fetch(
      `https://tile.googleapis.com/v1/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(
        token
      )}&key=${encodeURIComponent(key)}`
    );

  let upstream = await fetchTile(sess.token);
  if (upstream.status === 400 || upstream.status === 403) {
    sess = await getGoogleSessionToken(key, sessionType, true);
    if (sess.token) upstream = await fetchTile(sess.token);
  }

  if (!upstream.ok || !upstream.body) {
    return jsonResponse({ error: `Google tile error (${upstream.status})` }, upstream.status === 404 ? 404 : 502, 0);
  }

  const upstreamCache = upstream.headers.get('cache-control') ?? 'private, max-age=3600';
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'image/png',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': upstreamCache,
    },
  });
}

// Always uses free OpenStreetMap Nominatim — NEVER calls Google Geocoding API
async function handleGeocode(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const q = url.searchParams.get('q')?.trim();
  if (!q || q.length < 2) return jsonResponse({ results: [] }, 200, 60);

  const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=es,en&q=${encodeURIComponent(
    q
  )}`;

  const res = await fetch(nominatimUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'EarthXR-Maps/1.0 (https://maps.dcedwin.com; contact@dcedwin.com)',
    },
    cf: { cacheTtl: 3600, cacheEverything: true },
  } as RequestInit);

  if (!res.ok) {
    return jsonResponse({ results: [], error: `Geocode error (${res.status})` }, 502, 0);
  }

  const raw = (await res.json()) as Array<{
    name?: string;
    display_name: string;
    lat: string;
    lon: string;
    type?: string;
  }>;

  const results = raw.map((r) => ({
    name: r.name || r.display_name.split(',')[0],
    displayName: r.display_name,
    lat: Number(r.lat),
    lon: Number(r.lon),
    type: r.type ?? 'place',
  }));

  return jsonResponse({ results, provider: 'nominatim' }, 200, 600);
}

export async function handleApiRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS' && path.startsWith('/api/')) {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Google-Maps-Key, X-Use-Google-Maps',
      },
    });
  }

  if (path === '/api/health') {
    const { source } = resolveGoogleKey(request, env);
    return jsonResponse({
      ok: true,
      service: 'earthxr-maps',
      domain: 'maps.dcedwin.com',
      googleConfigured: source !== 'none',
      timestamp: new Date().toISOString(),
    });
  }

  if (path === '/api/config') {
    const { key, source } = resolveGoogleKey(request, env);
    const googleConfigured = Boolean(key);
    const googleActive = googleConfigured && isGoogleRequested(request);
    return jsonResponse({ googleConfigured, googleSource: source, googleActive }, 200, 0);
  }

  if (path === '/api/gmap/verify') {
    const { key } = resolveGoogleKey(request, env);
    if (!key) return jsonResponse({ ok: false, error: 'Falta la clave API de Map Tiles' }, 400, 0);
    const sat = await getGoogleSessionToken(key, 'hybrid', true);
    if (!sat.token) return jsonResponse({ ok: false, error: sat.error }, 400, 0);
    return jsonResponse({ ok: true }, 200, 0);
  }

  const gTileMatch = path.match(/^\/api\/gmap\/tile\/([a-z-]+)\/(\d+)\/(\d+)\/(\d+)$/);
  if (gTileMatch) {
    return handleGoogle2DTile(request, env, gTileMatch[1], gTileMatch[2], gTileMatch[3], gTileMatch[4]);
  }

  if (path === '/api/geocode') {
    return handleGeocode(request);
  }

  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const apiRes = await handleApiRequest(request, env);
      if (apiRes) return apiRes;

      if (env.ASSETS) {
        const assetRes = await env.ASSETS.fetch(request);
        const headers = new Headers(assetRes.headers);
        headers.set('Permissions-Policy', 'xr-spatial-tracking=(self)');
        return new Response(assetRes.body, { status: assetRes.status, headers });
      }

      const url = new URL(request.url);
      let assetPath = url.pathname;
      if (assetPath === '/' || !assetPath.includes('.')) {
        assetPath = '/index.html';
      }
      if (!/^\/[a-zA-Z0-9._/-]+$/.test(assetPath) || assetPath.includes('..')) {
        return new Response('Bad Request', { status: 400 });
      }

      const origin = (env.STATIC_ORIGIN ?? DEFAULT_STATIC_ORIGIN).replace(/\/$/, '');
      const upstream = await fetch(`${origin}${assetPath}`, {
        headers: { 'User-Agent': 'EarthXR-Maps-Worker/1.0' },
        cf: { cacheTtl: assetPath.startsWith('/assets/') ? 3600 : 120, cacheEverything: true },
      } as RequestInit);

      if (!upstream.ok || !upstream.body) {
        return new Response('Not Found', { status: 404 });
      }

      return new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': mimeForPath(assetPath),
          'Cache-Control': assetPath.startsWith('/assets/')
            ? 'public, max-age=3600'
            : 'public, max-age=120',
          'Permissions-Policy': 'xr-spatial-tracking=(self)',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (err) {
      console.error(JSON.stringify({ event: 'worker_error', message: String(err) }));
      return jsonResponse({ error: 'Internal server error' }, 500, 0);
    }
  },
};
