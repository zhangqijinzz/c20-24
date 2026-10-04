import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Expand, Maximize, Minus, Move, Plus, RotateCcw, RotateCw } from 'lucide-react'
import type { DeskItem, LayoutAnalysis, WorkspacePlan } from '../../../shared/models'
import { getDeviceDefinition } from '../../../shared/models'
import { getItemBounds } from '../../../shared/layoutRules'
import {
  CAMERA_ZOOM_STEP,
  MAX_CAMERA_ZOOM,
  MIN_CAMERA_ZOOM,
  createFitCamera,
  createResetCamera,
  panCameraBy,
  screenToMm,
  viewBoxFromCamera,
  zoomCameraAt,
  type Camera,
  type CameraDesk,
  type CameraViewport,
} from '../canvasViewModel'

interface CanvasStageProps {
  plan: WorkspacePlan
  selectedItemId: string | null
  analysis: LayoutAnalysis
  onSelect: (id: string | null) => void
  onMove: (id: string, x: number, y: number) => void
}

interface ItemDragState { kind: 'item'; id: string; offsetX: number; offsetY: number }
interface PanState { kind: 'pan'; startX: number; startY: number }

const ZOOM_BUTTON_FACTORS = { in: CAMERA_ZOOM_STEP, out: 1 / CAMERA_ZOOM_STEP }

export function CanvasStage({ plan, selectedItemId, analysis, onSelect, onMove }: CanvasStageProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const gridId = `desk-grid-${uid}`
  const shadowId = `item-shadow-${uid}`
  const [viewport, setViewport] = useState<CameraViewport>({ widthPx: 0, heightPx: 0 })
  const desk: CameraDesk = useMemo(() => ({ widthMm: plan.deskWidthMm, heightMm: plan.deskHeightMm }), [plan.deskWidthMm, plan.deskHeightMm])

  const [camera, setCamera] = useState<Camera>(() => ({ centerMm: { x: plan.deskWidthMm / 2, y: plan.deskHeightMm / 2 }, zoom: 1 }))
  const cameraRef = useRef(camera)
  cameraRef.current = camera
  const [gesture, setGesture] = useState<ItemDragState | PanState | null>(null)
  const gestureRef = useRef(gesture)
  gestureRef.current = gesture

  // 视口尺寸：等实际布局后再测量，viewBox 才有意义
  useLayoutEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const update = () => setViewport({ widthPx: element.clientWidth, heightPx: element.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const ready = viewport.widthPx > 0 && viewport.heightPx > 0

  // 切换方案时重新适应窗口；缩放/平移只存在本地视图状态，不写进方案数据
  const planIdRef = useRef(plan.id)
  useEffect(() => {
    if (!ready) return
    if (planIdRef.current === plan.id) return
    planIdRef.current = plan.id
    setCamera(createFitCamera(desk, viewport))
  }, [desk, plan.id, ready, viewport])

  // 桌面尺寸或视口变化时，把当前视图钳回合法范围（viewBoxFromCamera 内部会限制中心点）
  useEffect(() => {
    if (!ready) return
    setCamera((current) => {
      const box = viewBoxFromCamera(current, desk, viewport)
      const centerX = box.x + box.width / 2
      const centerY = box.y + box.height / 2
      if (Math.abs(centerX - current.centerMm.x) < 1e-9 && Math.abs(centerY - current.centerMm.y) < 1e-9) return current
      return { zoom: current.zoom, centerMm: { x: centerX, y: centerY } }
    })
  }, [desk, ready, viewport])

  const pointFromClient = useCallback((clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return null
    return { x: clientX - rect.left, y: clientY - rect.top }
  }, [])

  const startItemDrag = (event: ReactPointerEvent<SVGGElement>, item: DeskItem) => {
    event.stopPropagation()
    const point = pointFromClient(event.clientX, event.clientY)
    if (!point) return
    const mm = screenToMm(cameraRef.current, point, desk, viewport)
    if (!mm) return
    onSelect(item.id)
    setGesture({ kind: 'item', id: item.id, offsetX: mm.x - item.x, offsetY: mm.y - item.y })
  }
  // 拖动设备 / 平移画布共用一套指针监听；换算始终基于当前相机，放大后指针指哪跟哪
  useEffect(() => {
    if (!gesture) return
    const handleMove = (event: PointerEvent) => {
      const point = pointFromClient(event.clientX, event.clientY)
      if (!point) return
      const current = gestureRef.current
      if (current?.kind === 'item') {
        const mm = screenToMm(cameraRef.current, point, desk, viewport)
        if (!mm) return
        onMove(current.id, mm.x - current.offsetX, mm.y - current.offsetY)
      } else if (current?.kind === 'pan') {
        setCamera((cameraState) => panCameraBy(cameraState, { x: point.x - current.startX, y: point.y - current.startY }, desk, viewport))
        current.startX = point.x
        current.startY = point.y
      }
    }
    const handleUp = () => setGesture(null)
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }
  }, [desk, gesture, onMove, pointFromClient, viewport])

  const startPan = (event: ReactPointerEvent<SVGSVGElement>) => {
    const point = pointFromClient(event.clientX, event.clientY)
    if (!point) return
    onSelect(null)
    setGesture({ kind: 'pan', startX: point.x, startY: point.y })
  }

  // 以光标为锚点缩放：锚点 mm 坐标不变，放大后标注不会偏移
  const zoomAtPointer = useCallback((factor: number, clientX?: number, clientY?: number) => {
    if (!ready) return
    const rect = wrapRef.current?.getBoundingClientRect()
    const pointer = rect
      ? { x: (clientX ?? rect.left + rect.width / 2) - rect.left, y: (clientY ?? rect.top + rect.height / 2) - rect.top }
      : { x: viewport.widthPx / 2, y: viewport.heightPx / 2 }
    setCamera((current) => zoomCameraAt(current, factor, pointer, desk, viewport))
  }, [desk, ready, viewport])

  // 原生非 passive 监听：Ctrl/⌘+滚轮缩放时要阻止浏览器整页缩放，滚轮平移要阻止页面滚动
  useEffect(() => {
    const element = wrapRef.current
    if (!element || !ready) return
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        zoomAtPointer(event.deltaY < 0 ? CAMERA_ZOOM_STEP : 1 / CAMERA_ZOOM_STEP, event.clientX, event.clientY)
        return
      }
      const deltaX = event.shiftKey ? event.deltaY : event.deltaX
      const deltaY = event.shiftKey ? 0 : event.deltaY
      if (deltaX !== 0 || deltaY !== 0) {
        event.preventDefault()
        setCamera((current) => panCameraBy(current, { x: deltaX, y: deltaY }, desk, viewport))
      }
    }
    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => element.removeEventListener('wheel', handleWheel)
  }, [desk, ready, viewport, zoomAtPointer])

  const fitView = useCallback(() => { if (ready) setCamera(createFitCamera(desk, viewport)) }, [desk, ready, viewport])
  const resetView = useCallback(() => { if (ready) setCamera(createResetCamera(desk, viewport)) }, [desk, ready, viewport])

  const viewBox = ready ? viewBoxFromCamera(camera, desk, viewport) : null
  const isPanning = gesture?.kind === 'pan'
  const canZoomIn = camera.zoom < MAX_CAMERA_ZOOM - 1e-6
  const canZoomOut = camera.zoom > MIN_CAMERA_ZOOM + 1e-6

  return (
    <div className="canvas-wrap">
      <div className="canvas-toolbar">
        <span><Move size={14} /> 拖动设备调整位置</span>
        <div className="canvas-view-controls" role="group" aria-label="画布视图控制">
          <button type="button" className="view-button" onClick={() => zoomAtPointer(ZOOM_BUTTON_FACTORS.out)} disabled={!ready || !canZoomOut} aria-label="缩小" title="缩小"><Minus size={13} /></button>
          <span className="zoom-readout" aria-live="polite">{ready ? Math.round(camera.zoom * 100) : 100}%</span>
          <button type="button" className="view-button" onClick={() => zoomAtPointer(ZOOM_BUTTON_FACTORS.in)} disabled={!ready || !canZoomIn} aria-label="放大" title="放大"><Plus size={13} /></button>
          <button type="button" className="view-button" onClick={fitView} disabled={!ready} aria-label="适应窗口" title="适应窗口（双击空白处同样有效）"><Maximize size={13} /></button>
          <button type="button" className="view-button" onClick={resetView} disabled={!ready} aria-label="复位视图" title="复位视图（100%，1mm = 1px）"><RotateCcw size={13} /></button>
        </div>
        <span><RotateCw size={14} /> 旋转请在右侧操作</span>
      </div>
      <div className="canvas-viewport" ref={wrapRef}>
        {ready && viewBox && (
          <svg
            className={`desk-canvas ${isPanning ? 'is-panning' : ''}`}
            viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={`桌面布局画布，${plan.deskWidthMm}乘${plan.deskHeightMm}毫米，可缩放平移`}
            onPointerDown={startPan}
            onDoubleClick={(event) => { event.preventDefault(); fitView() }}
          >
            <defs>
              <pattern id={gridId} width="50" height="50" patternUnits="userSpaceOnUse"><path d="M 50 0 L 0 0 0 50" fill="none" stroke="#d8e1ed" strokeWidth="1" /></pattern>
              <filter id={shadowId} x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="8" stdDeviation="8" floodColor="#20304a" floodOpacity=".12" /></filter>
            </defs>
            <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} fill="#eef2f7" />
            <rect width={plan.deskWidthMm} height={plan.deskHeightMm} rx="22" fill="#f8fafc" />
            <rect width={plan.deskWidthMm} height={plan.deskHeightMm} rx="22" fill={`url(#${gridId})`} />
            <rect width={plan.deskWidthMm} height={plan.deskHeightMm} rx="22" fill="none" stroke="#cdd8e6" strokeWidth="2" />
            <text x="34" y="48" fill="#a0aec0" fontSize="20" letterSpacing="3">FOCUS ZONE / {plan.deskWidthMm} × {plan.deskHeightMm} MM</text>
            {plan.items.map((item) => {
              const definition = getDeviceDefinition(item.type)
              const isSelected = selectedItemId === item.id
              const hasIssue = analysis.overlapIds.includes(item.id) || analysis.outOfBoundsIds.includes(item.id)
              const cx = item.x + item.widthMm / 2
              const cy = item.y + item.heightMm / 2
              return <g className={`desk-item ${isSelected ? 'is-selected' : ''} ${hasIssue ? 'has-issue' : ''}`} key={item.id} onPointerDown={(event) => startItemDrag(event, item)} onDoubleClick={(event) => event.stopPropagation()} role="button" tabIndex={0} aria-label={`${definition.label}，${item.widthMm}乘${item.heightMm}毫米`}>
                <g transform={`translate(${cx} ${cy}) rotate(${item.rotation})`}>
                  <rect x={-item.widthMm / 2} y={-item.heightMm / 2} width={item.widthMm} height={item.heightMm} rx={Math.min(24, item.heightMm / 5)} fill={definition.color} filter={`url(#${shadowId})`} />
                  <rect className="item-inner-line" x={-item.widthMm / 2 + 12} y={-item.heightMm / 2 + 12} width={Math.max(0, item.widthMm - 24)} height={Math.max(0, item.heightMm - 24)} rx={12} fill="none" />
                  <text x="0" y="5" textAnchor="middle" fill="#1f2e44" fontWeight="700" fontSize={Math.max(18, Math.min(32, item.widthMm / 16))}>{definition.shortLabel}</text>
                  <text x="0" y="30" textAnchor="middle" fill="#44546b" fontSize="16">{item.widthMm} × {item.heightMm}</text>
                </g>
                {isSelected && <rect className="selection-box" x={getItemBounds(item).left - 8} y={getItemBounds(item).top - 8} width={getItemBounds(item).width + 16} height={getItemBounds(item).height + 16} rx="12" fill="none" />}
                {hasIssue && <g transform={`translate(${Math.max(18, getItemBounds(item).right - 4)} ${Math.max(18, getItemBounds(item).top - 4)}`}><circle r="18" fill="#ef6a6a" /><text textAnchor="middle" y="7" fill="white" fontSize="22" fontWeight="700">!</text></g>}
              </g>
            })}
            {plan.items.length === 0 && <g><circle cx={plan.deskWidthMm / 2} cy={plan.deskHeightMm / 2 - 12} r="32" fill="#e8eef6" /><text x={plan.deskWidthMm / 2} y={plan.deskHeightMm / 2 + 2} textAnchor="middle" fill="#8493a8" fontSize="22">+</text><text x={plan.deskWidthMm / 2} y={plan.deskHeightMm / 2 + 48} textAnchor="middle" fill="#8493a8" fontSize="22">从左侧添加第一件设备</text></g>}
          </svg>
        )}
        {ready && <div className="canvas-hint"><Expand size={12} /> 空白处拖动平移 · Ctrl/⌘ + 滚轮缩放 · 双击适应窗口</div>}
      </div>
      <div className="canvas-legend"><span><i className="legend-dot clear-dot" /> 可用空间</span><span><i className="legend-dot issue-dot" /> 冲突 / 越界</span><span className="canvas-scale">网格：50 mm</span></div>
    </div>
  )
}
