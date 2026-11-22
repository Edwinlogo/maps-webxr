import './style.css';
import * as THREE from 'three';
import type { GeocodeResult, MapLayer } from './types';
import { ANCHOR_Y_M, GlobeEngine } from './globe/GlobeEngine';
import { XRControllerManager } from './xr/XRControllerManager';
import { VRSpatialHUD } from './xr/VRSpatialHUD';
import { DesktopHUD } from './ui/DesktopHUD';
import { fetchServerConfig, setGoogleMapsPreferred } from './services/api';

const STORAGE_AUTO_TILT_MAX = 'earthxr_auto_tilt_max_deg';
const STORAGE_FLOOR_SHADOW = 'earthxr_floor_shadow';

function loadSavedAutoTiltMax(): number {
  try {
    const raw = localStorage.getItem(STORAGE_AUTO_TILT_MAX);
    if (raw !== null) {
      const n = Number(raw);
      if (Number.isFinite(n)) return THREE.MathUtils.clamp(Math.round(n), 0, 90);
    }
  } catch {
    // ignore
  }
  return 45;
}

function loadSavedFloorShadow(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_FLOOR_SHADOW);
    if (raw === '0') return false;
  } catch {
    // ignore
  }
  return true;
}

class EarthXRApp {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private desktopRig: THREE.Group;

  private globe: GlobeEngine;
  private vrHud: VRSpatialHUD;
  private xrControllers: XRControllerManager;
  private desktopHud: DesktopHUD;

  private googleConfigured = false;
  private googleActive = false;
  private passthroughEnabled = false;
  private globeMoveMode = false;
  private activeLocationLabel = 'Planeta Tierra';
  private globeDragOffset = new THREE.Vector3();

  private isDragging = false;
  private isOrbitTiltDragging = false;
  private isGlobePosDragging = false;
  private lastPointerPos = { x: 0, y: 0 };
  private mouseRaycaster = new THREE.Raycaster();
  private mouseNdc = new THREE.Vector2();

  private arSupported = false;
  private vrSupported = false;
  private prevTimeSec = performance.now() / 1000;

  constructor() {
    this.canvas = document.getElementById('xr-canvas') as HTMLCanvasElement;
    const hudRoot = document.getElementById('hud-root') as HTMLElement;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');

    this.scene = new THREE.Scene();
    this.scene.background = null;

    this.camera = new THREE.PerspectiveCamera(
      56,
      window.innerWidth / window.innerHeight,
      0.04,
      600
    );

    this.desktopRig = new THREE.Group();
    this.desktopRig.position.set(0, ANCHOR_Y_M, 0);
    this.desktopRig.add(this.camera);
    this.scene.add(this.desktopRig);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.88));
    const dirLight = new THREE.DirectionalLight(0xbae6fd, 0.9);
    dirLight.position.set(2, 4, 3);
    this.scene.add(dirLight);

    this.globe = new GlobeEngine(this.renderer.capabilities.getMaxAnisotropy());
    this.scene.add(this.globe.root);

    this.vrHud = new VRSpatialHUD({
      onZoomIn: () => this.globe.zoomByFactor(0.52),
      onZoomOut: () => this.globe.zoomByFactor(1.85),
      onToggleTilt3D: () => this.toggleTilt3D(),
      onAdjustTilt: (delta) => {
        this.globe.adjustTilt(delta);
        this.desktopHud.setTilt3DActive(true);
      },
      onSetAutoTiltMax: (maxDeg) => this.applyAutoTiltMax(maxDeg),
      onResetNorth: () => this.globe.resetNorth(),
      onResetGlobe: () => {
        this.activeLocationLabel = 'Planeta Tierra';
        this.globe.resetView();
      },
      onToggleGlobeMoveMode: () => this.toggleGlobeMoveMode(),
      onResetGlobePosition: () => this.globe.resetGlobePosition(),
      onToggleFloorShadow: () => this.applyFloorShadow(!this.globe.isFloorShadowEnabled()),
      onTogglePassthrough: () => this.togglePassthrough(),
      onSetLayer: (layer) => this.setLayer(layer),
      onToggleGoogleMaps: () => {
        if (!this.googleConfigured) return;
        setGoogleMapsPreferred(!this.googleActive);
        this.refreshServerConfig();
      },
      onExitXR: () => {
        const s = this.renderer.xr.getSession();
        if (s) s.end();
      },
    });
    this.scene.add(this.vrHud.group);

    this.xrControllers = new XRControllerManager(this.renderer, this.scene, {
      onSelectRay: (ray) => this.handleSelectRay(ray),
      onLeftStick: (x, y, dt) => {
        const alt = this.globe.getState().altitudeKm;
        const degPerSec = THREE.MathUtils.clamp((alt / 6371) * 58, 0.005, 72);
        this.globe.panByDegrees(-y * degPerSec * dt, x * degPerSec * dt);
      },
      onRightStick: (x, y, dt) => {
        if (Math.abs(y) > 0.16) this.globe.zoomByFactor(Math.exp(y * dt * 1.9));
        if (Math.abs(x) > 0.25) this.globe.rotateHeading(x * dt * 68);
      },
      onButtonB: () => this.globe.zoomByFactor(2.4),
      onButtonX: () => {
        if (this.vrHud.isVisible()) {
          this.vrHud.setVisible(false);
        } else {
          this.vrHud.recenterToCamera(this.renderer.xr.getCamera());
        }
      },
      onRotateViewDrag: (deltaWorld) => {
        const alt = this.globe.getState().altitudeKm;
        const scale = THREE.MathUtils.clamp((alt / 6371) * 110, 0.014, 125);
        this.globe.panByDegrees(-deltaWorld.y * scale, -deltaWorld.x * scale);
      },
      onTwoHandZoom: (ratio) => this.globe.zoomByFactor(ratio),
      onTestPanelGrab: (ray) => {
        const hit = this.vrHud.hitTestGrabHandle(ray);
        if (hit) this.vrHud.setGrabState(true, true);
        return hit;
      },
      onTestPanelBody: (ray) => {
        const hit = this.vrHud.testHover(ray);
        return Boolean(hit && !hit.isGrab);
      },
      onPanelDragMove: (worldPos) => {
        const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
        this.vrHud.moveToWorldPosition(worldPos, cam);
      },
      onPanelDragEnd: () => this.vrHud.setGrabState(false, false),
      onTestGlobeHandle: (ray) => {
        const hit = this.globe.hitTestGlobeHandle(ray);
        if (hit) this.globe.setGlobeHandleState(true, true);
        return hit;
      },
      onTestGlobeBody: (ray) => {
        const hit = this.globe.raycastGlobe(ray);
        return hit ? { point: hit.worldPoint, distance: hit.distance } : null;
      },
      onGlobeDragStart: (grabWorldPoint) => {
        this.globe.stopIdleSpin();
        this.globe.setGlobeHandleState(true, true);
        const curPos = this.globe.getGlobeWorldPosition();
        this.globeDragOffset.copy(curPos).sub(grabWorldPoint);
      },
      onGlobeDragMove: (targetWorldPos) => {
        const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
        const desiredPos = targetWorldPos.clone().add(this.globeDragOffset);
        this.globe.moveGlobeToWorldPosition(desiredPos, cam);
      },
      onGlobeDragEnd: () => {
        this.globe.setGlobeHandleState(false, false);
      },
    });

    this.desktopHud = new DesktopHUD(hudRoot, {
      onFlyToSearch: (res) => this.visitSearchResult(res),
      onSetLayer: (layer) => this.setLayer(layer),
      onTogglePassthrough: () => this.togglePassthrough(),
      onToggleTilt3D: () => this.toggleTilt3D(),
      onSetAutoTiltMax: (maxDeg) => this.applyAutoTiltMax(maxDeg),
      onToggleFloorShadow: (enabled) => this.applyFloorShadow(enabled),
      onResetGlobePosition: () => this.globe.resetGlobePosition(),
      onResetNorth: () => {
        this.globe.resetNorth();
        this.desktopHud.showToast('Orientación al Norte');
      },
      onZoomIn: () => this.globe.zoomByFactor(0.55),
      onZoomOut: () => this.globe.zoomByFactor(1.75),
      onResetGlobe: () => {
        this.activeLocationLabel = 'Planeta Tierra';
        this.globe.resetView();
      },
      onRequestXR: (preferPassthrough) => this.toggleXRSession(preferPassthrough),
      onConfigUpdated: () => this.refreshServerConfig(),
    });

    this.applyAutoTiltMax(loadSavedAutoTiltMax(), false);
    this.applyFloorShadow(loadSavedFloorShadow(), false);
    this.applyPassthroughState(false);
    this.applyInitialUrlCoords();
    this.bindDesktopEvents();
    this.setupWebXR();
    this.refreshServerConfig();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  private applyAutoTiltMax(maxDeg: number, persist = true): void {
    const clamped = THREE.MathUtils.clamp(Math.round(maxDeg), 0, 90);
    this.globe.setAutoTiltMaxDeg(clamped);
    this.desktopHud.setAutoTiltMaxUI(clamped);
    this.desktopHud.setTilt3DActive(clamped > 0);
    this.vrHud.updateState({
      autoTiltMaxDeg: clamped,
      tilt3DEnabled: clamped > 0,
    });
    if (persist) {
      try {
        localStorage.setItem(STORAGE_AUTO_TILT_MAX, String(clamped));
      } catch {
        // ignore
      }
    }
  }

  private applyFloorShadow(enabled: boolean, persist = true): void {
    this.globe.setFloorShadowEnabled(enabled);
    this.desktopHud.setFloorShadowUI(enabled);
    this.vrHud.updateState({ floorShadowEnabled: enabled });
    if (persist) {
      try {
        localStorage.setItem(STORAGE_FLOOR_SHADOW, enabled ? '1' : '0');
      } catch {
        // ignore
      }
    }
  }

  private toggleGlobeMoveMode(): void {
    this.globeMoveMode = !this.globeMoveMode;
    this.xrControllers.setGlobeMoveMode(this.globeMoveMode);
    this.vrHud.updateState({ globeMoveMode: this.globeMoveMode });
  }

  private applyInitialUrlCoords(): void {
    try {
      const params = new URLSearchParams(window.location.search);
      const tiltRaw = params.get('tilt');
      if (tiltRaw !== null) {
        const tiltVal = Number(tiltRaw);
        if (Number.isFinite(tiltVal)) {
          this.applyAutoTiltMax(tiltVal, false);
        }
      }
      const latRaw = params.get('lat');
      const lonRaw = params.get('lon');
      if (latRaw !== null && lonRaw !== null) {
        const lat = Number(latRaw);
        const lon = Number(lonRaw);
        const altRaw = params.get('alt');
        const alt = altRaw !== null ? Number(altRaw) : 1.3;
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          const safeAlt = Number.isFinite(alt) && alt > 0 ? alt : 1.3;
          this.globe.setImmediatePosition(lat, lon, safeAlt);
          if (tiltRaw !== null && Number.isFinite(Number(tiltRaw))) {
            this.globe.setImmediateTilt(Number(tiltRaw));
          }
          const name = params.get('name');
          if (name) this.activeLocationLabel = name;
        }
      }
      const gx = params.get('gx');
      const gy = params.get('gy');
      const gz = params.get('gz');
      if (gx !== null || gy !== null || gz !== null) {
        this.globe.nudgeGlobeWorldPosition(
          Number(gx ?? 0) || 0,
          Number(gy ?? 0) || 0,
          Number(gz ?? 0) || 0
        );
      }
    } catch {
      // ignore invalid query params
    }
  }

  private toggleTilt3D(): void {
    const active = this.globe.toggle3DTilt();
    const maxDeg = this.globe.getAutoTiltMaxDeg();
    this.desktopHud.setAutoTiltMaxUI(maxDeg);
    this.desktopHud.setTilt3DActive(active);
    this.vrHud.updateState({ tilt3DEnabled: active, autoTiltMaxDeg: maxDeg });
    if (!this.renderer.xr.isPresenting) {
      this.desktopHud.showToast(
        active
          ? maxDeg >= 85
            ? 'Inclinación horizontal (90° paralelo al piso) activada'
            : `Inclinación 3D activada (máx ${maxDeg}°)`
          : 'Vista vertical 2D'
      );
    }
  }

  private applyPassthroughState(enabled: boolean): void {
    this.passthroughEnabled = enabled;
    this.globe.setPassthroughMode(enabled);
    this.xrControllers.setPassthroughMode(enabled);
    this.desktopHud.setPassthroughUI(enabled);
    this.vrHud.updateState({ passthrough: enabled });
    document.body.classList.toggle('passthrough-preview', enabled);
  }

  private togglePassthrough(): void {
    const next = !this.passthroughEnabled;
    this.applyPassthroughState(next);
    if (!this.renderer.xr.isPresenting) {
      this.desktopHud.showToast(
        next ? 'Fondo Realidad (Passthrough) listo para Meta Quest 3' : 'Fondo Espacio con estrellas'
      );
    }
  }

  private async refreshServerConfig(): Promise<void> {
    const cfg = await fetchServerConfig();
    this.googleConfigured = cfg.googleConfigured;
    this.googleActive = cfg.googleActive;
    this.globe.setGoogleMode(cfg.googleActive);
    this.desktopHud.setServerConfig(cfg);
    this.vrHud.updateState({
      googleConfigured: cfg.googleConfigured,
      googleActive: cfg.googleActive,
    });
  }

  private async setupWebXR(): Promise<void> {
    if ('xr' in navigator && navigator.xr) {
      try {
        this.arSupported = await navigator.xr.isSessionSupported('immersive-ar');
      } catch {
        this.arSupported = false;
      }
      try {
        this.vrSupported = await navigator.xr.isSessionSupported('immersive-vr');
      } catch {
        this.vrSupported = false;
      }
    }
    this.desktopHud.setXRSupport(this.arSupported, this.vrSupported, false);

    this.renderer.xr.addEventListener('sessionstart', () => {
      this.desktopRig.position.set(0, 0, 0);
      this.camera.rotation.set(0, 0, 0);
      this.desktopHud.setXRSupport(this.arSupported, this.vrSupported, true);
      this.desktopHud.setInXRSession(true);
      this.vrHud.setVisible(true);
      this.globe.setGlobeHandleVisible(true);
    });

    this.renderer.xr.addEventListener('sessionend', () => {
      this.desktopRig.position.set(0, ANCHOR_Y_M, 0);
      this.desktopHud.setXRSupport(this.arSupported, this.vrSupported, false);
      this.desktopHud.setInXRSession(false);
      this.vrHud.setVisible(false);
      this.globe.setGlobeHandleVisible(false);
      this.globeMoveMode = false;
      this.xrControllers.setGlobeMoveMode(false);
      this.vrHud.updateState({ globeMoveMode: false });
    });
  }

  private async toggleXRSession(preferPassthrough: boolean): Promise<void> {
    const active = this.renderer.xr.getSession();
    if (active) {
      await active.end();
      return;
    }
    if (!navigator.xr) {
      this.desktopHud.showToast('Abre https://maps.dcedwin.com en Meta Quest 3 para XR y Passthrough');
      return;
    }

    const tryOrder: XRSessionMode[] = this.arSupported
      ? ['immersive-ar', 'immersive-vr']
      : ['immersive-vr', 'immersive-ar'];

    for (const sessionMode of tryOrder) {
      try {
        const session = await navigator.xr.requestSession(sessionMode, {
          optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
        });
        this.applyPassthroughState(sessionMode === 'immersive-ar' ? preferPassthrough : false);
        await this.renderer.xr.setSession(session);
        return;
      } catch {
        // try fallback mode
      }
    }

    this.desktopHud.showToast('No se detectó un visor WebXR activo en este dispositivo');
  }

  private setLayer(layer: MapLayer): void {
    this.globe.setLayer(layer);
    this.desktopHud.setActiveLayer(layer);
    this.vrHud.updateState({ layer });
  }

  private visitSearchResult(res: GeocodeResult): void {
    this.activeLocationLabel = res.name;
    this.desktopHud.showToast(`Volando hacia ${res.name}...`);
    this.globe.flyTo(res.lat, res.lon, 1.0, 1.8);
  }

  private handleSelectRay(raycaster: THREE.Raycaster): void {
    if (this.vrHud.triggerClick(raycaster)) return;

    const globeHit = this.globe.raycastGlobe(raycaster);
    if (globeHit) {
      const curAlt = this.globe.getState().altitudeKm;
      const nextAlt = curAlt > 1500 ? 140 : curAlt > 35 ? 2.0 : Math.max(0.25, curAlt * 0.45);
      this.activeLocationLabel = 'Ubicación seleccionada';
      this.globe.flyTo(globeHit.lat, globeHit.lon, nextAlt, 1.2);
    }
  }

  private bindDesktopEvents(): void {
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.canvas.addEventListener('pointerdown', (e) => {
      // Middle button or Alt + Left drag: move the 3D globe freely in space!
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        e.preventDefault();
        this.isGlobePosDragging = true;
        this.lastPointerPos = { x: e.clientX, y: e.clientY };
        this.canvas.setPointerCapture(e.pointerId);
        this.globe.stopIdleSpin();
        return;
      }
      if (e.button === 2 || (e.button === 0 && e.shiftKey)) {
        this.isOrbitTiltDragging = true;
        this.lastPointerPos = { x: e.clientX, y: e.clientY };
        this.canvas.setPointerCapture(e.pointerId);
        this.globe.stopIdleSpin();
        return;
      }
      if (e.button !== 0) return;
      this.isDragging = true;
      this.lastPointerPos = { x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture(e.pointerId);
      this.globe.stopIdleSpin();
    });

    this.canvas.addEventListener('pointermove', (e) => {
      this.updateMouseRay(e);

      if (this.isGlobePosDragging) {
        const dx = e.clientX - this.lastPointerPos.x;
        const dy = e.clientY - this.lastPointerPos.y;
        this.lastPointerPos = { x: e.clientX, y: e.clientY };
        this.globe.nudgeGlobeWorldPosition(dx * 0.0045, -dy * 0.0045, 0);
        return;
      }

      if (this.isOrbitTiltDragging) {
        const dx = e.clientX - this.lastPointerPos.x;
        const dy = e.clientY - this.lastPointerPos.y;
        this.lastPointerPos = { x: e.clientX, y: e.clientY };
        this.globe.rotateHeading(-dx * 0.28);
        this.globe.adjustTilt(-dy * 0.28);
        this.desktopHud.setTilt3DActive(true);
        return;
      }

      if (!this.isDragging) return;

      const dx = e.clientX - this.lastPointerPos.x;
      const dy = e.clientY - this.lastPointerPos.y;
      this.lastPointerPos = { x: e.clientX, y: e.clientY };

      const alt = this.globe.getState().altitudeKm;
      const degPerPx = THREE.MathUtils.clamp((alt / 6371) * 0.17, 0.00003, 0.34);
      this.globe.panByDegrees(dy * degPerPx, -dx * degPerPx);
    });

    const endDrag = (e: PointerEvent) => {
      this.isDragging = false;
      this.isOrbitTiltDragging = false;
      this.isGlobePosDragging = false;
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    };

    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);

    this.canvas.addEventListener('dblclick', (e) => {
      this.updateMouseRay(e);
      const hit = this.globe.raycastGlobe(this.mouseRaycaster);
      if (!hit) return;
      const curAlt = this.globe.getState().altitudeKm;
      const targetAlt = curAlt > 800 ? 45 : curAlt > 8 ? 1.0 : 0.3;
      this.activeLocationLabel = 'Ubicación seleccionada';
      this.globe.flyTo(hit.lat, hit.lon, targetAlt, 1.15);
    });

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.updateMouseRay(e);
        const hit = e.deltaY < 0 ? this.globe.raycastGlobe(this.mouseRaycaster) : null;
        this.globe.zoomByFactor(Math.exp(e.deltaY * 0.00145), hit?.lat, hit?.lon);
      },
      { passive: false }
    );
  }

  private updateMouseRay(e: PointerEvent | MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.mouseNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouseNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.mouseRaycaster.setFromCamera(this.mouseNdc, this.camera);
  }

  private updateXRPointerHovers(): void {
    if (!this.renderer.xr.isPresenting) return;
    let hudHitAny = false;
    let globeHandleHitAny = false;

    for (let i = 0; i < 2; i++) {
      const ray = this.xrControllers.getRaycasterForSlot(i);
      if (!ray) continue;

      const hudHit = this.vrHud.testHover(ray);
      if (hudHit) {
        hudHitAny = true;
        this.xrControllers.setSlotHitFeedback(i, hudHit.point, Boolean(hudHit.regionId));
        continue;
      }

      const handleHit = this.globe.hitTestGlobeHandle(ray);
      if (handleHit) {
        globeHandleHitAny = true;
        this.globe.setGlobeHandleHover(true);
        this.xrControllers.setSlotHitFeedback(i, handleHit.point, true);
        continue;
      }

      const gh = this.globe.raycastGlobe(ray);
      this.xrControllers.setSlotHitFeedback(i, gh?.worldPoint ?? null, this.globeMoveMode);
    }

    if (!hudHitAny) this.vrHud.clearHover();
    if (!globeHandleHitAny) this.globe.setGlobeHandleHover(false);
  }

  private tick(): void {
    const nowSec = performance.now() / 1000;
    const dt = Math.min(0.05, Math.max(0.001, nowSec - this.prevTimeSec));
    this.prevTimeSec = nowSec;

    this.xrControllers.update(dt);
    this.updateXRPointerHovers();

    const activeCam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
    this.globe.update(dt, nowSec, activeCam);
    const st = this.globe.getState();

    this.desktopHud.updateTelemetry(
      st.lat,
      st.lon,
      st.altitudeKm,
      st.headingDeg,
      this.activeLocationLabel
    );
    this.vrHud.updateState({
      lat: st.lat,
      lon: st.lon,
      altitudeKm: st.altitudeKm,
      headingDeg: st.headingDeg,
      tiltDeg: st.tiltDeg,
      tilt3DEnabled: this.globe.isTilt3DEnabled(),
      autoTiltMaxDeg: this.globe.getAutoTiltMaxDeg(),
      floorShadowEnabled: this.globe.isFloorShadowEnabled(),
      locationLabel: this.activeLocationLabel,
    });

    this.renderer.render(this.scene, this.camera);
  }
}

new EarthXRApp();
