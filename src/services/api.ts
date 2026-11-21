import type { GeocodeResult, PanoramaItem, PanoramaSearchResponse } from '../types';

const STORAGE_MAPILLARY_KEY = 'earthxr_mapillary_token';

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
    // ignore storage errors in restricted contexts
  }
}

export function proxyImageUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  if (rawUrl.startsWith('/api/image-proxy')) return rawUrl;
  return `/api/image-proxy?url=${encodeURIComponent(rawUrl)}`;
}

function buildApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getMapillaryToken();
  if (token) {
    headers['X-Mapillary-Token'] = token;
  }
  return headers;
}

export async function searchPanoramasNear(
  lat: number,
  lon: number,
  radiusMeters = 500,
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
  provider: 'panoramax' | 'mapillary' = 'panoramax',
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
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) {
    throw new Error(`Geocode failed (${res.status})`);
  }
  const data = (await res.json()) as { results: GeocodeResult[] };
  return data.results ?? [];
}
