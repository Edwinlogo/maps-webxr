export type MapLayer = 'satellite' | 'hybrid' | 'streets';

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface ServerConfig {
  googleConfigured: boolean;
  googleSource: 'server' | 'client' | 'none';
  googleActive: boolean;
  approxLocation?: {
    lat: number;
    lon: number;
    label?: string;
  };
}

export interface GeocodeResult {
  name: string;
  displayName: string;
  lat: number;
  lon: number;
  type: string;
}

export interface GlobeState {
  lat: number;
  lon: number;
  altitudeKm: number;
  headingDeg: number;
  tiltDeg: number;
}
