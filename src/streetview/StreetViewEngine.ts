import * as THREE from 'three';
import type { PanoramaItem, PanoramaLink } from '../types';
import { DEG2RAD, formatDistance } from '../services/geo';
import { googleStreetViewTileUrl, proxyImageUrl } from '../services/api';

interface NavArrowNode {
  link: PanoramaLink;
  group: THREE.Group;
  hitMesh: THREE.Mesh;
  chevronMesh: THREE.Mesh;
  ringMesh: THREE.Mesh;
}

function createCompassRingTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;

  ctx.clearRect(0, 0, size, size);

  ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(c, c, 212, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(c, c, 178, 0, Math.PI * 2);
  ctx.stroke();

  for (let deg = 0; deg < 360; deg += 15) {
    const rad = (deg - 90) * DEG2RAD;
    const isMajor = deg % 90 === 0;
    const r0 = isMajor ? 182 : 196;
    const r1 = 210;
    ctx.strokeStyle = isMajor ? 'rgba(56, 189, 248, 0.95)' : 'rgba(148, 163, 184, 0.45)';
    ctx.lineWidth = isMajor ? 4 : 2;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(rad) * r0, c + Math.sin(rad) * r0);
    ctx.lineTo(c + Math.cos(rad) * r1, c + Math.sin(rad) * r1);
    ctx.stroke();
  }

  const labels: Array<{ t: string; deg: number; col: string }> = [
    { t: 'N', deg: 0, col: '#38bdf8' },
    { t: 'E', deg: 90, col: '#e2e8f0' },
    { t: 'S', deg: 180, col: '#e2e8f0' },
    { t: 'O', deg: 270, col: '#e2e8f0' },
  ];
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const lb of labels) {
    const rad = (lb.deg - 90) * DEG2RAD;
    ctx.fillStyle = lb.col;
    ctx.fillText(lb.t, c + Math.cos(rad) * 150, c + Math.sin(rad) * 150);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createArrowLabelTag(label: string): THREE.Sprite {
  const text = label.length > 22 ? `${label.slice(0, 21)}…` : label;
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.font = '600 22px system-ui, -apple-system, sans-serif';
  const m = ctx.measureText(text);
  const pillW = Math.min(304, Math.max(110, m.width + 38));
  const rx = (canvas.width - pillW) / 2;

  ctx.fillStyle = 'rgba(7, 15, 32, 0.88)';
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.92)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.roundRect(rx, 10, pillW, 44, 22);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, 33, pillW - 22);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.1, 0.22, 1);
  sprite.renderOrder = 22;
  return sprite;
}

function createChevronGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.38);
  shape.lineTo(0.34, -0.14);
  shape.lineTo(0.18, -0.24);
  shape.lineTo(0, 0.08);
  shape.lineTo(-0.18, -0.24);
  shape.lineTo(-0.34, -0.14);
  shape.closePath();

  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function loadImgElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

async function loadTextureSafe(url: string, maxTexSize: number): Promise<THREE.Texture> {
  const img = await loadImgElement(url);
  let source: HTMLImageElement | HTMLCanvasElement = img;
  if (img.naturalWidth > maxTexSize || img.naturalHeight > maxTexSize) {
    const scale = Math.min(maxTexSize / img.naturalWidth, maxTexSize / img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.floor(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      source = canvas;
    }
  }
  const tex = new THREE.Texture(source);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

async function stitchGooglePanoramaTexture(
  pano: PanoramaItem,
  requestedZoom: number,
  maxTexSize: number,
  isCancelled: () => boolean
): Promise<THREE.Texture | null> {
  const imgW = pano.imageWidth ?? 13312;
  const imgH = pano.imageHeight ?? 6656;
  const tileW = pano.tileWidth ?? 512;
  const tileH = pano.tileHeight ?? 512;

  const maxZoom = Math.max(0, Math.ceil(Math.log2(imgW / tileW)));
  const z = Math.min(requestedZoom, maxZoom);
  const divisor = Math.pow(2, maxZoom - z);

  // Exact equirectangular dimensions at zoom z (clips transparent/black overhang on edge tiles!)
  const exactW = Math.max(tileW, Math.round(imgW / divisor));
  const exactH = Math.max(Math.round(tileH / 2), Math.round(imgH / divisor));
  const cols = Math.ceil(exactW / tileW);
  const rows = Math.ceil(exactH / tileH);

  const scaleToMax = Math.min(1, maxTexSize / exactW, maxTexSize / exactH);
  const outW = Math.max(1, Math.round(exactW * scaleToMax));
  const outH = Math.max(1, Math.round(exactH * scaleToMax));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const coords: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      coords.push({ x, y });
    }
  }

  let loadedCount = 0;
  const concurrency = 8;
  let cursor = 0;

  const worker = async () => {
    while (cursor < coords.length) {
      if (isCancelled()) return;
      const idx = cursor++;
      const { x, y } = coords[idx];
      try {
        const url = googleStreetViewTileUrl(pano.id, z, x, y);
        const img = await loadImgElement(url);
        if (isCancelled()) return;
        ctx.drawImage(
          img,
          Math.floor(x * tileW * scaleToMax),
          Math.floor(y * tileH * scaleToMax),
          Math.ceil(tileW * scaleToMax),
          Math.ceil(tileH * scaleToMax)
        );
        loadedCount++;
      } catch {
        // Ignore single missing tile if any
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, coords.length) }, () => worker()));

  if (isCancelled() || loadedCount === 0) return null;

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export class StreetViewEngine {
  public readonly root = new THREE.Group();
  private readonly sphereMesh: THREE.Mesh;
  private readonly sphereMat: THREE.MeshBasicMaterial;
  private readonly arrowsGroup = new THREE.Group();
  private readonly compassMesh: THREE.Mesh;

  private currentPanorama: PanoramaItem | null = null;
  private currentTexture: THREE.Texture | null = null;
  private navArrows: NavArrowNode[] = [];
  private hoveredLinkId: string | null = null;
  private loadVersion = 0;
  private yawOffsetRad = 0;
  private maxTextureSize: number;

  private readonly chevronGeo = createChevronGeometry();
  private readonly arrowRingGeo = new THREE.RingGeometry(0.32, 0.42, 32);
  private readonly hitDiscGeo = new THREE.CylinderGeometry(0.58, 0.58, 0.28, 16);

  constructor(maxTextureSize = 4096) {
    this.maxTextureSize = Math.min(8192, Math.max(2048, maxTextureSize));

    const sphereGeo = new THREE.SphereGeometry(48, 64, 48);
    sphereGeo.scale(-1, 1, 1);

    this.sphereMat = new THREE.MeshBasicMaterial({
      color: 0x0b1220,
      side: THREE.FrontSide,
      depthWrite: false,
    });

    this.sphereMesh = new THREE.Mesh(sphereGeo, this.sphereMat);
    this.sphereMesh.position.set(0, 1.4, 0);
    this.sphereMesh.renderOrder = -10;
    this.root.add(this.sphereMesh);

    const compassGeo = new THREE.PlaneGeometry(1.45, 1.45);
    compassGeo.rotateX(-Math.PI / 2);
    const compassMat = new THREE.MeshBasicMaterial({
      map: createCompassRingTexture(),
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    this.compassMesh = new THREE.Mesh(compassGeo, compassMat);
    this.compassMesh.position.set(0, 0.06, 0);
    this.compassMesh.renderOrder = 10;
    this.root.add(this.compassMesh);

    this.root.add(this.arrowsGroup);
    this.root.visible = false;
  }

  public getCurrentPanorama(): PanoramaItem | null {
    return this.currentPanorama;
  }

  public snapTurn(deltaDeg: number): void {
    this.yawOffsetRad -= deltaDeg * DEG2RAD;
    this.root.rotation.y = this.yawOffsetRad;
  }

  public resetYaw(): void {
    this.yawOffsetRad = 0;
    this.root.rotation.y = 0;
  }

  public async loadPanorama(
    pano: PanoramaItem,
    onProgress?: (stage: 'sd' | 'hd' | 'error') => void
  ): Promise<void> {
    const version = ++this.loadVersion;
    const isCancelled = () => version !== this.loadVersion;

    this.currentPanorama = pano;
    this.buildNavArrows(pano.links);

    // Align photo center (u=0.5, azimuth degrees from North) to true world North (-Z)
    const azimuth = Number.isFinite(pano.azimuth) ? pano.azimuth : 0;
    this.sphereMesh.rotation.order = 'YXZ';
    this.sphereMesh.rotation.y = (270 - azimuth) * DEG2RAD;
    this.sphereMesh.rotation.x = 0;
    this.sphereMesh.rotation.z = 0;

    // 1) Google Street View multi-tile equirectangular stitcher (z=2 instant -> z=3 4K HD!)
    if (pano.provider === 'google') {
      const sdTex = await stitchGooglePanoramaTexture(
        pano,
        2,
        Math.min(2048, this.maxTextureSize),
        isCancelled
      );
      if (isCancelled()) {
        sdTex?.dispose();
        return;
      }
      if (!sdTex) {
        onProgress?.('error');
        return;
      }
      this.applyTexture(sdTex);
      onProgress?.('sd');

      // Progressive upgrade to sharp 4K equirectangular HD (z=3)
      const hdTex = await stitchGooglePanoramaTexture(pano, 3, this.maxTextureSize, isCancelled);
      if (isCancelled()) {
        hdTex?.dispose();
        return;
      }
      if (hdTex) {
        this.applyTexture(hdTex);
        onProgress?.('hd');
      }
      return;
    }

    // 2) Single-image equirectangular providers (Panoramax / Mapillary)
    const sdRaw = pano.sdUrl ?? '';
    if (!sdRaw) {
      onProgress?.('error');
      return;
    }

    try {
      const sdTex = await loadTextureSafe(proxyImageUrl(sdRaw), Math.min(4096, this.maxTextureSize));
      if (isCancelled()) {
        sdTex.dispose();
        return;
      }
      this.applyTexture(sdTex);
      onProgress?.('sd');
    } catch {
      if (isCancelled()) return;
      try {
        const directTex = await loadTextureSafe(sdRaw, Math.min(4096, this.maxTextureSize));
        if (isCancelled()) {
          directTex.dispose();
          return;
        }
        this.applyTexture(directTex);
        onProgress?.('sd');
      } catch {
        onProgress?.('error');
        return;
      }
    }

    if (pano.hdUrl && pano.hdUrl !== pano.sdUrl) {
      try {
        const hdTex = await loadTextureSafe(proxyImageUrl(pano.hdUrl), this.maxTextureSize);
        if (isCancelled()) {
          hdTex.dispose();
          return;
        }
        this.applyTexture(hdTex);
        onProgress?.('hd');
      } catch {
        // Keep crisp SD texture
      }
    }
  }

  private applyTexture(tex: THREE.Texture): void {
    const prev = this.currentTexture;
    this.currentTexture = tex;
    this.sphereMat.map = tex;
    this.sphereMat.color.setHex(0xffffff);
    this.sphereMat.needsUpdate = true;
    if (prev && prev !== tex) {
      prev.dispose();
    }
  }

  private buildNavArrows(links: PanoramaLink[]): void {
    for (const node of this.navArrows) {
      this.arrowsGroup.remove(node.group);
    }
    this.navArrows = [];

    for (const link of links) {
      const group = new THREE.Group();
      const bearingRad = link.bearingDeg * DEG2RAD;
      const dist = 3.2;

      const dirX = Math.sin(bearingRad);
      const dirZ = -Math.cos(bearingRad);

      group.position.set(dirX * dist, 0.24, dirZ * dist);
      group.rotation.y = -bearingRad;

      const isPrimary = link.rel === 'next' || link.rel === 'prev';
      const chevronMat = new THREE.MeshBasicMaterial({
        color: isPrimary ? 0x22d3ee : 0x38bdf8,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.94,
      });
      const chevronMesh = new THREE.Mesh(this.chevronGeo, chevronMat);
      chevronMesh.renderOrder = 20;
      group.add(chevronMesh);

      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const ringMesh = new THREE.Mesh(this.arrowRingGeo, ringMat);
      ringMesh.rotation.x = -Math.PI / 2;
      ringMesh.position.y = -0.02;
      ringMesh.renderOrder = 19;
      group.add(ringMesh);

      const labelText =
        link.text ||
        (typeof link.distanceMeters === 'number'
          ? formatDistance(link.distanceMeters)
          : `${Math.round(link.bearingDeg)}°`);
      const tag = createArrowLabelTag(labelText);
      tag.position.set(0, 0.36, 0);
      group.add(tag);

      const hitMat = new THREE.MeshBasicMaterial({ visible: false });
      const hitMesh = new THREE.Mesh(this.hitDiscGeo, hitMat);
      hitMesh.userData = { navLink: link };
      group.add(hitMesh);

      this.arrowsGroup.add(group);
      this.navArrows.push({ link, group, hitMesh, chevronMesh, ringMesh });
    }
  }

  public setHoveredLink(id: string | null): void {
    this.hoveredLinkId = id;
  }

  public hitTestArrow(raycaster: THREE.Raycaster): PanoramaLink | null {
    if (!this.root.visible || this.navArrows.length === 0) return null;
    const hitMeshes = this.navArrows.map((a) => a.hitMesh);
    const hits = raycaster.intersectObjects(hitMeshes, false);
    if (hits.length === 0) return null;
    return (hits[0].object.userData.navLink as PanoramaLink | undefined) ?? null;
  }

  public findForwardLink(cameraWorldDir: THREE.Vector3): PanoramaLink | null {
    if (!this.currentPanorama || this.currentPanorama.links.length === 0) return null;
    const localDir = cameraWorldDir
      .clone()
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.yawOffsetRad);
    const lookBearing = ((Math.atan2(localDir.x, -localDir.z) * 180) / Math.PI + 360) % 360;

    let best: PanoramaLink | null = null;
    let bestDiff = 999;
    for (const link of this.currentPanorama.links) {
      const diff = Math.abs(((link.bearingDeg - lookBearing + 540) % 360) - 180);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = link;
      }
    }
    return bestDiff < 75 ? best : this.currentPanorama.links[0];
  }

  public update(elapsedSec: number): void {
    if (!this.root.visible) return;
    for (let i = 0; i < this.navArrows.length; i++) {
      const node = this.navArrows[i];
      const hovered = this.hoveredLinkId === node.link.id;
      const bob = Math.sin(elapsedSec * 2.8 + i) * 0.04;
      node.group.position.y = 0.24 + bob;
      node.group.scale.setScalar(hovered ? 1.32 : 1.0);
      const mat = node.chevronMesh.material as THREE.MeshBasicMaterial;
      mat.color.setHex(hovered ? 0xfef08a : 0x22d3ee);
    }
  }

  public dispose(): void {
    if (this.currentTexture) this.currentTexture.dispose();
    this.sphereMesh.geometry.dispose();
    this.sphereMat.dispose();
  }
}
