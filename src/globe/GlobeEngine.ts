import * as THREE from 'three';
import type { GeoPoint, GlobeState, MapLayer } from '../types';
import {
  clampLat,
  DEG2RAD,
  EARTH_RADIUS_KM,
  latLonToTileXY,
  latLonToUnitVec,
  mercatorYToLat,
  shortestLonDelta,
  tileBounds,
  unitVecToLatLon,
  wrapLon,
} from '../services/geo';
import { TileManager } from './TileManager';

interface TileMeshEntry {
  key: string;
  z: number;
  x: number;
  y: number;
  layer: MapLayer;
  centerUnit: THREE.Vector3;
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  loaded: boolean;
  fade: number;
}

interface FlyAnimation {
  startLat: number;
  startLon: number;
  startAlt: number;
  endLat: number;
  endLon: number;
  endAlt: number;
  peakAlt: number;
  startTime: number;
  durationSec: number;
  onComplete?: () => void;
}

export const MIN_ALTITUDE_KM = 0.22;
export const MAX_ALTITUDE_KM = 17500;
export const FOCUS_DIST_M = 2.05;
export const ANCHOR_Y_M = 1.38;

const ATMOSPHERE_VERTEX = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewPos;
  void main() {
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vViewPos = -mvPos.xyz;
    gl_Position = projectionMatrix * mvPos;
  }
`;

const ATMOSPHERE_FRAGMENT = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  void main() {
    vec3 viewDir = normalize(vViewPos);
    float ndotv = clamp(dot(normalize(vNormal), viewDir), 0.0, 1.0);
    float fresnel = pow(1.0 - ndotv, 2.8);
    vec3 innerCol = vec3(0.24, 0.65, 1.0);
    vec3 outerCol = vec3(0.45, 0.85, 1.0);
    vec3 col = mix(innerCol, outerCol, fresnel);
    float alpha = fresnel * 0.78 * uOpacity;
    gl_FragColor = vec4(col, alpha);
  }
`;

function createCloudTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);

  // Soft wispy atmospheric cloud bands
  let seed = 4219;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  for (let i = 0; i < 240; i++) {
    const cx = rand() * w;
    const cy = 22 + rand() * (h - 44);
    const rx = 18 + rand() * 54;
    const ry = 4 + rand() * 14;
    const alpha = 0.04 + rand() * 0.09;
    const grad = ctx.createRadialGradient(cx, cy, 1, cx, cy, rx);
    grad.addColorStop(0, `rgba(255,255,255,${alpha.toFixed(3)})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function createStarfield(): THREE.Points {
  const count = 4200;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  let seed = 918273;
  const rand = () => {
    seed = (seed * 48271) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  for (let i = 0; i < count; i++) {
    const u = rand() * 2 - 1;
    const theta = rand() * Math.PI * 2;
    const r = 140 + rand() * 120;
    const sqrtOneMinusU2 = Math.sqrt(Math.max(0, 1 - u * u));
    positions[i * 3] = r * sqrtOneMinusU2 * Math.cos(theta);
    positions[i * 3 + 1] = r * u;
    positions[i * 3 + 2] = r * sqrtOneMinusU2 * Math.sin(theta);

    const tint = rand();
    const brightness = 0.45 + rand() * 0.55;
    if (tint < 0.25) {
      colors[i * 3] = 0.72 * brightness;
      colors[i * 3 + 1] = 0.85 * brightness;
      colors[i * 3 + 2] = 1.0 * brightness;
    } else if (tint > 0.82) {
      colors[i * 3] = 1.0 * brightness;
      colors[i * 3 + 1] = 0.9 * brightness;
      colors[i * 3 + 2] = 0.75 * brightness;
    } else {
      colors[i * 3] = brightness;
      colors[i * 3 + 1] = brightness;
      colors[i * 3 + 2] = brightness;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.PointsMaterial({
    size: 0.75,
    vertexColors: true,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    sizeAttenuation: true,
  });

  return new THREE.Points(geo, mat);
}

/**
 * Builds a Mercator-accurate spherical patch geometry centered around its own unit center
 * (in float64 before writing float32 vertex buffers) so street-level zoom has sub-millimeter precision.
 */
function buildTileGeometry(
  z: number,
  x: number,
  y: number,
  radialMultiplier: number
): { geometry: THREE.BufferGeometry; centerUnit: THREE.Vector3 } {
  const n = Math.pow(2, z);
  const segs = z <= 2 ? 18 : z <= 4 ? 12 : z <= 7 ? 6 : 4;
  const lonMin = (x / n) * 360 - 180;
  const lonMax = ((x + 1) / n) * 360 - 180;

  const bounds = tileBounds(z, x, y);
  const centerUnit = latLonToUnitVec(bounds.centerLat, bounds.centerLon);

  const vertCount = (segs + 1) * (segs + 1);
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices: number[] = [];

  let vi = 0;
  let ui = 0;
  for (let iy = 0; iy <= segs; iy++) {
    // v = 1 at top (north, y), v = 0 at bottom (south, y+1)
    const v = 1 - iy / segs;
    const yNorm = (y + iy / segs) / n;
    const lat = mercatorYToLat(yNorm);
    const phi = lat * DEG2RAD;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);

    for (let ix = 0; ix <= segs; ix++) {
      const u = ix / segs;
      const lon = lonMin + (lonMax - lonMin) * u;
      const lam = lon * DEG2RAD;

      const px = cosPhi * Math.sin(lam) * radialMultiplier;
      const py = sinPhi * radialMultiplier;
      const pz = cosPhi * Math.cos(lam) * radialMultiplier;

      positions[vi++] = px - centerUnit.x;
      positions[vi++] = py - centerUnit.y;
      positions[vi++] = pz - centerUnit.z;

      uvs[ui++] = u;
      uvs[ui++] = v;
    }
  }

  for (let iy = 0; iy < segs; iy++) {
    for (let ix = 0; ix < segs; ix++) {
      const a = iy * (segs + 1) + ix;
      const b = a + 1;
      const c = (iy + 1) * (segs + 1) + ix;
      const d = c + 1;
      // Front-facing outward from Earth center: (a, c, b) and (b, c, d)
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  return { geometry, centerUnit };
}

export class GlobeEngine {
  public readonly root = new THREE.Group();
  public readonly globeGroup = new THREE.Group();
  public readonly tileGroup = new THREE.Group();
  public readonly starfield: THREE.Points;

  private tileManager: TileManager;
  private activeTiles = new Map<string, TileMeshEntry>();

  private coreSphere: THREE.Mesh;
  private atmosphereMesh: THREE.Mesh;
  private atmosphereMat: THREE.ShaderMaterial;
  private cloudMesh: THREE.Mesh;
  private cloudMat: THREE.MeshBasicMaterial;
  private reticleRing: THREE.Mesh;

  private state: GlobeState = {
    lat: 26,
    lon: -18,
    altitudeKm: 13800,
    headingDeg: 0,
    tiltDeg: 0,
  };

  private targetState: GlobeState = { ...this.state };
  private layer: MapLayer = 'hybrid';
  private flyAnim: FlyAnimation | null = null;
  private anchorUnit = new THREE.Vector3(0, 0, 1);
  private visualRadiusM = 0.95;
  private lastTileSyncTime = -1;
  private isSpinningIdle = true;

  private readonly tmpQuatY = new THREE.Quaternion();
  private readonly tmpQuatX = new THREE.Quaternion();
  private readonly tmpQuatH = new THREE.Quaternion();
  private readonly tmpQuatT = new THREE.Quaternion();
  private readonly axisX = new THREE.Vector3(1, 0, 0);
  private readonly axisY = new THREE.Vector3(0, 1, 0);
  private readonly axisZ = new THREE.Vector3(0, 0, 1);

  constructor(maxAnisotropy = 4) {
    this.tileManager = new TileManager(maxAnisotropy);

    this.starfield = createStarfield();
    this.root.add(this.starfield);

    this.globeGroup.position.set(0, ANCHOR_Y_M, -FOCUS_DIST_M);
    this.root.add(this.globeGroup);
    this.globeGroup.add(this.tileGroup);

    // Base ocean / polar cap sphere beneath tiles
    const coreGeo = new THREE.SphereGeometry(0.9988, 48, 36);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0x09182e });
    this.coreSphere = new THREE.Mesh(coreGeo, coreMat);
    this.coreSphere.renderOrder = 0;
    this.globeGroup.add(this.coreSphere);

    // Cloud shell
    const cloudGeo = new THREE.SphereGeometry(1.007, 48, 36);
    this.cloudMat = new THREE.MeshBasicMaterial({
      map: createCloudTexture(),
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    this.cloudMesh = new THREE.Mesh(cloudGeo, this.cloudMat);
    this.cloudMesh.renderOrder = 12;
    this.globeGroup.add(this.cloudMesh);

    // Atmosphere Fresnel halo
    const atmoGeo = new THREE.SphereGeometry(1.036, 48, 36);
    this.atmosphereMat = new THREE.ShaderMaterial({
      vertexShader: ATMOSPHERE_VERTEX,
      fragmentShader: ATMOSPHERE_FRAGMENT,
      uniforms: { uOpacity: { value: 1.0 } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
      depthWrite: false,
    });
    this.atmosphereMesh = new THREE.Mesh(atmoGeo, this.atmosphereMat);
    this.atmosphereMesh.renderOrder = 14;
    this.globeGroup.add(this.atmosphereMesh);

    // Center focus reticle (visible when zoomed closer toward a city)
    const reticleGeo = new THREE.RingGeometry(0.028, 0.036, 40);
    const reticleMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    this.reticleRing = new THREE.Mesh(reticleGeo, reticleMat);
    this.reticleRing.position.set(0, ANCHOR_Y_M, -FOCUS_DIST_M + 0.015);
    this.reticleRing.renderOrder = 30;
    this.root.add(this.reticleRing);

    this.applyGlobeTransform();
    this.syncTiles(true);
  }

  public getState(): GlobeState {
    return { ...this.state };
  }

  public getTargetState(): GlobeState {
    return { ...this.targetState };
  }

  public getLayer(): MapLayer {
    return this.layer;
  }

  public getAnchorUnit(): THREE.Vector3 {
    return this.anchorUnit;
  }

  public getVisualRadiusM(): number {
    return this.visualRadiusM;
  }

  public getSurfaceRadialOffset(): number {
    const z = this.computeDesiredZoom();
    return 1 + (z - 2) * 0.00045 + 0.0005;
  }

  public setLayer(layer: MapLayer): void {
    if (this.layer === layer) return;
    this.layer = layer;
    // Clear existing tiles cleanly so new layer streams immediately
    for (const entry of this.activeTiles.values()) {
      this.tileGroup.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      entry.material.dispose();
    }
    this.activeTiles.clear();
    this.syncTiles(true);
  }

  public stopIdleSpin(): void {
    this.isSpinningIdle = false;
  }

  public panByDegrees(dLat: number, dLon: number): void {
    this.isSpinningIdle = false;
    this.flyAnim = null;
    this.targetState.lat = clampLat(this.targetState.lat + dLat);
    this.targetState.lon = wrapLon(this.targetState.lon + dLon);
  }

  public zoomByFactor(factor: number): void {
    this.isSpinningIdle = false;
    this.flyAnim = null;
    this.targetState.altitudeKm = THREE.MathUtils.clamp(
      this.targetState.altitudeKm * factor,
      MIN_ALTITUDE_KM,
      MAX_ALTITUDE_KM
    );
  }

  public setAltitude(altitudeKm: number): void {
    this.isSpinningIdle = false;
    this.flyAnim = null;
    this.targetState.altitudeKm = THREE.MathUtils.clamp(
      altitudeKm,
      MIN_ALTITUDE_KM,
      MAX_ALTITUDE_KM
    );
  }

  public rotateHeading(deltaDeg: number): void {
    this.isSpinningIdle = false;
    this.targetState.headingDeg = (this.targetState.headingDeg + deltaDeg) % 360;
  }

  public resetView(): void {
    this.flyTo(26, -18, 13800, 1.5);
    this.targetState.headingDeg = 0;
  }

  public flyTo(
    lat: number,
    lon: number,
    altitudeKm: number,
    durationSec = 1.85,
    onComplete?: () => void
  ): void {
    this.isSpinningIdle = false;
    const clampedLat = clampLat(lat);
    const wrappedLon = wrapLon(lon);
    const clampedAlt = THREE.MathUtils.clamp(altitudeKm, MIN_ALTITUDE_KM, MAX_ALTITUDE_KM);

    const angularDist = Math.hypot(
      clampedLat - this.state.lat,
      shortestLonDelta(this.state.lon, wrappedLon)
    );
    const arcBoost = angularDist > 12 ? Math.min(9500, angularDist * 110) : 0;
    const peakAlt = Math.max(this.state.altitudeKm, clampedAlt, arcBoost);

    this.flyAnim = {
      startLat: this.state.lat,
      startLon: this.state.lon,
      startAlt: this.state.altitudeKm,
      endLat: clampedLat,
      endLon: wrappedLon,
      endAlt: clampedAlt,
      peakAlt,
      startTime: performance.now() / 1000,
      durationSec: Math.max(0.5, durationSec),
      onComplete,
    };
    this.targetState.lat = clampedLat;
    this.targetState.lon = wrappedLon;
    this.targetState.altitudeKm = clampedAlt;
  }

  public unitToGlobeLocal(unitVec: THREE.Vector3, radialOffset = 1.0, out = new THREE.Vector3()): THREE.Vector3 {
    out.set(
      (unitVec.x * radialOffset - this.anchorUnit.x) * this.visualRadiusM,
      (unitVec.y * radialOffset - this.anchorUnit.y) * this.visualRadiusM,
      (unitVec.z * radialOffset - this.anchorUnit.z) * this.visualRadiusM
    );
    return out;
  }

  public raycastGlobe(raycaster: THREE.Raycaster): { lat: number; lon: number; worldPoint: THREE.Vector3 } | null {
    // Analytic ray-sphere intersection with exact tilted globe center in world space
    const centerWorld = this.anchorUnit
      .clone()
      .multiplyScalar(-this.visualRadiusM);
    this.globeGroup.localToWorld(centerWorld);
    const sphere = new THREE.Sphere(centerWorld, this.visualRadiusM);
    const hitWorld = new THREE.Vector3();
    if (!raycaster.ray.intersectSphere(sphere, hitWorld)) {
      return null;
    }
    const localHit = this.globeGroup.worldToLocal(hitWorld.clone());
    const unitVec = new THREE.Vector3(
      localHit.x / this.visualRadiusM + this.anchorUnit.x,
      localHit.y / this.visualRadiusM + this.anchorUnit.y,
      localHit.z / this.visualRadiusM + this.anchorUnit.z
    ).normalize();
    const { lat, lon } = unitVecToLatLon(unitVec);
    return { lat, lon, worldPoint: hitWorld };
  }

  public update(dt: number, elapsedSec: number): void {
    const safeDt = Math.min(0.05, Math.max(0.001, dt));

    if (this.flyAnim) {
      const tRaw = (elapsedSec - this.flyAnim.startTime) / this.flyAnim.durationSec;
      const t = THREE.MathUtils.clamp(tRaw, 0, 1);
      // Smooth cubic ease in-out
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

      this.state.lat = this.flyAnim.startLat + (this.flyAnim.endLat - this.flyAnim.startLat) * ease;
      const dLon = shortestLonDelta(this.flyAnim.startLon, this.flyAnim.endLon);
      this.state.lon = wrapLon(this.flyAnim.startLon + dLon * ease);

      // Logarithmic altitude interpolation with smooth orbital arc
      const logStart = Math.log(this.flyAnim.startAlt);
      const logEnd = Math.log(this.flyAnim.endAlt);
      const logPeak = Math.log(this.flyAnim.peakAlt);
      const arcWeight = Math.sin(t * Math.PI);
      const baseLog = logStart + (logEnd - logStart) * ease;
      const arcLog = Math.max(baseLog, logPeak);
      this.state.altitudeKm = Math.exp(baseLog + (arcLog - baseLog) * arcWeight * 0.55);

      if (t >= 1) {
        const done = this.flyAnim.onComplete;
        this.flyAnim = null;
        this.state.lat = this.targetState.lat;
        this.state.lon = this.targetState.lon;
        this.state.altitudeKm = this.targetState.altitudeKm;
        done?.();
      }
    } else {
      if (this.isSpinningIdle && this.state.altitudeKm > 7000) {
        this.targetState.lon = wrapLon(this.targetState.lon + safeDt * 2.2);
      }

      const smooth = 1 - Math.exp(-9.5 * safeDt);
      this.state.lat += (this.targetState.lat - this.state.lat) * smooth;
      this.state.lon = wrapLon(
        this.state.lon + shortestLonDelta(this.state.lon, this.targetState.lon) * smooth
      );

      const logCur = Math.log(this.state.altitudeKm);
      const logTar = Math.log(this.targetState.altitudeKm);
      this.state.altitudeKm = Math.exp(logCur + (logTar - logCur) * smooth);

      const dH = ((this.targetState.headingDeg - this.state.headingDeg + 540) % 360) - 180;
      this.state.headingDeg += dH * smooth;
    }

    this.applyGlobeTransform();

    // Gentle cloud drift & altitude fade
    this.cloudMesh.rotation.y = elapsedSec * 0.008;
    const cloudFade = THREE.MathUtils.smoothstep(this.state.altitudeKm, 900, 3800);
    this.cloudMat.opacity = 0.36 * cloudFade;
    this.cloudMesh.visible = cloudFade > 0.01;

    const atmoFade = THREE.MathUtils.smoothstep(this.state.altitudeKm, 450, 2600);
    this.atmosphereMat.uniforms.uOpacity.value = atmoFade;
    this.atmosphereMesh.visible = atmoFade > 0.01;

    // Reticle ring fades in smoothly as you zoom closer to a city
    const reticleFade = 1 - THREE.MathUtils.smoothstep(this.state.altitudeKm, 25, 180);
    const reticleMat = this.reticleRing.material as THREE.MeshBasicMaterial;
    reticleMat.opacity = reticleFade * (0.45 + 0.18 * Math.sin(elapsedSec * 3.2));
    this.reticleRing.visible = reticleFade > 0.02;
    const pulse = 1 + 0.08 * Math.sin(elapsedSec * 3.2);
    this.reticleRing.scale.setScalar(pulse);

    // Smooth fade-in of newly loaded high-res tiles
    for (const entry of this.activeTiles.values()) {
      if (entry.loaded && entry.fade < 1) {
        entry.fade = Math.min(1, entry.fade + safeDt * 5.0);
        entry.material.opacity = entry.fade;
        if (entry.fade >= 1) {
          entry.material.transparent = false;
        }
      }
    }

    // Periodically sync required quadtree tiles
    if (elapsedSec - this.lastTileSyncTime > 0.14) {
      this.lastTileSyncTime = elapsedSec;
      this.syncTiles(false);
    }
  }

  private applyGlobeTransform(): void {
    latLonToUnitVec(this.state.lat, this.state.lon, this.anchorUnit);
    this.visualRadiusM = FOCUS_DIST_M * (EARTH_RADIUS_KM / this.state.altitudeKm);

    // Orient globe so anchorUnit maps cleanly to (0, 0, +1) facing the user
    this.tmpQuatY.setFromAxisAngle(this.axisY, -this.state.lon * DEG2RAD);
    this.tmpQuatX.setFromAxisAngle(this.axisX, this.state.lat * DEG2RAD);
    this.tmpQuatH.setFromAxisAngle(this.axisZ, this.state.headingDeg * DEG2RAD);

    // Slight gentle tilt when descending close to ground (desktop/VR comfortable horizon)
    const autoTilt = (1 - THREE.MathUtils.smoothstep(this.state.altitudeKm, 1.5, 45)) * 10;
    this.tmpQuatT.setFromAxisAngle(this.axisX, -autoTilt * DEG2RAD);

    this.globeGroup.quaternion
      .copy(this.tmpQuatT)
      .multiply(this.tmpQuatH)
      .multiply(this.tmpQuatX)
      .multiply(this.tmpQuatY);

    // Floating-origin placement of core, cloud, and atmosphere spheres (center is at -anchorUnit * R)
    const cx = -this.anchorUnit.x * this.visualRadiusM;
    const cy = -this.anchorUnit.y * this.visualRadiusM;
    const cz = -this.anchorUnit.z * this.visualRadiusM;

    this.coreSphere.position.set(cx, cy, cz);
    this.coreSphere.scale.setScalar(this.visualRadiusM);

    this.cloudMesh.position.set(cx, cy, cz);
    this.cloudMesh.scale.setScalar(this.visualRadiusM);

    this.atmosphereMesh.position.set(cx, cy, cz);
    this.atmosphereMesh.scale.setScalar(this.visualRadiusM);

    // Floating-origin placement of every active tile mesh using exact JS float64 delta!
    for (const entry of this.activeTiles.values()) {
      entry.mesh.position.set(
        (entry.centerUnit.x - this.anchorUnit.x) * this.visualRadiusM,
        (entry.centerUnit.y - this.anchorUnit.y) * this.visualRadiusM,
        (entry.centerUnit.z - this.anchorUnit.z) * this.visualRadiusM
      );
      entry.mesh.scale.setScalar(this.visualRadiusM);
    }
  }

  private computeDesiredZoom(): number {
    const cosLat = Math.max(0.25, Math.cos(this.state.lat * DEG2RAD));
    const rawZ = Math.log2((40075 * cosLat) / (this.state.altitudeKm * 0.42));
    return THREE.MathUtils.clamp(Math.round(rawZ), 2, 17);
  }

  private syncTiles(force: boolean): void {
    const targetZ = this.computeDesiredZoom();
    const desiredKeys = new Set<string>();

    // Always keep base level z=2 (4x4 = 16 tiles covering the entire globe)
    const addRing = (z: number, halfSpan: number, basePriority: number) => {
      const n = Math.pow(2, z);
      if (z === 2) {
        for (let y = 0; y < n; y++) {
          for (let x = 0; x < n; x++) {
            const key = this.tileManager.getKey(this.layer, z, x, y);
            desiredKeys.add(key);
            this.ensureTileMesh(z, x, y, basePriority);
          }
        }
        return;
      }

      const center = latLonToTileXY(this.state.lat, this.state.lon, z);
      for (let dy = -halfSpan; dy <= halfSpan; dy++) {
        const ty = center.y + dy;
        if (ty < 0 || ty >= n) continue;
        for (let dx = -halfSpan; dx <= halfSpan; dx++) {
          const tx = ((center.x + dx) % n + n) % n;
          const dist = Math.hypot(dx, dy);
          if (dist > halfSpan + 0.55) continue;
          const key = this.tileManager.getKey(this.layer, z, tx, ty);
          desiredKeys.add(key);
          this.ensureTileMesh(z, tx, ty, basePriority + dist);
        }
      }
    };

    // Base shell z=2 always present
    addRing(2, 2, 100);

    // Mid-level bridge so rapid zooming never reveals blurry z=2 tiles
    if (targetZ >= 5) {
      const midZ = Math.max(3, targetZ - 2);
      addRing(midZ, 2, 40);
    }

    // Target sharp resolution ring around focus point
    if (targetZ >= 3) {
      const span = targetZ <= 4 ? 3 : 2;
      addRing(targetZ, span, 0);
    }

    // Remove out-of-view tile meshes
    for (const [key, entry] of this.activeTiles) {
      if (!desiredKeys.has(key)) {
        this.tileGroup.remove(entry.mesh);
        entry.mesh.geometry.dispose();
        entry.material.dispose();
        this.activeTiles.delete(key);
      }
    }

    if (!force) {
      this.tileManager.pruneQueue(desiredKeys);
    }
  }

  private ensureTileMesh(z: number, x: number, y: number, priority: number): void {
    const key = this.tileManager.getKey(this.layer, z, x, y);
    if (this.activeTiles.has(key)) return;

    const radialMult = 1 + (z - 2) * 0.00045;
    const { geometry, centerUnit } = buildTileGeometry(z, x, y, radialMult);
    const cachedTex = this.tileManager.getCached(this.layer, z, x, y);

    const material = new THREE.MeshBasicMaterial({
      map: cachedTex ?? undefined,
      color: 0xffffff,
      transparent: !cachedTex,
      opacity: cachedTex ? 1.0 : 0.0,
      depthWrite: z === 2 || Boolean(cachedTex),
      polygonOffset: z > 2,
      polygonOffsetFactor: -(z - 2) * 2,
      polygonOffsetUnits: -(z - 2) * 2,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = z;
    mesh.visible = Boolean(cachedTex);
    mesh.position.set(
      (centerUnit.x - this.anchorUnit.x) * this.visualRadiusM,
      (centerUnit.y - this.anchorUnit.y) * this.visualRadiusM,
      (centerUnit.z - this.anchorUnit.z) * this.visualRadiusM
    );
    mesh.scale.setScalar(this.visualRadiusM);
    this.tileGroup.add(mesh);

    const entry: TileMeshEntry = {
      key,
      z,
      x,
      y,
      layer: this.layer,
      centerUnit,
      mesh,
      material,
      loaded: Boolean(cachedTex),
      fade: cachedTex ? 1.0 : 0.0,
    };
    this.activeTiles.set(key, entry);

    if (!cachedTex) {
      this.tileManager.requestTile(this.layer, z, x, y, priority, (tex) => {
        const cur = this.activeTiles.get(key);
        if (!cur || !tex) return;
        cur.material.map = tex;
        cur.material.needsUpdate = true;
        cur.material.transparent = true;
        cur.material.opacity = z === 2 ? 1.0 : 0.05;
        cur.material.depthWrite = z === 2;
        cur.loaded = true;
        cur.fade = z === 2 ? 1.0 : 0.05;
        cur.mesh.visible = true;
      });
    }
  }

  public dispose(): void {
    for (const entry of this.activeTiles.values()) {
      entry.mesh.geometry.dispose();
      entry.material.dispose();
    }
    this.activeTiles.clear();
    this.tileManager.dispose();
  }
}
