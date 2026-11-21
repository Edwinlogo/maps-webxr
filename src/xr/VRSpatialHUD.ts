import * as THREE from 'three';
import type { AppMode, Landmark, MapLayer, PanoramaItem } from '../types';
import { formatAltitude, formatCoords, formatDistance } from '../services/geo';

export interface VRHudState {
  mode: AppMode;
  googleActive: boolean;
  passthrough: boolean;
  streetPickMode: boolean;
  locationLabel: string;
  lat: number;
  lon: number;
  altitudeKm: number;
  layer: MapLayer;
  nearbyPano: PanoramaItem | null;
  searchingPano: boolean;
  currentPano: PanoramaItem | null;
  streetQuality: 'loading' | 'sd' | 'hd' | 'error';
  statusMessage: string;
}

export interface VRHudCallbacks {
  onToggleStreetView: () => void;
  onTogglePassthrough: () => void;
  onSelectLandmark: (landmark: Landmark) => void;
  onSetLayer: (layer: MapLayer) => void;
  onToggleStreetPick: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetGlobe: () => void;
  onStepForward: () => void;
  onTurnLeft: () => void;
  onTurnRight: () => void;
}

interface HitRegion {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  action: () => void;
}

const CANVAS_W = 960;
const CANVAS_H = 580;
const PANEL_W_M = 0.96;
const PANEL_H_M = (PANEL_W_M * CANVAS_H) / CANVAS_W;

function createGrabHandleTexture(grabbed: boolean, hovered: boolean): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 72;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = grabbed
    ? 'rgba(16, 185, 129, 0.92)'
    : hovered
      ? 'rgba(14, 165, 233, 0.9)'
      : 'rgba(15, 23, 42, 0.88)';
  ctx.strokeStyle = grabbed ? '#6ee7b7' : hovered ? '#7dd3fc' : 'rgba(125, 211, 252, 0.55)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(14, 10, canvas.width - 28, canvas.height - 20, 26);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#f8fafc';
  ctx.font = '700 22px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    grabbed ? '⠿  MOVIENDO TABLERO...' : '⠿  PELLIZCA AQUÍ PARA MOVER EL TABLERO',
    canvas.width / 2,
    canvas.height / 2 + 1
  );

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class VRSpatialHUD {
  public readonly group = new THREE.Group();
  public readonly panelMesh: THREE.Mesh;
  public readonly grabBarMesh: THREE.Mesh;
  public readonly bottomGrabMesh: THREE.Mesh;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private grabBarMat: THREE.MeshBasicMaterial;
  private bottomGrabMat: THREE.MeshBasicMaterial;
  private grabTexIdle: THREE.CanvasTexture;
  private grabTexHover: THREE.CanvasTexture;
  private grabTexActive: THREE.CanvasTexture;

  private regions: HitRegion[] = [];
  private hoveredRegionId: string | null = null;
  private isGrabbed = false;
  private isGrabHovered = false;
  private landmarks: Landmark[];
  private callbacks: VRHudCallbacks;
  private pageIndex = 0;
  private lastDrawHash = '';
  private state: VRHudState;

  constructor(landmarks: Landmark[], callbacks: VRHudCallbacks) {
    this.landmarks = landmarks;
    this.callbacks = callbacks;
    this.state = {
      mode: 'globe',
      googleActive: false,
      passthrough: false,
      streetPickMode: false,
      locationLabel: 'Planeta Tierra',
      lat: 16,
      lon: -52,
      altitudeKm: 13800,
      layer: 'hybrid',
      nearbyPano: null,
      searchingPano: false,
      currentPano: null,
      streetQuality: 'loading',
      statusMessage: 'Pellizca y mueve para girar · 2 manos para zoom',
    };

    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.ctx = this.canvas.getContext('2d')!;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;

    const geo = new THREE.PlaneGeometry(PANEL_W_M, PANEL_H_M);
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      side: THREE.FrontSide,
      depthTest: true,
    });
    this.panelMesh = new THREE.Mesh(geo, mat);
    this.panelMesh.renderOrder = 40;
    this.group.add(this.panelMesh);

    // Top movable handle bar (grab with hand pinch or controller trigger/grip to reposition anywhere!)
    this.grabTexIdle = createGrabHandleTexture(false, false);
    this.grabTexHover = createGrabHandleTexture(false, true);
    this.grabTexActive = createGrabHandleTexture(true, true);

    const grabGeo = new THREE.PlaneGeometry(0.58, 0.082);
    this.grabBarMat = new THREE.MeshBasicMaterial({
      map: this.grabTexIdle,
      transparent: true,
      side: THREE.FrontSide,
    });
    this.grabBarMesh = new THREE.Mesh(grabGeo, this.grabBarMat);
    this.grabBarMesh.position.set(0, PANEL_H_M / 2 + 0.052, 0.004);
    this.grabBarMesh.renderOrder = 42;
    this.group.add(this.grabBarMesh);

    // Subtle sleek bottom pill bar (VisionOS-style!) also draggable to move the console
    const bottomGeo = new THREE.PlaneGeometry(0.32, 0.036);
    this.bottomGrabMat = new THREE.MeshBasicMaterial({
      color: 0x94a3b8,
      transparent: true,
      opacity: 0.72,
    });
    this.bottomGrabMesh = new THREE.Mesh(bottomGeo, this.bottomGrabMat);
    this.bottomGrabMesh.position.set(0, -(PANEL_H_M / 2 + 0.034), 0.004);
    this.bottomGrabMesh.renderOrder = 42;
    this.group.add(this.bottomGrabMesh);

    this.group.position.set(0, 0.84, -1.12);
    this.group.rotation.set(-0.34, 0, 0);
    this.group.visible = false;

    this.redraw(true);
  }

  public setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  public isVisible(): boolean {
    return this.group.visible;
  }

  public recenterToCamera(camera: THREE.Camera): void {
    const camPos = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    camera.getWorldPosition(camPos);
    camera.getWorldDirection(camDir);
    camDir.y = 0;
    if (camDir.lengthSq() < 0.0001) {
      camDir.set(0, 0, -1);
    } else {
      camDir.normalize();
    }

    this.group.position.set(
      camPos.x + camDir.x * 1.05,
      Math.max(0.68, camPos.y - 0.44),
      camPos.z + camDir.z * 1.05
    );
    this.group.lookAt(camPos.x, camPos.y - 0.08, camPos.z);
    this.group.visible = true;
  }

  public hitTestGrabHandle(raycaster: THREE.Raycaster): { point: THREE.Vector3; distance: number } | null {
    if (!this.group.visible) return null;
    const hits = raycaster.intersectObjects([this.grabBarMesh, this.bottomGrabMesh], false);
    if (hits.length === 0) return null;
    return { point: hits[0].point.clone(), distance: hits[0].distance };
  }

  public setGrabState(grabbed: boolean, hovered: boolean): void {
    if (this.isGrabbed === grabbed && this.isGrabHovered === hovered) return;
    this.isGrabbed = grabbed;
    this.isGrabHovered = hovered;
    this.grabBarMat.map = grabbed
      ? this.grabTexActive
      : hovered
        ? this.grabTexHover
        : this.grabTexIdle;
    this.grabBarMat.needsUpdate = true;
    this.bottomGrabMat.color.setHex(grabbed ? 0x34d399 : hovered ? 0x38bdf8 : 0x94a3b8);
    this.bottomGrabMat.opacity = grabbed || hovered ? 0.95 : 0.72;
  }

  public moveToWorldPosition(targetPos: THREE.Vector3, camera: THREE.Camera): void {
    const camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);
    // Keep panel smoothly within comfortable reach (0.45m .. 2.8m)
    const offset = targetPos.clone().sub(camPos);
    const dist = THREE.MathUtils.clamp(offset.length(), 0.48, 2.6);
    if (offset.lengthSq() > 0.0001) {
      offset.normalize().multiplyScalar(dist);
    }
    this.group.position.copy(camPos).add(offset);
    this.group.position.y = THREE.MathUtils.clamp(this.group.position.y, 0.35, 2.35);
    this.group.lookAt(camPos.x, camPos.y - 0.05, camPos.z);
  }

  public updateState(partial: Partial<VRHudState>): void {
    this.state = { ...this.state, ...partial };
    this.redraw(false);
  }

  public testHover(raycaster: THREE.Raycaster): { point: THREE.Vector3; regionId: string | null; isGrab: boolean } | null {
    if (!this.group.visible) return null;

    const grabHit = this.hitTestGrabHandle(raycaster);
    if (grabHit) {
      this.setGrabState(this.isGrabbed, true);
      return { point: grabHit.point, regionId: 'grab_bar', isGrab: true };
    }
    this.setGrabState(this.isGrabbed, false);

    const hits = raycaster.intersectObject(this.panelMesh, false);
    if (hits.length === 0 || !hits[0].uv) {
      if (this.hoveredRegionId !== null) {
        this.hoveredRegionId = null;
        this.redraw(true);
      }
      return null;
    }

    const uv = hits[0].uv;
    const px = uv.x * CANVAS_W;
    const py = (1 - uv.y) * CANVAS_H;

    let hitId: string | null = null;
    for (const r of this.regions) {
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
        hitId = r.id;
        break;
      }
    }

    if (hitId !== this.hoveredRegionId) {
      this.hoveredRegionId = hitId;
      this.redraw(true);
    }

    return { point: hits[0].point, regionId: hitId, isGrab: false };
  }

  public clearHover(): void {
    this.setGrabState(this.isGrabbed, false);
    if (this.hoveredRegionId !== null) {
      this.hoveredRegionId = null;
      this.redraw(true);
    }
  }

  public triggerClick(raycaster: THREE.Raycaster): boolean {
    if (!this.group.visible) return false;
    const hits = raycaster.intersectObject(this.panelMesh, false);
    if (hits.length === 0 || !hits[0].uv) return false;

    const uv = hits[0].uv;
    const px = uv.x * CANVAS_W;
    const py = (1 - uv.y) * CANVAS_H;

    for (const r of this.regions) {
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
        r.action();
        return true;
      }
    }
    return true;
  }

  private drawButton(
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    options: {
      sublabel?: string;
      primary?: boolean;
      active?: boolean;
      accent?: 'cyan' | 'emerald' | 'amber' | 'violet' | 'slate';
      fontSize?: number;
      action: () => void;
    }
  ): void {
    this.regions.push({ id, x, y, w, h, action: options.action });
    const ctx = this.ctx;
    const hovered = this.hoveredRegionId === id;
    const accent = options.accent ?? 'slate';

    let fill = 'rgba(20, 32, 56, 0.84)';
    let stroke = 'rgba(148, 163, 184, 0.35)';
    let textColor = '#e2e8f0';

    if (accent === 'emerald') {
      fill = hovered ? 'rgba(16, 185, 129, 0.96)' : 'rgba(5, 150, 105, 0.9)';
      stroke = '#6ee7b7';
      textColor = '#ffffff';
    } else if (accent === 'cyan') {
      fill = hovered ? 'rgba(14, 165, 233, 0.96)' : 'rgba(2, 132, 199, 0.86)';
      stroke = '#7dd3fc';
      textColor = '#ffffff';
    } else if (accent === 'amber') {
      fill = hovered ? 'rgba(245, 158, 11, 0.96)' : 'rgba(217, 119, 6, 0.88)';
      stroke = '#fde68a';
      textColor = '#ffffff';
    } else if (accent === 'violet') {
      fill = hovered ? 'rgba(139, 92, 246, 0.94)' : 'rgba(109, 40, 217, 0.85)';
      stroke = '#c4b5fd';
      textColor = '#ffffff';
    } else if (options.active) {
      fill = 'rgba(14, 116, 144, 0.88)';
      stroke = '#38bdf8';
      textColor = '#ffffff';
    } else if (hovered) {
      fill = 'rgba(30, 58, 102, 0.94)';
      stroke = '#38bdf8';
      textColor = '#ffffff';
    }

    ctx.save();
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = hovered || options.primary ? 3 : 1.8;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 16);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${options.primary ? '700' : '600'} ${options.fontSize ?? 20}px system-ui, -apple-system, sans-serif`;

    if (options.sublabel) {
      ctx.fillText(label, x + w / 2, y + h / 2 - 10, w - 16);
      ctx.font = '500 14px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(226, 232, 240, 0.86)';
      ctx.fillText(options.sublabel, x + w / 2, y + h / 2 + 13, w - 16);
    } else {
      ctx.fillText(label, x + w / 2, y + h / 2 + 1, w - 16);
    }
    ctx.restore();
  }

  private redraw(force: boolean): void {
    const s = this.state;
    const hash = [
      s.mode,
      s.googleActive ? 'g1' : 'g0',
      s.passthrough ? 'pt1' : 'pt0',
      s.streetPickMode ? 'pk1' : 'pk0',
      s.locationLabel,
      s.lat.toFixed(2),
      s.lon.toFixed(2),
      formatAltitude(s.altitudeKm),
      s.layer,
      s.nearbyPano?.id ?? '',
      s.searchingPano ? '1' : '0',
      s.currentPano?.id ?? '',
      s.streetQuality,
      s.statusMessage,
      this.hoveredRegionId ?? '',
      this.pageIndex,
    ].join('|');

    if (!force && hash === this.lastDrawHash) return;
    this.lastDrawHash = hash;
    this.regions = [];

    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Minimalist frosted glass backdrop
    const bgGrad = ctx.createLinearGradient(0, 0, CANVAS_W, CANVAS_H);
    bgGrad.addColorStop(0, 'rgba(6, 12, 26, 0.90)');
    bgGrad.addColorStop(1, 'rgba(11, 20, 40, 0.90)');
    ctx.fillStyle = bgGrad;
    ctx.strokeStyle = 'rgba(125, 211, 252, 0.36)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.roundRect(8, 8, CANVAS_W - 16, CANVAS_H - 16, 28);
    ctx.fill();
    ctx.stroke();

    // Compact Header: Location + Coords + Passthrough Toggle
    const isSV = s.mode === 'streetview';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f8fafc';
    ctx.font = '700 25px system-ui, sans-serif';
    ctx.fillText(s.locationLabel, 34, 48, 560);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '500 16px ui-monospace, monospace';
    const metaRight = isSV ? 'Nivel calle 360°' : `Altitud ${formatAltitude(s.altitudeKm)}`;
    ctx.fillText(`${formatCoords(s.lat, s.lon)}  ·  ${metaRight}`, 34, 78, 560);

    // Passthrough / Stars live toggle right in top-right of movable console!
    this.drawButton(
      'toggle_passthrough',
      CANVAS_W - 310,
      26,
      276,
      62,
      s.passthrough ? '👁 REALIDAD · PASSTHROUGH' : '✦ ESPACIO · ESTRELLAS',
      {
        sublabel: s.passthrough ? 'Toca para fondo estelar' : 'Toca para ver tu entorno',
        accent: s.passthrough ? 'violet' : 'slate',
        fontSize: 17,
        action: () => this.callbacks.onTogglePassthrough(),
      }
    );

    // Primary Street View / Return Row
    if (isSV) {
      const qual =
        s.streetQuality === 'hd' ? 'HD' : s.streetQuality === 'sd' ? 'Mejorando HD...' : 'Cargando...';
      this.drawButton('primary_cta', 34, 112, 460, 82, 'VOLVER AL PLANETA 3D', {
        sublabel: `${s.currentPano?.copyright ?? (s.currentPano?.provider === 'mapillary' ? 'Mapillary' : 'Panoramax')} · ${qual}`,
        primary: true,
        accent: 'amber',
        fontSize: 22,
        action: () => this.callbacks.onToggleStreetView(),
      });
      this.drawButton('sv_walk', 510, 112, 190, 82, 'AVANZAR', {
        sublabel: 'Siguiente 360°',
        accent: 'cyan',
        fontSize: 20,
        action: () => this.callbacks.onStepForward(),
      });
      this.drawButton('sv_left', 716, 112, 100, 82, '↺ -30°', {
        fontSize: 20,
        action: () => this.callbacks.onTurnLeft(),
      });
      this.drawButton('sv_right', 826, 112, 100, 82, '↻ +30°', {
        fontSize: 20,
        action: () => this.callbacks.onTurnRight(),
      });
    } else {
      const hasNearby = Boolean(s.nearbyPano);
      this.drawButton(
        'primary_cta',
        34,
        112,
        526,
        82,
        hasNearby ? 'ENTRAR A STREET VIEW 360°' : 'BUSCAR STREET VIEW 360° AQUÍ',
        {
          sublabel: s.searchingPano
            ? 'Buscando 360° en esta calle...'
            : s.nearbyPano
              ? `Disponible a ${formatDistance(s.nearbyPano.distanceMeters)} · Toca o pulsa A`
              : s.statusMessage,
          primary: true,
          accent: hasNearby ? 'emerald' : 'cyan',
          fontSize: 22,
          action: () => this.callbacks.onToggleStreetView(),
        }
      );

      this.drawButton('zoom_in', 576, 112, 108, 82, '+', {
        sublabel: 'Acercar',
        fontSize: 28,
        action: () => this.callbacks.onZoomIn(),
      });
      this.drawButton('zoom_out', 696, 112, 108, 82, '−', {
        sublabel: 'Alejar',
        fontSize: 28,
        action: () => this.callbacks.onZoomOut(),
      });
      this.drawButton('reset_globe', 816, 112, 110, 82, 'GLOBO', {
        sublabel: 'Órbita',
        fontSize: 18,
        action: () => this.callbacks.onResetGlobe(),
      });
    }

    // Minimalist Layer + Street Pick + Destinations Pager row
    this.drawButton('layer_hybrid', 34, 214, 154, 46, 'Híbrido', {
      active: s.layer === 'hybrid',
      fontSize: 17,
      action: () => this.callbacks.onSetLayer('hybrid'),
    });
    this.drawButton('layer_sat', 200, 214, 150, 46, 'Satélite', {
      active: s.layer === 'satellite',
      fontSize: 17,
      action: () => this.callbacks.onSetLayer('satellite'),
    });
    this.drawButton('layer_streets', 362, 214, 146, 46, 'Calles', {
      active: s.layer === 'streets',
      fontSize: 17,
      action: () => this.callbacks.onSetLayer('streets'),
    });
    this.drawButton(
      'toggle_sv_pick',
      524,
      214,
      250,
      46,
      s.streetPickMode ? '📍 Clic Calle → 360°: ON' : '📍 Clic Calle → 360°',
      {
        accent: s.streetPickMode ? 'emerald' : 'slate',
        fontSize: 17,
        action: () => this.callbacks.onToggleStreetPick(),
      }
    );

    const perPage = 6;
    const totalPages = Math.max(1, Math.ceil(this.landmarks.length / perPage));
    this.drawButton('page_prev', 794, 214, 60, 46, '◀', {
      fontSize: 19,
      action: () => {
        this.pageIndex = (this.pageIndex - 1 + totalPages) % totalPages;
        this.redraw(true);
      },
    });
    this.drawButton('page_next', 866, 214, 60, 46, '▶', {
      fontSize: 19,
      action: () => {
        this.pageIndex = (this.pageIndex + 1) % totalPages;
        this.redraw(true);
      },
    });

    // Clean 3x2 Destination Grid
    const start = this.pageIndex * perPage;
    const slice = this.landmarks.slice(start, start + perPage);
    const cols = 3;
    const gap = 14;
    const btnW = (CANVAS_W - 68 - gap * (cols - 1)) / cols;
    const btnH = 104;

    slice.forEach((lm, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const bx = 34 + col * (btnW + gap);
      const by = 282 + row * (btnH + gap);
      this.drawButton(`lm_${lm.id}`, bx, by, btnW, btnH, lm.city, {
        sublabel: `${lm.name} · ${lm.country}`,
        fontSize: 22,
        action: () => this.callbacks.onSelectLandmark(lm),
      });
    });

    // Minimal gesture guide footer
    ctx.fillStyle = '#94a3b8';
    ctx.font = '500 15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      'Manos sin controles:  Pellizca + Mueve = Rotar vista   ·   Abrir/Cerrar 2 manos = Zoom   ·   Barra superior = Mover tablero',
      CANVAS_W / 2,
      CANVAS_H - 32
    );

    this.texture.needsUpdate = true;
  }

  public dispose(): void {
    this.texture.dispose();
    this.grabTexIdle.dispose();
    this.grabTexHover.dispose();
    this.grabTexActive.dispose();
    this.panelMesh.geometry.dispose();
    (this.panelMesh.material as THREE.Material).dispose();
  }
}
