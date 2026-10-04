import { describe, expect, it } from 'vitest'
import { createItem } from '../../../shared/models'
import {
  CAMERA_ZOOM_STEP,
  FIT_PADDING_PX,
  MAX_CAMERA_ZOOM,
  MIN_CAMERA_ZOOM,
  clampCameraZoom,
  createFitCamera,
  createResetCamera,
  fitScaleFor,
  moveCanvasItem,
  panCameraBy,
  rotateCanvasItem,
  screenToMm,
  viewBoxFromCamera,
  zoomCameraAt,
  type Camera,
} from '../canvasViewModel'

const DESK = { widthMm: 1600, heightMm: 800 }
const VIEWPORT = { widthPx: 800, heightPx: 600 }

describe('canvas item module', () => {
  it('moves and rotates the requested item without changing other items', () => {
    const first = createItem('monitor')
    const second = createItem('keyboard')
    const moved = moveCanvasItem([first, second], first.id, 320, 180)
    const rotated = rotateCanvasItem(moved, first.id, -15)
    expect(rotated[0]).toMatchObject({ x: 320, y: 180, rotation: 345 })
    expect(rotated[1]).toEqual(second)
  })
})

describe('camera fit and reset', () => {
  it('fits the whole desk inside the viewport with padding', () => {
    const scale = fitScaleFor(DESK, VIEWPORT)
    expect(scale).toBe((VIEWPORT.widthPx - FIT_PADDING_PX * 2) / DESK.widthMm)
    const camera = createFitCamera(DESK, VIEWPORT)
    const box = viewBoxFromCamera(camera, DESK, VIEWPORT)
    expect(box.x).toBeLessThanOrEqual(0)
    expect(box.y).toBeLessThanOrEqual(0)
    expect(box.x + box.width).toBeGreaterThanOrEqual(DESK.widthMm)
    expect(box.y + box.height).toBeGreaterThanOrEqual(DESK.heightMm)
  })

  it('reset view centers the desk at 1px per 1mm and keeps zoom within limits', () => {
    const camera = createResetCamera(DESK, VIEWPORT)
    expect(camera.centerMm).toEqual({ x: DESK.widthMm / 2, y: DESK.heightMm / 2 })
    expect(camera.zoom).toBeCloseTo(1 / fitScaleFor(DESK, VIEWPORT), 10)
    expect(camera.zoom).toBeLessThanOrEqual(MAX_CAMERA_ZOOM)
  })

  it('clamps invalid and out-of-range zoom values', () => {
    expect(clampCameraZoom(Number.NaN)).toBe(1)
    expect(clampCameraZoom(0.01)).toBe(MIN_CAMERA_ZOOM)
    expect(clampCameraZoom(100)).toBe(MAX_CAMERA_ZOOM)
  })
})

describe('camera zoom at pointer', () => {
  it('keeps the mm point under the pointer fixed when zooming in', () => {
    const fit = createFitCamera(DESK, VIEWPORT)
    const pointer = { x: 200, y: 150 }
    const beforeMm = screenToMm(fit, pointer, DESK, VIEWPORT)!
    const zoomed = zoomCameraAt(fit, CAMERA_ZOOM_STEP, pointer, DESK, VIEWPORT)
    const afterMm = screenToMm(zoomed, pointer, DESK, VIEWPORT)!
    expect(afterMm.x).toBeCloseTo(beforeMm.x, 6)
    expect(afterMm.y).toBeCloseTo(beforeMm.y, 6)
    expect(zoomed.zoom).toBeCloseTo(CAMERA_ZOOM_STEP, 10)
  })

  it('zooming out below the minimum stops at the lower bound', () => {
    const fit = createFitCamera(DESK, VIEWPORT)
    const zoomed = zoomCameraAt(fit, 0.01, { x: 400, y: 300 }, DESK, VIEWPORT)
    expect(zoomed.zoom).toBe(MIN_CAMERA_ZOOM)
  })

  it('zooming in above the maximum stops at the upper bound', () => {
    const fit = createFitCamera(DESK, VIEWPORT)
    const zoomed = zoomCameraAt(fit, 100, { x: 400, y: 300 }, DESK, VIEWPORT)
    expect(zoomed.zoom).toBe(MAX_CAMERA_ZOOM)
  })
})

describe('camera panning bounds', () => {
  it('keeps at least half the viewport over the desk when zoomed in', () => {
    const zoomedIn: Camera = { centerMm: { x: 800, y: 400 }, zoom: 3 }
    const boxBefore = viewBoxFromCamera(zoomedIn, DESK, VIEWPORT)
    // 试图把画布远远拖向左上
    const panned = panCameraBy(zoomedIn, { x: 100000, y: 100000 }, DESK, VIEWPORT)
    const box = viewBoxFromCamera(panned, DESK, VIEWPORT)
    expect(box.x).toBeLessThanOrEqual(0)
    expect(box.y).toBeLessThanOrEqual(0)
    expect(box.x).toBeGreaterThanOrEqual(-boxBefore.width / 2 - 1e-6)
    expect(box.y).toBeGreaterThanOrEqual(-boxBefore.height / 2 - 1e-6)
    expect(panned.centerMm).toEqual({ x: 0, y: 0 })
  })

  it('never moves the whole desk out of view when zoomed far out', () => {
    const zoomedOut: Camera = { centerMm: { x: 800, y: 400 }, zoom: MIN_CAMERA_ZOOM }
    const panned = panCameraBy(zoomedOut, { x: -100000, y: 0 }, DESK, VIEWPORT)
    const box = viewBoxFromCamera(panned, DESK, VIEWPORT)
    // 桌面至少 35% 的宽度仍在视口内
    expect(box.x + box.width).toBeGreaterThanOrEqual(0.35 * DESK.widthMm - 1e-6)
    expect(box.x).toBeLessThanOrEqual(DESK.widthMm * 0.65 + 1e-6)
  })

  it('moves the center opposite to the drag direction in mm units', () => {
    const fit = createFitCamera(DESK, VIEWPORT)
    const scale = fitScaleFor(DESK, VIEWPORT)
    const panned = panCameraBy(fit, { x: 100 * scale, y: 0 }, DESK, VIEWPORT)
    expect(panned.centerMm.x).toBeCloseTo(700, 6)
    expect(panned.centerMm.y).toBeCloseTo(400, 6)
  })
})

describe('screen to mm conversion', () => {
  it('returns null for an empty viewport', () => {
    const fit = createFitCamera(DESK, VIEWPORT)
    expect(screenToMm(fit, { x: 10, y: 10 }, DESK, { widthPx: 0, heightPx: 0 })).toBeNull()
  })

  it('maps viewport corners to the viewBox corners', () => {
    const camera: Camera = { centerMm: { x: 200, y: 100 }, zoom: 2 }
    const box = viewBoxFromCamera(camera, DESK, VIEWPORT)
    expect(screenToMm(camera, { x: 0, y: 0 }, DESK, VIEWPORT)).toEqual({ x: box.x, y: box.y })
    expect(screenToMm(camera, { x: VIEWPORT.widthPx, y: VIEWPORT.heightPx }, DESK, VIEWPORT))
      .toEqual({ x: box.x + box.width, y: box.y + box.height })
  })
})
