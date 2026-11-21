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
  isGoogleMapsPreferred,
  proxyImageUrl,
  setGoogleMapsKey,
  setGoogleMapsPreferred,
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
  onTogglePassthrough: () => void;
  onToggleSvOverlay: () => void;
  onToggleStreetPick: () => void;
  onToggleTilt3D: () => void;
  onResetNorth: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetGlobe: () => void;
  onRequestXR: (preferPassthrough: boolean) => void;
  onScanHere: () => void;
  onConfigUpdated: () => void;
}

export class DesktopHUD {
  private root: HTMLElement;
  private callbacks: DesktopHUDCallbacks;
  private landmarks: Landmark[];

  private searchInput!: HTMLInputElement;
  private searchResultsEl!: HTMLElement;
  private xrBtn!: HTMLButtonElement;
  private passthroughBtn!: HTMLButtonElement;
  private coordsEl!: HTMLElement;
  private placeNameEl!: HTMLElement;
  private svCardEl!: HTMLElement;
  private svThumbEl!: HTMLImageElement;
  private svTitleEl!: HTMLElement;
  private svMetaEl!: HTMLElement;
  private svActionBtn!: HTMLButtonElement;
  private svWalkBarEl!: HTMLElement;
  private drawerEl!: HTMLElement;
  private settingsModalEl!: HTMLElement;
  private layerBtns!: NodeListOf<HTMLButtonElement>;
  private googleToggleInput!: HTMLInputElement;
  private googleKeyInput!: HTMLInputElement;
  private googleVerifyMsgEl!: HTMLElement;
  private svLinesInput!: HTMLInputElement;
  private streetPickInput!: HTMLInputElement;
  private mapillaryInput!: HTMLInputElement;
  private providerBadgeEl!: HTMLElement;
  private toastEl!: HTMLElement;

  private searchAbort: AbortController | null = null;
  private searchTimer: number | null = null;
  private toastTimer: number | null = null;
  private currentNearbyPano: PanoramaItem | null = null;
  private currentMode: AppMode = 'globe';
  private passthroughMode = false;
  private serverConfig: ServerConfig = {
    googleConfigured: false,
    googleSource: 'none',
    googleActive: false,
    mapillaryConfigured: false,
  };

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
        </button>`
      )
      .join('');

    this.root.innerHTML = `
      <header class="hud-top">
        <div class="top-pill glass">
          <button class="icon-btn" id="btn-toggle-drawer" title="Destinos">☰</button>
          <span class="brand-name">EarthXR</span>
          <div class="search-wrap">
            <input id="search-input" type="search" placeholder="Buscar ciudad o calle..." autocomplete="off" />
            <div class="search-dropdown hidden" id="search-results"></div>
          </div>
        </div>

        <div class="top-right">
          <button class="icon-pill glass" id="btn-passthrough" title="Alternar Realidad (Passthrough) / Estrellas">
            <span id="pt-icon">✦</span>
            <span id="pt-label">Estrellas</span>
          </button>
          <button class="icon-btn glass" id="btn-settings" title="Configuración">⚙</button>
          <button class="xr-btn" id="btn-enter-xr">
            <span class="xr-dot"></span>
            <span id="xr-btn-label">Entrar en XR</span>
          </button>
        </div>
      </header>

      <aside class="landmarks-drawer glass collapsed" id="landmarks-drawer">
        <div class="drawer-header">
          <h3>Destinos</h3>
          <button class="icon-btn small" id="btn-close-drawer">✕</button>
        </div>
        <div class="lm-list">${landmarkItemsHtml}</div>
      </aside>

      <div class="zoom-stack glass" id="zoom-stack">
        <button id="btn-zoom-in" title="Acercar">+</button>
        <button id="btn-zoom-out" title="Alejar">−</button>
        <button id="btn-tilt-3d" class="active-ctrl" title="Alternar inclinación 3D / 2D (clic derecho para inclinar)">3D</button>
        <button id="btn-north" title="Orientar al Norte">N</button>
        <button id="btn-reset" title="Vista completa del planeta">🌍</button>
      </div>

      <footer class="hud-bottom">
        <div class="telemetry glass">
          <strong id="tel-place">Planeta Tierra</strong>
          <span class="tel-mono" id="tel-coords">16.00° N, 52.00° O · 13.8k km</span>
        </div>

        <div class="sv-card glass" id="sv-card">
          <img class="sv-thumb hidden" id="sv-thumb" alt="Vista previa 360°" />
          <div class="sv-info">
            <div class="sv-title" id="sv-title">Vista 360°</div>
            <div class="sv-meta" id="sv-meta">Acércate a una ciudad o pulsa explorar</div>
            <div class="sv-walk-bar hidden" id="sv-walk-bar"></div>
          </div>
          <button class="sv-btn" id="sv-action-btn">Vista 360°</button>
        </div>
      </footer>

      <div class="toast hidden" id="toast"></div>

      <div class="modal-backdrop hidden" id="settings-modal">
        <div class="modal glass">
          <div class="modal-header">
            <div>
              <h3>Configuración</h3>
              <span class="provider-badge" id="provider-badge">Fuente activa: Panoramax + Mapillary</span>
            </div>
            <button class="icon-btn small" id="btn-close-settings">✕</button>
          </div>

          <div class="modal-body">
            <section class="cfg-section">
              <h4>Mapa y Navegación</h4>
              <div class="layer-row">
                <button class="layer-btn active" data-layer="hybrid">Híbrido</button>
                <button class="layer-btn" data-layer="satellite">Satélite</button>
                <button class="layer-btn" data-layer="streets">Calles</button>
              </div>
              <label class="switch-row">
                <span>Modo Clic en Calle → Vista 360°</span>
                <input type="checkbox" id="chk-street-pick" />
              </label>
              <label class="switch-row">
                <span>Mostrar líneas azules de cobertura (cuando Google Map Tiles está activa)</span>
                <input type="checkbox" id="chk-sv-lines" checked />
              </label>
            </section>

            <section class="cfg-section">
              <h4>Vista 360° por defecto: Panoramax + Mapillary (Gratis, sin tarjeta)</h4>
              <p class="cfg-help">
                <b>Panoramax</b> funciona automáticamente sin clave. Agrega tu <b>Client Token gratuito de Mapillary</b> (Meta) para sumar millones de panoramas 360° en Colombia, Latinoamérica y todo el mundo.
              </p>
              <div class="token-row">
                <input id="mapillary-token" type="password" placeholder="MLY|..." value="${getMapillaryToken()}" />
                <button class="sv-btn" id="btn-save-mapillary">Guardar</button>
              </div>
            </section>

            <section class="cfg-section">
              <div class="section-title-row">
                <h4>Google Map Tiles API (Opcional)</h4>
                <label class="inline-toggle">
                  <input type="checkbox" id="chk-google-enable" ${isGoogleMapsPreferred() ? 'checked' : ''} />
                  <span>Usar Google Map Tiles</span>
                </label>
              </div>
              <p class="cfg-help">
                Solo usa <b>Map Tiles API</b> (mapas satelitales de Google + Google Street View oficial). <b>Nunca activa ni llama a Geocoding API</b> (las búsquedas siempre usan OpenStreetMap gratis).
              </p>
              <div class="token-row">
                <input id="google-maps-key" type="password" placeholder="AIzaSy..." value="${getGoogleMapsKey()}" />
                <button class="sv-btn emerald" id="btn-save-google">Validar</button>
              </div>
              <div class="verify-msg" id="google-verify-msg"></div>
            </section>

            <section class="cfg-section gestures-box">
              <h4>Controles y Gestos sin mandos (Meta Quest 3)</h4>
              <ul>
                <li><b>Pellizcar + Mover (1 mano):</b> Rotar el planeta o girar la Vista 360°</li>
                <li><b>Spread / Pinch-out (2 manos pellizcando):</b> Separar manos = acercar · Juntar = alejar</li>
                <li><b>Mover tablero 3D:</b> Pellizca la barra superior <code>⠿</code> del panel y ubícalo donde quieras</li>
                <li><b>Realidad (Passthrough):</b> Toca <code>👁 Realidad</code> en el tablero 3D para ver tu habitación real</li>
                <li><b>Escritorio:</b> Rueda = zoom al cursor · Clic derecho + arrastrar = inclinar 3D y girar brújula</li>
              </ul>
            </section>
          </div>
        </div>
      </div>
    `;

    this.searchInput = this.root.querySelector('#search-input')!;
    this.searchResultsEl = this.root.querySelector('#search-results')!;
    this.xrBtn = this.root.querySelector('#btn-enter-xr')!;
    this.passthroughBtn = this.root.querySelector('#btn-passthrough')!;
    this.coordsEl = this.root.querySelector('#tel-coords')!;
    this.placeNameEl = this.root.querySelector('#tel-place')!;
    this.svCardEl = this.root.querySelector('#sv-card')!;
    this.svThumbEl = this.root.querySelector('#sv-thumb')!;
    this.svTitleEl = this.root.querySelector('#sv-title')!;
    this.svMetaEl = this.root.querySelector('#sv-meta')!;
    this.svActionBtn = this.root.querySelector('#sv-action-btn')!;
    this.svWalkBarEl = this.root.querySelector('#sv-walk-bar')!;
    this.drawerEl = this.root.querySelector('#landmarks-drawer')!;
    this.settingsModalEl = this.root.querySelector('#settings-modal')!;
    this.layerBtns = this.root.querySelectorAll('.layer-btn');
    this.googleToggleInput = this.root.querySelector('#chk-google-enable')!;
    this.googleKeyInput = this.root.querySelector('#google-maps-key')!;
    this.googleVerifyMsgEl = this.root.querySelector('#google-verify-msg')!;
    this.svLinesInput = this.root.querySelector('#chk-sv-lines')!;
    this.streetPickInput = this.root.querySelector('#chk-street-pick')!;
    this.mapillaryInput = this.root.querySelector('#mapillary-token')!;
    this.providerBadgeEl = this.root.querySelector('#provider-badge')!;
    this.toastEl = this.root.querySelector('#toast')!;
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
        const lm = this.landmarks.find((l) => l.id === btn.dataset.lmId);
        if (lm) {
          this.drawerEl.classList.add('collapsed');
          this.callbacks.onSelectLandmark(lm);
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

    this.passthroughBtn.addEventListener('click', () => this.callbacks.onTogglePassthrough());
    this.root.querySelector('#btn-zoom-in')?.addEventListener('click', () => this.callbacks.onZoomIn());
    this.root.querySelector('#btn-zoom-out')?.addEventListener('click', () => this.callbacks.onZoomOut());
    this.root.querySelector('#btn-tilt-3d')?.addEventListener('click', () => this.callbacks.onToggleTilt3D());
    this.root.querySelector('#btn-north')?.addEventListener('click', () => this.callbacks.onResetNorth());
    this.root.querySelector('#btn-reset')?.addEventListener('click', () => this.callbacks.onResetGlobe());
    this.xrBtn.addEventListener('click', () => this.callbacks.onRequestXR(this.passthroughMode));

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

    this.streetPickInput.addEventListener('change', () => this.callbacks.onToggleStreetPick());
    this.svLinesInput.addEventListener('change', () => this.callbacks.onToggleSvOverlay());

    this.googleToggleInput.addEventListener('change', () => {
      setGoogleMapsPreferred(this.googleToggleInput.checked);
      this.callbacks.onConfigUpdated();
    });

    this.root.querySelector('#btn-save-google')?.addEventListener('click', async () => {
      const key = this.googleKeyInput.value.trim();
      if (!key) {
        setGoogleMapsKey('');
        setGoogleMapsPreferred(false);
        this.googleToggleInput.checked = false;
        this.googleVerifyMsgEl.textContent = 'Clave borrada · usando Panoramax + Mapillary.';
        this.googleVerifyMsgEl.className = 'verify-msg';
        this.callbacks.onConfigUpdated();
        return;
      }
      this.googleVerifyMsgEl.textContent = 'Validando Map Tiles API...';
      this.googleVerifyMsgEl.className = 'verify-msg';
      try {
        const res = await testGoogleMapsKey(key);
        if (res.ok) {
          setGoogleMapsKey(key);
          setGoogleMapsPreferred(true);
          this.googleToggleInput.checked = true;
          this.googleVerifyMsgEl.textContent = '✓ Map Tiles API verificada y activada.';
          this.googleVerifyMsgEl.className = 'verify-msg ok';
          this.callbacks.onConfigUpdated();
        } else {
          this.googleVerifyMsgEl.textContent = `✕ ${res.error ?? 'Error validando Map Tiles API.'}`;
          this.googleVerifyMsgEl.className = 'verify-msg err';
        }
      } catch {
        this.googleVerifyMsgEl.textContent = '✕ Error de red al validar la clave.';
        this.googleVerifyMsgEl.className = 'verify-msg err';
      }
    });

    this.root.querySelector('#btn-save-mapillary')?.addEventListener('click', () => {
      setMapillaryToken(this.mapillaryInput.value);
      this.showToast('Token de Mapillary guardado');
      this.callbacks.onConfigUpdated();
    });

    // Search
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
  }

  public openSettings(): void {
    this.googleKeyInput.value = getGoogleMapsKey();
    this.mapillaryInput.value = getMapillaryToken();
    this.googleToggleInput.checked = this.serverConfig.googleActive;
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

  public setServerConfig(cfg: ServerConfig): void {
    this.serverConfig = cfg;
    this.googleToggleInput.checked = cfg.googleActive;
    if (cfg.googleActive) {
      this.providerBadgeEl.textContent = 'Fuente activa: Google Map Tiles API';
    } else if (cfg.mapillaryConfigured) {
      this.providerBadgeEl.textContent = 'Fuente activa: Mapillary + Panoramax';
    } else {
      this.providerBadgeEl.textContent = 'Fuente activa: Panoramax (agrega Mapillary en ⚙)';
    }
  }

  public setPassthroughUI(enabled: boolean): void {
    this.passthroughMode = enabled;
    const icon = this.root.querySelector('#pt-icon')!;
    const label = this.root.querySelector('#pt-label')!;
    icon.textContent = enabled ? '👁' : '✦';
    label.textContent = enabled ? 'Realidad' : 'Estrellas';
    this.passthroughBtn.classList.toggle('active-pt', enabled);
  }

  public setSvOverlayActive(active: boolean): void {
    this.svLinesInput.checked = active;
  }

  public setStreetPickActive(active: boolean): void {
    this.streetPickInput.checked = active;
  }

  public setXRSupport(arSupported: boolean, vrSupported: boolean, active: boolean): void {
    const label = this.root.querySelector('#xr-btn-label')!;
    if (active) {
      this.xrBtn.classList.add('active');
      label.textContent = 'Salir de XR';
    } else if (arSupported) {
      this.xrBtn.classList.remove('active');
      this.xrBtn.classList.add('ready');
      label.textContent = 'Entrar en Quest 3 · XR';
    } else if (vrSupported) {
      this.xrBtn.classList.remove('active');
      this.xrBtn.classList.add('ready');
      label.textContent = 'Entrar en VR';
    } else {
      this.xrBtn.classList.remove('active', 'ready');
      label.textContent = 'Abrir en Quest 3';
    }
  }

  public setActiveLayer(layer: MapLayer): void {
    this.layerBtns.forEach((b) => {
      b.classList.toggle('active', b.dataset.layer === layer);
    });
  }

  public updateTelemetry(lat: number, lon: number, altitudeKm: number, locationLabel: string): void {
    this.placeNameEl.textContent = locationLabel;
    this.coordsEl.textContent = `${formatCoords(lat, lon)} · ${
      this.currentMode === 'streetview' ? '360°' : formatAltitude(altitudeKm)
    }`;
  }

  public setTilt3DActive(active: boolean): void {
    const btn = this.root.querySelector('#btn-tilt-3d');
    if (btn) {
      btn.textContent = active ? '3D' : '2D';
      btn.classList.toggle('active-ctrl', active);
    }
  }

  public setMode(mode: AppMode, activePano?: PanoramaItem | null, quality?: 'loading' | 'sd' | 'hd' | 'error'): void {
    this.currentMode = mode;
    const isSV = mode === 'streetview';
    this.root.querySelector('#zoom-stack')?.classList.toggle('hidden', isSV);

    if (isSV && activePano) {
      this.svCardEl.classList.add('ready');
      this.svThumbEl.classList.add('hidden');
      const modeName = activePano.provider === 'google' ? 'Google Street View' : 'Vista 360°';
      this.svTitleEl.textContent = activePano.address || modeName;
      const qLabel =
        quality === 'hd' ? 'HD' : quality === 'sd' ? 'Cargando HD...' : quality === 'error' ? 'Error' : 'Cargando...';
      const prov =
        activePano.provider === 'google'
          ? activePano.copyright || '© Google'
          : activePano.provider === 'mapillary'
            ? 'Mapillary'
            : 'Panoramax';
      this.svMetaEl.textContent = `${prov} · ${qLabel}`;
      this.svActionBtn.textContent = 'Volver al Planeta';
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
          (lk.rel === 'next' ? 'Avanzar' : lk.rel === 'prev' ? 'Retroceder' : `${Math.round(lk.bearingDeg)}°`);
        return `<button class="walk-pill" data-idx="${idx}">↗ ${label}</button>`;
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
      this.svTitleEl.textContent = 'Buscando 360°...';
      this.svMetaEl.textContent = 'Consultando panoramas cercanos';
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
      this.svTitleEl.textContent =
        pano.address || (pano.provider === 'google' ? 'Google Street View listo' : 'Vista 360° lista');
      const provTag =
        pano.provider === 'google' ? 'Google Street View' : pano.provider === 'mapillary' ? 'Mapillary' : 'Panoramax';
      this.svMetaEl.textContent = `${provTag} · a ${formatDistance(pano.distanceMeters)}`;
      this.svActionBtn.textContent = pano.provider === 'google' ? 'Street View' : 'Vista 360°';
      this.svActionBtn.classList.add('emerald');
    } else {
      this.svCardEl.classList.remove('ready');
      this.svThumbEl.classList.add('hidden');
      this.svTitleEl.textContent = 'Vista 360°';
      this.svMetaEl.textContent = hintText ?? 'Acércate a una calle para explorar en 360°';
      this.svActionBtn.textContent = 'Vista 360°';
      this.svActionBtn.classList.remove('emerald');
    }
  }

  public showToast(msg: string, durationMs = 2800): void {
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
