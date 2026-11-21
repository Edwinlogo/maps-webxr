import * as THREE from 'three';
import type { AppMode, Landmark, MapLayer, PanoramaItem } from '../types';
import { formatAltitude, formatCoords, formatDistance } from '../services/geo';

export interface VRHudState {
  mode: AppMode;
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
  onSelectLandmark: (landmark: Landmark) => void;
  onSetLayer: (layer: MapLayer) => void;
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

const CANVAS_W = 1024;
const CANVAS_H = 640;
const PANEL_W_M = 1.08;
const PANEL_H_M = (PANEL_W_M * CANVAS_H) / CANVAS_W;

export class VRSpatialHUD {
  public readonly group = new THREE.Group();
  public readonly panelMesh: THREE.Mesh;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private regions: HitRegion[] = [];
  private hoveredRegionId: string | null = null;
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
      locationLabel: 'Planeta Tierra',
      lat: 26,
      lon: -18,
      altitudeKm: 13800,
      layer: 'hybrid',
      nearbyPano: null,
      searchingPano: false,
      currentPano: null,
      streetQuality: 'loading',
      statusMessage: 'Acércate a una ciudad o elige un destino',
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

    // Comfortable cockpit position below forward gaze in Quest 3
    this.group.position.set(0, 0.78, -1.18);
    this.group.rotation.set(-0.42, 0, 0);
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
      camPos.x + camDir.x * 1.15,
      Math.max(0.65, camPos.y - 0.52),
      camPos.z + camDir.z * 1.15
    );
    this.group.lookAt(camPos.x, camPos.y - 0.1, camPos.z);
    this.group.visible = true;
  }

  public updateState(partial: Partial<VRHudState>): void {
    this.state = { ...this.state, ...partial };
    this.redraw(false);
  }

  public testHover(raycaster: THREE.Raycaster): { point: THREE.Vector3; regionId: string | null } | null {
    if (!this.group.visible) return null;
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

    return { point: hits[0].point, regionId: hitId };
  }

  public clearHover(): void {
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
    return true; // swallow panel clicks so they don't click through to globe
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
      accent?: 'cyan' | 'emerald' | 'amber' | 'slate';
      fontSize?: number;
      action: () => void;
    }
  ): void {
    this.regions.push({ id, x, y, w, h, action: options.action });
    const ctx = this.ctx;
    const hovered = this.hoveredRegionId === id;
    const accent = options.accent ?? 'slate';

    let fill = 'rgba(20, 32, 58, 0.88)';
    let stroke = 'rgba(100, 116, 139, 0.55)';
    let textColor = '#e2e8f0';

    if (accent === 'emerald') {
      fill = hovered ? 'rgba(16, 185, 129, 0.96)' : 'rgba(5, 150, 105, 0.9)';
      stroke = '#6ee7b7';
      textColor = '#ffffff';
    } else if (accent === 'cyan') {
      fill = hovered ? 'rgba(14, 165, 233, 0.95)' : 'rgba(2, 132, 199, 0.85)';
      stroke = '#7dd3fc';
      textColor = '#ffffff';
    } else if (accent === 'amber') {
      fill = hovered ? 'rgba(245, 158, 11, 0.95)' : 'rgba(217, 119, 6, 0.88)';
      stroke = '#fde68a';
      textColor = '#ffffff';
    } else if (options.active) {
      fill = 'rgba(14, 116, 144, 0.85)';
      stroke = '#38bdf8';
      textColor = '#ffffff';
    } else if (hovered) {
      fill = 'rgba(30, 58, 102, 0.95)';
      stroke = '#38bdf8';
      textColor = '#ffffff';
    }

    ctx.save();
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = hovered || options.primary ? 3 : 2;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 16);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${options.primary ? '700' : '600'} ${options.fontSize ?? 22}px system-ui, -apple-system, sans-serif`;

    if (options.sublabel) {
      ctx.fillText(label, x + w / 2, y + h / 2 - 11, w - 20);
      ctx.font = '500 16px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(226, 232, 240, 0.86)';
      ctx.fillText(options.sublabel, x + w / 2, y + h / 2 + 14, w - 20);
    } else {
      ctx.fillText(label, x + w / 2, y + h / 2 + 1, w - 20);
    }
    ctx.restore();
  }

  private redraw(force: boolean): void {
    const s = this.state;
    const hash = [
      s.mode,
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

    // Outer glass panel
    const bgGrad = ctx.createLinearGradient(0, 0, CANVAS_W, CANVAS_H);
    bgGrad.addColorStop(0, 'rgba(6, 12, 28, 0.93)');
    bgGrad.addColorStop(1, 'rgba(11, 22, 46, 0.93)');
    ctx.fillStyle = bgGrad;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.roundRect(10, 10, CANVAS_W - 20, CANVAS_H - 20, 28);
    ctx.fill();
    ctx.stroke();

    // Header bar
    ctx.fillStyle = '#38bdf8';
    ctx.font = '800 28px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('EARTH XR · META QUEST 3', 38, 52);

    // Mode pill
    const isSV = s.mode === 'streetview';
    ctx.fillStyle = isSV ? 'rgba(16, 185, 129, 0.22)' : 'rgba(56, 189, 248, 0.2)';
    ctx.strokeStyle = isSV ? '#34d399' : '#38bdf8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(CANVAS_W - 280, 30, 242, 42, 21);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = isSV ? '#6ee7b7' : '#7dd3fc';
    ctx.font = '700 18px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(isSV ? '● STREET VIEW 360°' : '● PLANETA 3D', CANVAS_W - 159, 52);

    // Telemetry strip
    ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
    ctx.beginPath();
    ctx.roundRect(34, 88, CANVAS_W - 68, 72, 16);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.fillStyle = '#f8fafc';
    ctx.font = '700 24px system-ui, sans-serif';
    ctx.fillText(s.locationLabel, 54, 114, 560);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '500 18px ui-monospace, monospace';
    ctx.fillText(
      `${formatCoords(s.lat, s.lon)}   |   ${isSV ? 'Nivel calle 360°' : `Altitud: ${formatAltitude(s.altitudeKm)}`}`,
      54,
      143
    );

    // Primary Street View / Return to Globe CTA button
    if (isSV) {
      const linkCount = s.currentPano?.links.length ?? 0;
      const qual =
        s.streetQuality === 'hd' ? 'HD 4K' : s.streetQuality === 'sd' ? 'Cargando HD...' : 'Cargando...';
      this.drawButton('primary_cta', 34, 178, 490, 92, 'VOLVER AL PLANETA 3D', {
        sublabel: `Botón B / Y · ${qual} · ${linkCount} pasos en calle`,
        primary: true,
        accent: 'amber',
        fontSize: 25,
        action: () => this.callbacks.onToggleStreetView(),
      });

      this.drawButton('sv_walk', 540, 178, 220, 92, 'AVANZAR', {
        sublabel: 'Siguiente 360°',
        accent: 'cyan',
        fontSize: 22,
        action: () => this.callbacks.onStepForward(),
      });
      this.drawButton('sv_left', 776, 178, 102, 92, '↺ -30°', {
        fontSize: 22,
        action: () => this.callbacks.onTurnLeft(),
      });
      this.drawButton('sv_right', 888, 178, 102, 92, '↻ +30°', {
        fontSize: 22,
        action: () => this.callbacks.onTurnRight(),
      });
    } else {
      const hasNearby = Boolean(s.nearbyPano);
      const ctaTitle = hasNearby ? 'ENTRAR A STREET VIEW 360°' : 'BUSCAR STREET VIEW 360° AQUÍ';
      const ctaSub = s.searchingPano
        ? 'Buscando captura 360° cercana...'
        : s.nearbyPano
          ? `360° disponible a ${formatDistance(s.nearbyPano.distanceMeters)} · Botón A`
          : s.statusMessage;

      this.drawButton('primary_cta', 34, 178, 560, 92, ctaTitle, {
        sublabel: ctaSub,
        primary: true,
        accent: hasNearby ? 'emerald' : 'cyan',
        fontSize: 24,
        action: () => this.callbacks.onToggleStreetView(),
      });

      // Zoom + / - / Reset controls
      this.drawButton('zoom_in', 610, 178, 120, 92, 'ZOOM +', {
        sublabel: 'Acercar',
        fontSize: 20,
        action: () => this.callbacks.onZoomIn(),
      });
      this.drawButton('zoom_out', 742, 178, 120, 92, 'ZOOM −', {
        sublabel: 'Alejar',
        fontSize: 20,
        action: () => this.callbacks.onZoomOut(),
      });
      this.drawButton('reset_globe', 874, 178, 116, 92, 'GLOBO', {
        sublabel: 'Órbita',
        fontSize: 20,
        action: () => this.callbacks.onResetGlobe(),
      });
    }

    // Layer switcher row
    ctx.textAlign = 'left';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 18px system-ui, sans-serif';
    ctx.fillText('CAPA DEL PLANETA:', 38, 306);

    this.drawButton('layer_hybrid', 228, 284, 180, 44, 'Híbrido', {
      active: s.layer === 'hybrid',
      fontSize: 19,
      action: () => this.callbacks.onSetLayer('hybrid'),
    });
    this.drawButton('layer_sat', 420, 284, 170, 44, 'Satélite', {
      active: s.layer === 'satellite',
      fontSize: 19,
      action: () => this.callbacks.onSetLayer('satellite'),
    });
    this.drawButton('layer_streets', 602, 284, 170, 44, 'Calles', {
      active: s.layer === 'streets',
      fontSize: 19,
      action: () => this.callbacks.onSetLayer('streets'),
    });

    // Page arrows for destinations
    const perPage = 8;
    const totalPages = Math.max(1, Math.ceil(this.landmarks.length / perPage));
    this.drawButton('page_prev', 830, 284, 72, 44, '◀', {
      fontSize: 20,
      action: () => {
        this.pageIndex = (this.pageIndex - 1 + totalPages) % totalPages;
        this.redraw(true);
      },
    });
    this.drawButton('page_next', 914, 284, 72, 44, '▶', {
      fontSize: 20,
      action: () => {
        this.pageIndex = (this.pageIndex + 1) % totalPages;
        this.redraw(true);
      },
    });

    // Quick 360° Teleport Destinations Grid (4x2)
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 17px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`DESTINOS VERIFICADOS CON 360° (Pág. ${this.pageIndex + 1}/${totalPages}):`, 38, 356);

    const start = this.pageIndex * perPage;
    const slice = this.landmarks.slice(start, start + perPage);
    const cols = 4;
    const gap = 14;
    const btnW = (CANVAS_W - 68 - gap * (cols - 1)) / cols;
    const btnH = 82;

    slice.forEach((lm, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const bx = 34 + col * (btnW + gap);
      const by = 376 + row * (btnH + gap);
      this.drawButton(`lm_${lm.id}`, bx, by, btnW, btnH, lm.city, {
        sublabel: lm.name,
        fontSize: 21,
        action: () => this.callbacks.onSelectLandmark(lm),
      });
    });

    // Footer Meta Quest 3 controls cheat-sheet
    ctx.fillStyle = '#64748b';
    ctx.font = '500 16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      'Stick Izq: Mover planeta / Caminar   ·   Stick Der: Zoom / Giro 30°   ·   Grip: Agarrar Globo   ·   A: Street View   ·   B: Salir   ·   X: Panel',
      CANVAS_W / 2,
      CANVAS_H - 36
    );

    this.texture.needsUpdate = true;
  }

  public dispose(): void {
    this.texture.dispose();
    this.panelMesh.geometry.dispose();
    (this.panelMesh.material as THREE.Material).dispose();
  }
}
