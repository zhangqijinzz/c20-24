import { normalizeRotation } from '../../shared/layoutRules'
import type { DeskItem } from '../../shared/models'

function updateCanvasItem(items: DeskItem[], id: string, updater: (item: DeskItem) => DeskItem): DeskItem[] {
  return items.map((item) => item.id === id ? updater(item) : item)
}

export function moveCanvasItem(items: DeskItem[], id: string, x: number, y: number): DeskItem[] {
  return updateCanvasItem(items, id, (item) => ({ ...item, x, y }))
}

export function rotateCanvasItem(items: DeskItem[], id: string, delta: number): DeskItem[] {
  return updateCanvasItem(items, id, (item) => ({ ...item, rotation: normalizeRotation(item.rotation + delta) }))
}

export interface Camera {
  centerMm: { x: number; y: number }
  /** 相对「适应窗口」基准缩放的倍数，1 = 适应窗口时的大小 */
  zoom: number
}

export interface CameraViewport {
  widthPx: number
  heightPx: number
}

export interface CameraDesk {
  widthMm: number
  heightMm: number
}

/** 缩放范围：相对适应窗口的 0.5（再小设备难点）到 4 倍（足够看局部标签） */
export const MIN_CAMERA_ZOOM = 0.5
export const MAX_CAMERA_ZOOM = 4
export const CAMERA_ZOOM_STEP = 1.25
/** 平移时至少保留桌面 35% 宽高的可见区域，避免把画布完全拖走 */
const PAN_OVERLAP_RATIO = 0.35
/** 适应窗口时桌面四周留白（像素） */
export const FIT_PADDING_PX = 18
/** 复位视图按 1 px ≈ 1 mm 显示，标签大小与设计尺寸一致 */
export const RESET_PX_PER_MM = 1

export function fitScaleFor(desk: CameraDesk, viewport: CameraViewport): number {
  if (desk.widthMm <= 0 || desk.heightMm <= 0 || viewport.widthPx <= 0 || viewport.heightPx <= 0) return 1
  return Math.min(
    Math.max(0, viewport.widthPx - FIT_PADDING_PX * 2) / desk.widthMm,
    Math.max(0, viewport.heightPx - FIT_PADDING_PX * 2) / desk.heightMm,
  )
}

export function clampCameraZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(MAX_CAMERA_ZOOM, Math.max(MIN_CAMERA_ZOOM, zoom))
}

function pxPerMmFor(camera: Camera, desk: CameraDesk, viewport: CameraViewport): number {
  return fitScaleFor(desk, viewport) * camera.zoom
}

/**
 * 平移边界钳制：
 * - 视口比桌面小（放大后）：相机中心限制在桌面内，任何位置至少有半个视口压在桌面上；
 * - 视口比桌面大（缩得很小）：桌面至少保留 PAN_OVERLAP_RATIO 的宽/高在屏内，不会被整个拖走。
 */
function clampCenter(centerMm: { x: number; y: number }, zoom: number, desk: CameraDesk, viewport: CameraViewport) {
  const pxPerMm = pxPerMmFor({ centerMm, zoom }, desk, viewport)
  const visibleMmW = viewport.widthPx / pxPerMm
  const visibleMmH = viewport.heightPx / pxPerMm
  const clampAxis = (value: number, deskSize: number, visibleSize: number) => {
    if (visibleSize <= deskSize) {
      return Math.min(deskSize, Math.max(0, value))
    }
    const minCenter = PAN_OVERLAP_RATIO * deskSize - visibleSize / 2
    const maxCenter = (1 - PAN_OVERLAP_RATIO) * deskSize + visibleSize / 2
    return Math.min(maxCenter, Math.max(minCenter, value))
  }
  return {
    x: clampAxis(centerMm.x, desk.widthMm, visibleMmW),
    y: clampAxis(centerMm.y, desk.heightMm, visibleMmH),
  }
}

export function createFitCamera(desk: CameraDesk, viewport: CameraViewport): Camera {
  return { centerMm: { x: desk.widthMm / 2, y: desk.heightMm / 2 }, zoom: 1 }
}

export function createResetCamera(desk: CameraDesk, viewport: CameraViewport): Camera {
  const targetZoom = RESET_PX_PER_MM / fitScaleFor(desk, viewport)
  return { centerMm: { x: desk.widthMm / 2, y: desk.heightMm / 2 }, zoom: clampCameraZoom(targetZoom) }
}

export interface ViewBox { x: number; y: number; width: number; height: number }

export function viewBoxFromCamera(camera: Camera, desk: CameraDesk, viewport: CameraViewport): ViewBox {
  const pxPerMm = pxPerMmFor(camera, desk, viewport)
  const width = viewport.widthPx / pxPerMm
  const height = viewport.heightPx / pxPerMm
  const center = clampCenter(camera.centerMm, camera.zoom, desk, viewport)
  return { x: center.x - width / 2, y: center.y - height / 2, width, height }
}

/**
 * 以光标处的桌面坐标为锚点缩放：缩放前后光标指向的 mm 坐标保持不变，
 * 因此放大后指针始终对准同一物理位置，不会出现越放越偏。
 */
export function zoomCameraAt(
  camera: Camera,
  factor: number,
  pointerPx: { x: number; y: number },
  desk: CameraDesk,
  viewport: CameraViewport,
): Camera {
  const nextZoom = clampCameraZoom(camera.zoom * factor)
  const effectiveFactor = nextZoom / camera.zoom
  const before = viewBoxFromCamera(camera, desk, viewport)
  const anchorMmX = before.x + (pointerPx.x / viewport.widthPx) * before.width
  const anchorMmY = before.y + (pointerPx.y / viewport.heightPx) * before.height
  const nextCenterX = anchorMmX + (camera.centerMm.x - anchorMmX) / effectiveFactor
  const nextCenterY = anchorMmY + (camera.centerMm.y - anchorMmY) / effectiveFactor
  const next: Camera = { centerMm: { x: nextCenterX, y: nextCenterY }, zoom: nextZoom }
  // 结果同样过一遍边界钳制，避免在边缘连续缩放时锚点漂移
  const clampedBox = viewBoxFromCamera(next, desk, viewport)
  return { centerMm: { x: clampedBox.x + clampedBox.width / 2, y: clampedBox.y + clampedBox.height / 2 }, zoom: nextZoom }
}

export function panCameraBy(camera: Camera, deltaPx: { x: number; y: number }, desk: CameraDesk, viewport: CameraViewport): Camera {
  const pxPerMm = pxPerMmFor(camera, desk, viewport)
  return {
    centerMm: clampCenter(
      { x: camera.centerMm.x - deltaPx.x / pxPerMm, y: camera.centerMm.y - deltaPx.y / pxPerMm },
      camera.zoom,
      desk,
      viewport,
    ),
    zoom: camera.zoom,
  }
}

/** 视口像素坐标 → 桌面 mm 坐标；拖动物体、命中判定统一走这条换算 */
export function screenToMm(
  camera: Camera,
  pointPx: { x: number; y: number },
  desk: CameraDesk,
  viewport: CameraViewport,
): { x: number; y: number } | null {
  if (viewport.widthPx <= 0 || viewport.heightPx <= 0) return null
  const box = viewBoxFromCamera(camera, desk, viewport)
  return {
    x: box.x + (pointPx.x / viewport.widthPx) * box.width,
    y: box.y + (pointPx.y / viewport.heightPx) * box.height,
  }
}
