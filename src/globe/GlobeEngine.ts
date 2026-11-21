import * as THREE from 'three';
import type { GlobeState, MapLayer } from '../types';
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

export const MIN_ALTITUDE_KM = 0.12;
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
    float fresnel = pow(1.0 - ndotv, 2.75);
    vec3 innerCol = vec3(0.22, 0.62, 1.0);
    vec3 outerCol = vec3(0.46, 0.86, 1.0);
    vec3 col = mix(innerCol, outerCol, fresnel);
    float alpha = fresnel * 0.82 * uOpacity;
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
 * Builds an exact unit-sphere (r = 1.0) Mercator-projected patch centered around its float64 centerUnit.
 * Keeping r = 1.0 strictly prevents radial blow-up at street-level zoom (when visualRadiusM > 50,000 m)!
 */
function buildTileGeometry(
  z: number,
  x: number,
  y: number
): { geometry: THREE.BufferGeometry; centerUnit: THREE.Vector3 } {
  const n = Math.pow(2, z);
  const segs = z <= 2 ? 22 : z <= 3 ? 14 : z <= 5 ? 8 : z <= 8 ? 5 : 3;
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

      const px = cosPhi * Math.sin(lam);
      const py = sinPhi;
      const pz = cosPhi * Math.cos(lam);

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
  public readonly spaceSkyDome: THREE.Mesh;

  private tileManager: TileManager;
  private activeTiles = new Map<string, TileMeshEntry>();

  private coreSphere: THREE.Mesh;
  private atmosphereMesh: THREE.Mesh;
  private atmosphereMat: THREE.ShaderMaterial;
  private cloudMesh: THREE.Mesh;
  private cloudMat: THREE.MeshBasicMaterial;
  private reticleRing: THREE.Mesh;

  private state: GlobeState = {
    lat: 16,
    lon: -52,
    altitudeKm: 13800,
    headingDeg: 0,
    tiltDeg: 0,
  };

  private targetState: GlobeState = { ...this.state };
  private layer: MapLayer = 'hybrid';
  private useGoogle = false;
  private showSvOverlay = true;
  private is3DTiltEnabled = true;
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

  constructor(maxAnisotropy = 8) {
    this.tileManager = new TileManager(maxAnisotropy);

    const skyGeo = new THREE.SphereGeometry(290, 32, 24);
    const skyMat = new THREE.MeshBasicMaterial({
      color: 0x030712,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.spaceSkyDome = new THREE.Mesh(skyGeo, skyMat);
    this.spaceSkyDome.renderOrder = -60;
    this.root.add(this.spaceSkyDome);

    this.starfield = createStarfield();
    this.root.add(this.starfield);

    this.globeGroup.position.set(0, ANCHOR_Y_M, -FOCUS_DIST_M);
    this.root.add(this.globeGroup);
    this.globeGroup.add(this.tileGroup);

    const coreGeo = new THREE.SphereGeometry(0.999, 48, 36);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0x09182e,
      depthWrite: false,
      transparent: true,
      opacity: 1.0,
    });
    this.coreSphere = new THREE.Mesh(coreGeo, coreMat);
    this.coreSphere.renderOrder = 1;
    this.globeGroup.add(this.coreSphere);

    const cloudGeo = new THREE.SphereGeometry(1.008, 48, 36);
    this.cloudMat = new THREE.MeshBasicMaterial({
      map: createCloudTexture(),
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
    });
    this.cloudMesh = new THREE.Mesh(cloudGeo, this.cloudMat);
    this.cloudMesh.renderOrder = 22;
    this.globeGroup.add(this.cloudMesh);

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
    this.atmosphereMesh.renderOrder = 24;
    this.globeGroup.add(this.atmosphereMesh);

    const reticleGeo = new THREE.RingGeometry(0.022, 0.029, 40);
    const reticleMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    this.reticleRing = new THREE.Mesh(reticleGeo, reticleMat);
    this.reticleRing.position.set(0, ANCHOR_Y_M, -FOCUS_DIST_M + 0.02);
    this.reticleRing.renderOrder = 30;
    this.root.add(this.reticleRing);

    this.applyGlobeTransform();
    this.syncTiles(true);
  }

  public getState(): GlobeState {
    return { ...this.state };
  }

  public getLayer(): MapLayer {
    return this.layer;
  }

  public isGoogleMode(): boolean {
    return this.useGoogle;
  }

  public getStreetViewOverlay(): boolean {
    return this.showSvOverlay;
  }

  public isTilt3DEnabled(): boolean {
    return this.is3DTiltEnabled;
  }

  public getAnchorUnit(): THREE.Vector3 {
    return this.anchorUnit;
  }

  public getVisualRadiusM(): number {
    return this.visualRadiusM;
  }

  public setPassthroughMode(enabled: boolean): void {
    this.spaceSkyDome.visible = !enabled;
    this.starfield.visible = !enabled;
  }

  public setGoogleMode(enabled: boolean): void {
    if (this.useGoogle === enabled) return;
    this.useGoogle = enabled;
    this.reloadAllTiles(true);
  }

  public setStreetViewOverlay(enabled: boolean): void {
    if (this.showSvOverlay === enabled) return;
    this.showSvOverlay = enabled;
    if (this.useGoogle) {
      this.reloadAllTiles(false);
    }
  }

  public setLayer(layer: MapLayer): void {
    if (this.layer === layer) return;
    this.layer = layer;
    this.reloadAllTiles(false);
  }

  public toggle3DTilt(): boolean {
    this.is3DTiltEnabled = !this.is3DTiltEnabled;
    if (!this.is3DTiltEnabled) {
      this.targetState.tiltDeg = 0;
    } else if (this.state.altitudeKm < 60) {
      this.targetState.tiltDeg = 32;
    }
    return this.is3DTiltEnabled;
  }

  public adjustTilt(deltaDeg: number): void {
    this.isSpinningIdle = false;
    this.is3DTiltEnabled = true;
    this.targetState.tiltDeg = THREE.MathUtils.clamp(this.targetState.tiltDeg + deltaDeg, 0, 56);
  }

  public resetNorth(): void {
    this.targetState.headingDeg = 0;
  }

  public setImmediatePosition(lat: number, lon: number, altitudeKm: number): void {
    this.isSpinningIdle = false;
    this.flyAnim = null;
    this.state.lat = clampLat(lat);
    this.state.lon = wrapLon(lon);
    this.state.altitudeKm = THREE.MathUtils.clamp(altitudeKm, MIN_ALTITUDE_KM, MAX_ALTITUDE_KM);
    this.targetState = { ...this.state };
    this.applyGlobeTransform();
    this.syncTiles(true);
  }

  public reloadAllTiles(clearCache: boolean): void {
    if (clearCache) {
      this.tileManager.clearCache();
    }
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
    // Account for camera heading so dragging always aligns with screen directions
    const hRad = this.state.headingDeg * DEG2RAD;
    const cosH = Math.cos(hRad);
    const sinH = Math.sin(hRad);
    const rotLat = dLat * cosH - dLon * sinH;
    const rotLon = dLat * sinH + dLon * cosH;
    this.targetState.lat = clampLat(this.targetState.lat + rotLat);
    this.targetState.lon = wrapLon(this.targetState.lon + rotLon);
  }

  public zoomByFactor(factor: number, towardLat?: number, towardLon?: number): void {
    this.isSpinningIdle = false;
    this.flyAnim = null;
    const prevAlt = this.targetState.altitudeKm;
    const nextAlt = THREE.MathUtils.clamp(prevAlt * factor, MIN_ALTITUDE_KM, MAX_ALTITUDE_KM);
    this.targetState.altitudeKm = nextAlt;

    // Google Earth-style zoom toward cursor point when zooming in
    if (factor < 1 && typeof towardLat === 'number' && typeof towardLon === 'number') {
      const pull = THREE.MathUtils.clamp((1 - factor) * 0.55, 0, 0.28);
      this.targetState.lat = clampLat(this.targetState.lat + (towardLat - this.targetState.lat) * pull);
      this.targetState.lon = wrapLon(
        this.targetState.lon + shortestLonDelta(this.targetState.lon, towardLon) * pull
      );
    }
  }

  public rotateHeading(deltaDeg: number): void {
    this.isSpinningIdle = false;
    this.targetState.headingDeg = (this.targetState.headingDeg + deltaDeg) % 360;
  }

  public resetView(): void {
    this.flyTo(16, -52, 13800, 1.5);
    this.targetState.headingDeg = 0;
    this.targetState.tiltDeg = 0;
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
      durationSec: Math.max(0.45, durationSec),
      onComplete,
    };
    this.targetState.lat = clampedLat;
    this.targetState.lon = wrappedLon;
    this.targetState.altitudeKm = clampedAlt;
  }

  /**
   * Projects a unit sphere vector into globeGroup local space with a fixed world-space lift (meters),
   * never scaled by visualRadiusM — guarantees pins stay glued to streets at every zoom level!
   */
  public unitToGlobeLocal(
    unitVec: THREE.Vector3,
    worldLiftMeters = 0.008,
    out = new THREE.Vector3()
  ): THREE.Vector3 {
    out.set(
      (unitVec.x - this.anchorUnit.x) * this.visualRadiusM + unitVec.x * worldLiftMeters,
      (unitVec.y - this.anchorUnit.y) * this.visualRadiusM + unitVec.y * worldLiftMeters,
      (unitVec.z - this.anchorUnit.z) * this.visualRadiusM + unitVec.z * worldLiftMeters
    );
    return out;
  }

  public raycastGlobe(
    raycaster: THREE.Raycaster
  ): { lat: number; lon: number; worldPoint: THREE.Vector3 } | null {
    const centerWorld = this.anchorUnit.clone().multiplyScalar(-this.visualRadiusM);
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
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

      this.state.lat = this.flyAnim.startLat + (this.flyAnim.endLat - this.flyAnim.startLat) * ease;
      const dLon = shortestLonDelta(this.flyAnim.startLon, this.flyAnim.endLon);
      this.state.lon = wrapLon(this.flyAnim.startLon + dLon * ease);

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
        this.targetState.lon = wrapLon(this.targetState.lon + safeDt * 2.0);
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

    // Google Earth automatic gentle 3D perspective tilt as you descend over a city
    const autoTiltTarget = this.is3DTiltEnabled
      ? (1 - THREE.MathUtils.smoothstep(this.state.altitudeKm, 1.0, 45)) * 28
      : 0;
    const desiredTilt = Math.max(autoTiltTarget, this.targetState.tiltDeg);
    const tiltSmooth = 1 - Math.exp(-7 * safeDt);
    this.state.tiltDeg += (desiredTilt - this.state.tiltDeg) * tiltSmooth;

    this.applyGlobeTransform();

    this.cloudMesh.rotation.y = elapsedSec * 0.008;
    const cloudFade = THREE.MathUtils.smoothstep(this.state.altitudeKm, 900, 3800);
    this.cloudMat.opacity = 0.34 * cloudFade;
    this.cloudMesh.visible = cloudFade > 0.01;

    const atmoFade = THREE.MathUtils.smoothstep(this.state.altitudeKm, 450, 2600);
    this.atmosphereMat.uniforms.uOpacity.value = atmoFade;
    this.atmosphereMesh.visible = atmoFade > 0.01;

    const reticleFade = 1 - THREE.MathUtils.smoothstep(this.state.altitudeKm, 20, 140);
    const reticleMat = this.reticleRing.material as THREE.MeshBasicMaterial;
    reticleMat.opacity = reticleFade * (0.4 + 0.16 * Math.sin(elapsedSec * 3.2));
    this.reticleRing.visible = reticleFade > 0.02;
    this.reticleRing.scale.setScalar(1 + 0.07 * Math.sin(elapsedSec * 3.2));

    for (const entry of this.activeTiles.values()) {
      if (entry.loaded && entry.fade < 1) {
        entry.fade = Math.min(1, entry.fade + safeDt * 7.5);
        entry.material.opacity = entry.fade;
      }
    }

    if (elapsedSec - this.lastTileSyncTime > 0.1) {
      this.lastTileSyncTime = elapsedSec;
      this.syncTiles(false);
    }
  }

  private applyGlobeTransform(): void {
    latLonToUnitVec(this.state.lat, this.state.lon, this.anchorUnit);
    this.visualRadiusM = FOCUS_DIST_M * (EARTH_RADIUS_KM / this.state.altitudeKm);

    this.tmpQuatY.setFromAxisAngle(this.axisY, -this.state.lon * DEG2RAD);
    this.tmpQuatX.setFromAxisAngle(this.axisX, this.state.lat * DEG2RAD);
    this.tmpQuatH.setFromAxisAngle(this.axisZ, this.state.headingDeg * DEG2RAD);
    this.tmpQuatT.setFromAxisAngle(this.axisX, -this.state.tiltDeg * DEG2RAD);

    this.globeGroup.quaternion
      .copy(this.tmpQuatT)
      .multiply(this.tmpQuatH)
      .multiply(this.tmpQuatX)
      .multiply(this.tmpQuatY);

    const cx = -this.anchorUnit.x * this.visualRadiusM;
    const cy = -this.anchorUnit.y * this.visualRadiusM;
    const cz = -this.anchorUnit.z * this.visualRadiusM;

    this.coreSphere.position.set(cx, cy, cz);
    this.coreSphere.scale.setScalar(this.visualRadiusM);

    this.cloudMesh.position.set(cx, cy, cz);
    this.cloudMesh.scale.setScalar(this.visualRadiusM);

    this.atmosphereMesh.position.set(cx, cy, cz);
    this.atmosphereMesh.scale.setScalar(this.visualRadiusM);

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
    const cosLat = Math.max(0.2, Math.cos(this.state.lat * DEG2RAD));
    // Crisp Google Earth tile resolution (~6-8 tiles across viewport)
    const rawZ = Math.log2((40075 * cosLat) / (this.state.altitudeKm * 0.2));
    return THREE.MathUtils.clamp(Math.round(rawZ), 2, 18);
  }

  private syncTiles(force: boolean): void {
    const targetZ = this.computeDesiredZoom();
    const desiredKeys = new Set<string>();

    const addRing = (
      z: number,
      halfSpan: number,
      basePriority: number,
      includeOverlays: boolean
    ) => {
      const n = Math.pow(2, z);
      const withSv = this.useGoogle && this.showSvOverlay && z >= 7 && includeOverlays;

      if (z === 2) {
        for (let y = 0; y < n; y++) {
          for (let x = 0; x < n; x++) {
            const key = this.tileManager.getKey(this.layer, z, x, y, this.useGoogle, false);
            desiredKeys.add(key);
            this.ensureTileMesh(z, x, y, false, includeOverlays, basePriority);
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
          const key = this.tileManager.getKey(this.layer, z, tx, ty, this.useGoogle, withSv);
          desiredKeys.add(key);
          this.ensureTileMesh(z, tx, ty, withSv, includeOverlays, basePriority + dist);
        }
      }
    };

    // 1) Enqueue razor-sharp targetZ FIRST (priority 0..) covering full widescreen viewport!
    if (targetZ >= 3) {
      const span = targetZ <= 4 ? 3 : 4;
      addRing(targetZ, span, 0, true);
    }

    // 2) Lightweight satellite-only bridge layer for far tilted horizon & seamless flights
    if (targetZ >= 6) {
      const bridgeZ = Math.max(4, targetZ - 3);
      addRing(bridgeZ, 3, 40, false);
    }

    // 3) Base world shell z=2 (priority 120, labels only when zoomed out!)
    addRing(2, 2, 120, targetZ <= 3);

    for (const [key, entry] of this.activeTiles) {
      if (!desiredKeys.has(key)) {
        this.tileGroup.remove(entry.mesh);
        entry.mesh.geometry.dispose();
        entry.material.dispose();
        this.activeTiles.delete(key);
      }
    }

    // ALWAYS prune stale out-of-view requests BEFORE pumping so rapid flights never clog the queue!
    this.tileManager.pruneQueue(desiredKeys);
    this.tileManager.flushQueue();
  }

  private ensureTileMesh(
    z: number,
    x: number,
    y: number,
    withSvOverlay: boolean,
    includeOverlays: boolean,
    priority: number
  ): void {
    const key = this.tileManager.getKey(this.layer, z, x, y, this.useGoogle, withSvOverlay);
    if (this.activeTiles.has(key)) return;

    const { geometry, centerUnit } = buildTileGeometry(z, x, y);
    const cachedTex = this.tileManager.getCached(
      this.layer,
      z,
      x,
      y,
      this.useGoogle,
      withSvOverlay
    );

    // All tile layers use transparent=true + depthWrite=false + renderOrder=z so Three.js
    // strictly renders z=2 -> bridgeZ -> targetZ in exact painter order with ZERO parent/child
    // z-fighting or depth override at any altitude (17,500 km down to 120 m)!
    const material = new THREE.MeshBasicMaterial({
      map: cachedTex ?? null,
      color: 0xffffff,
      transparent: true,
      opacity: cachedTex ? 1.0 : 0.0,
      depthTest: true,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = z;
    mesh.frustumCulled = false;
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
      this.tileManager.requestTile(
        this.layer,
        z,
        x,
        y,
        this.useGoogle,
        withSvOverlay,
        includeOverlays,
        priority,
        (tex) => {
          const cur = this.activeTiles.get(key);
          if (!cur || !tex) return;
          cur.material.map = tex;
          cur.material.needsUpdate = true;
          cur.material.opacity = z === 2 ? 1.0 : 0.15;
          cur.loaded = true;
          cur.fade = z === 2 ? 1.0 : 0.15;
          cur.mesh.visible = true;
        }
      );
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
