export type AppMode = 'globe' | 'streetview';

export type MapLayer = 'satellite' | 'hybrid' | 'streets';

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface PanoramaLink {
  rel: 'next' | 'prev' | 'related';
  id: string;
  collection?: string;
  lat: number;
  lon: number;
  bearingDeg: number;
  distanceMeters: number;
}

export interface PanoramaItem {
  id: string;
  collection?: string;
  lat: number;
  lon: number;
  azimuth: number;
  distanceMeters: number;
  sdUrl: string;
  hdUrl: string;
  thumbUrl?: string;
  capturedAt?: string;
  provider: 'panoramax' | 'mapillary';
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
  provider: 'panoramax' | 'mapillary';
  items: PanoramaItem[];
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
  lat: number;
  lon: number;
  region: string;
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
