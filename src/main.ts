import './style.css';
import * as THREE from 'three';
import type { AppMode, GeocodeResult, Landmark, MapLayer, PanoramaItem, PanoramaLink } from './types';
import { LANDMARKS } from './data/landmarks';
import { ANCHOR_Y_M, GlobeEngine } from './globe/GlobeEngine';
import { GlobeMarkers } from './globe/GlobeMarkers';
import { StreetViewEngine } from './streetview/StreetViewEngine';
import { XRControllerManager } from './xr/XRControllerManager';
import { VRSpatialHUD } from './xr/VRSpatialHUD';
import { DesktopHUD } from './ui/DesktopHUD';
import { fetchPanoramaById, searchPanoramasNear } from './services/api';
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

  // Smooth fade curtain mesh attached to camera for comfortable VR transitions
  private fadeMesh: THREE.Mesh;
  private fadeMat: THREE.MeshBasicMaterial;
  private fadeOpacity = 0;
  private fadeTarget = 0;

  private mode: AppMode = 'globe';
  private activeLocationLabel = 'Planeta Tierra';
  private nearbyPanoramas: PanoramaItem[] = [];
  private activePanorama: PanoramaItem | null = null;
  private searchingPano = false;
  private scanAbort: AbortController | null = null;
  private lastScanLat = 999;
  private lastScanLon = 999;
  private lastScanTime = 0;
  private autoEnterCooldown = 0;

  // Desktop pointer state
  private isDragging = false;
  private pointerDownPos = { x: 0, y: 0 };
  private lastPointerPos = { x: 0, y: 0 };
  private dragMoved = false;
  private svLookYaw = 0;
  private svLookPitch = 0;
  private mouseRaycaster = new THREE.Raycaster();
  private mouseNdc = new THREE.Vector2();

  private xrSupported = false;
  private prevTimeSec = performance.now() / 1000;

  constructor() {
    this.canvas = document.getElementById('xr-canvas') as HTMLCanvasElement;
    const hudRoot = document.getElementById('hud-root') as HTMLElement;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x030712);

    this.camera = new THREE.PerspectiveCamera(
      56,
      window.innerWidth / window.innerHeight,
      0.04,
      600
    );

    // Desktop camera sits at standing human VR height so Globe & Street View match Quest 3 1:1
    this.desktopRig = new THREE.Group();
    this.desktopRig.position.set(0, ANCHOR_Y_M, 0);
    this.desktopRig.add(this.camera);
    this.scene.add(this.desktopRig);

    // Soft ambient + key light for 3D controller models
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const dirLight = new THREE.DirectionalLight(0xbae6fd, 0.9);
    dirLight.position.set(2, 4, 3);
    this.scene.add(dirLight);

    // Subtle transition curtain around the camera (works cleanly in both stereoscopic VR & Desktop!)
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

    // 1) Globe Engine + 3D Markers
    this.globe = new GlobeEngine(this.renderer.capabilities.getMaxAnisotropy());
    this.scene.add(this.globe.root);

    this.markers = new GlobeMarkers(LANDMARKS);
    this.globe.globeGroup.add(this.markers.group);

    // 2) Street View 360° Engine
    this.streetView = new StreetViewEngine(this.renderer.capabilities.maxTextureSize);
    this.scene.add(this.streetView.root);

    // 3) Floating 3D VR Spatial Dashboard (for Meta Quest 3)
    this.vrHud = new VRSpatialHUD(LANDMARKS, {
      onToggleStreetView: () => this.toggleStreetViewFromAction(),
      onSelectLandmark: (lm) => this.visitLandmark(lm),
      onSetLayer: (layer) => this.setLayer(layer),
      onZoomIn: () => this.globe.zoomByFactor(0.55),
      onZoomOut: () => this.globe.zoomByFactor(1.8),
      onResetGlobe: () => {
        this.activeLocationLabel = 'Planeta Tierra';
        this.globe.resetView();
      },
      onStepForward: () => this.stepForwardInStreetView(),
      onTurnLeft: () => this.streetView.snapTurn(-30),
      onTurnRight: () => this.streetView.snapTurn(30),
    });
    this.scene.add(this.vrHud.group);

    // 4) Meta Quest 3 XR Controllers & Gestures
    this.xrControllers = new XRControllerManager(this.renderer, this.scene, {
      onSelectRay: (ray) => this.handleSelectRay(ray),
      onLeftStick: (x, y, dt) => {
        if (this.mode !== 'globe') return;
        const alt = this.globe.getState().altitudeKm;
        const degPerSec = THREE.MathUtils.clamp((alt / 6371) * 58, 0.008, 72);
        this.globe.panByDegrees(-y * degPerSec * dt, x * degPerSec * dt);
      },
      onRightStick: (x, y, dt) => {
        if (this.mode !== 'globe') return;
        if (Math.abs(y) > 0.16) {
          this.globe.zoomByFactor(Math.exp(y * dt * 1.9));
        }
        if (Math.abs(x) > 0.25) {
          this.globe.rotateHeading(x * dt * 68);
        }
      },
      onSnapTurn: (dir) => {
        if (this.mode === 'streetview') {
          this.streetView.snapTurn(dir * 30);
        }
      },
      onWalkForward: () => {
        if (this.mode === 'streetview') {
          this.stepForwardInStreetView();
        }
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
      onSingleGripDrag: (deltaWorld) => {
        const alt = this.globe.getState().altitudeKm;
        const scale = THREE.MathUtils.clamp((alt / 6371) * 85, 0.015, 95);
        this.globe.panByDegrees(-deltaWorld.y * scale, -deltaWorld.x * scale);
      },
      onTwoHandZoom: (ratio) => {
        this.globe.zoomByFactor(ratio);
      },
    });

    // 5) Desktop / 2D HUD
    this.desktopHud = new DesktopHUD(hudRoot, LANDMARKS, {
      onSelectLandmark: (lm) => this.visitLandmark(lm),
      onFlyToSearch: (res) => this.visitSearchResult(res),
      onEnterStreetView: (pano) => this.enterStreetView(pano ?? this.nearbyPanoramas[0]),
      onExitStreetView: () => this.exitStreetView(),
      onStepLink: (link) => this.stepToLink(link),
      onSetLayer: (layer) => this.setLayer(layer),
      onZoomIn: () => this.globe.zoomByFactor(0.58),
      onZoomOut: () => this.globe.zoomByFactor(1.72),
      onResetGlobe: () => {
        this.activeLocationLabel = 'Planeta Tierra';
        this.globe.resetView();
      },
      onRequestXR: () => this.toggleXRSession(),
      onScanHere: () => {
        const st = this.globe.getState();
        this.scanStreetViewNear(st.lat, st.lon, true);
      },
      onTokenUpdated: () => {
        const st = this.globe.getState();
        this.scanStreetViewNear(st.lat, st.lon, true);
      },
    });

    this.bindDesktopEvents();
    this.setupWebXR();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  private async setupWebXR(): Promise<void> {
    if ('xr' in navigator && navigator.xr) {
      try {
        this.xrSupported = await navigator.xr.isSessionSupported('immersive-vr');
      } catch {
        this.xrSupported = false;
      }
    }
    this.desktopHud.setXRSupport(this.xrSupported, false);

    this.renderer.xr.addEventListener('sessionstart', () => {
      // In WebXR local-floor, XR headset provides real head height from y=0, so rig moves to 0
      this.desktopRig.position.set(0, 0, 0);
      this.camera.rotation.set(0, 0, 0);
      this.desktopHud.setXRSupport(true, true);
      this.desktopHud.setInXRSession(true);
      this.vrHud.setVisible(true);
    });

    this.renderer.xr.addEventListener('sessionend', () => {
      this.desktopRig.position.set(0, ANCHOR_Y_M, 0);
      this.desktopHud.setXRSupport(this.xrSupported, false);
      this.desktopHud.setInXRSession(false);
      this.vrHud.setVisible(false);
    });
  }

  private async toggleXRSession(): Promise<void> {
    const active = this.renderer.xr.getSession();
    if (active) {
      await active.end();
      return;
    }
    if (!navigator.xr) {
      this.desktopHud.showToast('Abre https://maps.dcedwin.com en el navegador de tu Meta Quest 3 para modo VR');
      return;
    }
    try {
      const session = await navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
      });
      await this.renderer.xr.setSession(session);
    } catch (err) {
      console.warn('WebXR session request failed:', err);
      this.desktopHud.showToast('No se detectó un visor WebXR activo en este dispositivo');
    }
  }

  private setLayer(layer: MapLayer): void {
    this.globe.setLayer(layer);
    this.desktopHud.setActiveLayer(layer);
    this.vrHud.updateState({ layer });
  }

  private visitLandmark(lm: Landmark): void {
    this.activeLocationLabel = `${lm.name} · ${lm.city}`;
    if (this.mode === 'streetview') {
      // Directly jump to this landmark's 360° street view!
      this.openLandmarkStreetView(lm);
      return;
    }

    this.desktopHud.showToast(`Volando hacia ${lm.city}...`);
    this.globe.flyTo(lm.lat, lm.lon, lm.defaultAltitudeKm, 1.9, () => {
      this.scanStreetViewNear(lm.lat, lm.lon, true, lm.verified360Id);
    });
  }

  private async openLandmarkStreetView(lm: Landmark): Promise<void> {
    if (lm.verified360Id) {
      try {
        const pano = await fetchPanoramaById(lm.verified360Id);
        this.globe.flyTo(pano.lat, pano.lon, 0.85, 0.5);
        await this.enterStreetView(pano);
        return;
      } catch {
        // Fallback to coordinate scan
      }
    }
    await this.scanStreetViewNear(lm.lat, lm.lon, true);
    if (this.nearbyPanoramas[0]) {
      await this.enterStreetView(this.nearbyPanoramas[0]);
    }
  }

  private visitSearchResult(res: GeocodeResult): void {
    this.activeLocationLabel = res.name;
    const goToGlobe = () => {
      this.desktopHud.showToast(`Volando hacia ${res.name}...`);
      this.globe.flyTo(res.lat, res.lon, 3.2, 1.9, () => {
        this.scanStreetViewNear(res.lat, res.lon, true);
      });
    };
    if (this.mode === 'streetview') {
      this.exitStreetView(goToGlobe);
    } else {
      goToGlobe();
    }
  }

  private async scanStreetViewNear(
    lat: number,
    lon: number,
    explicit = false,
    preferredId?: string
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
      statusMessage: 'Escaneando capturas 360° cercanas...',
    });

    try {
      const alt = this.globe.getState().altitudeKm;
      const radius = alt > 20 ? 2500 : alt > 5 ? 1000 : 450;
      const res = await searchPanoramasNear(lat, lon, radius, this.scanAbort.signal);

      let items = res.items;
      // If landmark has a verified 360 ID and wasn't #1, ensure it's available
      if (preferredId && !items.some((i) => i.id === preferredId)) {
        try {
          const verified = await fetchPanoramaById(preferredId, undefined, 'panoramax', this.scanAbort.signal);
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
        this.desktopHud.updateStreetViewAvailability(closest, false);
        this.vrHud.updateState({
          searchingPano: false,
          nearbyPano: closest,
          statusMessage: `360° listo a ${formatDistance(closest.distanceMeters)}`,
        });
      } else {
        const msg = 'No hay 360° abierta en un radio de 25 km. Prueba un destino del panel.';
        this.desktopHud.updateStreetViewAvailability(null, false, msg);
        this.vrHud.updateState({
          searchingPano: false,
          nearbyPano: null,
          statusMessage: 'Sin 360° en esta zona · Elige un destino',
        });
        if (explicit) {
          this.desktopHud.showToast('Sin capturas 360° cercanas aquí · Elige un destino verificado');
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      this.searchingPano = false;
      this.desktopHud.updateStreetViewAvailability(null, false, 'Error al consultar Street View 360°');
      this.vrHud.updateState({
        searchingPano: false,
        statusMessage: 'Error de red consultando 360°',
      });
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
    await this.scanStreetViewNear(st.lat, st.lon, true);
    if (this.nearbyPanoramas.length > 0) {
      await this.enterStreetView(this.nearbyPanoramas[0]);
    }
  }

  private async enterStreetView(pano?: PanoramaItem): Promise<void> {
    if (!pano) {
      this.desktopHud.showToast('No hay vista 360° seleccionada aún');
      return;
    }

    this.xrControllers.pulseAllHaptics(0.6, 55);
    this.fadeTarget = 1;
    await this.waitMs(210);

    // Fetch full item details (including prev/next street links) if needed
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
      currentPano: fullPano,
      lat: fullPano.lat,
      lon: fullPano.lon,
      streetQuality: 'loading',
      statusMessage: 'Cargando Street View 360°...',
    });

    await this.streetView.loadPanorama(fullPano, (stage) => {
      if (this.mode !== 'streetview') return;
      this.desktopHud.setMode('streetview', fullPano, stage);
      this.vrHud.updateState({
        streetQuality: stage,
        statusMessage:
          stage === 'hd'
            ? 'Street View 360° HD cargado'
            : stage === 'sd'
              ? 'Vista 360° activa (mejorando a HD...)'
              : 'No se pudo cargar esta imagen 360°',
      });
      if (stage === 'sd') {
        this.fadeTarget = 0;
      }
    });
    this.fadeTarget = 0;
  }

  private async stepToLink(link: PanoramaLink): Promise<void> {
    if (this.mode !== 'streetview') return;
    this.xrControllers.pulseAllHaptics(0.4, 30);
    this.fadeTarget = 0.88;
    await this.waitMs(140);

    try {
      const provider = this.activePanorama?.provider ?? 'panoramax';
      const nextPano = await fetchPanoramaById(link.id, link.collection, provider);
      this.activePanorama = nextPano;
      this.globe.flyTo(nextPano.lat, nextPano.lon, 0.65, 0.1);

      this.desktopHud.setMode('streetview', nextPano, 'loading');
      this.vrHud.updateState({
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
    await this.waitMs(200);

    const pano = this.activePanorama;
    this.mode = 'globe';
    this.autoEnterCooldown = 2.8;
    this.streetView.root.visible = false;
    this.globe.root.visible = true;

    if (!this.renderer.xr.isPresenting) {
      this.camera.rotation.set(0, 0, 0);
    }

    if (pano && !afterExit) {
      this.globe.flyTo(pano.lat, pano.lon, 1.8, 0.9);
    }

    this.desktopHud.setMode('globe');
    this.vrHud.updateState({
      mode: 'globe',
      currentPano: null,
      statusMessage: 'De regreso al planeta 3D',
    });

    this.fadeTarget = 0;
    afterExit?.();
  }

  private handleSelectRay(raycaster: THREE.Raycaster): void {
    // 1) Floating 3D VR Spatial Dashboard always gets first priority!
    if (this.vrHud.triggerClick(raycaster)) {
      return;
    }

    // 2) Street View navigation arrows
    if (this.mode === 'streetview') {
      const link = this.streetView.hitTestArrow(raycaster);
      if (link) {
        this.stepToLink(link);
      }
      return;
    }

    // 3) Globe 3D markers (Landmarks or nearby 360° blue orbs)
    const markerHit = this.markers.hitTest(raycaster);
    if (markerHit) {
      if (markerHit.kind === 'panorama') {
        this.enterStreetView(markerHit.panorama);
      } else {
        const alt = this.globe.getState().altitudeKm;
        if (alt < 12) {
          this.openLandmarkStreetView(markerHit.landmark);
        } else {
          this.visitLandmark(markerHit.landmark);
        }
      }
      return;
    }

    // 4) Clicking ANY point on the 3D planet flies closer & scans for 360° Street View!
    const globeHit = this.globe.raycastGlobe(raycaster);
    if (globeHit) {
      const curAlt = this.globe.getState().altitudeKm;
      const nextAlt = curAlt > 1500 ? 180 : curAlt > 60 ? 6 : Math.max(0.65, curAlt * 0.45);
      this.activeLocationLabel = 'Ubicación seleccionada';
      this.globe.flyTo(globeHit.lat, globeHit.lon, nextAlt, 1.3, () => {
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

    this.canvas.addEventListener('pointerdown', (e) => {
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

      if (!this.isDragging) {
        if (this.mode === 'streetview') {
          const arrow = this.streetView.hitTestArrow(this.mouseRaycaster);
          this.streetView.setHoveredLink(arrow?.id ?? null);
          this.canvas.style.cursor = arrow ? 'pointer' : 'grab';
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

      if (
        Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y) > 5
      ) {
        this.dragMoved = true;
      }

      if (this.mode === 'globe') {
        const alt = this.globe.getState().altitudeKm;
        const degPerPx = THREE.MathUtils.clamp((alt / 6371) * 0.17, 0.00004, 0.34);
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
      const targetAlt = curAlt > 800 ? 60 : curAlt > 12 ? 1.8 : 0.45;
      this.activeLocationLabel = 'Ubicación seleccionada';
      this.globe.flyTo(hit.lat, hit.lon, targetAlt, 1.2, () => {
        if (targetAlt <= 15) {
          this.scanStreetViewNear(hit.lat, hit.lon, true);
        }
      });
    });

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.mode === 'globe') {
          const factor = Math.exp(e.deltaY * 0.00145);
          this.globe.zoomByFactor(factor);
        } else {
          this.camera.fov = THREE.MathUtils.clamp(this.camera.fov + e.deltaY * 0.03, 35, 82);
          this.camera.updateProjectionMatrix();
        }
      },
      { passive: false }
    );

    window.addEventListener('keydown', (e) => {
      if (document.activeElement?.tagName === 'INPUT') return;
      if (e.key === 'Escape' && this.mode === 'streetview') {
        this.exitStreetView();
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
          this.xrControllers.setSlotHitFeedback(i, gh?.worldPoint ?? null, false);
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

    // Smooth transition fade curtain
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

      // Automatic Street View 360° scan whenever user zooms in close to ANY position on Earth!
      if (st.altitudeKm <= 16 && !this.searchingPano) {
        const movedMeters = haversineMeters(st.lat, st.lon, this.lastScanLat, this.lastScanLon);
        const moveThreshold = Math.max(250, st.altitudeKm * 220);
        if (movedMeters > moveThreshold && nowSec - this.lastScanTime > 1.3) {
          this.scanStreetViewNear(st.lat, st.lon, false);
        }
      }

      // Seamless deep-zoom activation: diving below 300 m right over a 360° spot opens Street View automatically!
      if (
        st.altitudeKm <= 0.3 &&
        this.autoEnterCooldown <= 0 &&
        this.nearbyPanoramas.length > 0 &&
        this.nearbyPanoramas[0].distanceMeters < 450
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
