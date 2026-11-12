/** Discrete tools complete only after an actual annotation/shape is committed. */
export type PdfTool = 'hand' | 'select' | 'highlight' | 'underline' | 'note' | 'text' | 'shape' | 'ink' | 'eraser'
export const isDiscrete = (tool: PdfTool): boolean => tool === 'highlight' || tool === 'underline' || tool === 'shape'
export class ToolSession {
  active: PdfTool = 'select'
  navigation: 'select' | 'hand' = 'select'
  locked = false
  activate(tool: PdfTool, locked = false): PdfTool {
    if (tool === 'select' || tool === 'hand') this.navigation = tool
    this.active = tool
    this.locked = isDiscrete(tool) && locked
    return tool
  }
  complete(tool: PdfTool): PdfTool | null {
    return tool === this.active && isDiscrete(tool) && !this.locked ? this.activate(this.navigation) : null
  }
  escape(): PdfTool { return this.activate(this.navigation) }
}
export const validNewShape = (element: any, previous: ReadonlySet<string>): boolean => {
  if (!element || previous.has(element.id) || element.isDeleted || !['rectangle', 'ellipse', 'arrow', 'line'].includes(element.type)) return false
  const w = Math.abs(Number(element.width)), h = Math.abs(Number(element.height))
  if (!Number.isFinite(w) || !Number.isFinite(h)) return false
  return element.type === 'line' || element.type === 'arrow' ? Math.hypot(w, h) >= 2 : w >= 2 && h >= 2
}
export type MarkTool = 'highlight' | 'underline' | 'strike' | 'note' | 'text'
export const DEFAULT_MARK_COLORS: Record<MarkTool, string> = {
  highlight: '#ffd400', underline: '#ffd400', strike: '#ffd400', note: '#ffd400', text: '#ffd400',
}
export function markColors(value: unknown): Record<MarkTool, string> {
  const result = { ...DEFAULT_MARK_COLORS }
  if (value && typeof value === 'object') for (const key of Object.keys(result) as MarkTool[]) {
    const color = (value as Record<string, unknown>)[key]
    if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) result[key] = color.toLowerCase()
  }
  return result
}
