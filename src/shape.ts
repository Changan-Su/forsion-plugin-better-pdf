import { boundsOf } from './geom'

// Shape notes travel with the board element, including when the board moves or restores it.
export const SHAPE_TYPES = ['rectangle', 'ellipse', 'arrow', 'line'] as const
export type ShapeType = typeof SHAPE_TYPES[number]
export const isShape = (element: any): boolean => SHAPE_TYPES.some(type => element?.type === type)
export const shapeNote = (element: any): string => {
  const note = element?.customData?.betterPdfNote
  return isShape(element) && typeof note === 'string' ? note : ''
}
export const shapeColor = (element: any): string => {
  const color = element?.strokeColor
  return typeof color === 'string' && /^#[\da-f]{6}$/i.test(color) ? color : '#1e1e1e'
}
export const withShapeNote = (element: any, note: string): any => ({
  ...element,
  customData: { ...element.customData, betterPdfNote: note || undefined },
})
export type ShapeStyle = { strokeColor?: string; strokeWidth?: number; roundness?: { type: number } | null }
export type ShapeEdit = { id: string; before: ShapeStyle; after: ShapeStyle }


/** Bounds of the rotated board frame, in page or scene units. */
export function visualBoundsOf(element: any): [number, number, number, number] {
  const [left, top, right, bottom] = boundsOf(element)
  const angle = Number(element.angle) || 0
  const x = (left + right) / 2, y = (top + bottom) / 2
  const w = (right - left) / 2, h = (bottom - top) / 2
  const dx = Math.abs(Math.cos(angle)) * w + Math.abs(Math.sin(angle)) * h
  const dy = Math.abs(Math.sin(angle)) * w + Math.abs(Math.cos(angle)) * h
  return [x - dx, y - dy, x + dx, y + dy]
}
