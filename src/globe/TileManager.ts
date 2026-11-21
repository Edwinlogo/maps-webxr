import * as THREE from 'three';
import type { MapLayer } from '../types';
import { google2DTileUrl } from '../services/api';

interface CacheEntry {
  key: string;
  texture: THREE.Texture;
  lastUsed: number;
}

interface PendingTask {
  key: string;
  z: number;
  x: number;
  y: number;
  layer: MapLayer;
  useGoogle: boolean;
  withSvOverlay: boolean;
  priority: number;
  callbacks: Array<(tex: THREE.Texture | null) => void>;
}

const MAX_CACHE_ENTRIES = 210;
const MAX_CONCURRENT = 6;

function esriSatelliteUrl(z: number, x: number, y: number): string {
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
}

function esriLabelsUrl(z: number, x: number, y: number): string {
  return `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`;
}

function cartoStreetsUrl(z: number, x: number, y: number): string {
  const sub = ['a', 'b', 'c', 'd'][(x + y) & 3];
  return `https://${sub}.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load tile: ${url}`));
    img.src = url;
  });
}

export class TileManager {
  private cache = new Map<string, CacheEntry>();
  private queue = new Map<string, PendingTask>();
  private activeCount = 0;
  private tick = 0;
  private anisotropy: number;

  constructor(maxAnisotropy = 4) {
    this.anisotropy = Math.min(4, Math.max(1, maxAnisotropy));
  }

  public getKey(
    layer: MapLayer,
    z: number,
    x: number,
    y: number,
    useGoogle: boolean,
    withSvOverlay: boolean
  ): string {
    const providerTag = useGoogle ? (withSvOverlay ? 'gsv' : 'g') : 'o';
    return `${providerTag}/${layer}/${z}/${x}/${y}`;
  }

  public getCached(
    layer: MapLayer,
    z: number,
    x: number,
    y: number,
    useGoogle: boolean,
    withSvOverlay: boolean
  ): THREE.Texture | null {
    const key = this.getKey(layer, z, x, y, useGoogle, withSvOverlay);
    const entry = this.cache.get(key);
    if (!entry) return null;
    entry.lastUsed = ++this.tick;
    return entry.texture;
  }

  public requestTile(
    layer: MapLayer,
    z: number,
    x: number,
    y: number,
    useGoogle: boolean,
    withSvOverlay: boolean,
    priority: number,
    onLoaded: (tex: THREE.Texture | null) => void
  ): void {
    const key = this.getKey(layer, z, x, y, useGoogle, withSvOverlay);
    const cached = this.cache.get(key);
    if (cached) {
      cached.lastUsed = ++this.tick;
      onLoaded(cached.texture);
      return;
    }

    const existing = this.queue.get(key);
    if (existing) {
      existing.priority = Math.min(existing.priority, priority);
      existing.callbacks.push(onLoaded);
      return;
    }

    this.queue.set(key, {
      key,
      z,
      x,
      y,
      layer,
      useGoogle,
      withSvOverlay,
      priority,
      callbacks: [onLoaded],
    });
    this.pump();
  }

  public pruneQueue(activeKeys: Set<string>): void {
    for (const [key] of this.queue) {
      if (!activeKeys.has(key)) {
        this.queue.delete(key);
      }
    }
  }

  public clearCache(): void {
    for (const entry of this.cache.values()) {
      entry.texture.dispose();
    }
    this.cache.clear();
    this.queue.clear();
  }

  private pump(): void {
    while (this.activeCount < MAX_CONCURRENT && this.queue.size > 0) {
      let best: PendingTask | null = null;
      for (const task of this.queue.values()) {
        if (!best || task.priority < best.priority) {
          best = task;
        }
      }
      if (!best) break;
      this.queue.delete(best.key);
      this.activeCount++;
      this.executeTask(best);
    }
  }

  private async fetchFallbackTexture(layer: MapLayer, z: number, x: number, y: number): Promise<THREE.Texture> {
    if (layer === 'satellite') {
      const img = await loadImage(esriSatelliteUrl(z, x, y));
      return new THREE.Texture(img);
    }
    if (layer === 'streets') {
      const img = await loadImage(cartoStreetsUrl(z, x, y));
      return new THREE.Texture(img);
    }
    const [satImg, lblImg] = await Promise.all([
      loadImage(esriSatelliteUrl(z, x, y)),
      loadImage(esriLabelsUrl(z, x, y)).catch(() => null),
    ]);
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(satImg, 0, 0, 256, 256);
      if (lblImg) ctx.drawImage(lblImg, 0, 0, 256, 256);
    }
    return new THREE.CanvasTexture(canvas);
  }

  private async executeTask(task: PendingTask): Promise<void> {
    try {
      let texture: THREE.Texture;

      if (task.useGoogle) {
        try {
          if (task.withSvOverlay && task.z >= 7) {
            // Composite Google base tile + official Google Blue Street View coverage lines in 1 texture!
            const [baseImg, svImg] = await Promise.all([
              loadImage(google2DTileUrl(task.layer, task.z, task.x, task.y)),
              loadImage(google2DTileUrl('sv-overlay', task.z, task.x, task.y)).catch(() => null),
            ]);
            const canvas = document.createElement('canvas');
            canvas.width = 256;
            canvas.height = 256;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(baseImg, 0, 0, 256, 256);
              if (svImg && svImg.naturalWidth > 2) {
                ctx.globalAlpha = 0.88;
                ctx.drawImage(svImg, 0, 0, 256, 256);
                ctx.globalAlpha = 1.0;
              }
            }
            texture = new THREE.CanvasTexture(canvas);
          } else {
            const img = await loadImage(google2DTileUrl(task.layer, task.z, task.x, task.y));
            texture = new THREE.Texture(img);
          }
        } catch {
          texture = await this.fetchFallbackTexture(task.layer, task.z, task.x, task.y);
        }
      } else {
        texture = await this.fetchFallbackTexture(task.layer, task.z, task.x, task.y);
      }

      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = this.anisotropy;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;

      this.cache.set(task.key, {
        key: task.key,
        texture,
        lastUsed: ++this.tick,
      });
      this.evictIfNeeded();

      for (const cb of task.callbacks) cb(texture);
    } catch {
      for (const cb of task.callbacks) cb(null);
    } finally {
      this.activeCount--;
      this.pump();
    }
  }

  private evictIfNeeded(): void {
    if (this.cache.size <= MAX_CACHE_ENTRIES) return;
    const entries = Array.from(this.cache.values()).sort((a, b) => a.lastUsed - b.lastUsed);
    const toRemove = this.cache.size - MAX_CACHE_ENTRIES;
    let removed = 0;
    for (const entry of entries) {
      if (entry.key.includes('/2/')) continue;
      this.cache.delete(entry.key);
      entry.texture.dispose();
      removed++;
      if (removed >= toRemove) break;
    }
  }

  public dispose(): void {
    this.clearCache();
  }
}
