import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Hand, Maximize, Minus, Move, Plus, RotateCw } from 'lucide-react'
import type { DeskItem, LayoutAnalysis, WorkspacePlan } from '../../../shared/models'
import { getDeviceDefinition } from '../../../shared/models'
import { getItemBounds } from '../../../shared/layoutRules'
import { moveCanvasItem, snapCanvasItem, type DragGuide } from '../canvasViewModel'
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampView,
  clampZoom,
  createFitView,
  panView,
  pxToMm,
  reconcileView,
  screenToPlan,
  toViewBox,
  zoomAt,
  type CameraView,
} from '../cameraViewModel'

interface CanvasStageProps {
  plan: WorkspacePlan
  selectedItemId: string | null
  analysis: LayoutAnalysis
  onSelect: (id: string | null) => void
  onMove: (id: string, x: number, y: number) => void
  /** 预览模式：禁用拖动与平移，只保留浏览缩放 */
  readOnly?: boolean
}

interface ItemDragState {
  kind: 'item'
  id: string
  offsetX: number
  offsetY: number
  pointerId: number
}

interface PanState {
  kind: 'pan'
  pointerId: number
  lastX: number
  lastY: number
  moved: boolean
}

interface PinchState {
  kind: 'pinch'
  startDistance: number
  startView: CameraView
  pointers: Map<number, { x: number; y: number }>
}

type DragState = ItemDragState | PanState | PinchState

interface ActivePointers {
  pointers: Map<number, { x: number; y: number; targetItem: string | null }>
}

const FIT_PADDING = 0.94

export function CanvasStage({ plan, selectedItemId, analysis, onSelect, onMove, readOnly = false }: CanvasStageProps) {
  const stageRef = useRef<SVGSVGElement>(null)
  const [viewport, setViewport] = useState({ widthPx: 0, heightPx: 0 })
  const [view, setView] = useState<CameraView>(() => createFitView(plan))
  const [drag, setDrag] = useState<DragState | null>(null)
  const [guides, setGuides] = useState<DragGuide[]>([])
  const [isSpaceDown, setIsSpaceDown] = useState(false)

  const viewRef = useRef(view)
  viewRef.current = view
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const activePointers = useRef<ActivePointers>({ pointers: new Map() })

  /* ---------- 画布尺寸测量 ---------- */

  useLayoutEffect(() => {
    const svg = stageRef.current
    if (!svg) return
    const measure = () => {
      const rect = svg.getBoundingClientRect()
      setViewport({ widthPx: rect.width, heightPx: rect.height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(svg)
    return () => observer.disconnect()
  }, [])

  /* ---------- 切换方案：视图一键适应窗口 ---------- */

  const deskWidthMm = plan.deskWidthMm
  const deskHeightMm = plan.deskHeightMm
  const planIdRef = useRef(plan.id)
  useEffect(() => {
    if (planIdRef.current === plan.id) return
    planIdRef.current = plan.id
    setView(createFitView({ deskWidthMm, deskHeightMm }))
    // 切换方案时只按新方案 id 触发，尺寸取最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.id])

  /* 同一方案桌面尺寸变化：保留当前缩放/视角，仅收回越界部分 */
  const deskSizeRef = useRef({ w: deskWidthMm, h: deskHeightMm })
  useEffect(() => {
    const previous = deskSizeRef.current
    if (previous.w === deskWidthMm && previous.h === deskHeightMm) return
    deskSizeRef.current = { w: deskWidthMm, h: deskHeightMm }
    if (viewportRef.current.widthPx > 0) {
      setView((current) => reconcileView(current, { deskWidthMm, deskHeightMm }, viewportRef.current))
    }
  }, [deskWidthMm, deskHeightMm])

  /* 视口尺寸变化时同步约束（缩放状态不写进方案数据） */
  useEffect(() => {
    if (viewport.widthPx <= 0) return
    setView((current) => clampView(current, { deskWidthMm, deskHeightMm }, viewport))
  }, [viewport.widthPx, viewport.heightPx, viewport, deskWidthMm, deskHeightMm])

  /* ---------- 坐标换算 ---------- */

  const toPlan = useCallback((clientX: number, clientY: number) => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect || viewportRef.current.widthPx <= 0) return null
    return screenToPlan(viewRef.current, clientX, clientY, rect, plan, viewportRef.current)
  }, [plan])

  /* ---------- 缩放 / 平移操作 ---------- */

  const applyZoom = useCallback((clientX: number | null, clientY: number | null, updater: (zoom: number) => number) => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect || viewportRef.current.widthPx <= 0) return
    const nextZoom = clampZoom(updater(viewRef.current.zoom))
    if (nextZoom === viewRef.current.zoom) return
    const focus = clientX === null || clientY === null
      ? { x: viewRef.current.centerX, y: viewRef.current.centerY }
      : screenToPlan(viewRef.current, clientX, clientY, rect, plan, viewportRef.current)
    setView((current) => clampView(zoomAt(current, nextZoom, focus.x, focus.y), plan, viewportRef.current))
  }, [plan])

  const zoomIn = useCallback(() => applyZoom(null, null, (zoom) => zoom * 1.25), [applyZoom])
  const zoomOut = useCallback(() => applyZoom(null, null, (zoom) => zoom / 1.25), [applyZoom])
  const fitToWindow = useCallback(() => {
    setView({ ...createFitView(plan), zoom: FIT_PADDING })
  }, [plan])
  const resetView = useCallback(() => setView(createFitView(plan)), [plan])

  /* 滚轮：以指针位置为锚点缩放；不带修饰键的滚轮平移，避免页面滚动冲突 */
  useEffect(() => {
    const svg = stageRef.current
    if (!svg) return
    const handleWheel = (event: WheelEvent) => {
      if (viewportRef.current.widthPx <= 0) return
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) {
        const factor = Math.exp(-event.deltaY * 0.0015)
        applyZoom(event.clientX, event.clientY, (zoom) => zoom * factor)
      } else {
        const deltaX = event.shiftKey ? event.deltaY : event.deltaX
        const deltaY = event.shiftKey ? 0 : event.deltaY
        setView((current) => panView(current, deltaX, deltaY, plan, viewportRef.current))
      }
    }
    svg.addEventListener('wheel', handleWheel, { passive: false })
    return () => svg.removeEventListener('wheel', handleWheel)
  }, [applyZoom, plan])

  /* 空格临时切换为抓手平移 */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      event.preventDefault()
      setIsSpaceDown(true)
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setIsSpaceDown(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => { window.removeEventListener('keydown', handleKeyDown); window.removeEventListener('keyup', handleKeyUp) }
  }, [])

  /* ---------- 指针交互：设备拖动 / 画布平移 / 双指捏合 ---------- */

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const itemElement = event.target instanceof Element ? event.target.closest<SVGGElement>('[data-item-id]') : null
    const itemId = itemElement?.dataset.itemId ?? null
    activePointers.current.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, targetItem: itemId })

    if (activePointers.current.pointers.size === 2) {
      const [first, second] = [...activePointers.current.pointers.values()]
      setDrag({
        kind: 'pinch',
        startDistance: Math.hypot(second.x - first.x, second.y - first.y),
        startView: viewRef.current,
        pointers: new Map([...activePointers.current.pointers].map(([id, point]) => [id, { x: point.x, y: point.y }])),
      })
      setGuides([])
      return
    }

    if (readOnly || isSpaceDown) {
      if (readOnly && !isSpaceDown) return
      event.preventDefault()
      setDrag({ kind: 'pan', pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY, moved: false })
      return
    }

    if (itemId) {
      const point = toPlan(event.clientX, event.clientY)
      if (!point) return
      const item = plan.items.find((candidate) => candidate.id === itemId)
      if (!item) return
      event.stopPropagation()
      onSelect(item.id)
      setDrag({ kind: 'item', id: item.id, offsetX: point.x - item.x, offsetY: point.y - item.y, pointerId: event.pointerId })
      return
    }

    setDrag({ kind: 'pan', pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY, moved: false })
  }

  useEffect(() => {
    if (!drag) return

    const updatePointer = (event: PointerEvent) => {
      const stored = activePointers.current.pointers.get(event.pointerId)
      if (stored) stored.x = event.clientX, stored.y = event.clientY
      return stored
    }

    const handleMove = (event: PointerEvent) => {
      if (drag.kind === 'pinch') {
        const stored = updatePointer(event)
        if (!stored || activePointers.current.pointers.size < 2) return
        const [first, second] = [...activePointers.current.pointers.values()]
        const distance = Math.hypot(second.x - first.x, second.y - first.y)
        if (distance <= 0 || drag.startDistance <= 0) return
        const rect = stageRef.current?.getBoundingClientRect()
        if (!rect) return
        const midStart = [...drag.pointers.values()].reduce((acc, point) => ({ x: acc.x + point.x / 2, y: acc.y + point.y / 2 }), { x: 0, y: 0 })
        const midNow = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
        const focusStart = screenToPlan(drag.startView, midStart.x, midStart.y, rect, plan, viewportRef.current)
        const focusNow = screenToPlan(drag.startView, midNow.x, midNow.y, rect, plan, viewportRef.current)
        const zoom = clampZoom(drag.startView.zoom * (distance / drag.startDistance))
        const ratio = zoom / drag.startView.zoom
        // 先按双指中点的移动平移视图，再以当前中点为锚点缩放
        const translated: CameraView = {
          ...drag.startView,
          centerX: drag.startView.centerX + (focusNow.x - focusStart.x) / ratio,
          centerY: drag.startView.centerY + (focusNow.y - focusStart.y) / ratio,
        }
        setView(clampView(zoomAt(translated, zoom, focusNow.x, focusNow.y), plan, viewportRef.current))
        return
      }

      if (event.pointerId !== drag.pointerId) return
      if (drag.kind === 'pan') {
        const deltaX = event.clientX - drag.lastX
        const deltaY = event.clientY - drag.lastY
        if (deltaX !== 0 || deltaY !== 0) {
          drag.lastX = event.clientX
          drag.lastY = event.clientY
          if (Math.abs(deltaX) + Math.abs(deltaY) > 2) drag.moved = true
          setView((current) => panView(current, deltaX, deltaY, plan, viewportRef.current))
        }
        return
      }

      const point = toPlan(event.clientX, event.clientY)
      if (!point) return
      const threshold = pxToMm(viewRef.current, event.pointerType === 'touch' ? 14 : 8, plan, viewportRef.current)
      const items = moveCanvasItem(plan.items, drag.id, point.x - drag.offsetX, point.y - drag.offsetY)
      const movedItem = items.find((candidate) => candidate.id === drag.id)
      if (!movedItem) return
      const snapped = snapCanvasItem(items, drag.id, movedItem.x, movedItem.y, plan, Math.min(threshold, 30))
      setGuides(snapped.guides)
      onMove(drag.id, snapped.x, snapped.y)
    }

    const finish = (event: PointerEvent) => {
      if (drag.kind !== 'pinch' && event.pointerId !== drag.pointerId && activePointers.current.pointers.has(event.pointerId)) {
        activePointers.current.pointers.delete(event.pointerId)
        return
      }
      if (drag.kind === 'pan' && !drag.moved && event.pointerId === drag.pointerId) {
        const startedOnItem = activePointers.current.pointers.get(event.pointerId)?.targetItem
        if (!startedOnItem) onSelect(null)
      }
      activePointers.current.pointers.clear()
      setDrag(null)
      setGuides([])
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [drag, onMove, onSelect, plan, toPlan])

  /* ---------- 渲染 ---------- */

  const viewBox = toViewBox(view, plan, viewport.widthPx > 0 ? viewport : { widthPx: plan.deskWidthMm, heightPx: plan.deskHeightMm })
  const zoomPercent = Math.round(view.zoom * 100)
  const canvasCursor = readOnly ? 'default' : isSpaceDown ? 'grab' : drag?.kind === 'pan' ? 'grabbing' : 'default'

  return (
    <div className="canvas-wrap">
      <div className="canvas-toolbar">
        <span><Move size={14} /> {readOnly ? '布局预览（只读）' : '拖动设备调整位置'}</span>
        <span><Hand size={14} /> {readOnly ? 'Ctrl / ⌘ + 滚轮缩放，按钮可复位' : '拖空白处 / 滚轮平移 · Ctrl + 滚轮缩放 · 空格抓手'}</span>
        <div className="canvas-view-controls">
          <button type="button" className="view-button" onClick={zoomOut} disabled={view.zoom <= MIN_ZOOM + 0.001} aria-label="缩小视图" title="缩小"><Minus size={14} /></button>
          <span className="canvas-zoom-readout" aria-live="polite">{zoomPercent}%</span>
          <button type="button" className="view-button" onClick={zoomIn} disabled={view.zoom >= MAX_ZOOM - 0.001} aria-label="放大视图" title="放大"><Plus size={14} /></button>
          <button type="button" className="view-button" onClick={fitToWindow} aria-label="适应窗口" title="适应窗口"><Maximize size={14} /></button>
          <button type="button" className="view-button" onClick={resetView} aria-label="复位视图" title="复位"><RotateCw size={14} /></button>
        </div>
      </div>
      <svg
        ref={stageRef}
        className="desk-canvas"
        style={{ cursor: canvasCursor }}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`桌面布局画布，${plan.deskWidthMm}乘${plan.deskHeightMm}毫米，当前缩放${zoomPercent}%`}
        onPointerDown={handlePointerDown}
        tabIndex={0}
      >
        <defs>
          <pattern id="desk-grid" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M 50 0 L 0 0 0 50" fill="none" stroke="#d8e1ed" strokeWidth="1" /></pattern>
          <filter id="item-shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="8" stdDeviation="8" floodColor="#20304a" floodOpacity=".12" /></filter>
        </defs>
        <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} fill="#eef2f8" />
        <rect width={plan.deskWidthMm} height={plan.deskHeightMm} rx="22" fill="#f8fafc" stroke="#d9e2ec" strokeWidth="2" />
        <rect width={plan.deskWidthMm} height={plan.deskHeightMm} rx="22" fill="url(#desk-grid)" />
        <text x="34" y="48" fill="#a0aec0" fontSize="20" letterSpacing="3">FOCUS ZONE / {plan.deskWidthMm} × {plan.deskHeightMm} MM</text>
        {guides.map((guide, index) => guide.axis === 'x'
          ? <line key={`guide-${index}`} className="drag-guide" x1={guide.pos} y1={viewBox.y} x2={guide.pos} y2={viewBox.y + viewBox.height} />
          : <line key={`guide-${index}`} className="drag-guide" x1={viewBox.x} y1={guide.pos} x2={viewBox.x + viewBox.width} y2={guide.pos} />)}
        {plan.items.map((item) => {
          const definition = getDeviceDefinition(item.type)
          const isSelected = selectedItemId === item.id
          const hasIssue = analysis.overlapIds.includes(item.id) || analysis.outOfBoundsIds.includes(item.id)
          const bounds = getItemBounds(item)
          const cx = item.x + item.widthMm / 2
          const cy = item.y + item.heightMm / 2
          return <g className={`desk-item ${isSelected ? 'is-selected' : ''} ${hasIssue ? 'has-issue' : ''}`} key={item.id} data-item-id={item.id} role="button" tabIndex={-1} aria-label={`${definition.label}，${item.widthMm}乘${item.heightMm}毫米`}>
            <g transform={`translate(${cx} ${cy}) rotate(${item.rotation})`}>
              <rect x={-item.widthMm / 2} y={-item.heightMm / 2} width={item.widthMm} height={item.heightMm} rx={Math.min(24, item.heightMm / 5)} fill={definition.color} filter="url(#item-shadow)" />
              <rect className="item-inner-line" x={-item.widthMm / 2 + 12} y={-item.heightMm / 2 + 12} width={Math.max(0, item.widthMm - 24)} height={Math.max(0, item.heightMm - 24)} rx="12" fill="none" />
              <text x="0" y="5" textAnchor="middle" fill="#1f2e44" fontWeight="700" fontSize={Math.max(18, Math.min(32, item.widthMm / 16))}>{definition.shortLabel}</text>
              <text x="0" y="30" textAnchor="middle" fill="#44546b" fontSize="16">{item.widthMm} × {item.heightMm}</text>
            </g>
            {isSelected && <rect className="selection-box" x={bounds.left - 8} y={bounds.top - 8} width={bounds.width + 16} height={bounds.height + 16} rx="12" fill="none" />}
            {hasIssue && <g transform={`translate(${Math.max(18, bounds.right - 4)} ${Math.max(18, bounds.top - 4)})`}><circle r="18" fill="#ef6a6a" /><text textAnchor="middle" y="7" fill="white" fontSize="22" fontWeight="700">!</text></g>}
          </g>
        })}
        {plan.items.length === 0 && <g><circle cx={plan.deskWidthMm / 2} cy={plan.deskHeightMm / 2 - 12} r="32" fill="#e8eef6" /><text x={plan.deskWidthMm / 2} y={plan.deskHeightMm / 2 + 2} textAnchor="middle" fill="#8493a8" fontSize="22">+</text><text x={plan.deskWidthMm / 2} y={plan.deskHeightMm / 2 + 48} textAnchor="middle" fill="#8493a8" fontSize="22">从左侧添加第一件设备</text></g>}
      </svg>
      <div className="canvas-legend"><span><i className="legend-dot clear-dot" /> 可用空间</span><span><i className="legend-dot issue-dot" /> 冲突 / 越界</span><span className="canvas-scale">网格：50 mm</span></div>
    </div>
  )
}
