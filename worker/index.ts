interface Env {
  ASSETS?: {
    fetch(request: Request): Promise<Response>;
  };
  STATIC_ORIGIN?: string;
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
    'pers:interior_orientation'?: {
      field_of_view?: number;
    };
  };
  assets?: {
    hd?: { href?: string };
    sd?: { href?: string };
    thumb?: { href?: string };
  };
  links?: RawPanoramaxLink[];
}

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
      // Spread out markers so we don't return 30 frames from the exact same 3m spot
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
        if (!tooClose) {
          selected.push(item);
        }
        if (selected.length >= 16) break;
      }

      // Enrich the closest item with any nearby panos as related links if it lacks prev/next
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

      return {
        searchRadiusUsed: radius,
        items: selected,
      };
    }
  }

  return { searchRadiusUsed: 25000, items: [] };
}

async function searchMapillary(
  lat: number,
  lon: number,
  radiusMeters: number,
  token: string
) {
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

  // Connect nearby Mapillary 360 frames as navigable steps
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

async function handlePanoramas(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  const radius = Number(url.searchParams.get('radius') ?? '500');

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return jsonResponse({ error: 'Invalid lat/lon coordinates' }, 400, 0);
  }

  const mapillaryToken = request.headers.get('X-Mapillary-Token')?.trim();
  const panoramaxResult = await searchPanoramax(lat, lon, Number.isFinite(radius) ? radius : 500);

  if (panoramaxResult.items.length > 0 && panoramaxResult.items[0].distanceMeters < 1500) {
    return jsonResponse(
      {
        query: { lat, lon, radiusMeters: radius },
        searchRadiusUsed: panoramaxResult.searchRadiusUsed,
        provider: 'panoramax',
        items: panoramaxResult.items,
      },
      200,
      120
    );
  }

  if (mapillaryToken) {
    const mapillaryItems = await searchMapillary(lat, lon, radius, mapillaryToken);
    if (mapillaryItems.length > 0) {
      return jsonResponse(
        {
          query: { lat, lon, radiusMeters: radius },
          searchRadiusUsed: radius,
          provider: 'mapillary',
          items: mapillaryItems,
        },
        200,
        0
      );
    }
  }

  return jsonResponse(
    {
      query: { lat, lon, radiusMeters: radius },
      searchRadiusUsed: panoramaxResult.searchRadiusUsed,
      provider: 'panoramax',
      items: panoramaxResult.items,
    },
    200,
    120
  );
}

async function handleSinglePanorama(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get('id')?.trim();
  const collection = url.searchParams.get('collection')?.trim();
  const provider = url.searchParams.get('provider') ?? 'panoramax';

  if (!id || !/^[a-zA-Z0-9_-]{4,80}$/.test(id)) {
    return jsonResponse({ error: 'Invalid panorama id' }, 400, 0);
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

  if (!res.ok) {
    return jsonResponse({ error: 'Panorama not found' }, 404, 0);
  }

  const data = (await res.json()) as RawPanoramaxFeature & { features?: RawPanoramaxFeature[] };
  const feature = Array.isArray(data.features) ? data.features[0] : data;
  if (!feature || !feature.geometry?.coordinates) {
    return jsonResponse({ error: 'Panorama data invalid' }, 404, 0);
  }
  const [lon, lat] = feature.geometry.coordinates;
  const item = normalizePanoramaxFeature(feature, lat, lon);
  if (!item) {
    return jsonResponse({ error: 'Panorama missing image assets' }, 404, 0);
  }

  // If the panorama has no prev/next links in its collection, look up immediate nearby 360s
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
  if (!target) {
    return jsonResponse({ error: 'Missing url parameter' }, 400, 0);
  }

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

  const contentType = upstream.headers.get('content-type') ?? 'image/jpeg';
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  });
}

async function handleGeocode(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const q = url.searchParams.get('q')?.trim();
  if (!q || q.length < 2) {
    return jsonResponse({ results: [] }, 200, 60);
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

  return jsonResponse({ results }, 200, 600);
}

export async function handleApiRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Mapillary-Token',
      },
    });
  }

  if (url.pathname === '/api/health') {
    return jsonResponse({
      ok: true,
      service: 'earthxr-maps',
      domain: 'maps.dcedwin.com',
      timestamp: new Date().toISOString(),
    });
  }

  if (url.pathname === '/api/panoramas') {
    return handlePanoramas(request);
  }

  if (url.pathname === '/api/panorama') {
    return handleSinglePanorama(request);
  }

  if (url.pathname === '/api/image-proxy') {
    return handleImageProxy(request);
  }

  if (url.pathname === '/api/geocode') {
    return handleGeocode(request);
  }

  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const apiRes = await handleApiRequest(request);
      if (apiRes) return apiRes;

      if (env.ASSETS) {
        const assetRes = await env.ASSETS.fetch(request);
        const headers = new Headers(assetRes.headers);
        headers.set('Permissions-Policy', 'xr-spatial-tracking=(self)');
        return new Response(assetRes.body, { status: assetRes.status, headers });
      }

      // Edge-cached static asset serving from published gh-pages bundle
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
