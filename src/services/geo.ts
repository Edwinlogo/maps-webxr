import * as THREE from 'three';
import type { GeoPoint } from '../types';

export const EARTH_RADIUS_KM = 6371.0088;
export const EARTH_RADIUS_M = 6371008.8;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const MAX_MERCATOR_LAT = 85.05112878;

export function clampLat(lat: number): number {
  return Math.max(-85, Math.min(85, lat));
}

export function wrapLon(lon: number): number {
  let wrapped = ((lon + 180) % 360 + 360) % 360 - 180;
  if (wrapped === -180 && lon > 0) wrapped = 180;
  return wrapped;
}

/**
 * Right-handed unit sphere vector:
 * +Y = North Pole (lat +90)
 * +Z = Prime Meridian (lat 0, lon 0)
 * +X = 90° East (lat 0, lon +90)
 */
export function latLonToUnitVec(lat: number, lon: number, target = new THREE.Vector3()): THREE.Vector3 {
  const phi = lat * DEG2RAD;
  const lam = lon * DEG2RAD;
  const cosPhi = Math.cos(phi);
  target.set(
    cosPhi * Math.sin(lam),
    Math.sin(phi),
    cosPhi * Math.cos(lam)
  );
  return target;
}

export function unitVecToLatLon(vec: THREE.Vector3): GeoPoint {
  const len = vec.length();
  if (len === 0) return { lat: 0, lon: 0 };
  const ny = THREE.MathUtils.clamp(vec.y / len, -1, 1);
  const lat = Math.asin(ny) * RAD2DEG;
  const lon = Math.atan2(vec.x / len, vec.z / len) * RAD2DEG;
  return { lat, lon: wrapLon(lon) };
}

export function latLonToTileXY(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = Math.pow(2, z);
  const clampedLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const latRad = clampedLat * DEG2RAD;
  const x = Math.floor(((wrapLon(lon) + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return {
    x: ((x % n) + n) % n,
    y: Math.max(0, Math.min(n - 1, y)),
  };
}

export function mercatorYToLat(yNorm: number): number {
  const n = Math.PI * (1 - 2 * yNorm);
  return Math.atan(Math.sinh(n)) * RAD2DEG;
}

export function tileBounds(z: number, x: number, y: number): {
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
  centerLat: number;
  centerLon: number;
} {
  const n = Math.pow(2, z);
  const lonMin = (x / n) * 360 - 180;
  const lonMax = ((x + 1) / n) * 360 - 180;
  const latMax = mercatorYToLat(y / n);
  const latMin = mercatorYToLat((y + 1) / n);
  const centerLat = mercatorYToLat((y + 0.5) / n);
  const centerLon = (lonMin + lonMax) * 0.5;
  return { lonMin, lonMax, latMin, latMax, centerLat, centerLon };
}

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

/**
 * Initial compass bearing in degrees [0, 360) from point 1 to point 2.
 * 0 = North, 90 = East, 180 = South, 270 = West.
 */
export function bearingDegrees(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = lat1 * DEG2RAD;
  const phi2 = lat2 * DEG2RAD;
  const dLam = (lon2 - lon1) * DEG2RAD;
  const y = Math.sin(dLam) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLam);
  return ((Math.atan2(y, x) * RAD2DEG) + 360) % 360;
}

export function formatCoords(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'O';
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lon).toFixed(4)}° ${ew}`;
}

export function formatAltitude(altitudeKm: number): string {
  if (altitudeKm >= 1000) return `${(altitudeKm / 1000).toFixed(1)}k km`;
  if (altitudeKm >= 10) return `${Math.round(altitudeKm)} km`;
  if (altitudeKm >= 1) return `${altitudeKm.toFixed(1)} km`;
  return `${Math.round(altitudeKm * 1000)} m`;
}

export function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

export function shortestLonDelta(fromLon: number, toLon: number): number {
  return ((toLon - fromLon + 540) % 360) - 180;
}
