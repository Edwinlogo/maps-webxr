import * as THREE from 'three';
import type { Landmark, PanoramaItem } from '../types';
import { latLonToUnitVec } from '../services/geo';
import type { GlobeEngine } from './GlobeEngine';

export type MarkerHit =
  | { kind: 'landmark'; landmark: Landmark }
  | { kind: 'panorama'; panorama: PanoramaItem };

interface LandmarkNode {
  landmark: Landmark;
  unitVec: THREE.Vector3;
  group: THREE.Group;
  hitMesh: THREE.Mesh;
  ringMesh: THREE.Mesh;
  labelSprite: THREE.Sprite;
}

interface PanoNode {
  panorama: PanoramaItem;
  unitVec: THREE.Vector3;
  group: THREE.Group;
  hitMesh: THREE.Mesh;
  ringMesh: THREE.Mesh;
}

function createLabelSprite(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 76;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Pill background
  const padX = 14;
  ctx.font = '600 24px system-ui, -apple-system, Segoe UI, sans-serif';
  const metrics = ctx.measureText(text);
  const pillW = Math.min(308, Math.max(120, metrics.width + padX * 2 + 24));
  const pillH = 44;
  const rx = (canvas.width - pillW) / 2;
  const ry = (canvas.height - pillH) / 2;

  ctx.fillStyle = 'rgba(7, 15, 32, 0.86)';
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.88)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.roundRect(rx, ry, pillW, pillH, 22);
  ctx.fill();
  ctx.stroke();

  // Small cyan 360 dot
  ctx.fillStyle = '#22d3ee';
  ctx.beginPath();
  ctx.arc(rx + 20, ry + pillH / 2, 5.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#f8fafc';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, rx + 34, ry + pillH / 2 + 1);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.185, 0.045, 1);
  sprite.renderOrder = 32;
  return sprite;
}

const ORBIT_PRIMARY_IDS = new Set([
  'bogota',
  'eiffel',
  'nyc',
  'tokyo',
  'sf',
  'buenosaires',
  'taipei',
  'madrid',
]);

export class GlobeMarkers {
  public readonly group = new THREE.Group();
  private landmarksGroup = new THREE.Group();
  private panoramasGroup = new THREE.Group();

  private landmarkNodes: LandmarkNode[] = [];
  private panoNodes: PanoNode[] = [];
  private hoveredId: string | null = null;

  private readonly pinGeo = new THREE.SphereGeometry(0.017, 16, 12);
  private readonly panoOrbGeo = new THREE.SphereGeometry(0.018, 16, 12);
  private readonly ringGeo = new THREE.RingGeometry(0.022, 0.032, 24);
  private readonly stemGeo = new THREE.CylinderGeometry(0.0025, 0.0025, 0.045, 8);
  private readonly hitSphereGeo = new THREE.SphereGeometry(0.055, 10, 8);
  private readonly upAxis = new THREE.Vector3(0, 1, 0);
  private readonly tmpQuat = new THREE.Quaternion();

  constructor(landmarks: Landmark[]) {
    this.group.add(this.landmarksGroup);
    this.group.add(this.panoramasGroup);

    for (const lm of landmarks) {
      const unitVec = latLonToUnitVec(lm.lat, lm.lon);
      const nodeGroup = new THREE.Group();

      const stemMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.85,
      });
      const stem = new THREE.Mesh(this.stemGeo, stemMat);
      stem.position.y = 0.022;
      nodeGroup.add(stem);

      const headMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee });
      const head = new THREE.Mesh(this.pinGeo, headMat);
      head.position.y = 0.048;
      head.renderOrder = 26;
      nodeGroup.add(head);

      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x7dd3fc,
        transparent: true,
        opacity: 0.78,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const ringMesh = new THREE.Mesh(this.ringGeo, ringMat);
      ringMesh.rotation.x = -Math.PI / 2;
      ringMesh.position.y = 0.004;
      ringMesh.renderOrder = 25;
      nodeGroup.add(ringMesh);

      const labelSprite = createLabelSprite(lm.city);
      labelSprite.position.set(0, 0.095, 0);
      nodeGroup.add(labelSprite);

      // Invisible generous hit collider for effortless VR controller ray clicking
      const hitMat = new THREE.MeshBasicMaterial({ visible: false });
      const hitMesh = new THREE.Mesh(this.hitSphereGeo, hitMat);
      hitMesh.position.y = 0.04;
      hitMesh.userData = { markerHit: { kind: 'landmark', landmark: lm } satisfies MarkerHit };
      nodeGroup.add(hitMesh);

      this.tmpQuat.setFromUnitVectors(this.upAxis, unitVec);
      nodeGroup.quaternion.copy(this.tmpQuat);

      this.landmarksGroup.add(nodeGroup);
      this.landmarkNodes.push({
        landmark: lm,
        unitVec,
        group: nodeGroup,
        hitMesh,
        ringMesh,
        labelSprite,
      });
    }
  }

  public setNearbyPanoramas(panoramas: PanoramaItem[]): void {
    for (const node of this.panoNodes) {
      this.panoramasGroup.remove(node.group);
    }
    this.panoNodes = [];

    for (const pano of panoramas) {
      const unitVec = latLonToUnitVec(pano.lat, pano.lon);
      const nodeGroup = new THREE.Group();

      const orbMat = new THREE.MeshBasicMaterial({ color: 0x3b82f6 });
      const orb = new THREE.Mesh(this.panoOrbGeo, orbMat);
      orb.position.y = 0.025;
      orb.renderOrder = 28;
      nodeGroup.add(orb);

      const haloMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const ringMesh = new THREE.Mesh(this.ringGeo, haloMat);
      ringMesh.rotation.x = -Math.PI / 2;
      ringMesh.position.y = 0.005;
      ringMesh.renderOrder = 27;
      nodeGroup.add(ringMesh);

      const hitMat = new THREE.MeshBasicMaterial({ visible: false });
      const hitMesh = new THREE.Mesh(this.hitSphereGeo, hitMat);
      hitMesh.position.y = 0.025;
      hitMesh.userData = { markerHit: { kind: 'panorama', panorama: pano } satisfies MarkerHit };
      nodeGroup.add(hitMesh);

      this.tmpQuat.setFromUnitVectors(this.upAxis, unitVec);
      nodeGroup.quaternion.copy(this.tmpQuat);

      this.panoramasGroup.add(nodeGroup);
      this.panoNodes.push({
        panorama: pano,
        unitVec,
        group: nodeGroup,
        hitMesh,
        ringMesh,
      });
    }
  }

  public setHoveredId(id: string | null): void {
    this.hoveredId = id;
  }

  public hitTest(raycaster: THREE.Raycaster): MarkerHit | null {
    const targets: THREE.Object3D[] = [];
    for (const n of this.panoNodes) {
      if (n.group.visible) targets.push(n.hitMesh);
    }
    for (const n of this.landmarkNodes) {
      if (n.group.visible) targets.push(n.hitMesh);
    }
    if (targets.length === 0) return null;
    const hits = raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return null;
    return (hits[0].object.userData.markerHit as MarkerHit | undefined) ?? null;
  }

  public update(globe: GlobeEngine, elapsedSec: number): void {
    const anchor = globe.getAnchorUnit();
    const altKm = globe.getState().altitudeKm;
    const showLabels = altKm > 35;

    for (let i = 0; i < this.landmarkNodes.length; i++) {
      const node = this.landmarkNodes[i];
      // Only show pins on the front-facing hemisphere of the planet!
      const facing = node.unitVec.dot(anchor);
      const visible = facing > 0.12;
      node.group.visible = visible;
      if (!visible) continue;

      globe.unitToGlobeLocal(node.unitVec, 0.007, node.group.position);

      const isHovered = this.hoveredId === node.landmark.id;
      const baseScale = isHovered ? 1.45 : 1.0;
      node.group.scale.setScalar(baseScale);

      const pulse = 1 + 0.35 * ((elapsedSec * 0.9 + i * 0.17) % 1);
      node.ringMesh.scale.setScalar(pulse);
      (node.ringMesh.material as THREE.MeshBasicMaterial).opacity =
        (1 - ((elapsedSec * 0.9 + i * 0.17) % 1)) * 0.85;

      const showOrbitLabel = altKm < 7500 || ORBIT_PRIMARY_IDS.has(node.landmark.id);
      node.labelSprite.visible = (showLabels && showOrbitLabel) || isHovered;
    }

    const showPanos = altKm < 60;
    this.panoramasGroup.visible = showPanos;
    if (showPanos) {
      for (let i = 0; i < this.panoNodes.length; i++) {
        const node = this.panoNodes[i];
        const facing = node.unitVec.dot(anchor);
        node.group.visible = facing > 0.5;
        if (!node.group.visible) continue;

        globe.unitToGlobeLocal(node.unitVec, 0.008, node.group.position);
        const isHovered = this.hoveredId === node.panorama.id;
        node.group.scale.setScalar(isHovered ? 1.5 : 1.05);

        const pulse = 1 + 0.4 * ((elapsedSec * 1.3 + i * 0.23) % 1);
        node.ringMesh.scale.setScalar(pulse);
        (node.ringMesh.material as THREE.MeshBasicMaterial).opacity =
          (1 - ((elapsedSec * 1.3 + i * 0.23) % 1)) * 0.9;
      }
    }
  }
}
