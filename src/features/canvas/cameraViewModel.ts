import type { WorkspacePlan } from '../../shared/models'

export interface CameraView {
  /** 可视区域左上角在方案（毫米）坐标系中的位置 */
  centerX: number
  centerY: number
  /** 相对「适应窗口」缩放的倍率，1 即整个桌面刚好铺满画布 */
  zoom: number
}

export interface Viewport {
  widthPx: number
  heightPx: number
}

/** 缩放下限：不能缩到设备小得点不中 */
export const MIN_ZOOM = 0.5
/** 缩放上限：放大 4 倍足够看清局部标签 */
export const MAX_ZOOM = 4
/** 平移时至少在画布上保留的可视区域比例（两个方向各自约束） */
const MIN_VISIBLE_RATIO = 0.25

/** 「适应窗口」时每个毫米对应的像素数 */
export function fitScale(plan: Pick<WorkspacePlan, 'deskWidthMm' | 'deskHeightMm'>, viewport: Viewport): number {
  if (viewport.widthPx <= 0 || viewport.heightPx <= 0) return 0
  return Math.min(viewport.widthPx / plan.deskWidthMm, viewport.heightPx / plan.deskHeightMm)
}

/** 「适应窗口」视图：桌面完整居中显示 */
export function createFitView(plan: Pick<WorkspacePlan, 'deskWidthMm' | 'deskHeightMm'>): CameraView {
  return { centerX: plan.deskWidthMm / 2, centerY: plan.deskHeightMm / 2, zoom: 1 }
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/** 当前可视区域（毫米）的宽高，始终与画布保持相同宽高比 */
export function viewSizeMm(view: CameraView, plan: Pick<WorkspacePlan, 'deskWidthMm' | 'deskHeightMm'>, viewport: Viewport) {
  const scale = fitScale(plan, viewport)
  const widthMm = scale > 0 ? viewport.widthPx / (scale * view.zoom) : plan.deskWidthMm
  const heightMm = scale > 0 ? viewport.heightPx / (scale * view.zoom) : plan.deskHeightMm
  return { widthMm, heightMm }
}

/**
 * 约束平移范围：任何时刻画布上都要保留桌面的一部分，
 * 且周围空白不超过上限，画布不会被拖到看不见。
 */
export function clampView(view: CameraView, plan: Pick<WorkspacePlan, 'deskWidthMm' | 'deskHeightMm'>, viewport: Viewport): CameraView {
  const zoom = clampZoom(view.zoom)
  const { widthMm, heightMm } = viewSizeMm({ ...view, zoom }, plan, viewport)
  if (widthMm <= 0 || heightMm <= 0) return createFitView(plan)

  const keepX = Math.min(widthMm * MIN_VISIBLE_RATIO, plan.deskWidthMm)
  const keepY = Math.min(heightMm * MIN_VISIBLE_RATIO, plan.deskHeightMm)
  const minCenterX = keepX - widthMm / 2
  const maxCenterX = plan.deskWidthMm + widthMm / 2 - keepX
  const minCenterY = keepY - heightMm / 2
  const maxCenterY = plan.deskHeightMm + heightMm / 2 - keepY

  const centerX = Number.isFinite(view.centerX)
    ? Math.min(maxCenterX, Math.max(minCenterX, view.centerX))
    : plan.deskWidthMm / 2
  const centerY = Number.isFinite(view.centerY)
    ? Math.min(maxCenterY, Math.max(minCenterY, view.centerY))
    : plan.deskHeightMm / 2
  return { centerX, centerY, zoom }
}

/** 以方案坐标 (focusX, focusY) 为锚点缩放，锚点在屏幕上的位置保持不动 */
export function zoomAt(view: CameraView, nextZoom: number, focusX: number, focusY: number): CameraView {
  const zoom = clampZoom(nextZoom)
  const ratio = zoom / view.zoom
  return {
    centerX: focusX + (view.centerX - focusX) / ratio,
    centerY: focusY + (view.centerY - focusY) / ratio,
    zoom,
  }
}

/** 平移 delta（毫米，方案坐标系） */
export function panView(view: CameraView, deltaXPx: number, deltaYPx: number, plan: Pick<WorkspacePlan, 'deskWidthMm' | 'deskHeightMm'>, viewport: Viewport): CameraView {
  const scale = fitScale(plan, viewport)
  const factor = scale > 0 ? 1 / (scale * view.zoom) : 1
  return clampView({
    ...view,
    centerX: view.centerX - deltaXPx * factor,
    centerY: view.centerY - deltaYPx * factor,
  }, plan, viewport)
}

/**
 * 桌面尺寸变化后保留当前缩放与中心点（中心越界时收回）；
 * 「适应窗口」由组件在切换方案时主动触发。
 */
export function reconcileView(view: CameraView, plan: Pick<WorkspacePlan, 'deskWidthMm' | 'deskHeightMm'>, viewport: Viewport): CameraView {
  return clampView(view, plan, viewport)
}

/** 视图对应的 SVG viewBox（屏幕宽高比，毫米单位） */
export function toViewBox(view: CameraView, plan: Pick<WorkspacePlan, 'deskWidthMm' | 'deskHeightMm'>, viewport: Viewport): { x: number; y: number; width: number; height: number } {
  const clamped = clampView(view, plan, viewport)
  const { widthMm, heightMm } = viewSizeMm(clamped, plan, viewport)
  return { x: clamped.centerX - widthMm / 2, y: clamped.centerY - heightMm / 2, width: widthMm, height: heightMm }
}

/** 屏幕像素 → 方案毫米坐标 */
export function screenToPlan(
  view: CameraView,
  clientX: number,
  clientY: number,
  bounds: { left: number; top: number; width: number; height: number },
  plan: Pick<WorkspacePlan, 'deskWidthMm' | 'deskHeightMm'>,
  viewport: Viewport,
): { x: number; y: number } {
  const box = toViewBox(view, plan, viewport)
  return {
    x: box.x + ((clientX - bounds.left) / bounds.width) * box.width,
    y: box.y + ((clientY - bounds.top) / bounds.height) * box.height,
  }
}

/** 屏幕像素对应的方案毫米距离（用于吸附阈值等） */
export function pxToMm(view: CameraView, px: number, plan: Pick<WorkspacePlan, 'deskWidthMm' | 'deskHeightMm'>, viewport: Viewport): number {
  const scale = fitScale(plan, viewport)
  return scale > 0 ? px / (scale * view.zoom) : px
}
