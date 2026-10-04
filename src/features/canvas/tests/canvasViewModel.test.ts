import { describe, expect, it } from 'vitest'
import { createItem } from '../../../shared/models'
import { moveCanvasItem, rotateCanvasItem, snapCanvasItem } from '../canvasViewModel'

describe('canvas module', () => {
  it('moves and rotates the requested item without changing other items', () => {
    const first = createItem('monitor')
    const second = createItem('keyboard')
    const moved = moveCanvasItem([first, second], first.id, 320, 180)
    const rotated = rotateCanvasItem(moved, first.id, -15)
    expect(rotated[0]).toMatchObject({ x: 320, y: 180, rotation: 345 })
    expect(rotated[1]).toEqual(second)
  })

  it('snaps the dragged item to the desk left edge and reports a guide', () => {
    const item = createItem('monitor')
    const plan = { deskWidthMm: 1600, deskHeightMm: 800 }
    const result = snapCanvasItem([item], item.id, 4, 120, plan, 10)
    expect(result.x).toBe(0)
    expect(result.y).toBe(120)
    expect(result.guides).toEqual([{ axis: 'x', pos: 0 }])
  })

  it('aligns centres with other devices', () => {
    const first = createItem('monitor')
    const second = createItem('keyboard')
    first.x = 530
    first.y = 100
    second.x = 0
    second.y = 0
    const plan = { deskWidthMm: 1600, deskHeightMm: 800 }
    // first 中心 x = 800（桌面中线）；second 宽 440，x=578 时中心 798；y=323 时中心 398
    const result = snapCanvasItem([first, second], second.id, 578, 323, plan, 10)
    expect(result.x).toBe(580)
    expect(result.guides).toContainEqual({ axis: 'x', pos: 800 })
    expect(result.guides).toContainEqual({ axis: 'y', pos: 400 })
  })

  it('leaves positions untouched beyond the snap threshold', () => {
    const item = createItem('lamp')
    const plan = { deskWidthMm: 1600, deskHeightMm: 800 }
    const result = snapCanvasItem([item], item.id, 300, 300, plan, 8)
    expect(result).toEqual({ x: 300, y: 300, guides: [] })
  })
})
