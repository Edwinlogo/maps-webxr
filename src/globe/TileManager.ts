import * as THREE from 'three';
import type { MapLayer } from '../types';

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
  priority: number;
  callbacks: Array<(tex: THREE.Texture | null) => void>;
}

const MAX_CACHE_ENTRIES = 190;
const MAX_CONCURRENT = 6;

function satelliteUrl(z: number, x: number, y: number): string {
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
}

function labelsUrl(z: number, x: number, y: number): string {
  return `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`;
}

function streetsUrl(z: number, x: number, y: number): string {
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

  public getKey(layer: MapLayer, z: number, x: number, y: number): string {
    return `${layer}/${z}/${x}/${y}`;
  }

  public getCached(layer: MapLayer, z: number, x: number, y: number): THREE.Texture | null {
    const key = this.getKey(layer, z, x, y);
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
    priority: number,
    onLoaded: (tex: THREE.Texture | null) => void
  ): void {
    const key = this.getKey(layer, z, x, y);
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

  private async executeTask(task: PendingTask): Promise<void> {
    try {
      let texture: THREE.Texture;

      if (task.layer === 'satellite') {
        const img = await loadImage(satelliteUrl(task.z, task.x, task.y));
        texture = new THREE.Texture(img);
      } else if (task.layer === 'streets') {
        const img = await loadImage(streetsUrl(task.z, task.x, task.y));
        texture = new THREE.Texture(img);
      } else {
        // Hybrid: composite satellite + transparent Esri place/boundary labels in a single texture (1 draw call!)
        const [satImg, lblImg] = await Promise.all([
          loadImage(satelliteUrl(task.z, task.x, task.y)),
          loadImage(labelsUrl(task.z, task.x, task.y)).catch(() => null),
        ]);
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(satImg, 0, 0, 256, 256);
          if (lblImg) {
            ctx.drawImage(lblImg, 0, 0, 256, 256);
          }
        }
        texture = new THREE.CanvasTexture(canvas);
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
      // Never evict zoom level 2 base world shell tiles
      if (entry.key.includes('/2/')) continue;
      this.cache.delete(entry.key);
      entry.texture.dispose();
      removed++;
      if (removed >= toRemove) break;
    }
  }

  public dispose(): void {
    for (const entry of this.cache.values()) {
      entry.texture.dispose();
    }
    this.cache.clear();
    this.queue.clear();
  }
}
