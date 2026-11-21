import type { AppMode, GeocodeResult, Landmark, MapLayer, PanoramaItem, PanoramaLink } from '../types';
import { formatAltitude, formatCoords, formatDistance } from '../services/geo';
import { geocodePlace, getMapillaryToken, proxyImageUrl, setMapillaryToken } from '../services/api';

export interface DesktopHUDCallbacks {
  onSelectLandmark: (landmark: Landmark) => void;
  onFlyToSearch: (result: GeocodeResult) => void;
  onEnterStreetView: (pano?: PanoramaItem) => void;
  onExitStreetView: () => void;
  onStepLink: (link: PanoramaLink) => void;
  onSetLayer: (layer: MapLayer) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetGlobe: () => void;
  onRequestXR: () => void;
  onScanHere: () => void;
  onTokenUpdated: () => void;
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
  private coordsEl!: HTMLElement;
  private altEl!: HTMLElement;
  private placeNameEl!: HTMLElement;
  private svCardEl!: HTMLElement;
  private svThumbEl!: HTMLImageElement;
  private svTitleEl!: HTMLElement;
  private svMetaEl!: HTMLElement;
  private svActionBtn!: HTMLButtonElement;
  private svSecondaryBtn!: HTMLButtonElement;
  private svWalkBarEl!: HTMLElement;
  private layerBtns!: NodeListOf<HTMLButtonElement>;
  private drawerEl!: HTMLElement;
  private settingsModalEl!: HTMLElement;
  private mapillaryInput!: HTMLInputElement;
  private toastEl!: HTMLElement;

  private searchAbort: AbortController | null = null;
  private searchTimer: number | null = null;
  private toastTimer: number | null = null;
  private currentNearbyPano: PanoramaItem | null = null;
  private currentMode: AppMode = 'globe';

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
          <button class="icon-btn" id="btn-toggle-drawer" title="Destinos 360°">☰</button>
          <div class="brand-title">
            <span class="brand-name">EarthXR</span>
            <span class="mode-pill" id="mode-pill">PLANETA 3D</span>
          </div>
          <div class="search-wrap">
            <input id="search-input" type="search" placeholder="Buscar ciudad, lugar o dirección..." autocomplete="off" />
            <div class="search-dropdown hidden" id="search-results"></div>
          </div>
        </div>

        <div class="top-actions">
          <div class="layer-group glass">
            <button class="layer-btn active" data-layer="hybrid">Híbrido</button>
            <button class="layer-btn" data-layer="satellite">Satélite</button>
            <button class="layer-btn" data-layer="streets">Calles</button>
          </div>
          <button class="icon-btn glass" id="btn-settings" title="Configuración y controles Quest 3">⚙</button>
          <button class="xr-btn" id="btn-enter-xr">
            <span class="xr-dot"></span>
            <span id="xr-btn-label">Entrar en VR · Meta Quest 3</span>
          </button>
        </div>
      </div>

      <aside class="landmarks-drawer glass" id="landmarks-drawer">
        <div class="drawer-header">
          <div>
            <h3>Destinos con Street View 360°</h3>
            <p>Acércate a cualquier punto del globo o elige un destino verificado</p>
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
            <span id="tel-coords">26.0000° N, 18.0000° O</span>
            <span class="sep">·</span>
            <span id="tel-alt">Altitud: 13.8k km</span>
          </div>
          <div class="xr-hint" id="xr-badge">Verificando soporte WebXR...</div>
        </div>

        <div class="sv-card glass" id="sv-card">
          <img class="sv-thumb hidden" id="sv-thumb" alt="Vista previa 360°" />
          <div class="sv-info">
            <div class="sv-title" id="sv-title">Street View 360°</div>
            <div class="sv-meta" id="sv-meta">Acércate a una ciudad para detectar capturas 360°</div>
            <div class="sv-walk-bar hidden" id="sv-walk-bar"></div>
          </div>
          <div class="sv-actions">
            <button class="sv-btn primary" id="sv-action-btn">Buscar 360° aquí</button>
            <button class="sv-btn ghost hidden" id="sv-secondary-btn">Escanear</button>
          </div>
        </div>
      </div>

      <div class="toast hidden" id="toast"></div>

      <div class="modal-backdrop hidden" id="settings-modal">
        <div class="modal glass">
          <div class="modal-header">
            <h3>EarthXR · Controles Meta Quest 3 & Fuentes 360°</h3>
            <button class="icon-btn small" id="btn-close-settings">✕</button>
          </div>
          <div class="modal-body">
            <div class="guide-grid">
              <div class="guide-box">
                <h4>Meta Quest 3 (WebXR)</h4>
                <ul>
                  <li><b>Stick Izquierdo:</b> Girar / mover el planeta · Avanzar en Street View</li>
                  <li><b>Stick Derecho:</b> Acercar / alejar · Giro cómodo ±30° en Street View</li>
                  <li><b>Gatillo (Trigger):</b> Seleccionar lugar, pin 360°, flechas o panel VR</li>
                  <li><b>Grip (Lateral):</b> Agarrar el globo (dos manos = zoom pellizco)</li>
                  <li><b>Botón A:</b> Activar Street View 360° · <b>B / Y:</b> Volver al planeta</li>
                  <li><b>Botón X:</b> Mostrar / recentrar el panel VR flotante</li>
                </ul>
              </div>
              <div class="guide-box">
                <h4>Escritorio / Táctil</h4>
                <ul>
                  <li><b>Arrastrar:</b> Rotar el planeta o mirar 360° en Street View</li>
                  <li><b>Rueda / Pellizco:</b> Zoom continuo desde órbita hasta nivel calle</li>
                  <li><b>Doble clic en el globo:</b> Volar y escanear Street View 360°</li>
                  <li><b>Flechas en el suelo 360°:</b> Caminar por la calle panorámica</li>
                </ul>
              </div>
            </div>
            <div class="settings-section">
              <label for="mapillary-token">Token opcional de Mapillary (cobertura 360° adicional)</label>
              <p class="settings-help">
                Por defecto EarthXR usa <b>Panoramax</b> (100% libre y sin clave). Si deseas añadir cobertura global de Mapillary para ciudades sin capturas en Panoramax, pega tu Client Token gratuito aquí (se guarda solo en tu navegador):
              </p>
              <div class="token-row">
                <input id="mapillary-token" type="password" placeholder="MLY|..." value="${getMapillaryToken()}" />
                <button class="sv-btn primary" id="btn-save-token">Guardar</button>
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
    this.coordsEl = this.root.querySelector('#tel-coords')!;
    this.altEl = this.root.querySelector('#tel-alt')!;
    this.placeNameEl = this.root.querySelector('#tel-place')!;
    this.svCardEl = this.root.querySelector('#sv-card')!;
    this.svThumbEl = this.root.querySelector('#sv-thumb')!;
    this.svTitleEl = this.root.querySelector('#sv-title')!;
    this.svMetaEl = this.root.querySelector('#sv-meta')!;
    this.svActionBtn = this.root.querySelector('#sv-action-btn')!;
    this.svSecondaryBtn = this.root.querySelector('#sv-secondary-btn')!;
    this.svWalkBarEl = this.root.querySelector('#sv-walk-bar')!;
    this.layerBtns = this.root.querySelectorAll('.layer-btn');
    this.drawerEl = this.root.querySelector('#landmarks-drawer')!;
    this.settingsModalEl = this.root.querySelector('#settings-modal')!;
    this.mapillaryInput = this.root.querySelector('#mapillary-token')!;
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

    this.svSecondaryBtn.addEventListener('click', () => {
      this.callbacks.onScanHere();
    });

    // Settings modal
    this.root.querySelector('#btn-settings')?.addEventListener('click', () => {
      this.settingsModalEl.classList.remove('hidden');
    });
    this.root.querySelector('#btn-close-settings')?.addEventListener('click', () => {
      this.settingsModalEl.classList.add('hidden');
    });
    this.settingsModalEl.addEventListener('click', (e) => {
      if (e.target === this.settingsModalEl) this.settingsModalEl.classList.add('hidden');
    });
    this.root.querySelector('#btn-save-token')?.addEventListener('click', () => {
      setMapillaryToken(this.mapillaryInput.value);
      this.settingsModalEl.classList.add('hidden');
      this.showToast('Token guardado localmente');
      this.callbacks.onTokenUpdated();
    });

    // Place search (Nominatim)
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
      this.xrBadgeEl.textContent = 'Modo Escritorio · Abre maps.dcedwin.com en tu Meta Quest 3 para inmersión VR';
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

    if (isSV && activePano) {
      this.svCardEl.classList.add('ready');
      this.svThumbEl.classList.add('hidden');
      this.svTitleEl.textContent = 'Modo Street View 360° activo';
      const qLabel =
        quality === 'hd' ? 'HD 4K' : quality === 'sd' ? 'Cargando HD...' : quality === 'error' ? 'Error de carga' : 'Cargando 360°...';
      const prov = activePano.provider === 'mapillary' ? 'Mapillary' : 'Panoramax';
      this.svMetaEl.textContent = `${prov} · ${qLabel} · Arrastra o gira tu visor para mirar 360°`;
      this.svActionBtn.textContent = 'Volver al Planeta 3D';
      this.svActionBtn.classList.add('amber');
      this.svActionBtn.classList.remove('emerald');
      this.svSecondaryBtn.classList.add('hidden');
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
          lk.rel === 'next' ? 'Avanzar' : lk.rel === 'prev' ? 'Retroceder' : `Paso ${idx + 1}`;
        return `<button class="walk-pill" data-idx="${idx}">↗ ${label} (${formatDistance(lk.distanceMeters)})</button>`;
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
      this.svMetaEl.textContent = 'Consultando capturas panorámicas cercanas a esta posición';
      this.svActionBtn.textContent = 'Buscando...';
      this.svActionBtn.classList.remove('emerald');
      this.svSecondaryBtn.classList.add('hidden');
      return;
    }

    if (pano) {
      this.svCardEl.classList.add('ready');
      const thumb = pano.thumbUrl || pano.sdUrl;
      if (thumb) {
        this.svThumbEl.src = proxyImageUrl(thumb);
        this.svThumbEl.classList.remove('hidden');
      }
      this.svTitleEl.textContent = '¡Street View 360° disponible!';
      this.svMetaEl.textContent = `A ${formatDistance(pano.distanceMeters)} del punto actual · ${
        pano.links.length > 0 ? `${pano.links.length} pasos conectados` : 'Vista panorámica 360°'
      }`;
      this.svActionBtn.textContent = 'Entrar a Street View 360°';
      this.svActionBtn.classList.add('emerald');
      this.svSecondaryBtn.classList.add('hidden');
    } else {
      this.svCardEl.classList.remove('ready');
      this.svThumbEl.classList.add('hidden');
      this.svTitleEl.textContent = 'Street View 360°';
      this.svMetaEl.textContent =
        hintText ?? 'Acércate a una ciudad o haz clic en cualquier marcador azul del planeta';
      this.svActionBtn.textContent = 'Buscar 360° aquí';
      this.svActionBtn.classList.remove('emerald');
      this.svSecondaryBtn.classList.add('hidden');
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
