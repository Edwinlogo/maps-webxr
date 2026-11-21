import type { GeocodeResult, MapLayer, ServerConfig } from '../types';

const STORAGE_GOOGLE_KEY = 'earthxr_google_maps_key';
const STORAGE_GOOGLE_ENABLED = 'earthxr_google_maps_enabled';

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

export function isGoogleMapsPreferred(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_GOOGLE_ENABLED);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return Boolean(getGoogleMapsKey());
  } catch {
    return false;
  }
}

export function setGoogleMapsPreferred(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_GOOGLE_ENABLED, enabled ? '1' : '0');
  } catch {
    // ignore storage errors
  }
}

export function buildApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  headers['X-Use-Google-Maps'] = isGoogleMapsPreferred() ? '1' : '0';
  const googleKey = getGoogleMapsKey();
  if (googleKey) headers['X-Google-Maps-Key'] = googleKey;
  return headers;
}

export function google2DTileUrl(layer: MapLayer, z: number, x: number, y: number): string {
  const googleKey = getGoogleMapsKey();
  const base = `/api/gmap/tile/${layer}/${z}/${x}/${y}`;
  return googleKey ? `${base}?gkey=${encodeURIComponent(googleKey)}` : base;
}

export async function fetchServerConfig(): Promise<ServerConfig> {
  try {
    const res = await fetch('/api/config', { headers: buildApiHeaders() });
    if (!res.ok) {
      return {
        googleConfigured: Boolean(getGoogleMapsKey()),
        googleSource: getGoogleMapsKey() ? 'client' : 'none',
        googleActive: isGoogleMapsPreferred() && Boolean(getGoogleMapsKey()),
      };
    }
    return (await res.json()) as ServerConfig;
  } catch {
    return {
      googleConfigured: Boolean(getGoogleMapsKey()),
      googleSource: getGoogleMapsKey() ? 'client' : 'none',
      googleActive: isGoogleMapsPreferred() && Boolean(getGoogleMapsKey()),
    };
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
