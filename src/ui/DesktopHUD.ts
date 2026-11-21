import type {
  AppMode,
  GeocodeResult,
  Landmark,
  MapLayer,
  PanoramaItem,
  PanoramaLink,
  ServerConfig,
} from '../types';
import { formatAltitude, formatCoords, formatDistance } from '../services/geo';
import {
  geocodePlace,
  getGoogleMapsKey,
  getMapillaryToken,
  googleStreetViewThumbUrl,
  proxyImageUrl,
  setGoogleMapsKey,
  setMapillaryToken,
  testGoogleMapsKey,
} from '../services/api';

export interface DesktopHUDCallbacks {
  onSelectLandmark: (landmark: Landmark) => void;
  onFlyToSearch: (result: GeocodeResult) => void;
  onEnterStreetView: (pano?: PanoramaItem) => void;
  onExitStreetView: () => void;
  onStepLink: (link: PanoramaLink) => void;
  onSetLayer: (layer: MapLayer) => void;
  onToggleSvOverlay: () => void;
  onToggleStreetPick: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetGlobe: () => void;
  onRequestXR: () => void;
  onScanHere: () => void;
  onKeysUpdated: () => void;
}

export class DesktopHUD {
  private root: HTMLElement;
  private callbacks: DesktopHUDCallbacks;
  private landmarks: Landmark[];

  private searchInput!: HTMLInputElement;
  private searchResultsEl!: HTMLElement;
  private xrBtn!: HTMLButtonElement;
  private xrBadgeEl!: HTMLElement;
  private modePillEl!: HTMLElement;
  private googleBtn!: HTMLButtonElement;
  private svLinesBtn!: HTMLButtonElement;
  private streetPickBtn!: HTMLButtonElement;
  private coordsEl!: HTMLElement;
  private altEl!: HTMLElement;
  private placeNameEl!: HTMLElement;
  private svCardEl!: HTMLElement;
  private svThumbEl!: HTMLImageElement;
  private svTitleEl!: HTMLElement;
  private svMetaEl!: HTMLElement;
  private svActionBtn!: HTMLButtonElement;
  private svWalkBarEl!: HTMLElement;
  private layerBtns!: NodeListOf<HTMLButtonElement>;
  private drawerEl!: HTMLElement;
  private settingsModalEl!: HTMLElement;
  private googleKeyInput!: HTMLInputElement;
  private googleVerifyMsgEl!: HTMLElement;
  private mapillaryInput!: HTMLInputElement;
  private toastEl!: HTMLElement;
  private setupBannerEl!: HTMLElement;

  private searchAbort: AbortController | null = null;
  private searchTimer: number | null = null;
  private toastTimer: number | null = null;
  private currentNearbyPano: PanoramaItem | null = null;
  private currentMode: AppMode = 'globe';
  private googleConfig: ServerConfig = { googleEnabled: false, source: 'none' };

  constructor(root: HTMLElement, landmarks: Landmark[], callbacks: DesktopHUDCallbacks) {
    this.root = root;
    this.landmarks = landmarks;
    this.callbacks = callbacks;
    this.render();
    this.bindEvents();
  }

  private render(): void {
    const landmarkItemsHtml = this.landmarks
      .map(
        (lm) => `
        <button class="lm-item" data-lm-id="${lm.id}">
          <span class="lm-dot"></span>
          <span class="lm-text">
            <strong>${lm.city}</strong>
            <small>${lm.name} · ${lm.country}</small>
          </span>
          <span class="lm-badge">360°</span>
        </button>`
      )
      .join('');

    this.root.innerHTML = `
      <div class="hud-top">
        <div class="brand-cluster glass">
          <button class="icon-btn" id="btn-toggle-drawer" title="Destinos">☰</button>
          <div class="brand-title">
            <span class="brand-name">EarthXR</span>
            <span class="mode-pill" id="mode-pill">PLANETA 3D</span>
          </div>
          <div class="search-wrap">
            <input id="search-input" type="search" placeholder="Buscar calle, dirección o ciudad..." autocomplete="off" />
            <div class="search-dropdown hidden" id="search-results"></div>
          </div>
        </div>

        <div class="top-actions">
          <div class="layer-group glass">
            <button class="layer-btn active" data-layer="hybrid">Híbrido</button>
            <button class="layer-btn" data-layer="satellite">Satélite</button>
            <button class="layer-btn" data-layer="streets">Calles</button>
          </div>
          <button class="pill-btn glass active" id="btn-sv-lines" title="Mostrar líneas azules de cobertura Google Street View">
            Líneas 360°
          </button>
          <button class="pill-btn glass" id="btn-street-pick" title="Haz clic sobre cualquier calle del globo para abrir Street View 360°">
            📍 Clic Calle → 360°
          </button>
          <button class="pill-btn glass google-pill" id="btn-google-status" title="Configurar Google Maps API Key">
            Google Maps
          </button>
          <button class="icon-btn glass" id="btn-settings" title="Configuración y controles Quest 3">⚙</button>
          <button class="xr-btn" id="btn-enter-xr">
            <span class="xr-dot"></span>
            <span id="xr-btn-label">Entrar en VR · Meta Quest 3</span>
          </button>
        </div>
      </div>

      <div class="setup-banner glass hidden" id="setup-banner">
        <span>🗺️ Conecta tu <b>Google Maps API Key</b> (Map Tiles API) para usar mapas de Google y entrar en Street View en <b>cualquier calle del mundo</b>.</span>
        <button class="sv-btn emerald small-btn" id="btn-banner-setup">Conectar Google Maps</button>
      </div>

      <aside class="landmarks-drawer glass" id="landmarks-drawer">
        <div class="drawer-header">
          <div>
            <h3>Explorar Destinos</h3>
            <p>Vuela a cualquier ciudad o busca una calle exacta arriba</p>
          </div>
          <button class="icon-btn small" id="btn-close-drawer">✕</button>
        </div>
        <div class="lm-list">${landmarkItemsHtml}</div>
      </aside>

      <div class="zoom-stack glass" id="zoom-stack">
        <button id="btn-zoom-in" title="Acercar">+</button>
        <button id="btn-zoom-out" title="Alejar">−</button>
        <button id="btn-reset" title="Vista completa del planeta">🌍</button>
      </div>

      <div class="hud-bottom">
        <div class="telemetry glass">
          <div class="tel-place" id="tel-place">Planeta Tierra</div>
          <div class="tel-row">
            <span id="tel-coords">16.0000° N, 52.0000° O</span>
            <span class="sep">·</span>
            <span id="tel-alt">Altitud: 13.8k km</span>
          </div>
          <div class="xr-hint" id="xr-badge">Verificando soporte WebXR...</div>
        </div>

        <div class="sv-card glass" id="sv-card">
          <img class="sv-thumb hidden" id="sv-thumb" alt="Vista previa Street View 360°" />
          <div class="sv-info">
            <div class="sv-title" id="sv-title">Street View 360°</div>
            <div class="sv-meta" id="sv-meta">Acércate a cualquier calle o activa "Clic Calle → 360°"</div>
            <div class="sv-walk-bar hidden" id="sv-walk-bar"></div>
          </div>
          <div class="sv-actions">
            <button class="sv-btn primary" id="sv-action-btn">Entrar a 360° aquí</button>
          </div>
        </div>
      </div>

      <div class="toast hidden" id="toast"></div>

      <div class="modal-backdrop hidden" id="settings-modal">
        <div class="modal glass">
          <div class="modal-header">
            <h3>Google Maps + Street View 360° & Controles Meta Quest 3</h3>
            <button class="icon-btn small" id="btn-close-settings">✕</button>
          </div>
          <div class="modal-body">
            <div class="settings-section google-box">
              <label for="google-maps-key">Google Maps API Key (Map Tiles API — Satélite, Calles, Líneas Azules y Street View 360° global)</label>
              <p class="settings-help">
                1. Crea o abre un proyecto en <b>Google Cloud Console</b> y habilita la API <b>Map Tiles API</b> (opcional: <b>Geocoding API</b>).<br/>
                2. Pega tu API Key aquí para probar al instante en este navegador, <b>o</b> guárdala como secreto <code>GOOGLE_MAPS_API_KEY</code> en Cloudflare Workers (<code>maps-webxr</code> → Settings → Variables and Secrets) para que funcione automáticamente en tu <b>Meta Quest 3</b> sin escribir nada.
              </p>
              <div class="token-row">
                <input id="google-maps-key" type="password" placeholder="AIzaSy..." value="${getGoogleMapsKey()}" />
                <button class="sv-btn emerald" id="btn-save-google">Validar y Guardar</button>
              </div>
              <div class="verify-msg" id="google-verify-msg"></div>
            </div>

            <div class="guide-grid">
              <div class="guide-box">
                <h4>Meta Quest 3 (WebXR)</h4>
                <ul>
                  <li><b>Stick Izquierdo:</b> Mover planeta · Empujar adelante para caminar en Street View</li>
                  <li><b>Stick Derecho:</b> Zoom continuo · Giro cómodo ±30° en Street View</li>
                  <li><b>Gatillo (Trigger):</b> Apunta a <b>cualquier calle</b> (al acercarte o con "Clic Calle") para entrar en 360°</li>
                  <li><b>Grip (Lateral):</b> Agarrar el planeta (dos manos = zoom pellizco)</li>
                  <li><b>Botón A:</b> Entrar a Street View 360° · <b>B / Y:</b> Volver al planeta · <b>X:</b> Panel VR</li>
                </ul>
              </div>
              <div class="guide-box">
                <h4>Escritorio / Navegador</h4>
                <ul>
                  <li><b>Líneas 360°:</b> Muestra las calles azules oficiales de Google Street View sobre el globo</li>
                  <li><b>📍 Clic Calle → 360°:</b> Haz clic en cualquier calle y entra directamente en Street View 360°</li>
                  <li><b>Doble clic en el mapa:</b> Acercarte y buscar Street View al instante</li>
                  <li><b>Flechas 3D en el suelo:</b> Camina paso a paso por las intersecciones reales</li>
                </ul>
              </div>
            </div>

            <div class="settings-section">
              <label for="mapillary-token">Token opcional de Mapillary (respaldo si no usas Google Maps)</label>
              <div class="token-row">
                <input id="mapillary-token" type="password" placeholder="MLY|..." value="${getMapillaryToken()}" />
                <button class="sv-btn ghost" id="btn-save-mapillary">Guardar</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    this.searchInput = this.root.querySelector('#search-input')!;
    this.searchResultsEl = this.root.querySelector('#search-results')!;
    this.xrBtn = this.root.querySelector('#btn-enter-xr')!;
    this.xrBadgeEl = this.root.querySelector('#xr-badge')!;
    this.modePillEl = this.root.querySelector('#mode-pill')!;
    this.googleBtn = this.root.querySelector('#btn-google-status')!;
    this.svLinesBtn = this.root.querySelector('#btn-sv-lines')!;
    this.streetPickBtn = this.root.querySelector('#btn-street-pick')!;
    this.coordsEl = this.root.querySelector('#tel-coords')!;
    this.altEl = this.root.querySelector('#tel-alt')!;
    this.placeNameEl = this.root.querySelector('#tel-place')!;
    this.svCardEl = this.root.querySelector('#sv-card')!;
    this.svThumbEl = this.root.querySelector('#sv-thumb')!;
    this.svTitleEl = this.root.querySelector('#sv-title')!;
    this.svMetaEl = this.root.querySelector('#sv-meta')!;
    this.svActionBtn = this.root.querySelector('#sv-action-btn')!;
    this.svWalkBarEl = this.root.querySelector('#sv-walk-bar')!;
    this.layerBtns = this.root.querySelectorAll('.layer-btn');
    this.drawerEl = this.root.querySelector('#landmarks-drawer')!;
    this.settingsModalEl = this.root.querySelector('#settings-modal')!;
    this.googleKeyInput = this.root.querySelector('#google-maps-key')!;
    this.googleVerifyMsgEl = this.root.querySelector('#google-verify-msg')!;
    this.mapillaryInput = this.root.querySelector('#mapillary-token')!;
    this.toastEl = this.root.querySelector('#toast')!;
    this.setupBannerEl = this.root.querySelector('#setup-banner')!;
  }

  private bindEvents(): void {
    this.root.querySelector('#btn-toggle-drawer')?.addEventListener('click', () => {
      this.drawerEl.classList.toggle('collapsed');
    });
    this.root.querySelector('#btn-close-drawer')?.addEventListener('click', () => {
      this.drawerEl.classList.add('collapsed');
    });

    this.root.querySelectorAll<HTMLButtonElement>('.lm-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.lmId;
        const lm = this.landmarks.find((l) => l.id === id);
        if (lm) {
          this.callbacks.onSelectLandmark(lm);
          if (window.innerWidth < 900) {
            this.drawerEl.classList.add('collapsed');
          }
        }
      });
    });

    this.layerBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const layer = btn.dataset.layer as MapLayer;
        this.setActiveLayer(layer);
        this.callbacks.onSetLayer(layer);
      });
    });

    this.svLinesBtn.addEventListener('click', () => this.callbacks.onToggleSvOverlay());
    this.streetPickBtn.addEventListener('click', () => this.callbacks.onToggleStreetPick());
    this.googleBtn.addEventListener('click', () => this.openSettings());
    this.root.querySelector('#btn-banner-setup')?.addEventListener('click', () => this.openSettings());

    this.root.querySelector('#btn-zoom-in')?.addEventListener('click', () => this.callbacks.onZoomIn());
    this.root.querySelector('#btn-zoom-out')?.addEventListener('click', () => this.callbacks.onZoomOut());
    this.root.querySelector('#btn-reset')?.addEventListener('click', () => this.callbacks.onResetGlobe());
    this.xrBtn.addEventListener('click', () => this.callbacks.onRequestXR());

    this.svActionBtn.addEventListener('click', () => {
      if (this.currentMode === 'streetview') {
        this.callbacks.onExitStreetView();
      } else if (this.currentNearbyPano) {
        this.callbacks.onEnterStreetView(this.currentNearbyPano);
      } else {
        this.callbacks.onScanHere();
      }
    });

    // Settings modal
    this.root.querySelector('#btn-settings')?.addEventListener('click', () => this.openSettings());
    this.root.querySelector('#btn-close-settings')?.addEventListener('click', () => {
      this.settingsModalEl.classList.add('hidden');
    });
    this.settingsModalEl.addEventListener('click', (e) => {
      if (e.target === this.settingsModalEl) this.settingsModalEl.classList.add('hidden');
    });

    this.root.querySelector('#btn-save-google')?.addEventListener('click', async () => {
      const key = this.googleKeyInput.value.trim();
      if (!key) {
        setGoogleMapsKey('');
        this.googleVerifyMsgEl.textContent = 'Clave local borrada.';
        this.googleVerifyMsgEl.className = 'verify-msg';
        this.callbacks.onKeysUpdated();
        return;
      }
      this.googleVerifyMsgEl.textContent = 'Verificando Map Tiles API y Street View con Google...';
      this.googleVerifyMsgEl.className = 'verify-msg';
      try {
        const res = await testGoogleMapsKey(key);
        if (res.ok) {
          setGoogleMapsKey(key);
          this.googleVerifyMsgEl.textContent = '✓ ¡Google Maps y Street View 360° verificados y activados!';
          this.googleVerifyMsgEl.className = 'verify-msg ok';
          this.callbacks.onKeysUpdated();
          window.setTimeout(() => this.settingsModalEl.classList.add('hidden'), 900);
        } else {
          this.googleVerifyMsgEl.textContent = `✕ Error de Google: ${res.error ?? 'Revisa que Map Tiles API y facturación estén activas.'}`;
          this.googleVerifyMsgEl.className = 'verify-msg err';
        }
      } catch {
        this.googleVerifyMsgEl.textContent = '✕ No se pudo contactar el servidor para validar la clave.';
        this.googleVerifyMsgEl.className = 'verify-msg err';
      }
    });

    this.root.querySelector('#btn-save-mapillary')?.addEventListener('click', () => {
      setMapillaryToken(this.mapillaryInput.value);
      this.showToast('Token de Mapillary guardado');
      this.callbacks.onKeysUpdated();
    });

    // Place search
    this.searchInput.addEventListener('input', () => {
      const q = this.searchInput.value.trim();
      if (this.searchTimer) window.clearTimeout(this.searchTimer);
      if (q.length < 2) {
        this.searchResultsEl.classList.add('hidden');
        return;
      }
      this.searchTimer = window.setTimeout(() => this.runSearch(q), 340);
    });

    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = this.searchInput.value.trim();
        if (q.length >= 2) this.runSearch(q, true);
      } else if (e.key === 'Escape') {
        this.searchResultsEl.classList.add('hidden');
      }
    });

    document.addEventListener('click', (e) => {
      if (!this.searchResultsEl.contains(e.target as Node) && e.target !== this.searchInput) {
        this.searchResultsEl.classList.add('hidden');
      }
    });

    if (window.innerWidth < 1024) {
      this.drawerEl.classList.add('collapsed');
    }
  }

  public openSettings(): void {
    this.googleKeyInput.value = getGoogleMapsKey();
    this.googleVerifyMsgEl.textContent =
      this.googleConfig.source === 'server'
        ? '✓ Google Maps ya está activo desde el servidor (Cloudflare Worker Secret).'
        : '';
    this.googleVerifyMsgEl.className =
      this.googleConfig.source === 'server' ? 'verify-msg ok' : 'verify-msg';
    this.settingsModalEl.classList.remove('hidden');
  }

  private async runSearch(query: string, autoSelectFirst = false): Promise<void> {
    this.searchAbort?.abort();
    this.searchAbort = new AbortController();

    try {
      const results = await geocodePlace(query, this.searchAbort.signal);
      if (autoSelectFirst && results.length > 0) {
        this.searchResultsEl.classList.add('hidden');
        this.searchInput.blur();
        this.callbacks.onFlyToSearch(results[0]);
        return;
      }

      if (results.length === 0) {
        this.searchResultsEl.innerHTML = `<div class="search-empty">Sin resultados para "${query}"</div>`;
        this.searchResultsEl.classList.remove('hidden');
        return;
      }

      this.searchResultsEl.innerHTML = results
        .map(
          (r, i) => `
          <button class="search-row" data-idx="${i}">
            <strong>${r.name}</strong>
            <small>${r.displayName}</small>
          </button>`
        )
        .join('');
      this.searchResultsEl.classList.remove('hidden');

      this.searchResultsEl.querySelectorAll<HTMLButtonElement>('.search-row').forEach((btn) => {
        btn.addEventListener('click', () => {
          const item = results[Number(btn.dataset.idx)];
          if (item) {
            this.searchInput.value = item.name;
            this.searchResultsEl.classList.add('hidden');
            this.callbacks.onFlyToSearch(item);
          }
        });
      });
    } catch {
      // ignore aborted searches
    }
  }

  public setGoogleConfig(cfg: ServerConfig): void {
    this.googleConfig = cfg;
    if (cfg.googleEnabled) {
      this.googleBtn.textContent = 'Google Maps ✓';
      this.googleBtn.classList.add('connected');
      this.googleBtn.classList.remove('needs-key');
      this.setupBannerEl.classList.add('hidden');
      this.svLinesBtn.classList.remove('hidden');
    } else {
      this.googleBtn.textContent = 'Conectar Google Maps';
      this.googleBtn.classList.remove('connected');
      this.googleBtn.classList.add('needs-key');
      this.setupBannerEl.classList.remove('hidden');
      this.svLinesBtn.classList.add('hidden');
    }
  }

  public setSvOverlayActive(active: boolean): void {
    this.svLinesBtn.classList.toggle('active', active);
  }

  public setStreetPickActive(active: boolean): void {
    this.streetPickBtn.classList.toggle('picking', active);
    this.streetPickBtn.textContent = active ? '📍 Haz clic en una calle...' : '📍 Clic Calle → 360°';
  }

  public setXRSupport(supported: boolean, active: boolean): void {
    const label = this.root.querySelector('#xr-btn-label')!;
    if (active) {
      this.xrBtn.classList.add('active');
      label.textContent = 'Salir de VR';
      this.xrBadgeEl.textContent = 'Sesión WebXR inmersiva activa';
    } else if (supported) {
      this.xrBtn.classList.remove('active');
      this.xrBtn.classList.add('ready');
      label.textContent = 'Entrar en VR · Meta Quest 3';
      this.xrBadgeEl.textContent = 'WebXR listo · Compatible con Meta Quest 3';
    } else {
      this.xrBtn.classList.remove('active', 'ready');
      label.textContent = 'WebXR VR (Abrir en Quest 3)';
      this.xrBadgeEl.textContent = 'Modo Escritorio · Abre maps.dcedwin.com en Meta Quest 3 para VR';
    }
  }

  public setActiveLayer(layer: MapLayer): void {
    this.layerBtns.forEach((b) => {
      b.classList.toggle('active', b.dataset.layer === layer);
    });
  }

  public updateTelemetry(lat: number, lon: number, altitudeKm: number, locationLabel: string): void {
    this.coordsEl.textContent = formatCoords(lat, lon);
    this.altEl.textContent =
      this.currentMode === 'streetview' ? 'Nivel calle 360°' : `Altitud: ${formatAltitude(altitudeKm)}`;
    this.placeNameEl.textContent = locationLabel;
  }

  public setMode(mode: AppMode, activePano?: PanoramaItem | null, quality?: 'loading' | 'sd' | 'hd' | 'error'): void {
    this.currentMode = mode;
    const isSV = mode === 'streetview';
    this.modePillEl.textContent = isSV ? 'STREET VIEW 360°' : 'PLANETA 3D';
    this.modePillEl.classList.toggle('sv', isSV);
    this.root.querySelector('#zoom-stack')?.classList.toggle('hidden', isSV);
    this.streetPickBtn.classList.toggle('hidden', isSV);

    if (isSV && activePano) {
      this.svCardEl.classList.add('ready');
      this.svThumbEl.classList.add('hidden');
      this.svTitleEl.textContent = activePano.address || 'Street View 360° activo';
      const qLabel =
        quality === 'hd'
          ? 'HD 4K'
          : quality === 'sd'
            ? 'Mejorando a HD...'
            : quality === 'error'
              ? 'Error de carga'
              : 'Cargando 360°...';
      const prov =
        activePano.provider === 'google'
          ? activePano.copyright || '© Google'
          : activePano.provider === 'mapillary'
            ? 'Mapillary'
            : 'Panoramax';
      const datePart = activePano.capturedAt ? ` · ${activePano.capturedAt.slice(0, 10)}` : '';
      this.svMetaEl.textContent = `${prov}${datePart} · ${qLabel}`;
      this.svActionBtn.textContent = 'Volver al Planeta 3D';
      this.svActionBtn.classList.add('amber');
      this.svActionBtn.classList.remove('emerald');
      this.renderWalkLinks(activePano.links);
    } else {
      this.svWalkBarEl.classList.add('hidden');
      this.svActionBtn.classList.remove('amber');
      this.updateStreetViewAvailability(this.currentNearbyPano, false);
    }
  }

  private renderWalkLinks(links: PanoramaLink[]): void {
    if (!links || links.length === 0) {
      this.svWalkBarEl.classList.add('hidden');
      return;
    }
    this.svWalkBarEl.classList.remove('hidden');
    this.svWalkBarEl.innerHTML = links
      .slice(0, 4)
      .map((lk, idx) => {
        const label =
          lk.text ||
          (lk.rel === 'next' ? 'Avanzar' : lk.rel === 'prev' ? 'Retroceder' : `Dirección ${Math.round(lk.bearingDeg)}°`);
        const suffix = typeof lk.distanceMeters === 'number' ? ` (${formatDistance(lk.distanceMeters)})` : '';
        return `<button class="walk-pill" data-idx="${idx}">↗ ${label}${suffix}</button>`;
      })
      .join('');

    this.svWalkBarEl.querySelectorAll<HTMLButtonElement>('.walk-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        const link = links[Number(btn.dataset.idx)];
        if (link) this.callbacks.onStepLink(link);
      });
    });
  }

  public updateStreetViewAvailability(
    pano: PanoramaItem | null,
    searching: boolean,
    hintText?: string
  ): void {
    this.currentNearbyPano = pano;
    if (this.currentMode === 'streetview') return;

    if (searching) {
      this.svCardEl.classList.remove('ready');
      this.svTitleEl.textContent = 'Buscando Street View 360°...';
      this.svMetaEl.textContent = 'Consultando panoramas en esta calle';
      this.svActionBtn.textContent = 'Buscando...';
      this.svActionBtn.classList.remove('emerald');
      return;
    }

    if (pano) {
      this.svCardEl.classList.add('ready');
      const thumb =
        pano.provider === 'google'
          ? googleStreetViewThumbUrl(pano.id)
          : pano.thumbUrl || pano.sdUrl
            ? proxyImageUrl(pano.thumbUrl || pano.sdUrl!)
            : '';
      if (thumb) {
        this.svThumbEl.src = thumb;
        this.svThumbEl.classList.remove('hidden');
      }
      this.svTitleEl.textContent = pano.address
        ? `Street View 360° · ${pano.address}`
        : '¡Street View 360° disponible!';
      const provTag = pano.provider === 'google' ? 'Google Street View' : pano.provider === 'mapillary' ? 'Mapillary' : 'Panoramax';
      this.svMetaEl.textContent = `${provTag} · A ${formatDistance(pano.distanceMeters)} · ${
        pano.links.length > 0 ? `${pano.links.length} direcciones` : 'Vista 360°'
      }`;
      this.svActionBtn.textContent = 'Entrar a Street View 360°';
      this.svActionBtn.classList.add('emerald');
    } else {
      this.svCardEl.classList.remove('ready');
      this.svThumbEl.classList.add('hidden');
      this.svTitleEl.textContent = 'Street View 360°';
      this.svMetaEl.textContent =
        hintText ?? 'Acércate a cualquier calle o pulsa "📍 Clic Calle → 360°"';
      this.svActionBtn.textContent = 'Entrar a 360° aquí';
      this.svActionBtn.classList.remove('emerald');
    }
  }

  public showToast(msg: string, durationMs = 3000): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.remove('hidden');
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.add('hidden');
    }, durationMs);
  }

  public setInXRSession(inXR: boolean): void {
    this.root.classList.toggle('hidden-xr', inXR);
  }
}
