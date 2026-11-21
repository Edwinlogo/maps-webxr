import type { GeocodeResult, MapLayer, ServerConfig } from '../types';
import { formatAltitude, formatCoords } from '../services/geo';
import {
  geocodePlace,
  getGoogleMapsKey,
  isGoogleMapsPreferred,
  setGoogleMapsKey,
  setGoogleMapsPreferred,
  testGoogleMapsKey,
} from '../services/api';

export interface DesktopHUDCallbacks {
  onFlyToSearch: (result: GeocodeResult) => void;
  onSetLayer: (layer: MapLayer) => void;
  onTogglePassthrough: () => void;
  onToggleTilt3D: () => void;
  onResetNorth: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetGlobe: () => void;
  onRequestXR: (preferPassthrough: boolean) => void;
  onConfigUpdated: () => void;
}

export class DesktopHUD {
  private root: HTMLElement;
  private callbacks: DesktopHUDCallbacks;

  private searchInput!: HTMLInputElement;
  private searchResultsEl!: HTMLElement;
  private xrBtn!: HTMLButtonElement;
  private passthroughBtn!: HTMLButtonElement;
  private compassNeedleEl!: HTMLElement;
  private coordsEl!: HTMLElement;
  private placeNameEl!: HTMLElement;
  private settingsModalEl!: HTMLElement;
  private layerBtns!: NodeListOf<HTMLButtonElement>;
  private googleToggleInput!: HTMLInputElement;
  private googleKeyInput!: HTMLInputElement;
  private googleVerifyMsgEl!: HTMLElement;
  private tilt3DInput!: HTMLInputElement;
  private passthroughInput!: HTMLInputElement;
  private providerBadgeEl!: HTMLElement;
  private toastEl!: HTMLElement;

  private searchAbort: AbortController | null = null;
  private searchTimer: number | null = null;
  private toastTimer: number | null = null;
  private passthroughMode = false;
  private serverConfig: ServerConfig = {
    googleConfigured: false,
    googleSource: 'none',
    googleActive: false,
  };

  constructor(root: HTMLElement, callbacks: DesktopHUDCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.render();
    this.bindEvents();
  }

  private render(): void {
    this.root.innerHTML = `
      <header class="hud-top">
        <div class="top-pill glass">
          <span class="brand-name">EarthXR</span>
          <div class="search-wrap">
            <input id="search-input" type="search" placeholder="Buscar ciudad, lugar o calle..." autocomplete="off" />
            <div class="search-dropdown hidden" id="search-results"></div>
          </div>
        </div>

        <div class="top-right">
          <button class="icon-pill glass" id="btn-passthrough" title="Cambiar fondo: Estrellas / Realidad (Passthrough)">
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

      <div class="zoom-stack glass" id="zoom-stack">
        <button id="btn-zoom-in" title="Acercar">+</button>
        <button id="btn-zoom-out" title="Alejar">−</button>
        <button id="btn-tilt-3d" class="active-ctrl" title="Alternar vista 3D / 2D (clic derecho para inclinar)">3D</button>
        <button id="btn-north" title="Brújula: orientar al Norte">
          <span class="compass-icon" id="compass-needle">▲</span>
        </button>
        <button id="btn-reset" title="Vista completa del planeta">🌍</button>
      </div>

      <footer class="hud-bottom">
        <div class="telemetry glass">
          <strong id="tel-place">Planeta Tierra</strong>
          <span class="tel-mono" id="tel-coords">16.00° N, 52.00° O · 13.8k km</span>
        </div>
      </footer>

      <div class="toast hidden" id="toast"></div>

      <div class="modal-backdrop hidden" id="settings-modal">
        <div class="modal glass">
          <div class="modal-header">
            <div>
              <h3>Configuración</h3>
              <span class="provider-badge" id="provider-badge">Mapas activos: Satélite HD + Vías</span>
            </div>
            <button class="icon-btn small" id="btn-close-settings">✕</button>
          </div>

          <div class="modal-body">
            <section class="cfg-section">
              <h4>Mapa y Vista</h4>
              <div class="layer-row">
                <button class="layer-btn active" data-layer="hybrid">Híbrido</button>
                <button class="layer-btn" data-layer="satellite">Satélite</button>
                <button class="layer-btn" data-layer="streets">Calles</button>
              </div>
              <label class="switch-row">
                <span>Inclinación 3D automática estilo Google Earth</span>
                <input type="checkbox" id="chk-tilt-3d" checked />
              </label>
              <label class="switch-row">
                <span>Fondo Realidad / Passthrough (en vez de estrellas)</span>
                <input type="checkbox" id="chk-passthrough" />
              </label>
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
                Conecta tu clave solo de <b>Map Tiles API</b> para usar las capas satelitales y de calles de Google Maps. <b>Nunca activa ni llama a Geocoding API</b> (el buscador usa OpenStreetMap gratis).
              </p>
              <div class="token-row">
                <input id="google-maps-key" type="password" placeholder="AIzaSy..." value="${getGoogleMapsKey()}" />
                <button class="sv-btn emerald" id="btn-save-google">Validar</button>
              </div>
              <div class="verify-msg" id="google-verify-msg"></div>
            </section>

            <section class="cfg-section gestures-box">
              <h4>Controles y Gestos (Meta Quest 3 & Escritorio)</h4>
              <ul>
                <li><b>Pellizcar + Mover (1 mano):</b> Rotar el planeta</li>
                <li><b>Spread / Pinch-out (2 manos pellizcando):</b> Separar manos = acercar · Juntar = alejar</li>
                <li><b>Mover tablero 3D:</b> Pellizca la barra superior <code>⠿</code> o inferior y ubícalo donde quieras</li>
                <li><b>Tablero 3D completo:</b> Incluye zoom, 3D/2D, brújula, planeta, cambiar fondo y configuración</li>
                <li><b>Escritorio:</b> Rueda = zoom al cursor · Clic derecho o Shift + arrastrar = inclinar 3D y girar brújula</li>
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
    this.compassNeedleEl = this.root.querySelector('#compass-needle')!;
    this.coordsEl = this.root.querySelector('#tel-coords')!;
    this.placeNameEl = this.root.querySelector('#tel-place')!;
    this.settingsModalEl = this.root.querySelector('#settings-modal')!;
    this.layerBtns = this.root.querySelectorAll('.layer-btn');
    this.googleToggleInput = this.root.querySelector('#chk-google-enable')!;
    this.googleKeyInput = this.root.querySelector('#google-maps-key')!;
    this.googleVerifyMsgEl = this.root.querySelector('#google-verify-msg')!;
    this.tilt3DInput = this.root.querySelector('#chk-tilt-3d')!;
    this.passthroughInput = this.root.querySelector('#chk-passthrough')!;
    this.providerBadgeEl = this.root.querySelector('#provider-badge')!;
    this.toastEl = this.root.querySelector('#toast')!;
  }

  private bindEvents(): void {
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

    this.root.querySelector('#btn-settings')?.addEventListener('click', () => this.openSettings());
    this.root.querySelector('#btn-close-settings')?.addEventListener('click', () => {
      this.settingsModalEl.classList.add('hidden');
    });
    this.settingsModalEl.addEventListener('click', (e) => {
      if (e.target === this.settingsModalEl) this.settingsModalEl.classList.add('hidden');
    });

    this.tilt3DInput.addEventListener('change', () => this.callbacks.onToggleTilt3D());
    this.passthroughInput.addEventListener('change', () => this.callbacks.onTogglePassthrough());

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
        this.googleVerifyMsgEl.textContent = 'Clave borrada · usando satélite HD por defecto.';
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
    this.googleToggleInput.checked = this.serverConfig.googleActive;
    this.passthroughInput.checked = this.passthroughMode;
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
    this.providerBadgeEl.textContent = cfg.googleActive
      ? 'Mapas activos: Google Map Tiles API'
      : 'Mapas activos: Satélite HD + Vías (Esri / Carto)';
  }

  public setPassthroughUI(enabled: boolean): void {
    this.passthroughMode = enabled;
    const icon = this.root.querySelector('#pt-icon')!;
    const label = this.root.querySelector('#pt-label')!;
    icon.textContent = enabled ? '👁' : '✦';
    label.textContent = enabled ? 'Realidad' : 'Estrellas';
    this.passthroughBtn.classList.toggle('active-pt', enabled);
    this.passthroughInput.checked = enabled;
  }

  public setTilt3DActive(active: boolean): void {
    const btn = this.root.querySelector('#btn-tilt-3d');
    if (btn) {
      btn.textContent = active ? '3D' : '2D';
      btn.classList.toggle('active-ctrl', active);
    }
    this.tilt3DInput.checked = active;
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

  public updateTelemetry(
    lat: number,
    lon: number,
    altitudeKm: number,
    headingDeg: number,
    locationLabel: string
  ): void {
    this.placeNameEl.textContent = locationLabel;
    this.coordsEl.textContent = `${formatCoords(lat, lon)} · ${formatAltitude(altitudeKm)}`;
    this.compassNeedleEl.style.transform = `rotate(${headingDeg.toFixed(1)}deg)`;
  }

  public showToast(msg: string, durationMs = 2600): void {
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
