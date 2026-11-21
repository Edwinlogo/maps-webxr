import './style.css';
import * as THREE from 'three';
import type { GeocodeResult, MapLayer } from './types';
import { ANCHOR_Y_M, GlobeEngine } from './globe/GlobeEngine';
import { XRControllerManager } from './xr/XRControllerManager';
import { VRSpatialHUD } from './xr/VRSpatialHUD';
import { DesktopHUD } from './ui/DesktopHUD';
import { fetchServerConfig, setGoogleMapsPreferred } from './services/api';

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
  private activeLocationLabel = 'Planeta Tierra';

  private isDragging = false;
  private isOrbitTiltDragging = false;
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
      onResetNorth: () => this.globe.resetNorth(),
      onResetGlobe: () => {
        this.activeLocationLabel = 'Planeta Tierra';
        this.globe.resetView();
      },
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
    });

    this.desktopHud = new DesktopHUD(hudRoot, {
      onFlyToSearch: (res) => this.visitSearchResult(res),
      onSetLayer: (layer) => this.setLayer(layer),
      onTogglePassthrough: () => this.togglePassthrough(),
      onToggleTilt3D: () => this.toggleTilt3D(),
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

    this.applyPassthroughState(false);
    this.applyInitialUrlCoords();
    this.bindDesktopEvents();
    this.setupWebXR();
    this.refreshServerConfig();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  private applyInitialUrlCoords(): void {
    try {
      const params = new URLSearchParams(window.location.search);
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
          const name = params.get('name');
          if (name) this.activeLocationLabel = name;
        }
      }
    } catch {
      // ignore invalid query params
    }
  }

  private toggleTilt3D(): void {
    const active = this.globe.toggle3DTilt();
    this.desktopHud.setTilt3DActive(active);
    this.vrHud.updateState({ tilt3DEnabled: active });
    if (!this.renderer.xr.isPresenting) {
      this.desktopHud.showToast(active ? 'Inclinación 3D activada' : 'Vista vertical 2D');
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
    });

    this.renderer.xr.addEventListener('sessionend', () => {
      this.desktopRig.position.set(0, ANCHOR_Y_M, 0);
      this.desktopHud.setXRSupport(this.arSupported, this.vrSupported, false);
      this.desktopHud.setInXRSession(false);
      this.vrHud.setVisible(false);
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
    this.globe.flyTo(res.lat, res.lon, 1.5, 1.8);
  }

  private handleSelectRay(raycaster: THREE.Raycaster): void {
    if (this.vrHud.triggerClick(raycaster)) return;

    const globeHit = this.globe.raycastGlobe(raycaster);
    if (globeHit) {
      const curAlt = this.globe.getState().altitudeKm;
      const nextAlt = curAlt > 1500 ? 140 : curAlt > 35 ? 2.5 : Math.max(0.25, curAlt * 0.45);
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

      if (this.isOrbitTiltDragging) {
        const dx = e.clientX - this.lastPointerPos.x;
        const dy = e.clientY - this.lastPointerPos.y;
        this.lastPointerPos = { x: e.clientX, y: e.clientY };
        this.globe.rotateHeading(-dx * 0.28);
        this.globe.adjustTilt(-dy * 0.22);
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
      const targetAlt = curAlt > 800 ? 45 : curAlt > 8 ? 1.4 : 0.3;
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

    for (let i = 0; i < 2; i++) {
      const ray = this.xrControllers.getRaycasterForSlot(i);
      if (!ray) continue;

      const hudHit = this.vrHud.testHover(ray);
      if (hudHit) {
        hudHitAny = true;
        this.xrControllers.setSlotHitFeedback(i, hudHit.point, Boolean(hudHit.regionId));
        continue;
      }

      const gh = this.globe.raycastGlobe(ray);
      this.xrControllers.setSlotHitFeedback(i, gh?.worldPoint ?? null, false);
    }

    if (!hudHitAny) this.vrHud.clearHover();
  }

  private tick(): void {
    const nowSec = performance.now() / 1000;
    const dt = Math.min(0.05, Math.max(0.001, nowSec - this.prevTimeSec));
    this.prevTimeSec = nowSec;

    this.xrControllers.update(dt);
    this.updateXRPointerHovers();

    this.globe.update(dt, nowSec);
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
      locationLabel: this.activeLocationLabel,
    });

    this.renderer.render(this.scene, this.camera);
  }
}

new EarthXRApp();
