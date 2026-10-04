import { getItemBounds, normalizeRotation } from '../../shared/layoutRules'
import type { DeskItem, ItemBounds, WorkspacePlan } from '../../shared/models'

function updateCanvasItem(items: DeskItem[], id: string, updater: (item: DeskItem) => DeskItem): DeskItem[] {
  return items.map((item) => item.id === id ? updater(item) : item)
}

export function moveCanvasItem(items: DeskItem[], id: string, x: number, y: number): DeskItem[] {
  return updateCanvasItem(items, id, (item) => ({ ...item, x, y }))
}

export function rotateCanvasItem(items: DeskItem[], id: string, delta: number): DeskItem[] {
  return updateCanvasItem(items, id, (item) => ({ ...item, rotation: normalizeRotation(item.rotation + delta) }))
}

export interface DragGuide {
  /** 'x' 表示竖直线（对齐左右边缘/中心），'y' 表示水平线 */
  axis: 'x' | 'y'
  pos: number
}

export interface SnapResult {
  x: number
  y: number
  guides: DragGuide[]
}

/** 可参与吸附的纵向/横向坐标：边缘与中心 */
function snapPoints(bounds: ItemBounds): { xs: number[]; ys: number[] } {
  return {
    xs: [bounds.left, (bounds.left + bounds.right) / 2, bounds.right],
    ys: [bounds.top, (bounds.top + bounds.bottom) / 2, bounds.bottom],
  }
}

/**
 * 拖动时对其他设备和桌面的边缘/中心线做最近距离吸附，
 * 阈值与返回坐标均为方案（毫米）单位；辅助线也在方案坐标系中绘制，
 * 因此任意缩放级别下都与设备严格对齐。
 */
export function snapCanvasItem(
  items: DeskItem[],
  id: string,
  x: number,
  y: number,
  plan: Pick<WorkspacePlan, 'deskWidthMm' | 'deskHeightMm'>,
  thresholdMm: number,
): SnapResult {
  const item = items.find((candidate) => candidate.id === id)
  if (!item || thresholdMm <= 0) return { x, y, guides: [] }

  const moving = getItemBounds({ ...item, x, y })
  const movingPoints = snapPoints(moving)

  const targetXs = [0, plan.deskWidthMm / 2, plan.deskWidthMm]
  const targetYs = [0, plan.deskHeightMm / 2, plan.deskHeightMm]
  items.forEach((other) => {
    if (other.id === id) return
    const points = snapPoints(getItemBounds(other))
    targetXs.push(...points.xs)
    targetYs.push(...points.ys)
  })

  const guides: DragGuide[] = []
  let nextX = x
  let nextY = y

  const nearest = (sources: number[], targets: number[]): { source: number; target: number; delta: number } | null => {
    let best: { source: number; target: number; delta: number } | null = null
    sources.forEach((source) => {
      targets.forEach((target) => {
        const delta = target - source
        if (Math.abs(delta) <= thresholdMm && (!best || Math.abs(delta) < Math.abs(best.delta))) {
          best = { source, target, delta }
        }
      })
    })
    return best
  }

  const xMatch = nearest(movingPoints.xs, targetXs)
  if (xMatch) {
    nextX = x + xMatch.delta
    guides.push({ axis: 'x', pos: xMatch.target })
  }
  const yMatch = nearest(movingPoints.ys, targetYs)
  if (yMatch) {
    nextY = y + yMatch.delta
    guides.push({ axis: 'y', pos: yMatch.target })
  }

  return { x: nextX, y: nextY, guides }
}
