/** DOM plugins use the host's tooltip timing, handoff and reduced-motion policy. */
export function tooltips(root: HTMLElement): () => void {
  if (!ctx.ui?.attachTooltip) return () => {}
  const handles = new Map<HTMLElement, { dispose(): void }>()
  const sync = (): void => {
    for (const [el, tip] of handles) if (!root.contains(el)) { tip.dispose(); handles.delete(el) }
    for (const el of root.querySelectorAll<HTMLElement>('[title]')) {
      const title = el.getAttribute('title')
      if (!title) continue
      handles.get(el)?.dispose()
      handles.set(el, ctx.ui!.attachTooltip!(el, title))
      el.removeAttribute('title')
    }
  }
  const observer = new MutationObserver(sync)
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] })
  sync()
  return () => { observer.disconnect(); for (const tip of handles.values()) tip.dispose(); handles.clear() }
}
