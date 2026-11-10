/** Page coordinates from PDF.js survive changes in pane width and zoom. */
export interface ReadingPosition {
  page: number
  scale: string
  top: number
  left: number
}

const pending = new Map<string, ReadingPosition>()
let timer: ReturnType<typeof setTimeout> | undefined

export function readingPositionKey(path: string, external: boolean): string | null {
  const vault = external ? null : ctx.app.vaultRoot?.()
  if (!external && !vault) return null
  return `pdf-reader.position.v1:${JSON.stringify([vault, path])}`
}

function valid(position: ReadingPosition | null): position is ReadingPosition {
  return !!position && Number.isInteger(position.page) && position.page > 0
    && Number.isFinite(position.top) && Number.isFinite(position.left)
    && typeof position.scale === 'string'
    && (position.scale === 'page-width' || position.scale === 'page-fit'
      || (Number(position.scale) > 0 && Number(position.scale) <= 10))
}

export function readReadingPosition(key: string | null): ReadingPosition | null {
  if (!key) return null
  try {
    const position = pending.get(key) ?? JSON.parse(localStorage.getItem(key) ?? 'null')
    return valid(position) ? position : null
  } catch { return null }
}

export function rememberReadingPosition(key: string, position: ReadingPosition): void {
  if (!valid(position)) return
  pending.set(key, position)
  timer ??= setTimeout(flushReadingPositions, 500)
}

export function flushReadingPositions(): void {
  clearTimeout(timer)
  timer = undefined
  for (const [key, position] of pending) {
    try {
      localStorage.setItem(key, JSON.stringify(position))
      pending.delete(key)
    } catch { /* Keep the latest position in memory if storage is unavailable. */ }
  }
}
