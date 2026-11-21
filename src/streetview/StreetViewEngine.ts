import * as THREE from 'three';
import type { PanoramaItem, PanoramaLink } from '../types';
import { DEG2RAD, formatDistance } from '../services/geo';
import { proxyImageUrl } from '../services/api';

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

  // Outer glowing circle
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(c, c, 212, 0, Math.PI * 2);
  ctx.stroke();

  // Inner circle
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(c, c, 178, 0, Math.PI * 2);
  ctx.stroke();

  // Tick marks every 15 deg
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

  // Cardinal labels (N at top = -Z when rotated -PI/2 on X)
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

function createDistanceTag(label: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 180;
  canvas.height = 56;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = 'rgba(7, 15, 32, 0.85)';
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.9)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.roundRect(12, 8, 156, 40, 20);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#f8fafc';
  ctx.font = '600 22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 90, 29);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.68, 0.21, 1);
  sprite.renderOrder = 22;
  return sprite;
}

function createChevronGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.36);
  shape.lineTo(0.32, -0.14);
  shape.lineTo(0.18, -0.24);
  shape.lineTo(0, 0.08);
  shape.lineTo(-0.18, -0.24);
  shape.lineTo(-0.32, -0.14);
  shape.closePath();

  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function loadTextureSafe(url: string, maxTexSize: number): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
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
      resolve(tex);
    };
    img.onerror = () => reject(new Error(`Failed to load 360 image: ${url}`));
    img.src = url;
  });
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
  private readonly hitDiscGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.25, 16);

  constructor(maxTextureSize = 4096) {
    this.maxTextureSize = Math.min(8192, Math.max(2048, maxTextureSize));

    // Inverted sphere with flipped X so inside text/signs read naturally left-to-right!
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

    // Ground compass ring directly under the user
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

  public getYawOffsetDeg(): number {
    return ((-(this.yawOffsetRad * 180) / Math.PI) % 360 + 360) % 360;
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
    this.currentPanorama = pano;
    this.buildNavArrows(pano.links);

    // Align photo center (u=0.5, azimuth degrees from North) to true world North (-Z)
    const azimuth = Number.isFinite(pano.azimuth) ? pano.azimuth : 0;
    this.sphereMesh.rotation.y = (270 - azimuth) * DEG2RAD;

    // 1) Fast SD load via CORS-safe Worker proxy
    const sdProxied = proxyImageUrl(pano.sdUrl);
    try {
      const sdTex = await loadTextureSafe(sdProxied, Math.min(4096, this.maxTextureSize));
      if (version !== this.loadVersion) {
        sdTex.dispose();
        return;
      }
      this.applyTexture(sdTex);
      onProgress?.('sd');
    } catch {
      if (version !== this.loadVersion) return;
      // Fallback: try direct URL if proxy failed in local dev
      try {
        const directTex = await loadTextureSafe(pano.sdUrl, Math.min(4096, this.maxTextureSize));
        if (version !== this.loadVersion) {
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

    // 2) Seamless HD upgrade in background if HD differs from SD
    if (pano.hdUrl && pano.hdUrl !== pano.sdUrl) {
      const hdProxied = proxyImageUrl(pano.hdUrl);
      try {
        const hdTex = await loadTextureSafe(hdProxied, this.maxTextureSize);
        if (version !== this.loadVersion) {
          hdTex.dispose();
          return;
        }
        this.applyTexture(hdTex);
        onProgress?.('hd');
      } catch {
        // Keep crisp SD texture if HD fails
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

      // Geographic bearing: 0° = -Z (North), 90° = +X (East), 180° = +Z (South), 270° = -X (West)
      const dirX = Math.sin(bearingRad);
      const dirZ = -Math.cos(bearingRad);

      group.position.set(dirX * dist, 0.24, dirZ * dist);
      // Point chevron outward along bearing direction
      group.rotation.y = -bearingRad;

      const isPrimary = link.rel === 'next' || link.rel === 'prev';
      const chevronMat = new THREE.MeshBasicMaterial({
        color: isPrimary ? 0x22d3ee : 0x60a5fa,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.92,
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

      const tag = createDistanceTag(formatDistance(link.distanceMeters));
      tag.position.set(0, 0.34, 0);
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

  /**
   * Returns the link whose geographic bearing is closest to the direction the user is currently facing.
   */
  public findForwardLink(cameraWorldDir: THREE.Vector3): PanoramaLink | null {
    if (!this.currentPanorama || this.currentPanorama.links.length === 0) return null;
    // Transform world look direction into StreetView local coordinates (accounting for yawOffsetRad)
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
      mat.color.setHex(hovered ? 0xfef08a : node.link.rel === 'related' ? 0x60a5fa : 0x22d3ee);
    }
  }

  public dispose(): void {
    if (this.currentTexture) this.currentTexture.dispose();
    this.sphereMesh.geometry.dispose();
    this.sphereMat.dispose();
  }
}
