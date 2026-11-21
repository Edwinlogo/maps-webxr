import './style.css';
import * as THREE from 'three';
import type {
  AppMode,
  GeocodeResult,
  Landmark,
  MapLayer,
  PanoramaItem,
  PanoramaLink,
} from './types';
import { LANDMARKS } from './data/landmarks';
import { ANCHOR_Y_M, GlobeEngine } from './globe/GlobeEngine';
import { GlobeMarkers } from './globe/GlobeMarkers';
import { StreetViewEngine } from './streetview/StreetViewEngine';
import { XRControllerManager } from './xr/XRControllerManager';
import { VRSpatialHUD } from './xr/VRSpatialHUD';
import { DesktopHUD } from './ui/DesktopHUD';
import { fetchPanoramaById, fetchServerConfig, searchPanoramasNear } from './services/api';
import { DEG2RAD, formatDistance, haversineMeters } from './services/geo';

class EarthXRApp {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private desktopRig: THREE.Group;

  private globe: GlobeEngine;
  private markers: GlobeMarkers;
  private streetView: StreetViewEngine;
  private vrHud: VRSpatialHUD;
  private xrControllers: XRControllerManager;
  private desktopHud: DesktopHUD;

  private fadeMesh: THREE.Mesh;
  private fadeMat: THREE.MeshBasicMaterial;
  private fadeOpacity = 0;
  private fadeTarget = 0;

  private mode: AppMode = 'globe';
  private googleActive = false;
  private passthroughEnabled = false;
  private streetPickMode = false;
  private activeLocationLabel = 'Planeta Tierra';
  private nearbyPanoramas: PanoramaItem[] = [];
  private activePanorama: PanoramaItem | null = null;
  private searchingPano = false;
  private scanAbort: AbortController | null = null;
  private lastScanLat = 999;
  private lastScanLon = 999;
  private lastScanTime = 0;
  private autoEnterCooldown = 0;

  private isDragging = false;
  private isOrbitTiltDragging = false;
  private pointerDownPos = { x: 0, y: 0 };
  private lastPointerPos = { x: 0, y: 0 };
  private dragMoved = false;
  private svLookYaw = 0;
  private svLookPitch = 0;
  private mouseRaycaster = new THREE.Raycaster();
  private mouseNdc = new THREE.Vector2();

  private arSupported = false;
  private vrSupported = false;
  private prevTimeSec = performance.now() / 1000;

  constructor() {
    this.canvas = document.getElementById('xr-canvas') as HTMLCanvasElement;
    const hudRoot = document.getElementById('hud-root') as HTMLElement;

    // alpha: true enables true color Passthrough (Mixed Reality) on Meta Quest 3!
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
    this.scene.background = null; // Space dome handles opaque starfield; hiding it reveals Passthrough!

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

    const fadeGeo = new THREE.SphereGeometry(0.42, 16, 12);
    this.fadeMat = new THREE.MeshBasicMaterial({
      color: 0x020617,
      transparent: true,
      opacity: 0,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    this.fadeMesh = new THREE.Mesh(fadeGeo, this.fadeMat);
    this.fadeMesh.renderOrder = 100;
    this.fadeMesh.visible = false;
    this.camera.add(this.fadeMesh);

    this.globe = new GlobeEngine(this.renderer.capabilities.getMaxAnisotropy());
    this.scene.add(this.globe.root);

    this.markers = new GlobeMarkers(LANDMARKS);
    this.globe.globeGroup.add(this.markers.group);

    this.streetView = new StreetViewEngine(this.renderer.capabilities.maxTextureSize);
    this.scene.add(this.streetView.root);

    this.vrHud = new VRSpatialHUD(LANDMARKS, {
      onToggleStreetView: () => this.toggleStreetViewFromAction(),
      onTogglePassthrough: () => this.togglePassthrough(),
      onSelectLandmark: (lm) => this.visitLandmark(lm),
      onSetLayer: (layer) => this.setLayer(layer),
      onToggleStreetPick: () => this.toggleStreetPick(),
      onZoomIn: () => this.globe.zoomByFactor(0.52),
      onZoomOut: () => this.globe.zoomByFactor(1.85),
      onResetGlobe: () => {
        this.activeLocationLabel = 'Planeta Tierra';
        this.globe.resetView();
      },
      onStepForward: () => this.stepForwardInStreetView(),
      onTurnLeft: () => this.streetView.snapTurn(-30),
      onTurnRight: () => this.streetView.snapTurn(30),
    });
    this.scene.add(this.vrHud.group);

    this.xrControllers = new XRControllerManager(this.renderer, this.scene, {
      onSelectRay: (ray) => this.handleSelectRay(ray),
      onLeftStick: (x, y, dt) => {
        if (this.mode !== 'globe') return;
        const alt = this.globe.getState().altitudeKm;
        const degPerSec = THREE.MathUtils.clamp((alt / 6371) * 58, 0.005, 72);
        this.globe.panByDegrees(-y * degPerSec * dt, x * degPerSec * dt);
      },
      onRightStick: (x, y, dt) => {
        if (this.mode !== 'globe') return;
        if (Math.abs(y) > 0.16) this.globe.zoomByFactor(Math.exp(y * dt * 1.9));
        if (Math.abs(x) > 0.25) this.globe.rotateHeading(x * dt * 68);
      },
      onSnapTurn: (dir) => {
        if (this.mode === 'streetview') this.streetView.snapTurn(dir * 30);
      },
      onWalkForward: () => {
        if (this.mode === 'streetview') this.stepForwardInStreetView();
      },
      onButtonA: () => this.toggleStreetViewFromAction(),
      onButtonB: () => {
        if (this.mode === 'streetview') {
          this.exitStreetView();
        } else {
          this.globe.zoomByFactor(2.4);
        }
      },
      onButtonX: () => {
        if (this.vrHud.isVisible()) {
          this.vrHud.setVisible(false);
        } else {
          this.vrHud.recenterToCamera(this.renderer.xr.getCamera());
        }
      },
      // Bare-hand Pinch + Move OR Controller Drag: rotates Planet OR rotates 360° Street View!
      onRotateViewDrag: (deltaWorld) => {
        if (this.mode === 'globe') {
          const alt = this.globe.getState().altitudeKm;
          const scale = THREE.MathUtils.clamp((alt / 6371) * 110, 0.014, 125);
          this.globe.panByDegrees(-deltaWorld.y * scale, -deltaWorld.x * scale);
        } else {
          // Swipe with bare hand to spin the 360° street panorama effortlessly!
          this.streetView.snapTurn(-deltaWorld.x * 165);
        }
      },
      // Bare-hand Two-Hand Spread / Pinch-Out Zoom!
      onTwoHandZoom: (ratio) => {
        if (this.mode === 'globe') {
          this.globe.zoomByFactor(ratio);
        }
      },
      // Movable 3D Control Panel Grab Handle!
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
      onPanelDragEnd: () => {
        this.vrHud.setGrabState(false, false);
      },
    });

    this.desktopHud = new DesktopHUD(hudRoot, LANDMARKS, {
      onSelectLandmark: (lm) => this.visitLandmark(lm),
      onFlyToSearch: (res) => this.visitSearchResult(res),
      onEnterStreetView: (pano) => this.enterStreetView(pano ?? this.nearbyPanoramas[0]),
      onExitStreetView: () => this.exitStreetView(),
      onStepLink: (link) => this.stepToLink(link),
      onSetLayer: (layer) => this.setLayer(layer),
      onTogglePassthrough: () => this.togglePassthrough(),
      onToggleSvOverlay: () => this.toggleSvOverlay(),
      onToggleStreetPick: () => this.toggleStreetPick(),
      onToggleTilt3D: () => {
        const active = this.globe.toggle3DTilt();
        this.desktopHud.setTilt3DActive(active);
        this.desktopHud.showToast(active ? 'Inclinación 3D estilo Google Earth activada' : 'Vista vertical 2D');
      },
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
      onScanHere: () => {
        const st = this.globe.getState();
        this.openStreetViewAtCoords(st.lat, st.lon);
      },
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
        next
          ? 'Modo Realidad (Passthrough) listo para Meta Quest 3'
          : 'Fondo Espacio con estrellas activo'
      );
    }
  }

  private async refreshServerConfig(): Promise<void> {
    const cfg = await fetchServerConfig();
    this.googleActive = cfg.googleActive;
    this.globe.setGoogleMode(cfg.googleActive);
    this.desktopHud.setServerConfig(cfg);
    this.desktopHud.setSvOverlayActive(this.globe.getStreetViewOverlay());
    this.vrHud.updateState({ googleActive: cfg.googleActive });

    const st = this.globe.getState();
    if (st.altitudeKm <= 30) {
      this.scanStreetViewNear(st.lat, st.lon, false);
    }
  }

  private toggleSvOverlay(): void {
    const next = !this.globe.getStreetViewOverlay();
    this.globe.setStreetViewOverlay(next);
    this.desktopHud.setSvOverlayActive(next);
  }

  private toggleStreetPick(): void {
    this.streetPickMode = !this.streetPickMode;
    this.desktopHud.setStreetPickActive(this.streetPickMode);
    this.vrHud.updateState({ streetPickMode: this.streetPickMode });
    this.canvas.style.cursor = this.streetPickMode ? 'crosshair' : 'grab';
    if (this.streetPickMode) {
      this.desktopHud.showToast('Haz clic sobre cualquier calle para abrir Vista 360°');
    }
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

    // Prefer immersive-ar on Meta Quest 3 because it allows seamless live switching
    // between Passthrough Reality (alpha=0) and Starry Space (opaque sky dome) without restarting!
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

  private visitLandmark(lm: Landmark): void {
    this.activeLocationLabel = `${lm.name} · ${lm.city}`;
    if (this.mode === 'streetview') {
      this.openStreetViewAtCoords(lm.lat, lm.lon, lm.verified360Id);
      return;
    }

    this.desktopHud.showToast(`Volando hacia ${lm.city}...`);
    this.globe.flyTo(lm.lat, lm.lon, lm.defaultAltitudeKm, 1.85, () => {
      this.scanStreetViewNear(lm.lat, lm.lon, true, lm.verified360Id);
    });
  }

  private visitSearchResult(res: GeocodeResult): void {
    this.activeLocationLabel = res.name;
    const goToGlobe = () => {
      this.desktopHud.showToast(`Volando hacia ${res.name}...`);
      this.globe.flyTo(res.lat, res.lon, 1.6, 1.85, () => {
        this.scanStreetViewNear(res.lat, res.lon, true);
      });
    };
    if (this.mode === 'streetview') {
      this.exitStreetView(goToGlobe);
    } else {
      goToGlobe();
    }
  }

  private async openStreetViewAtCoords(
    lat: number,
    lon: number,
    fallbackPanoramaxId?: string
  ): Promise<void> {
    this.desktopHud.showToast('Buscando vista 360° cercana...');
    await this.scanStreetViewNear(lat, lon, true, fallbackPanoramaxId);
    if (this.nearbyPanoramas.length > 0) {
      await this.enterStreetView(this.nearbyPanoramas[0]);
    }
  }

  private async scanStreetViewNear(
    lat: number,
    lon: number,
    explicit = false,
    fallbackPanoramaxId?: string
  ): Promise<void> {
    this.scanAbort?.abort();
    this.scanAbort = new AbortController();

    this.lastScanLat = lat;
    this.lastScanLon = lon;
    this.lastScanTime = performance.now() / 1000;
    this.searchingPano = true;

    this.desktopHud.updateStreetViewAvailability(null, true);
    this.vrHud.updateState({
      searchingPano: true,
      nearbyPano: null,
      statusMessage: 'Buscando vista 360°...',
    });

    try {
      const alt = this.globe.getState().altitudeKm;
      const radius = this.googleActive
        ? alt > 15
          ? 600
          : alt > 3
            ? 250
            : 80
        : alt > 20
          ? 2500
          : 600;
      const res = await searchPanoramasNear(lat, lon, radius, this.scanAbort.signal);

      let items = res.items;
      if (!this.googleActive && fallbackPanoramaxId && !items.some((i) => i.id === fallbackPanoramaxId)) {
        try {
          const verified = await fetchPanoramaById(
            fallbackPanoramaxId,
            undefined,
            'panoramax',
            this.scanAbort.signal
          );
          items = [verified, ...items];
        } catch {
          // ignore
        }
      }

      this.nearbyPanoramas = items;
      this.markers.setNearbyPanoramas(items);
      this.searchingPano = false;

      const closest = items[0] ?? null;
      if (closest) {
        if (closest.address) this.activeLocationLabel = closest.address;
        this.desktopHud.updateStreetViewAvailability(closest, false);
        this.vrHud.updateState({
          searchingPano: false,
          nearbyPano: closest,
          statusMessage: `360° listo a ${formatDistance(closest.distanceMeters)}`,
        });
      } else {
        const msg = 'Sin capturas 360° aquí · Agrega token de Mapillary o Map Tiles API en ⚙';
        this.desktopHud.updateStreetViewAvailability(null, false, msg);
        this.vrHud.updateState({
          searchingPano: false,
          nearbyPano: null,
          statusMessage: 'Sin 360° en esta zona · Prueba otro destino',
        });
        if (explicit) this.desktopHud.showToast(msg, 3400);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      this.searchingPano = false;
      this.desktopHud.updateStreetViewAvailability(null, false, 'Error consultando 360°');
      this.vrHud.updateState({ searchingPano: false, statusMessage: 'Error de red' });
    }
  }

  private async toggleStreetViewFromAction(): Promise<void> {
    if (this.mode === 'streetview') {
      this.exitStreetView();
      return;
    }
    if (this.nearbyPanoramas.length > 0) {
      await this.enterStreetView(this.nearbyPanoramas[0]);
      return;
    }
    const st = this.globe.getState();
    await this.openStreetViewAtCoords(st.lat, st.lon);
  }

  private async enterStreetView(pano?: PanoramaItem): Promise<void> {
    if (!pano) {
      this.desktopHud.showToast('No hay vista 360° seleccionada aún');
      return;
    }

    if (this.streetPickMode) {
      this.streetPickMode = false;
      this.desktopHud.setStreetPickActive(false);
      this.vrHud.updateState({ streetPickMode: false });
      this.canvas.style.cursor = 'grab';
    }

    this.xrControllers.pulseAllHaptics(0.6, 55);
    this.fadeTarget = 1;
    await this.waitMs(180);

    let fullPano = pano;
    if (pano.links.length === 0) {
      try {
        fullPano = await fetchPanoramaById(pano.id, pano.collection, pano.provider);
      } catch {
        fullPano = pano;
      }
    }

    this.mode = 'streetview';
    this.activePanorama = fullPano;
    if (fullPano.address) this.activeLocationLabel = fullPano.address;

    this.globe.root.visible = false;
    this.streetView.root.visible = true;
    this.streetView.resetYaw();
    this.svLookYaw = 0;
    this.svLookPitch = 0;
    if (!this.renderer.xr.isPresenting) {
      this.camera.rotation.set(0, 0, 0, 'YXZ');
    }

    this.desktopHud.setMode('streetview', fullPano, 'loading');
    this.vrHud.updateState({
      mode: 'streetview',
      locationLabel: this.activeLocationLabel,
      currentPano: fullPano,
      lat: fullPano.lat,
      lon: fullPano.lon,
      streetQuality: 'loading',
      statusMessage: 'Cargando 360°...',
    });

    await this.streetView.loadPanorama(fullPano, (stage) => {
      if (this.mode !== 'streetview') return;
      this.desktopHud.setMode('streetview', fullPano, stage);
      this.vrHud.updateState({ streetQuality: stage });
      if (stage === 'sd') this.fadeTarget = 0;
    });
    this.fadeTarget = 0;
  }

  private async stepToLink(link: PanoramaLink): Promise<void> {
    if (this.mode !== 'streetview') return;
    this.xrControllers.pulseAllHaptics(0.4, 30);
    this.fadeTarget = 0.85;
    await this.waitMs(130);

    try {
      const provider = this.activePanorama?.provider ?? (this.googleActive ? 'google' : 'panoramax');
      const nextPano = await fetchPanoramaById(link.id, link.collection, provider);
      this.activePanorama = nextPano;
      if (nextPano.address) this.activeLocationLabel = nextPano.address;
      this.globe.flyTo(nextPano.lat, nextPano.lon, 0.45, 0.1);

      this.desktopHud.setMode('streetview', nextPano, 'loading');
      this.vrHud.updateState({
        locationLabel: this.activeLocationLabel,
        currentPano: nextPano,
        lat: nextPano.lat,
        lon: nextPano.lon,
        streetQuality: 'loading',
      });

      await this.streetView.loadPanorama(nextPano, (stage) => {
        if (this.mode !== 'streetview') return;
        this.desktopHud.setMode('streetview', nextPano, stage);
        this.vrHud.updateState({ streetQuality: stage });
        if (stage === 'sd') this.fadeTarget = 0;
      });
    } catch {
      this.desktopHud.showToast('No se pudo cargar el siguiente paso');
    } finally {
      this.fadeTarget = 0;
    }
  }

  private stepForwardInStreetView(): void {
    const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    const link = this.streetView.findForwardLink(dir);
    if (link) {
      this.stepToLink(link);
    } else {
      this.desktopHud.showToast('No hay más pasos conectados en esta calle');
    }
  }

  private async exitStreetView(afterExit?: () => void): Promise<void> {
    if (this.mode !== 'streetview') {
      afterExit?.();
      return;
    }

    this.xrControllers.pulseAllHaptics(0.45, 35);
    this.fadeTarget = 1;
    await this.waitMs(180);

    const pano = this.activePanorama;
    this.mode = 'globe';
    this.autoEnterCooldown = 2.8;
    this.streetView.root.visible = false;
    this.globe.root.visible = true;

    if (!this.renderer.xr.isPresenting) {
      this.camera.rotation.set(0, 0, 0);
    }

    if (pano && !afterExit) {
      this.globe.flyTo(pano.lat, pano.lon, 1.2, 0.8);
    }

    this.desktopHud.setMode('globe');
    this.vrHud.updateState({
      mode: 'globe',
      currentPano: null,
      statusMessage: 'Pellizca y mueve para girar · 2 manos para zoom',
    });

    this.fadeTarget = 0;
    afterExit?.();
  }

  private handleSelectRay(raycaster: THREE.Raycaster): void {
    if (this.vrHud.triggerClick(raycaster)) return;

    if (this.mode === 'streetview') {
      const link = this.streetView.hitTestArrow(raycaster);
      if (link) this.stepToLink(link);
      return;
    }

    const markerHit = this.markers.hitTest(raycaster);
    if (markerHit) {
      if (markerHit.kind === 'panorama') {
        this.enterStreetView(markerHit.panorama);
      } else {
        const alt = this.globe.getState().altitudeKm;
        if (alt < 12) {
          this.openStreetViewAtCoords(
            markerHit.landmark.lat,
            markerHit.landmark.lon,
            markerHit.landmark.verified360Id
          );
        } else {
          this.visitLandmark(markerHit.landmark);
        }
      }
      return;
    }

    const globeHit = this.globe.raycastGlobe(raycaster);
    if (globeHit) {
      const curAlt = this.globe.getState().altitudeKm;
      if (this.streetPickMode || curAlt <= 3.5) {
        this.globe.flyTo(globeHit.lat, globeHit.lon, Math.min(curAlt, 0.8), 0.7, () => {
          this.openStreetViewAtCoords(globeHit.lat, globeHit.lon);
        });
        return;
      }

      const nextAlt = curAlt > 1500 ? 140 : curAlt > 45 ? 3.5 : Math.max(0.5, curAlt * 0.45);
      this.activeLocationLabel = 'Ubicación seleccionada';
      this.globe.flyTo(globeHit.lat, globeHit.lon, nextAlt, 1.25, () => {
        if (nextAlt <= 20) {
          this.scanStreetViewNear(globeHit.lat, globeHit.lon, true);
        }
      });
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
        // Right-click or Shift+drag: Google Earth 3D tilt & heading orbit!
        this.isOrbitTiltDragging = true;
        this.lastPointerPos = { x: e.clientX, y: e.clientY };
        this.canvas.setPointerCapture(e.pointerId);
        if (this.mode === 'globe') this.globe.stopIdleSpin();
        return;
      }
      if (e.button !== 0) return;
      this.isDragging = true;
      this.dragMoved = false;
      this.pointerDownPos = { x: e.clientX, y: e.clientY };
      this.lastPointerPos = { x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture(e.pointerId);
      if (this.mode === 'globe') this.globe.stopIdleSpin();
    });

    this.canvas.addEventListener('pointermove', (e) => {
      this.updateMouseRay(e);

      if (this.isOrbitTiltDragging) {
        const dx = e.clientX - this.lastPointerPos.x;
        const dy = e.clientY - this.lastPointerPos.y;
        this.lastPointerPos = { x: e.clientX, y: e.clientY };
        if (this.mode === 'globe') {
          this.globe.rotateHeading(-dx * 0.28);
          this.globe.adjustTilt(-dy * 0.22);
          this.desktopHud.setTilt3DActive(true);
        }
        return;
      }

      if (!this.isDragging) {
        if (this.mode === 'streetview') {
          const arrow = this.streetView.hitTestArrow(this.mouseRaycaster);
          this.streetView.setHoveredLink(arrow?.id ?? null);
          this.canvas.style.cursor = arrow ? 'pointer' : 'grab';
        } else if (this.streetPickMode) {
          this.canvas.style.cursor = 'crosshair';
        } else {
          const hit = this.markers.hitTest(this.mouseRaycaster);
          this.markers.setHoveredId(
            hit ? (hit.kind === 'landmark' ? hit.landmark.id : hit.panorama.id) : null
          );
          this.canvas.style.cursor = hit ? 'pointer' : 'grab';
        }
        return;
      }

      const dx = e.clientX - this.lastPointerPos.x;
      const dy = e.clientY - this.lastPointerPos.y;
      this.lastPointerPos = { x: e.clientX, y: e.clientY };

      if (Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y) > 5) {
        this.dragMoved = true;
      }

      if (this.mode === 'globe') {
        const alt = this.globe.getState().altitudeKm;
        const degPerPx = THREE.MathUtils.clamp((alt / 6371) * 0.17, 0.00003, 0.34);
        this.globe.panByDegrees(dy * degPerPx, -dx * degPerPx);
      } else {
        this.svLookYaw += dx * 0.0038;
        this.svLookPitch = THREE.MathUtils.clamp(
          this.svLookPitch + dy * 0.0034,
          -Math.PI * 0.47,
          Math.PI * 0.47
        );
        this.camera.rotation.order = 'YXZ';
        this.camera.rotation.y = this.svLookYaw;
        this.camera.rotation.x = this.svLookPitch;
      }
    });

    const endDrag = (e: PointerEvent) => {
      if (this.isOrbitTiltDragging) {
        this.isOrbitTiltDragging = false;
        try {
          this.canvas.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        return;
      }
      if (!this.isDragging) return;
      this.isDragging = false;
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      if (!this.dragMoved) {
        this.updateMouseRay(e);
        if (this.mode === 'streetview') {
          const arrow = this.streetView.hitTestArrow(this.mouseRaycaster);
          if (arrow) this.stepToLink(arrow);
        } else if (this.streetPickMode) {
          const hit = this.globe.raycastGlobe(this.mouseRaycaster);
          if (hit) this.openStreetViewAtCoords(hit.lat, hit.lon);
        } else {
          const markerHit = this.markers.hitTest(this.mouseRaycaster);
          if (markerHit) {
            if (markerHit.kind === 'panorama') {
              this.enterStreetView(markerHit.panorama);
            } else {
              this.visitLandmark(markerHit.landmark);
            }
          }
        }
      }
    };

    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);

    this.canvas.addEventListener('dblclick', (e) => {
      if (this.mode !== 'globe') return;
      this.updateMouseRay(e);
      const hit = this.globe.raycastGlobe(this.mouseRaycaster);
      if (!hit) return;
      const curAlt = this.globe.getState().altitudeKm;
      if (curAlt <= 2.5) {
        this.openStreetViewAtCoords(hit.lat, hit.lon);
        return;
      }
      const targetAlt = curAlt > 800 ? 45 : curAlt > 8 ? 1.4 : 0.35;
      this.activeLocationLabel = 'Ubicación seleccionada';
      this.globe.flyTo(hit.lat, hit.lon, targetAlt, 1.15, () => {
        if (targetAlt <= 15) this.scanStreetViewNear(hit.lat, hit.lon, true);
      });
    });

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.mode === 'globe') {
          this.updateMouseRay(e);
          const hit = e.deltaY < 0 ? this.globe.raycastGlobe(this.mouseRaycaster) : null;
          this.globe.zoomByFactor(Math.exp(e.deltaY * 0.00145), hit?.lat, hit?.lon);
        } else {
          this.camera.fov = THREE.MathUtils.clamp(this.camera.fov + e.deltaY * 0.03, 35, 82);
          this.camera.updateProjectionMatrix();
        }
      },
      { passive: false }
    );

    window.addEventListener('keydown', (e) => {
      if (document.activeElement?.tagName === 'INPUT') return;
      if (e.key === 'Escape') {
        if (this.mode === 'streetview') this.exitStreetView();
        else if (this.streetPickMode) this.toggleStreetPick();
      } else if ((e.key === 's' || e.key === 'S') && this.mode === 'globe') {
        this.toggleStreetViewFromAction();
      } else if (e.key === 'ArrowUp' && this.mode === 'streetview') {
        this.stepForwardInStreetView();
      }
    });
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
    let hoveredMarkerId: string | null = null;
    let hoveredArrowId: string | null = null;

    for (let i = 0; i < 2; i++) {
      const ray = this.xrControllers.getRaycasterForSlot(i);
      if (!ray) continue;

      const hudHit = this.vrHud.testHover(ray);
      if (hudHit) {
        hudHitAny = true;
        this.xrControllers.setSlotHitFeedback(i, hudHit.point, Boolean(hudHit.regionId));
        continue;
      }

      if (this.mode === 'streetview') {
        const arrow = this.streetView.hitTestArrow(ray);
        if (arrow) {
          hoveredArrowId = arrow.id;
          const bRad = arrow.bearingDeg * DEG2RAD;
          const localPt = new THREE.Vector3(Math.sin(bRad) * 3.2, 0.25, -Math.cos(bRad) * 3.2);
          this.streetView.root.localToWorld(localPt);
          this.xrControllers.setSlotHitFeedback(i, localPt, true);
        } else {
          this.xrControllers.setSlotHitFeedback(i, null, false);
        }
      } else {
        const marker = this.markers.hitTest(ray);
        if (marker) {
          hoveredMarkerId = marker.kind === 'landmark' ? marker.landmark.id : marker.panorama.id;
          const gh = this.globe.raycastGlobe(ray);
          this.xrControllers.setSlotHitFeedback(i, gh?.worldPoint ?? null, true);
        } else {
          const gh = this.globe.raycastGlobe(ray);
          this.xrControllers.setSlotHitFeedback(
            i,
            gh?.worldPoint ?? null,
            this.streetPickMode || this.globe.getState().altitudeKm <= 3.5
          );
        }
      }
    }

    if (!hudHitAny) this.vrHud.clearHover();
    this.markers.setHoveredId(hoveredMarkerId);
    this.streetView.setHoveredLink(hoveredArrowId);
  }

  private tick(): void {
    const nowSec = performance.now() / 1000;
    const dt = Math.min(0.05, Math.max(0.001, nowSec - this.prevTimeSec));
    this.prevTimeSec = nowSec;
    this.autoEnterCooldown = Math.max(0, this.autoEnterCooldown - dt);

    const fadeDelta = this.fadeTarget - this.fadeOpacity;
    if (Math.abs(fadeDelta) > 0.002) {
      this.fadeOpacity += fadeDelta * Math.min(1, dt * 11);
      this.fadeMat.opacity = this.fadeOpacity;
      this.fadeMesh.visible = this.fadeOpacity > 0.01;
    } else {
      this.fadeOpacity = this.fadeTarget;
      this.fadeMat.opacity = this.fadeOpacity;
      this.fadeMesh.visible = this.fadeOpacity > 0.01;
    }

    this.xrControllers.update(dt, this.mode === 'streetview');
    this.updateXRPointerHovers();

    if (this.mode === 'globe') {
      this.globe.update(dt, nowSec);
      this.markers.update(this.globe, nowSec);

      const st = this.globe.getState();
      this.desktopHud.updateTelemetry(st.lat, st.lon, st.altitudeKm, this.activeLocationLabel);
      this.vrHud.updateState({
        lat: st.lat,
        lon: st.lon,
        altitudeKm: st.altitudeKm,
        locationLabel: this.activeLocationLabel,
      });

      if (st.altitudeKm <= 16 && !this.searchingPano) {
        const movedMeters = haversineMeters(st.lat, st.lon, this.lastScanLat, this.lastScanLon);
        const moveThreshold = Math.max(140, st.altitudeKm * 180);
        if (movedMeters > moveThreshold && nowSec - this.lastScanTime > 1.3) {
          this.scanStreetViewNear(st.lat, st.lon, false);
        }
      }

      if (
        st.altitudeKm <= 0.24 &&
        this.autoEnterCooldown <= 0 &&
        this.nearbyPanoramas.length > 0 &&
        this.nearbyPanoramas[0].distanceMeters < 350
      ) {
        this.autoEnterCooldown = 5.0;
        this.enterStreetView(this.nearbyPanoramas[0]);
      }
    } else {
      this.streetView.update(nowSec);
      if (this.activePanorama) {
        this.desktopHud.updateTelemetry(
          this.activePanorama.lat,
          this.activePanorama.lon,
          0.002,
          this.activeLocationLabel
        );
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  private waitMs(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
}

new EarthXRApp();
