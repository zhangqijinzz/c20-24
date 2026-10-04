import { describe, expect, it } from 'vitest'
import type { WorkspacePlan } from '../../../shared/models'
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampView,
  clampZoom,
  createFitView,
  fitScale,
  panView,
  screenToPlan,
  toViewBox,
  zoomAt,
} from '../cameraViewModel'

const plan: Pick<WorkspacePlan, 'deskWidthMm' | 'deskHeightMm'> = { deskWidthMm: 1600, deskHeightMm: 800 }
const viewport = { widthPx: 800, heightPx: 400 }

describe('camera view model', () => {
  it('fit scale keeps the whole desk visible while filling the viewport', () => {
    expect(fitScale(plan, viewport)).toBe(0.5)
    const fit = createFitView(plan)
    const box = toViewBox(fit, plan, viewport)
    expect(box).toMatchObject({ x: 0, y: 0, width: 1600, height: 800 })
  })

  it('clamps zoom into the supported range', () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM)
    expect(clampZoom(99)).toBe(MAX_ZOOM)
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM)
  })

  it('keeps the desk reachable when panning far away', () => {
    const panned = panView(createFitView(plan), 10000, 10000, plan, viewport)
    const box = toViewBox(panned, plan, viewport)
    // 视口（zoom=1 时宽 1600mm）至少保留桌面的 25%，画布永远拖不丢
    expect(box.x + box.width).toBeGreaterThanOrEqual(plan.deskWidthMm * 0.25 - 0.001)
    expect(box.y + box.height).toBeGreaterThanOrEqual(plan.deskHeightMm * 0.25 - 0.001)
    expect(box.x).toBeLessThanOrEqual(plan.deskWidthMm * 0.75 + 0.001)
  })

  it('converts screen pixels to plan millimetres through any zoom level', () => {
    const rect = { left: 0, top: 0, width: 800, height: 400 }
    expect(screenToPlan(createFitView(plan), 400, 200, rect, plan, viewport)).toEqual({ x: 800, y: 400 })

    const zoomed = clampView(zoomAt(createFitView(plan), 2, 800, 400), plan, viewport)
    // 放大 2 倍后，锚点在屏幕上的位置不动
    expect(screenToPlan(zoomed, 400, 200, rect, plan, viewport)).toEqual({ x: 800, y: 400 })
    // 视口可视区域对应方案坐标缩小一半
    const box = toViewBox(zoomed, plan, viewport)
    expect(box.width).toBeCloseTo(800)
    expect(box.height).toBeCloseTo(400)
  })

  it('pans content opposite to the pointer drag, in millimetres', () => {
    const panned = panView(createFitView(plan), 100, 0, plan, viewport)
    // 100px / (0.5 px per mm * zoom 1) = 200mm，视图中心向左移
    expect(panned.centerX).toBeCloseTo(600)
    expect(panned.centerY).toBe(400)
  })
})
