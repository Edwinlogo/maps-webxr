import * as THREE from 'three';
import type { MapLayer } from '../types';
import { formatAltitude, formatCoords } from '../services/geo';

export interface VRHudState {
  locationLabel: string;
  lat: number;
  lon: number;
  altitudeKm: number;
  headingDeg: number;
  tiltDeg: number;
  tilt3DEnabled: boolean;
  layer: MapLayer;
  passthrough: boolean;
  googleConfigured: boolean;
  googleActive: boolean;
}

export interface VRHudCallbacks {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onToggleTilt3D: () => void;
  onAdjustTilt: (deltaDeg: number) => void;
  onResetNorth: () => void;
  onResetGlobe: () => void;
  onTogglePassthrough: () => void;
  onSetLayer: (layer: MapLayer) => void;
  onToggleGoogleMaps: () => void;
  onExitXR: () => void;
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
const CANVAS_H = 420;
const PANEL_W_M = 0.88;
const PANEL_H_M = (PANEL_W_M * CANVAS_H) / CANVAS_W;

function createGrabHandleTexture(grabbed: boolean, hovered: boolean): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 72;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = grabbed
    ? 'rgba(16, 185, 129, 0.94)'
    : hovered
      ? 'rgba(14, 165, 233, 0.92)'
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
  private settingsOpen = false;
  private callbacks: VRHudCallbacks;
  private lastDrawHash = '';
  private state: VRHudState;

  constructor(callbacks: VRHudCallbacks) {
    this.callbacks = callbacks;
    this.state = {
      locationLabel: 'Planeta Tierra',
      lat: 16,
      lon: -52,
      altitudeKm: 13800,
      headingDeg: 0,
      tiltDeg: 0,
      tilt3DEnabled: true,
      layer: 'hybrid',
      passthrough: false,
      googleConfigured: false,
      googleActive: false,
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

    this.grabTexIdle = createGrabHandleTexture(false, false);
    this.grabTexHover = createGrabHandleTexture(false, true);
    this.grabTexActive = createGrabHandleTexture(true, true);

    const grabGeo = new THREE.PlaneGeometry(0.54, 0.076);
    this.grabBarMat = new THREE.MeshBasicMaterial({
      map: this.grabTexIdle,
      transparent: true,
      side: THREE.FrontSide,
    });
    this.grabBarMesh = new THREE.Mesh(grabGeo, this.grabBarMat);
    this.grabBarMesh.position.set(0, PANEL_H_M / 2 + 0.048, 0.004);
    this.grabBarMesh.renderOrder = 42;
    this.group.add(this.grabBarMesh);

    const bottomGeo = new THREE.PlaneGeometry(0.3, 0.032);
    this.bottomGrabMat = new THREE.MeshBasicMaterial({
      color: 0x94a3b8,
      transparent: true,
      opacity: 0.72,
    });
    this.bottomGrabMesh = new THREE.Mesh(bottomGeo, this.bottomGrabMat);
    this.bottomGrabMesh.position.set(0, -(PANEL_H_M / 2 + 0.03), 0.004);
    this.bottomGrabMesh.renderOrder = 42;
    this.group.add(this.bottomGrabMesh);

    this.group.position.set(0, 0.82, -1.08);
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
      camPos.x + camDir.x * 1.0,
      Math.max(0.66, camPos.y - 0.44),
      camPos.z + camDir.z * 1.0
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
    const offset = targetPos.clone().sub(camPos);
    const dist = THREE.MathUtils.clamp(offset.length(), 0.45, 2.6);
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

  public testHover(
    raycaster: THREE.Raycaster
  ): { point: THREE.Vector3; regionId: string | null; isGrab: boolean } | null {
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
      active?: boolean;
      accent?: 'cyan' | 'emerald' | 'violet' | 'rose' | 'slate';
      fontSize?: number;
      action: () => void;
    }
  ): void {
    this.regions.push({ id, x, y, w, h, action: options.action });
    const ctx = this.ctx;
    const hovered = this.hoveredRegionId === id;
    const accent = options.accent ?? 'slate';

    let fill = 'rgba(20, 32, 56, 0.86)';
    let stroke = 'rgba(148, 163, 184, 0.36)';
    let textColor = '#f1f5f9';

    if (accent === 'emerald') {
      fill = hovered ? 'rgba(16, 185, 129, 0.96)' : 'rgba(5, 150, 105, 0.9)';
      stroke = '#6ee7b7';
      textColor = '#ffffff';
    } else if (accent === 'cyan') {
      fill = hovered ? 'rgba(14, 165, 233, 0.96)' : 'rgba(2, 132, 199, 0.88)';
      stroke = '#7dd3fc';
      textColor = '#ffffff';
    } else if (accent === 'violet') {
      fill = hovered ? 'rgba(139, 92, 246, 0.96)' : 'rgba(109, 40, 217, 0.88)';
      stroke = '#c4b5fd';
      textColor = '#ffffff';
    } else if (accent === 'rose') {
      fill = hovered ? 'rgba(225, 29, 72, 0.92)' : 'rgba(159, 18, 57, 0.8)';
      stroke = '#fda4af';
      textColor = '#ffffff';
    } else if (options.active) {
      fill = 'rgba(14, 116, 144, 0.9)';
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
    ctx.lineWidth = hovered || options.active ? 3 : 1.8;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 18);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${options.fontSize ?? 22}px system-ui, -apple-system, sans-serif`;

    if (options.sublabel) {
      ctx.fillText(label, x + w / 2, y + h / 2 - 12, w - 18);
      ctx.font = '500 15px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(226, 232, 240, 0.86)';
      ctx.fillText(options.sublabel, x + w / 2, y + h / 2 + 15, w - 18);
    } else {
      ctx.fillText(label, x + w / 2, y + h / 2 + 1, w - 18);
    }
    ctx.restore();
  }

  private drawCompassButton(x: number, y: number, w: number, h: number, headingDeg: number): void {
    const id = 'compass_north';
    this.regions.push({ id, x, y, w, h, action: () => this.callbacks.onResetNorth() });
    const ctx = this.ctx;
    const hovered = this.hoveredRegionId === id;
    const normDeg = ((Math.round(headingDeg) % 360) + 360) % 360;

    ctx.save();
    ctx.fillStyle = hovered ? 'rgba(30, 58, 102, 0.95)' : 'rgba(20, 32, 56, 0.86)';
    ctx.strokeStyle = hovered ? '#38bdf8' : 'rgba(148, 163, 184, 0.36)';
    ctx.lineWidth = hovered ? 3 : 1.8;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 18);
    ctx.fill();
    ctx.stroke();

    // Mini rotating compass needle
    const cx = x + w / 2;
    const cy = y + 36;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((headingDeg * Math.PI) / 180);

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.stroke();

    // Red North arrow
    ctx.fillStyle = '#f43f5e';
    ctx.beginPath();
    ctx.moveTo(0, -18);
    ctx.lineTo(6, 2);
    ctx.lineTo(-6, 2);
    ctx.closePath();
    ctx.fill();

    // Slate South arrow
    ctx.fillStyle = '#94a3b8';
    ctx.beginPath();
    ctx.moveTo(0, 18);
    ctx.lineTo(5, 2);
    ctx.lineTo(-5, 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#f8fafc';
    ctx.font = '700 17px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`Brújula · ${normDeg}°`, cx, y + h - 22);
    ctx.restore();
  }

  private redraw(force: boolean): void {
    const s = this.state;
    const normHeading = ((Math.round(s.headingDeg) % 360) + 360) % 360;
    const hash = [
      this.settingsOpen ? 'cfg' : 'main',
      s.locationLabel,
      s.lat.toFixed(2),
      s.lon.toFixed(2),
      formatAltitude(s.altitudeKm),
      normHeading,
      Math.round(s.tiltDeg),
      s.tilt3DEnabled ? '3d' : '2d',
      s.layer,
      s.passthrough ? 'pt' : 'sp',
      s.googleConfigured ? 'gc1' : 'gc0',
      s.googleActive ? 'ga1' : 'ga0',
      this.hoveredRegionId ?? '',
    ].join('|');

    if (!force && hash === this.lastDrawHash) return;
    this.lastDrawHash = hash;
    this.regions = [];

    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Frosted glass frame
    const bgGrad = ctx.createLinearGradient(0, 0, CANVAS_W, CANVAS_H);
    bgGrad.addColorStop(0, 'rgba(6, 12, 26, 0.92)');
    bgGrad.addColorStop(1, 'rgba(11, 20, 40, 0.92)');
    ctx.fillStyle = bgGrad;
    ctx.strokeStyle = 'rgba(125, 211, 252, 0.38)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.roundRect(8, 8, CANVAS_W - 16, CANVAS_H - 16, 28);
    ctx.fill();
    ctx.stroke();

    if (this.settingsOpen) {
      this.drawSettingsView();
    } else {
      this.drawMainView();
    }

    this.texture.needsUpdate = true;
  }

  private drawMainView(): void {
    const s = this.state;
    const ctx = this.ctx;

    // Top telemetry header
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f8fafc';
    ctx.font = '700 26px system-ui, sans-serif';
    ctx.fillText(s.locationLabel, 34, 46, 560);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '500 17px ui-monospace, monospace';
    ctx.fillText(
      `${formatCoords(s.lat, s.lon)}   ·   Altitud ${formatAltitude(s.altitudeKm)}`,
      34,
      78,
      620
    );

    // Exit XR button top right
    this.drawButton('exit_xr', CANVAS_W - 186, 28, 154, 54, '✕  Salir XR', {
      accent: 'rose',
      fontSize: 18,
      action: () => this.callbacks.onExitXR(),
    });

    // Row 1: All 2D navigation controls (Zoom +, Zoom -, 3D/2D Tilt, Compass N, Full Globe)
    const r1Y = 112;
    const r1H = 104;
    const gap = 14;
    const w5 = (CANVAS_W - 68 - gap * 4) / 5;

    this.drawButton('zoom_in', 34, r1Y, w5, r1H, '+', {
      sublabel: 'Acercar',
      fontSize: 34,
      action: () => this.callbacks.onZoomIn(),
    });
    this.drawButton('zoom_out', 34 + (w5 + gap), r1Y, w5, r1H, '−', {
      sublabel: 'Alejar',
      fontSize: 34,
      action: () => this.callbacks.onZoomOut(),
    });
    this.drawButton(
      'tilt_3d',
      34 + (w5 + gap) * 2,
      r1Y,
      w5,
      r1H,
      s.tilt3DEnabled ? '3D' : '2D',
      {
        sublabel: s.tilt3DEnabled ? `Inclinado ${Math.round(s.tiltDeg)}°` : 'Vista vertical',
        active: s.tilt3DEnabled,
        fontSize: 28,
        action: () => this.callbacks.onToggleTilt3D(),
      }
    );
    this.drawCompassButton(34 + (w5 + gap) * 3, r1Y, w5, r1H, s.headingDeg);
    this.drawButton('reset_globe', 34 + (w5 + gap) * 4, r1Y, w5, r1H, '🌍', {
      sublabel: 'Planeta',
      fontSize: 30,
      action: () => this.callbacks.onResetGlobe(),
    });

    // Row 2: Cambiar fondo (Estrellas ↔ Realidad Passthrough) + Configuración
    const r2Y = 236;
    const r2H = 104;
    const halfW = (CANVAS_W - 68 - gap) / 2;

    this.drawButton(
      'toggle_bg',
      34,
      r2Y,
      halfW,
      r2H,
      s.passthrough ? '👁  FONDO: REALIDAD (PASSTHROUGH)' : '✦  FONDO: ESPACIO (ESTRELLAS)',
      {
        sublabel: s.passthrough ? 'Toca para cambiar a estrellas' : 'Toca para ver tu entorno real',
        accent: s.passthrough ? 'violet' : 'cyan',
        fontSize: 19,
        action: () => this.callbacks.onTogglePassthrough(),
      }
    );

    const layerName = s.layer === 'hybrid' ? 'Híbrido' : s.layer === 'satellite' ? 'Satélite' : 'Calles';
    const srcName = s.googleActive ? 'Google Map Tiles' : 'Satélite HD';
    this.drawButton('open_settings', 34 + halfW + gap, r2Y, halfW, r2H, '⚙  CONFIGURACIÓN', {
      sublabel: `${layerName} · ${srcName} · Inclinación`,
      fontSize: 21,
      action: () => {
        this.settingsOpen = true;
        this.redraw(true);
      },
    });

    // Gesture hint footer
    ctx.fillStyle = '#94a3b8';
    ctx.font = '500 15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      'Pellizcar + mover: Rotar planeta   ·   Abrir/cerrar 2 manos: Zoom   ·   Barra superior ⠿: Mover tablero',
      CANVAS_W / 2,
      CANVAS_H - 30
    );
  }

  private drawSettingsView(): void {
    const s = this.state;
    const ctx = this.ctx;

    // Header + Back button
    this.drawButton('cfg_back', 34, 28, 168, 52, '←  Volver', {
      accent: 'cyan',
      fontSize: 19,
      action: () => {
        this.settingsOpen = false;
        this.redraw(true);
      },
    });

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f8fafc';
    ctx.font = '700 25px system-ui, sans-serif';
    ctx.fillText('⚙  Configuración', 224, 54);

    // Section 1: Map Layers
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 16px system-ui, sans-serif';
    ctx.fillText('CAPA DEL MAPA', 38, 108);

    const gap = 14;
    const layerW = (CANVAS_W - 68 - gap * 2) / 3;
    this.drawButton('layer_hybrid', 34, 124, layerW, 64, 'Híbrido (Satélite + Calles)', {
      active: s.layer === 'hybrid',
      fontSize: 18,
      action: () => this.callbacks.onSetLayer('hybrid'),
    });
    this.drawButton('layer_sat', 34 + layerW + gap, 124, layerW, 64, 'Satélite Puro', {
      active: s.layer === 'satellite',
      fontSize: 18,
      action: () => this.callbacks.onSetLayer('satellite'),
    });
    this.drawButton('layer_streets', 34 + (layerW + gap) * 2, 124, layerW, 64, 'Mapa Callejero', {
      active: s.layer === 'streets',
      fontSize: 18,
      action: () => this.callbacks.onSetLayer('streets'),
    });

    // Section 2: Fondo + Tilt fine control + Google Map Tiles toggle
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 16px system-ui, sans-serif';
    ctx.fillText('FONDO, CÁMARA Y PROVEEDOR', 38, 214);

    this.drawButton(
      'cfg_bg',
      34,
      230,
      300,
      86,
      s.passthrough ? '👁 Realidad · Passthrough' : '✦ Espacio · Estrellas',
      {
        sublabel: 'Cambiar fondo',
        accent: s.passthrough ? 'violet' : 'slate',
        fontSize: 18,
        action: () => this.callbacks.onTogglePassthrough(),
      }
    );

    this.drawButton('cfg_tilt_up', 348, 230, 134, 86, 'Inclinar ▲', {
      sublabel: `${Math.round(s.tiltDeg)}°`,
      fontSize: 18,
      action: () => this.callbacks.onAdjustTilt(10),
    });
    this.drawButton('cfg_tilt_down', 494, 230, 134, 86, 'Inclinar ▼', {
      sublabel: 'Vertical',
      fontSize: 18,
      action: () => this.callbacks.onAdjustTilt(-10),
    });

    const gLabel = s.googleActive
      ? 'Google Map Tiles: ON'
      : s.googleConfigured
        ? 'Google Map Tiles: OFF'
        : 'Satélite HD (Por defecto)';
    const gSub = s.googleConfigured
      ? 'Toca para alternar proveedor'
      : 'Configura API Key en la web 2D';
    this.drawButton('cfg_google', 642, 230, 284, 86, gLabel, {
      sublabel: gSub,
      accent: s.googleActive ? 'emerald' : 'slate',
      fontSize: 17,
      action: () => this.callbacks.onToggleGoogleMaps(),
    });

    ctx.fillStyle = '#94a3b8';
    ctx.font = '500 15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      'Nota: Las búsquedas usan OpenStreetMap gratis (nunca Geocoding API)  ·  Pellizca barra ⠿ para mover este panel',
      CANVAS_W / 2,
      CANVAS_H - 36
    );
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
