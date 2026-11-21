interface Env {
  ASSETS?: {
    fetch(request: Request): Promise<Response>;
  };
  STATIC_ORIGIN?: string;
  GOOGLE_MAPS_API_KEY?: string;
}

type GoogleSessionType = 'hybrid' | 'satellite' | 'streets' | 'sv-overlay' | 'streetview';

interface CachedGoogleSession {
  token: string;
  expiresAtMs: number;
}

interface RawGoogleSvLink {
  panoId?: string;
  heading?: number;
  text?: string;
}

interface RawGoogleSvMetadata {
  panoId?: string;
  lat?: number;
  lng?: number;
  originalLat?: number;
  originalLng?: number;
  imageWidth?: number;
  imageHeight?: number;
  tileWidth?: number;
  tileHeight?: number;
  heading?: number;
  tilt?: number;
  roll?: number;
  date?: string;
  copyright?: string;
  imageryType?: string;
  links?: RawGoogleSvLink[];
  addressComponents?: Array<{
    longName?: string;
    shortName?: string;
    types?: string[];
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

interface RawPanoramaxLink {
  rel?: string;
  id?: string;
  href?: string;
  geometry?: {
    type?: string;
    coordinates?: [number, number];
  };
}

interface RawPanoramaxFeature {
  id: string;
  collection?: string;
  geometry?: {
    type?: string;
    coordinates?: [number, number];
  };
  properties?: {
    datetime?: string;
    'view:azimuth'?: number;
    license?: string;
  };
  assets?: {
    hd?: { href?: string };
    sd?: { href?: string };
    thumb?: { href?: string };
  };
  links?: RawPanoramaxLink[];
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

const EARTH_RADIUS_M = 6371008.8;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

const ALLOWED_IMAGE_HOST_PATTERNS: RegExp[] = [
  /(^|\.)panoramax\.[a-z.]+$/i,
  /(^|\.)openstreetmap\.[a-z.]+$/i,
  /(^|\.)ign\.fr$/i,
  /(^|\.)basi\.re$/i,
  /(^|\.)osm\.tw$/i,
  /(^|\.)libre\.net\.ar$/i,
  /(^|\.)locus\.sbs$/i,
  /(^|\.)ovh\.net$/i,
  /(^|\.)scw\.cloud$/i,
  /(^|\.)mapillary\.com$/i,
  /(^|\.)fbcdn\.net$/i,
  /(^|\.)wikimedia\.org$/i,
  /(^|\.)arcgisonline\.com$/i,
  /(^|\.)cartocdn\.com$/i,
  /(^|\.)geovisio\.[a-z.]+$/i,
  /(^|\.)panoramax-storage[a-z0-9.-]*$/i,
  /(^|\.)s3\.[a-z0-9.-]+\.amazonaws\.com$/i,
];

function mimeForPath(pathname: string): string {
  const idx = pathname.lastIndexOf('.');
  if (idx === -1) return 'text/html; charset=utf-8';
  return STATIC_MIME[pathname.slice(idx).toLowerCase()] ?? 'application/octet-stream';
}

function isAllowedImageHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.local') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(lower) ||
    lower.includes(':')
  ) {
    return false;
  }
  return ALLOWED_IMAGE_HOST_PATTERNS.some((re) => re.test(lower));
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = lat1 * DEG2RAD;
  const phi2 = lat2 * DEG2RAD;
  const dLam = (lon2 - lon1) * DEG2RAD;
  const y = Math.sin(dLam) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLam);
  return ((Math.atan2(y, x) * RAD2DEG) + 360) % 360;
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
      return {
        mapType: 'satellite',
        language: 'es',
        region: 'CO',
      };
    case 'streets':
      return {
        mapType: 'roadmap',
        language: 'es',
        region: 'CO',
      };
    case 'sv-overlay':
      return {
        mapType: 'satellite',
        language: 'es',
        region: 'CO',
        layerTypes: ['layerStreetview'],
        overlay: true,
      };
    case 'streetview':
      return {
        mapType: 'streetview',
        language: 'es',
        region: 'CO',
      };
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
      // Cache read optional
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
    error?: { message?: string; status?: string };
  };

  if (!res.ok || !data.session) {
    return {
      error: data.error?.message || `Google Map Tiles session error (${res.status})`,
    };
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
      // ignore cache write failure
    }
  }

  return { token: data.session };
}

function formatGoogleAddress(meta: RawGoogleSvMetadata): string {
  const comps = meta.addressComponents ?? [];
  if (comps.length === 0) return '';
  const parts: string[] = [];
  for (const c of comps) {
    const name = c.longName || c.shortName;
    if (name && !parts.includes(name)) parts.push(name);
    if (parts.length >= 3) break;
  }
  return parts.join(', ');
}

function normalizeGoogleMetadata(
  meta: RawGoogleSvMetadata,
  refLat: number,
  refLon: number
) {
  if (!meta.panoId) return null;
  const lat = typeof meta.lat === 'number' ? meta.lat : meta.originalLat ?? refLat;
  const lon = typeof meta.lng === 'number' ? meta.lng : meta.originalLng ?? refLon;
  const azimuth =
    typeof meta.heading === 'number' && Number.isFinite(meta.heading)
      ? ((meta.heading % 360) + 360) % 360
      : 0;

  const links = (meta.links ?? [])
    .filter((l) => Boolean(l.panoId) && typeof l.heading === 'number')
    .map((l) => ({
      rel: 'related' as const,
      id: l.panoId!,
      bearingDeg: ((l.heading! % 360) + 360) % 360,
      text: l.text?.trim() || undefined,
    }));

  return {
    id: meta.panoId,
    lat,
    lon,
    azimuth,
    tilt: typeof meta.tilt === 'number' ? meta.tilt : 90,
    roll: typeof meta.roll === 'number' ? meta.roll : 0,
    distanceMeters: haversineMeters(refLat, refLon, lat, lon),
    imageWidth: meta.imageWidth ?? 13312,
    imageHeight: meta.imageHeight ?? 6656,
    tileWidth: meta.tileWidth ?? 512,
    tileHeight: meta.tileHeight ?? 512,
    capturedAt: meta.date,
    address: formatGoogleAddress(meta) || undefined,
    copyright: meta.copyright || '© Google',
    provider: 'google' as const,
    sourceHost: 'tile.googleapis.com',
    links,
  };
}

async function lookupGoogleStreetView(
  apiKey: string,
  lat: number,
  lon: number,
  initialRadiusMeters: number
): Promise<{ item: ReturnType<typeof normalizeGoogleMetadata> | null; radiusUsed: number; error?: string }> {
  const sess = await getGoogleSessionToken(apiKey, 'streetview');
  if (!sess.token) {
    return { item: null, radiusUsed: initialRadiusMeters, error: sess.error };
  }

  const base = Math.max(50, Math.min(5000, initialRadiusMeters));
  const radii = Array.from(new Set([base, Math.max(base, 250), Math.max(base, 1200), 5000])).sort(
    (a, b) => a - b
  );

  for (const radius of radii) {
    const url = `https://tile.googleapis.com/v1/streetview/metadata?session=${encodeURIComponent(
      sess.token
    )}&key=${encodeURIComponent(apiKey)}&lat=${lat.toFixed(6)}&lng=${lon.toFixed(
      6
    )}&radius=${Math.round(radius)}`;

    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      cf: { cacheTtl: 180, cacheEverything: true },
    } as RequestInit);

    if (res.status === 404) continue;
    const data = (await res.json()) as RawGoogleSvMetadata;
    if (res.ok && data.panoId) {
      return {
        item: normalizeGoogleMetadata(data, lat, lon),
        radiusUsed: radius,
      };
    }
    if (res.status === 400 || res.status === 403) {
      return {
        item: null,
        radiusUsed: radius,
        error: data.error?.message || `Google Street View error (${res.status})`,
      };
    }
  }

  return { item: null, radiusUsed: 5000 };
}

async function fetchGooglePanoramaById(apiKey: string, panoId: string) {
  const sess = await getGoogleSessionToken(apiKey, 'streetview');
  if (!sess.token) return { item: null, error: sess.error };

  const url = `https://tile.googleapis.com/v1/streetview/metadata?session=${encodeURIComponent(
    sess.token
  )}&key=${encodeURIComponent(apiKey)}&panoId=${encodeURIComponent(panoId)}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    cf: { cacheTtl: 300, cacheEverything: true },
  } as RequestInit);

  const data = (await res.json()) as RawGoogleSvMetadata;
  if (!res.ok || !data.panoId) {
    return { item: null, error: data.error?.message || `Panorama not found (${res.status})` };
  }
  const lat = data.lat ?? data.originalLat ?? 0;
  const lon = data.lng ?? data.originalLng ?? 0;
  return { item: normalizeGoogleMetadata(data, lat, lon) };
}

async function handleGoogle2DTile(
  request: Request,
  env: Env,
  layer: string,
  z: string,
  x: string,
  y: string
): Promise<Response> {
  const validLayers: GoogleSessionType[] = ['hybrid', 'satellite', 'streets', 'sv-overlay'];
  if (!validLayers.includes(layer as GoogleSessionType)) {
    return jsonResponse({ error: 'Invalid map layer' }, 400, 0);
  }
  if (!/^\d+$/.test(z) || !/^\d+$/.test(x) || !/^\d+$/.test(y)) {
    return jsonResponse({ error: 'Invalid tile coordinates' }, 400, 0);
  }

  const { key } = resolveGoogleKey(request, env);
  if (!key) {
    return jsonResponse({ error: 'Google Maps API key not configured' }, 401, 0);
  }

  const sessionType = layer as GoogleSessionType;
  let sess = await getGoogleSessionToken(key, sessionType, false);
  if (!sess.token) {
    return jsonResponse({ error: sess.error || 'Could not initialize Google Map Tiles session' }, 502, 0);
  }

  const fetchTile = (token: string) =>
    fetch(
      `https://tile.googleapis.com/v1/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(
        token
      )}&key=${encodeURIComponent(key)}`,
      {
        cf: { cacheTtl: 86400, cacheEverything: true },
      } as RequestInit
    );

  let upstream = await fetchTile(sess.token);
  if (upstream.status === 400 || upstream.status === 403) {
    sess = await getGoogleSessionToken(key, sessionType, true);
    if (sess.token) {
      upstream = await fetchTile(sess.token);
    }
  }

  // Google returns 404 for empty sv-overlay tiles (areas with no blue lines) — return transparent 1x1 PNG cleanly!
  if (upstream.status === 404 && sessionType === 'sv-overlay') {
    const emptyPng = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
      (c) => c.charCodeAt(0)
    );
    return new Response(emptyPng, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  if (!upstream.ok || !upstream.body) {
    return jsonResponse({ error: `Google tile error (${upstream.status})` }, upstream.status === 404 ? 404 : 502, 0);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'image/png',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  });
}

async function handleGoogleSvTile(
  request: Request,
  env: Env,
  z: string,
  x: string,
  y: string
): Promise<Response> {
  const url = new URL(request.url);
  const panoId = url.searchParams.get('panoId')?.trim();
  if (!panoId || !/^[a-zA-Z0-9_-]{8,120}$/.test(panoId)) {
    return jsonResponse({ error: 'Invalid panoId' }, 400, 0);
  }
  if (!/^[0-5]$/.test(z) || !/^\d+$/.test(x) || !/^\d+$/.test(y)) {
    return jsonResponse({ error: 'Invalid Street View tile coordinates' }, 400, 0);
  }

  const { key } = resolveGoogleKey(request, env);
  if (!key) {
    return jsonResponse({ error: 'Google Maps API key not configured' }, 401, 0);
  }

  let sess = await getGoogleSessionToken(key, 'streetview', false);
  if (!sess.token) {
    return jsonResponse({ error: sess.error || 'Could not initialize Street View session' }, 502, 0);
  }

  const fetchSvTile = (token: string) =>
    fetch(
      `https://tile.googleapis.com/v1/streetview/tiles/${z}/${x}/${y}?session=${encodeURIComponent(
        token
      )}&key=${encodeURIComponent(key)}&panoId=${encodeURIComponent(panoId)}`,
      {
        cf: { cacheTtl: 86400, cacheEverything: true },
      } as RequestInit
    );

  let upstream = await fetchSvTile(sess.token);
  if (upstream.status === 400 || upstream.status === 403) {
    sess = await getGoogleSessionToken(key, 'streetview', true);
    if (sess.token) {
      upstream = await fetchSvTile(sess.token);
    }
  }

  if (!upstream.ok || !upstream.body) {
    return jsonResponse({ error: `Google SV tile error (${upstream.status})` }, 502, 0);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'image/jpeg',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  });
}

function extractCollectionFromHref(href?: string): string | undefined {
  if (!href) return undefined;
  const match = href.match(/\/collections\/([^/]+)\/items\//);
  return match?.[1];
}

function normalizePanoramaxFeature(
  feature: RawPanoramaxFeature,
  refLat: number,
  refLon: number
) {
  const coords = feature.geometry?.coordinates;
  if (!coords || coords.length < 2) return null;
  const [lon, lat] = coords;
  const sdUrl = feature.assets?.sd?.href ?? feature.assets?.hd?.href ?? '';
  const hdUrl = feature.assets?.hd?.href ?? sdUrl;
  if (!sdUrl) return null;

  let sourceHost = '';
  try {
    sourceHost = new URL(sdUrl).hostname;
  } catch {
    sourceHost = '';
  }

  const rawAz = feature.properties?.['view:azimuth'];
  const azimuth = typeof rawAz === 'number' && Number.isFinite(rawAz) ? ((rawAz % 360) + 360) % 360 : 0;

  const links: Array<{
    rel: 'next' | 'prev' | 'related';
    id: string;
    collection?: string;
    lat: number;
    lon: number;
    bearingDeg: number;
    distanceMeters: number;
  }> = [];

  for (const link of feature.links ?? []) {
    if (link.rel !== 'next' && link.rel !== 'prev' && link.rel !== 'related') continue;
    const lc = link.geometry?.coordinates;
    if (!link.id || !lc || lc.length < 2) continue;
    const [lLon, lLat] = lc;
    const dist = haversineMeters(lat, lon, lLat, lLon);
    if (dist < 0.5 || dist > 300) continue;
    links.push({
      rel: link.rel,
      id: link.id,
      collection: extractCollectionFromHref(link.href) ?? feature.collection,
      lat: lLat,
      lon: lLon,
      bearingDeg: bearingDeg(lat, lon, lLat, lLon),
      distanceMeters: dist,
    });
  }

  return {
    id: feature.id,
    collection: feature.collection,
    lat,
    lon,
    azimuth,
    distanceMeters: haversineMeters(refLat, refLon, lat, lon),
    sdUrl,
    hdUrl,
    thumbUrl: feature.assets?.thumb?.href,
    capturedAt: feature.properties?.datetime,
    provider: 'panoramax' as const,
    sourceHost,
    license: feature.properties?.license,
    links,
  };
}

async function searchPanoramax(lat: number, lon: number, initialRadiusMeters: number) {
  const baseRadius = Math.max(250, Math.min(25000, initialRadiusMeters));
  const candidateRadii = Array.from(
    new Set([baseRadius, Math.max(baseRadius, 1500), Math.max(baseRadius, 6000), 25000])
  ).sort((a, b) => a - b);

  const cosLat = Math.max(0.15, Math.cos(lat * DEG2RAD));

  for (const radius of candidateRadii) {
    const dLat = radius / 111320;
    const dLon = radius / (111320 * cosLat);
    const minLon = Math.max(-180, lon - dLon);
    const maxLon = Math.min(180, lon + dLon);
    const minLat = Math.max(-85, lat - dLat);
    const maxLat = Math.min(85, lat + dLat);

    const bbox = `${minLon.toFixed(6)},${minLat.toFixed(6)},${maxLon.toFixed(6)},${maxLat.toFixed(6)}`;
    const url = `https://api.panoramax.xyz/api/search?bbox=${bbox}&filter=${encodeURIComponent(
      'field_of_view=360'
    )}&limit=36`;

    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'EarthXR-Maps/1.0 (https://maps.dcedwin.com)',
      },
      cf: { cacheTtl: 180, cacheEverything: true },
    } as RequestInit);

    if (!res.ok) continue;

    const payload = (await res.json()) as { features?: RawPanoramaxFeature[] };
    const normalized = (payload.features ?? [])
      .map((f) => normalizePanoramaxFeature(f, lat, lon))
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => a.distanceMeters - b.distanceMeters);

    if (normalized.length > 0) {
      const selected: typeof normalized = [];
      for (const item of normalized) {
        if (selected.length === 0) {
          selected.push(item);
          continue;
        }
        const minGap = radius > 3000 ? 60 : 12;
        const tooClose = selected.some(
          (s) => haversineMeters(s.lat, s.lon, item.lat, item.lon) < minGap
        );
        if (!tooClose) selected.push(item);
        if (selected.length >= 16) break;
      }

      const primary = selected[0];
      if (primary && primary.links.length === 0 && normalized.length > 1) {
        for (const other of normalized.slice(1, 8)) {
          const dist = haversineMeters(primary.lat, primary.lon, other.lat, other.lon);
          if (dist >= 4 && dist <= 180) {
            primary.links.push({
              rel: 'related',
              id: other.id,
              collection: other.collection,
              lat: other.lat,
              lon: other.lon,
              bearingDeg: bearingDeg(primary.lat, primary.lon, other.lat, other.lon),
              distanceMeters: dist,
            });
          }
          if (primary.links.length >= 4) break;
        }
      }

      return { searchRadiusUsed: radius, items: selected };
    }
  }

  return { searchRadiusUsed: 25000, items: [] };
}

async function searchMapillary(lat: number, lon: number, radiusMeters: number, token: string) {
  const cosLat = Math.max(0.15, Math.cos(lat * DEG2RAD));
  const r = Math.max(300, Math.min(5000, radiusMeters));
  const dLat = r / 111320;
  const dLon = r / (111320 * cosLat);
  const bbox = `${(lon - dLon).toFixed(6)},${(lat - dLat).toFixed(6)},${(lon + dLon).toFixed(6)},${(lat + dLat).toFixed(6)}`;
  const url = `https://graph.mapillary.com/images?access_token=${encodeURIComponent(
    token
  )}&fields=id,computed_geometry,compass_angle,is_pano,thumb_1024_url,thumb_2048_url,thumb_original_url,captured_at&bbox=${bbox}&is_pano=true&limit=20`;

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return [];
  const json = (await res.json()) as {
    data?: Array<{
      id: string;
      computed_geometry?: { coordinates?: [number, number] };
      compass_angle?: number;
      thumb_1024_url?: string;
      thumb_2048_url?: string;
      thumb_original_url?: string;
      captured_at?: number;
    }>;
  };
  const items = (json.data ?? [])
    .filter((d) => d.computed_geometry?.coordinates && (d.thumb_2048_url || d.thumb_1024_url))
    .map((d) => {
      const [iLon, iLat] = d.computed_geometry!.coordinates!;
      return {
        id: d.id,
        lat: iLat,
        lon: iLon,
        azimuth: d.compass_angle ?? 0,
        distanceMeters: haversineMeters(lat, lon, iLat, iLon),
        sdUrl: d.thumb_1024_url ?? d.thumb_2048_url!,
        hdUrl: d.thumb_2048_url ?? d.thumb_original_url ?? d.thumb_1024_url!,
        capturedAt: d.captured_at ? new Date(d.captured_at).toISOString() : undefined,
        provider: 'mapillary' as const,
        sourceHost: 'graph.mapillary.com',
        links: [] as Array<{
          rel: 'next' | 'prev' | 'related';
          id: string;
          collection?: string;
          lat: number;
          lon: number;
          bearingDeg: number;
          distanceMeters: number;
        }>,
      };
    })
    .sort((a, b) => a.distanceMeters - b.distanceMeters);

  for (const item of items) {
    for (const other of items) {
      if (other.id === item.id) continue;
      const dist = haversineMeters(item.lat, item.lon, other.lat, other.lon);
      if (dist >= 4 && dist <= 120) {
        item.links.push({
          rel: 'related',
          id: other.id,
          lat: other.lat,
          lon: other.lon,
          bearingDeg: bearingDeg(item.lat, item.lon, other.lat, other.lon),
          distanceMeters: dist,
        });
      }
      if (item.links.length >= 4) break;
    }
  }
  return items;
}

async function handlePanoramas(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  const radius = Number(url.searchParams.get('radius') ?? '250');

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return jsonResponse({ error: 'Invalid lat/lon coordinates' }, 400, 0);
  }

  const safeRadius = Number.isFinite(radius) ? radius : 250;

  // 1) Primary provider: Google Maps Street View (works on ANY street worldwide!)
  const { key: googleKey } = resolveGoogleKey(request, env);
  let googleError: string | undefined;
  if (googleKey) {
    const gRes = await lookupGoogleStreetView(googleKey, lat, lon, safeRadius);
    if (gRes.item) {
      return jsonResponse(
        {
          query: { lat, lon, radiusMeters: safeRadius },
          searchRadiusUsed: gRes.radiusUsed,
          provider: 'google',
          items: [gRes.item],
        },
        200,
        0
      );
    }
    googleError = gRes.error;
  }

  // 2) Fallback: Open Panoramax / optional Mapillary
  const mapillaryToken = request.headers.get('X-Mapillary-Token')?.trim();
  const panoramaxResult = await searchPanoramax(lat, lon, safeRadius);

  if (panoramaxResult.items.length > 0 && panoramaxResult.items[0].distanceMeters < 1500) {
    return jsonResponse(
      {
        query: { lat, lon, radiusMeters: safeRadius },
        searchRadiusUsed: panoramaxResult.searchRadiusUsed,
        provider: 'panoramax',
        items: panoramaxResult.items,
        googleError,
      },
      200,
      120
    );
  }

  if (mapillaryToken) {
    const mapillaryItems = await searchMapillary(lat, lon, safeRadius, mapillaryToken);
    if (mapillaryItems.length > 0) {
      return jsonResponse(
        {
          query: { lat, lon, radiusMeters: safeRadius },
          searchRadiusUsed: safeRadius,
          provider: 'mapillary',
          items: mapillaryItems,
          googleError,
        },
        200,
        0
      );
    }
  }

  return jsonResponse(
    {
      query: { lat, lon, radiusMeters: safeRadius },
      searchRadiusUsed: panoramaxResult.searchRadiusUsed,
      provider: googleKey ? 'google' : 'panoramax',
      items: panoramaxResult.items,
      googleError,
    },
    200,
    googleKey ? 0 : 120
  );
}

async function handleSinglePanorama(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get('id')?.trim();
  const collection = url.searchParams.get('collection')?.trim();
  const provider = url.searchParams.get('provider') ?? 'panoramax';

  if (!id || !/^[a-zA-Z0-9_-]{4,120}$/.test(id)) {
    return jsonResponse({ error: 'Invalid panorama id' }, 400, 0);
  }

  if (provider === 'google') {
    const { key: googleKey } = resolveGoogleKey(request, env);
    if (!googleKey) return jsonResponse({ error: 'Google Maps API key required' }, 401, 0);
    const res = await fetchGooglePanoramaById(googleKey, id);
    if (!res.item) {
      return jsonResponse({ error: res.error || 'Google panorama not found' }, 404, 0);
    }
    return jsonResponse(res.item, 200, 0);
  }

  if (provider === 'mapillary') {
    const token = request.headers.get('X-Mapillary-Token')?.trim();
    if (!token) return jsonResponse({ error: 'Mapillary token required' }, 401, 0);
    const res = await fetch(
      `https://graph.mapillary.com/${encodeURIComponent(id)}?access_token=${encodeURIComponent(
        token
      )}&fields=id,computed_geometry,compass_angle,thumb_1024_url,thumb_2048_url,captured_at`
    );
    if (!res.ok) return jsonResponse({ error: 'Mapillary item not found' }, 404, 0);
    const d = (await res.json()) as {
      id: string;
      computed_geometry?: { coordinates?: [number, number] };
      compass_angle?: number;
      thumb_1024_url?: string;
      thumb_2048_url?: string;
      captured_at?: number;
    };
    const [lon, lat] = d.computed_geometry?.coordinates ?? [0, 0];
    const nearby = await searchMapillary(lat, lon, 120, token);
    const match = nearby.find((n) => n.id === d.id);
    return jsonResponse(
      match ?? {
        id: d.id,
        lat,
        lon,
        azimuth: d.compass_angle ?? 0,
        distanceMeters: 0,
        sdUrl: d.thumb_1024_url ?? d.thumb_2048_url ?? '',
        hdUrl: d.thumb_2048_url ?? d.thumb_1024_url ?? '',
        provider: 'mapillary',
        links: [],
      },
      200,
      0
    );
  }

  const endpoint =
    collection && /^[a-zA-Z0-9_-]{4,80}$/.test(collection)
      ? `https://api.panoramax.xyz/api/collections/${encodeURIComponent(collection)}/items/${encodeURIComponent(id)}`
      : `https://api.panoramax.xyz/api/search?ids=${encodeURIComponent(id)}`;

  const res = await fetch(endpoint, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'EarthXR-Maps/1.0 (https://maps.dcedwin.com)',
    },
    cf: { cacheTtl: 300, cacheEverything: true },
  } as RequestInit);

  if (!res.ok) return jsonResponse({ error: 'Panorama not found' }, 404, 0);

  const data = (await res.json()) as RawPanoramaxFeature & { features?: RawPanoramaxFeature[] };
  const feature = Array.isArray(data.features) ? data.features[0] : data;
  if (!feature || !feature.geometry?.coordinates) {
    return jsonResponse({ error: 'Panorama data invalid' }, 404, 0);
  }
  const [lon, lat] = feature.geometry.coordinates;
  const item = normalizePanoramaxFeature(feature, lat, lon);
  if (!item) return jsonResponse({ error: 'Panorama missing image assets' }, 404, 0);

  if (item.links.length === 0) {
    const nearby = await searchPanoramax(item.lat, item.lon, 250);
    for (const other of nearby.items) {
      if (other.id === item.id) continue;
      const dist = haversineMeters(item.lat, item.lon, other.lat, other.lon);
      if (dist >= 4 && dist <= 220) {
        item.links.push({
          rel: 'related',
          id: other.id,
          collection: other.collection,
          lat: other.lat,
          lon: other.lon,
          bearingDeg: bearingDeg(item.lat, item.lon, other.lat, other.lon),
          distanceMeters: dist,
        });
      }
      if (item.links.length >= 4) break;
    }
  }

  return jsonResponse(item, 200, 300);
}

async function handleImageProxy(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target) return jsonResponse({ error: 'Missing url parameter' }, 400, 0);

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return jsonResponse({ error: 'Invalid target URL' }, 400, 0);
  }

  if (parsed.protocol !== 'https:' || !isAllowedImageHost(parsed.hostname)) {
    return jsonResponse({ error: 'Host not permitted for image proxy' }, 403, 0);
  }

  const upstream = await fetch(parsed.toString(), {
    headers: {
      'User-Agent': 'EarthXR-Maps/1.0 (https://maps.dcedwin.com)',
      Accept: 'image/webp,image/jpeg,image/png,image/*,*/*;q=0.8',
    },
    cf: { cacheTtl: 86400, cacheEverything: true },
  } as RequestInit);

  if (!upstream.ok || !upstream.body) {
    return jsonResponse({ error: `Upstream image error (${upstream.status})` }, 502, 0);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'image/jpeg',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  });
}

async function handleGeocode(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const q = url.searchParams.get('q')?.trim();
  if (!q || q.length < 2) return jsonResponse({ results: [] }, 200, 60);

  // Try Google Geocoding first if key is present and Geocoding API is enabled
  const { key: googleKey } = resolveGoogleKey(request, env);
  if (googleKey) {
    try {
      const gUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
        q
      )}&language=es&key=${encodeURIComponent(googleKey)}`;
      const gRes = await fetch(gUrl, { cf: { cacheTtl: 1800, cacheEverything: true } } as RequestInit);
      if (gRes.ok) {
        const gData = (await gRes.json()) as {
          status?: string;
          results?: Array<{
            formatted_address: string;
            geometry?: { location?: { lat: number; lng: number } };
            types?: string[];
          }>;
        };
        if (gData.status === 'OK' && gData.results && gData.results.length > 0) {
          const results = gData.results.slice(0, 6).map((r) => ({
            name: r.formatted_address.split(',')[0],
            displayName: r.formatted_address,
            lat: r.geometry?.location?.lat ?? 0,
            lon: r.geometry?.location?.lng ?? 0,
            type: r.types?.[0] ?? 'place',
          }));
          return jsonResponse({ results, provider: 'google' }, 200, 600);
        }
      }
    } catch {
      // Fall through cleanly to Nominatim if Geocoding API isn't enabled on the key
    }
  }

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
        'Access-Control-Allow-Headers': 'Content-Type, X-Google-Maps-Key, X-Mapillary-Token',
      },
    });
  }

  if (path === '/api/health') {
    const { source } = resolveGoogleKey(request, env);
    return jsonResponse({
      ok: true,
      service: 'earthxr-maps',
      domain: 'maps.dcedwin.com',
      googleEnabled: source !== 'none',
      timestamp: new Date().toISOString(),
    });
  }

  if (path === '/api/config') {
    const { source } = resolveGoogleKey(request, env);
    return jsonResponse({ googleEnabled: source !== 'none', source }, 200, 0);
  }

  if (path === '/api/gmap/verify') {
    const { key } = resolveGoogleKey(request, env);
    if (!key) return jsonResponse({ ok: false, error: 'Falta la clave API de Google Maps' }, 400, 0);
    const sat = await getGoogleSessionToken(key, 'hybrid', true);
    if (!sat.token) return jsonResponse({ ok: false, error: sat.error }, 400, 0);
    const sv = await getGoogleSessionToken(key, 'streetview', true);
    if (!sv.token) return jsonResponse({ ok: false, error: sv.error }, 400, 0);
    return jsonResponse({ ok: true }, 200, 0);
  }

  const gTileMatch = path.match(/^\/api\/gmap\/tile\/([a-z-]+)\/(\d+)\/(\d+)\/(\d+)$/);
  if (gTileMatch) {
    return handleGoogle2DTile(request, env, gTileMatch[1], gTileMatch[2], gTileMatch[3], gTileMatch[4]);
  }

  const gSvTileMatch = path.match(/^\/api\/gmap\/streetview\/tile\/(\d+)\/(\d+)\/(\d+)$/);
  if (gSvTileMatch) {
    return handleGoogleSvTile(request, env, gSvTileMatch[1], gSvTileMatch[2], gSvTileMatch[3]);
  }

  if (path === '/api/panoramas') {
    return handlePanoramas(request, env);
  }

  if (path === '/api/panorama') {
    return handleSinglePanorama(request, env);
  }

  if (path === '/api/image-proxy') {
    return handleImageProxy(request);
  }

  if (path === '/api/geocode') {
    return handleGeocode(request, env);
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
