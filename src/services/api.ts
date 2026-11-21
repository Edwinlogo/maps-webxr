import type {
  GeocodeResult,
  ImageryProvider,
  MapLayer,
  PanoramaItem,
  PanoramaSearchResponse,
  ServerConfig,
} from '../types';

const STORAGE_GOOGLE_KEY = 'earthxr_google_maps_key';
const STORAGE_MAPILLARY_KEY = 'earthxr_mapillary_token';

export function getGoogleMapsKey(): string {
  try {
    return localStorage.getItem(STORAGE_GOOGLE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setGoogleMapsKey(key: string): void {
  try {
    const trimmed = key.trim();
    if (trimmed) {
      localStorage.setItem(STORAGE_GOOGLE_KEY, trimmed);
    } else {
      localStorage.removeItem(STORAGE_GOOGLE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

export function getMapillaryToken(): string {
  try {
    return localStorage.getItem(STORAGE_MAPILLARY_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setMapillaryToken(token: string): void {
  try {
    const trimmed = token.trim();
    if (trimmed) {
      localStorage.setItem(STORAGE_MAPILLARY_KEY, trimmed);
    } else {
      localStorage.removeItem(STORAGE_MAPILLARY_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

export function proxyImageUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  if (rawUrl.startsWith('/api/')) return rawUrl;
  return `/api/image-proxy?url=${encodeURIComponent(rawUrl)}`;
}

export function buildApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const googleKey = getGoogleMapsKey();
  if (googleKey) headers['X-Google-Maps-Key'] = googleKey;
  const mapillaryToken = getMapillaryToken();
  if (mapillaryToken) headers['X-Mapillary-Token'] = mapillaryToken;
  return headers;
}

export function google2DTileUrl(layer: MapLayer | 'sv-overlay', z: number, x: number, y: number): string {
  const googleKey = getGoogleMapsKey();
  const base = `/api/gmap/tile/${layer}/${z}/${x}/${y}`;
  return googleKey ? `${base}?gkey=${encodeURIComponent(googleKey)}` : base;
}

export function googleStreetViewTileUrl(panoId: string, z: number, x: number, y: number): string {
  const params = new URLSearchParams({ panoId });
  const googleKey = getGoogleMapsKey();
  if (googleKey) params.set('gkey', googleKey);
  return `/api/gmap/streetview/tile/${z}/${x}/${y}?${params.toString()}`;
}

export function googleStreetViewThumbUrl(panoId: string): string {
  return googleStreetViewTileUrl(panoId, 0, 0, 0);
}

export async function fetchServerConfig(): Promise<ServerConfig> {
  try {
    const res = await fetch('/api/config', { headers: buildApiHeaders() });
    if (!res.ok) return { googleEnabled: Boolean(getGoogleMapsKey()), source: getGoogleMapsKey() ? 'client' : 'none' };
    return (await res.json()) as ServerConfig;
  } catch {
    return { googleEnabled: Boolean(getGoogleMapsKey()), source: getGoogleMapsKey() ? 'client' : 'none' };
  }
}

export async function testGoogleMapsKey(key: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/api/gmap/verify', {
    headers: {
      Accept: 'application/json',
      'X-Google-Maps-Key': key.trim(),
    },
  });
  return (await res.json()) as { ok: boolean; error?: string };
}

export async function searchPanoramasNear(
  lat: number,
  lon: number,
  radiusMeters = 250,
  signal?: AbortSignal
): Promise<PanoramaSearchResponse> {
  const params = new URLSearchParams({
    lat: lat.toFixed(6),
    lon: lon.toFixed(6),
    radius: String(Math.round(radiusMeters)),
  });
  const res = await fetch(`/api/panoramas?${params.toString()}`, {
    headers: buildApiHeaders(),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Panorama search failed (${res.status})`);
  }
  return (await res.json()) as PanoramaSearchResponse;
}

export async function fetchPanoramaById(
  id: string,
  collection?: string,
  provider: ImageryProvider = 'google',
  signal?: AbortSignal
): Promise<PanoramaItem> {
  const params = new URLSearchParams({ id, provider });
  if (collection) params.set('collection', collection);
  const res = await fetch(`/api/panorama?${params.toString()}`, {
    headers: buildApiHeaders(),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Panorama fetch failed (${res.status})`);
  }
  return (await res.json()) as PanoramaItem;
}

export async function geocodePlace(query: string, signal?: AbortSignal): Promise<GeocodeResult[]> {
  const q = query.trim();
  if (!q) return [];
  const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, {
    headers: buildApiHeaders(),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Geocode failed (${res.status})`);
  }
  const data = (await res.json()) as { results: GeocodeResult[] };
  return data.results ?? [];
}
