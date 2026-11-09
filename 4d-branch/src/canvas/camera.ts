// カメラ: 画面 = ワールド × zoom + (x, y)

export const MIN_ZOOM = 0.04;
export const MAX_ZOOM = 2.5;

export class Camera {
  x = 0;
  y = 0;
  zoom = 1;

  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.x) / this.zoom, y: (sy - this.y) / this.zoom };
  }

  toScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: wx * this.zoom + this.x, y: wy * this.zoom + this.y };
  }

  /** 画面の (sx, sy) を中心に拡大縮小 */
  zoomAt(sx: number, sy: number, factor: number): void {
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * factor));
    const k = z / this.zoom;
    this.x = sx - (sx - this.x) * k;
    this.y = sy - (sy - this.y) * k;
    this.zoom = z;
  }

  /** ワールドの範囲が画面に収まる位置と拡大率 */
  fitTarget(b: { minX: number; minY: number; maxX: number; maxY: number }, w: number, h: number, pad: { left: number; right: number; top: number; bottom: number }, maxZoom = 1.1): { x: number; y: number; zoom: number } {
    const bw = Math.max(1, b.maxX - b.minX);
    const bh = Math.max(1, b.maxY - b.minY);
    const aw = Math.max(50, w - pad.left - pad.right);
    const ah = Math.max(50, h - pad.top - pad.bottom);
    const zoom = Math.max(MIN_ZOOM, Math.min(maxZoom, aw / bw, ah / bh));
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    return { zoom, x: pad.left + aw / 2 - cx * zoom, y: pad.top + ah / 2 - cy * zoom };
  }
}
