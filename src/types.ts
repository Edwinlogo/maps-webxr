export type AppMode = 'globe' | 'streetview';

export type MapLayer = 'satellite' | 'hybrid' | 'streets';

export type ImageryProvider = 'google' | 'panoramax' | 'mapillary';

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface ServerConfig {
  googleConfigured: boolean;
  googleSource: 'server' | 'client' | 'none';
  googleActive: boolean;
  mapillaryConfigured: boolean;
}

export interface PanoramaLink {
  rel: 'next' | 'prev' | 'related';
  id: string;
  collection?: string;
  lat?: number;
  lon?: number;
  bearingDeg: number;
  distanceMeters?: number;
  text?: string;
}

export interface PanoramaItem {
  id: string;
  collection?: string;
  lat: number;
  lon: number;
  azimuth: number;
  tilt?: number;
  roll?: number;
  distanceMeters: number;
  sdUrl?: string;
  hdUrl?: string;
  thumbUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  tileWidth?: number;
  tileHeight?: number;
  capturedAt?: string;
  address?: string;
  copyright?: string;
  provider: ImageryProvider;
  sourceHost?: string;
  license?: string;
  links: PanoramaLink[];
}

export interface PanoramaSearchResponse {
  query: {
    lat: number;
    lon: number;
    radiusMeters: number;
  };
  searchRadiusUsed: number;
  provider: ImageryProvider;
  items: PanoramaItem[];
  googleError?: string;
}

export interface GeocodeResult {
  name: string;
  displayName: string;
  lat: number;
  lon: number;
  type: string;
}

export interface Landmark {
  id: string;
  name: string;
  city: string;
  country: string;
  region: string;
  lat: number;
  lon: number;
  defaultAltitudeKm: number;
  verified360Id?: string;
  description: string;
}

export interface GlobeState {
  lat: number;
  lon: number;
  altitudeKm: number;
  headingDeg: number;
  tiltDeg: number;
}
