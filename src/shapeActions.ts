import { esc, richNotes, type Reader } from './reader'
import { INK_COLORS, INK_WIDTHS } from './ink'
import { icon } from './icons'
import { t } from './i18n'
import { shapeColor, shapeNote, visualBoundsOf } from './shape'

type Panel = 'color' | 'note' | 'more'
const button = (action: string, label: string, contents: string, className = 'pr-pbtn'): string =>
  `<button type="button" class="${className}" data-shape-action="${action}" aria-label="${esc(label)}" title="${esc(label)}">${contents}</button>`

const colorControl = (color: string, mixed = false): string => button('color', t('shape.strokeColor'),
  `<span class="pr-color-current${mixed ? ' pr-mixed-color' : ''}" style="--c:${color}"></span>${icon('chevron-down', 12)}`, 'pr-color-trigger')

export class ShapeActions {
  private readonly el: HTMLElement
  private readonly viewport: HTMLElement
  private readonly bar: HTMLElement
  private readonly panel: HTMLElement
  private readonly frame: HTMLElement
  private readonly pinLayers = new Map<number, { layer: HTMLElement; stamp: string }>()
  private panelKind: Panel | null = null
  private selectionKey = ''
  private controlKey = ''
  private frameId = 0
  private editor: ReturnType<NonNullable<NonNullable<typeof ctx.ui>['mountMarkdownEditor']>> | null = null
  private gesture = false
  private outline = false

  constructor(private readonly r: Reader) {
    this.viewport = r.root.querySelector('.pr-viewport')!
    this.el = document.createElement('div')
    this.el.className = 'pr-shape-ui pr-pop'
    this.el.hidden = true
    this.el.innerHTML = '<div class="pr-shape-frame" hidden></div><div class="pr-shape-bar ui-popover pr-selpop" role="group"></div><div class="pr-shape-panel ui-popover" hidden></div>'
    this.bar = this.el.querySelector('.pr-shape-bar')!
    this.panel = this.el.querySelector('.pr-shape-panel')!
    this.frame = this.el.querySelector('.pr-shape-frame')!
    this.viewport.append(this.el)
    this.el.addEventListener('click', this.onClick)
    this.el.addEventListener('change', this.onColor)
  }

  private selected(): any[] { return this.r.ink?.selectedShapes() ?? [] }

  refresh(): void {
    if (this.frameId) return
    this.frameId = requestAnimationFrame(() => {
      this.frameId = 0
      const selected = this.selected()
      const key = selected.map(e => e.id).join(',')
      if (key !== this.selectionKey) {
        this.selectionKey = key
        this.closePanel()
      }
      this.el.hidden = !selected.length || this.gesture || this.r.root.hasAttribute('data-grab')
      if (this.el.hidden) return
      const first = selected[0]
      const color = shapeColor(first)
      const mixed = selected.some(e => shapeColor(e) !== color)
      const note = selected.length === 1 && shapeNote(first)
      const readonly = !!this.r.doc?.readonly
      const controls = JSON.stringify([key, color, mixed, !!note, readonly, t('shape.addNote')])
      if (controls !== this.controlKey) {
        const labels = { note: t(note ? 'shape.editNote' : 'shape.addNote'), more: t('tool.more') }
        this.controlKey = controls
        const focus = this.bar.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.shapeAction : undefined
        this.bar.setAttribute('aria-label', t('shape.actions'))
        this.bar.innerHTML = colorControl(color, mixed) +
          (selected.length === 1 ? button('note', labels.note, `${icon('message-circle')} ${esc(labels.note)}`, 'pr-pbtn txt') : '') +
          button('more', labels.more, icon('ellipsis'), 'pr-ibtn')
        if (readonly) this.bar.querySelectorAll<HTMLButtonElement>('button').forEach(b => {
          b.disabled = b.dataset.shapeAction !== 'note' || !note
        })
        if (focus) this.bar.querySelector<HTMLElement>(`[data-shape-action="${focus}"]`)?.focus({ preventScroll: true })
      }
      for (const item of this.bar.querySelectorAll<HTMLElement>('[data-shape-action]')) {
        item.setAttribute('aria-expanded', String(this.panelKind === item.dataset.shapeAction))
      }
      this.layout(selected)
    })
  }

  setGesture(active: boolean): void {
    this.gesture = active
    if (active) this.closePanel()
    this.refresh()
  }

  setOutline(visible: boolean): void {
    this.outline = visible
    this.refresh()
  }

  private layout(selected: any[]): void {
    const [x0, y0, x1, y1] = this.r.ink!.selectionBounds(selected)
    const view = this.viewport
    this.el.hidden = !view.clientWidth || x1 < 0 || y1 < 0 || x0 > view.clientWidth || y0 > view.clientHeight
    if (this.el.hidden) { this.closePanel(); return }
    this.frame.hidden = !this.outline
    this.frame.style.cssText = `left:${x0}px;top:${y0}px;width:${Math.max(1, x1 - x0)}px;height:${Math.max(1, y1 - y0)}px`
    const note = this.panelKind === 'note'
    const surface = note ? this.panel : this.bar
    this.el.dataset.panel = this.panelKind ?? ''
    const hasMenu = this.panelKind === 'color' || this.panelKind === 'more'
    const w = Math.max(surface.offsetWidth, hasMenu ? this.panel.offsetWidth : 0)
    const h = surface.offsetHeight + (hasMenu ? this.panel.offsetHeight + 4 : 0)
    const pad = 8, gap = 16
    const maxX = view.clientWidth - w - pad
    const dock = this.r.root.dataset.w === 'dock'
    const top = dock ? pad : 58
    const bottom = view.clientHeight - (dock ? 56 : 40) - h
    const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
    const sideY = clamp(y0, top, bottom)
    const edgeX = clamp(x0, pad, maxX)
    const beside: [number, number][] = [[x1 + gap, sideY], [x0 - w - gap, sideY]]
    const vertical: [number, number][] = [[edgeX, y0 - h - gap], [edgeX, y1 + gap]]
    const placed = !dock && [...beside, ...vertical].find(([x, y]) =>
      x >= pad && x <= maxX && y >= top && y <= bottom)
    const [x, y] = placed || [Math.max(pad, (view.clientWidth - w) / 2), Math.max(pad, bottom)]
    surface.style.left = `${x}px`
    surface.style.top = `${y + (hasMenu && !placed ? this.panel.offsetHeight + 4 : 0)}px`
    if (hasMenu) {
      this.panel.style.left = `${x}px`
      this.panel.style.top = `${y + (placed ? surface.offsetHeight + 4 : 0)}px`
    }
  }

  private readonly onClick = (event: MouseEvent): void => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('button')
    const action = target?.dataset.shapeAction ?? target?.dataset.act
    if (!action) return
    event.stopPropagation()
    const value = target?.dataset.v ?? ''
    const selected = this.selected()
    if (!selected.length || (this.r.doc?.readonly && action !== 'note' && action !== 'close')) return
    switch (action) {
      case 'color': case 'note': case 'more':
        if (this.panelKind === action) this.closePanel(true)
        else this.openPanel(action, selected)
        break
      case 'close': this.closePanel(true); break
      case 'shape-ink-color': this.applyColor(value); break
      case 'width': this.r.ink?.editShapes({ strokeWidth: Number(value) }); this.closePanel(true); break
      case 'corners':
        this.r.ink?.editShapes({ roundness: value === 'round' ? { type: 3 } : null }, selected.filter(e => e.type === 'rectangle'))
        this.closePanel(true)
        break
      case 'delete':
        this.r.container.focus({ preventScroll: true })
        this.r.ink?.deleteSelectedShapes()
        break
    }
  }

  private readonly onColor = (event: Event): void => {
    const input = event.target as HTMLInputElement
    if (!input.matches('input[data-color="shape-ink-color"]')) return
    event.stopPropagation()
    this.r.rememberColor(input.value)
    this.applyColor(input.value)
  }

  private applyColor(color: string): void {
    if (/^#[\da-f]{6}$/i.test(color)) this.r.ink?.editShapes({ strokeColor: color })
    this.closePanel(true)
  }

  private openPanel(kind: Panel, selected: any[]): void {
    this.closePanel()
    const first = selected[0]
    this.panelKind = kind
    this.panel.hidden = false
    this.panel.dataset.kind = kind
    this.el.dataset.panel = kind
    this.panel.setAttribute('role', kind === 'note' ? 'dialog' : 'group')
    const colors = selected.map(shapeColor)
    const color = colors.every(c => c === colors[0]) ? colors[0] : null
    if (kind === 'color') {
      this.panel.setAttribute('aria-label', t('shape.strokeColor'))
      this.panel.innerHTML = this.r.dotsHtml(color, 'shape-ink-color', INK_COLORS)
    } else if (kind === 'more') {
      this.panel.setAttribute('aria-label', t('tool.more'))
      const widths = INK_WIDTHS.map(w => `<button type="button" class="pr-width${selected.every(e => e.strokeWidth === w * 2) ? ' on' : ''}" style="--d:${Math.min(13, 4 + 2 * w)}px" data-shape-action="width" data-v="${w * 2}" title="${w}" aria-label="${esc(t('tool.width'))} ${w}"></button>`).join('')
      const rectangles = selected.filter(e => e.type === 'rectangle')
      const corners = rectangles.length ? `<div class="pr-penrow">${(['sharp', 'round'] as const).map(v =>
        `<button type="button" class="pr-btn pr-tool${rectangles.every(e => !!e.roundness === (v === 'round')) ? ' on' : ''}" data-shape-action="corners" data-v="${v}">${esc(t(`shape.${v}`))}</button>`).join('')}</div>` : ''
      this.panel.innerHTML = `<div class="pr-shape-style"><span>${esc(t('tool.width'))}</span><div class="pr-widths">${widths}</div></div>${corners}` +
        button('delete', t('shape.delete'), `${icon('trash-2')} ${esc(t('shape.delete'))}`)
    } else {
      this.panel.setAttribute('aria-label', t('shape.editNote'))
      const page = Object.entries(this.r.doc?.data.ink ?? {}).find(([, els]) => els.some(e => e.id === first.id))?.[0]
      const readonly = this.r.doc?.readonly
      const note = shapeNote(first)
      this.panel.innerHTML = `<div class="pr-card pr-shape-card">
        <div class="pr-card-top">${readonly ? '' : colorControl(shapeColor(first))}<span>${esc(t(`shape.${first.type}`))}</span><span class="pr-flex"></span>${button('close', t('shape.close'), icon('x'), 'pr-ibtn')}</div>
        ${readonly ? `<div class="pr-card-body pr-cmt">${esc(note)}</div>` : richNotes() ? '<div class="pr-card-body pr-card-md"></div>' : `<textarea class="pr-card-body" rows="3" aria-label="${esc(t('card.placeholder'))}" placeholder="${esc(t('card.placeholder'))}"></textarea>`}
        ${page !== undefined ? `<div class="pr-card-foot"><span class="pr-flex"></span>${esc(t('card.page', { n: Number(page) + 1 }))}</div>` : ''}
      </div>`
      const write = (value: string): void => this.r.ink?.writeShapeNote(first.id, value)
      const textarea = this.panel.querySelector('textarea')
      if (readonly) this.panel.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
      else if (textarea) {
        textarea.value = note
        textarea.addEventListener('input', () => write(textarea.value))
        textarea.focus({ preventScroll: true })
      } else {
        this.editor = ctx.ui!.mountMarkdownEditor!(this.panel.querySelector('.pr-card-md')!, {
          value: note, label: t('card.placeholder'), modes: false, vault: true, onChange: write,
        })
        this.editor.focus()
      }
    }
    if (this.bar.childElementCount) this.layout(selected)
    if (kind !== 'note') this.panel.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
    this.refresh()
  }

  closePanel(focus = false): boolean {
    const kind = this.panelKind
    if (!kind) return false
    this.panelKind = null
    this.editor?.dispose()
    this.editor = null
    this.panel.replaceChildren()
    this.panel.hidden = true
    this.el.dataset.panel = ''
    if (focus) this.bar.querySelector<HTMLElement>(`[data-shape-action="${kind}"]`)?.focus({ preventScroll: true })
    this.refresh()
    return true
  }

  updatePins(page: number): void {
    const shapes = (this.r.doc?.data.ink[page] ?? []).filter(e => shapeNote(e).trim())
    const stamp = JSON.stringify([t('shape.editNote'), shapes.map(e => [e.id, visualBoundsOf(e)])])
    const current = this.pinLayers.get(page)
    if (current?.stamp === stamp || (!current && !shapes.length)) return
    current?.layer.remove()
    this.pinLayers.delete(page)
    const target = shapes.length && this.r.layerOf(page, false)
    if (!target) return
    const layer = document.createElement('div')
    layer.className = 'pr-shape-pins'
    this.pinLayers.set(page, { layer, stamp })
    for (const e of shapes) {
      const [, top, right] = visualBoundsOf(e)
      const zoom = this.r.viewer.getPageView(page)?.viewport?.scale ?? 1
      const span = this.r.viewer.getPageView(page)?.viewport?.width / zoom
      const x = Number.isFinite(span) ? Math.min(right, span - 27 / zoom) : right
      const y = Math.max(0, top)
      const pin = document.createElement('button')
      pin.type = 'button'
      pin.className = 'pr-shape-pin'
      pin.style.setProperty('--x', String(x))
      pin.style.setProperty('--y', String(y))
      pin.setAttribute('aria-label', t('shape.editNote'))
      pin.title = t('shape.editNote')
      pin.innerHTML = icon('message-circle', 12)
      pin.addEventListener('click', event => {
        event.stopPropagation()
        this.r.revealShape(e.id, false)
        const selected = this.selected()
        if (selected.length === 1) {
          this.selectionKey = selected[0].id
          this.el.hidden = false
          this.openPanel('note', selected)
        }
      })
      layer.append(pin)
    }
    target.append(layer)
  }

  refreshPins(): void {
    for (const page of new Set([...this.pinLayers.keys(), ...Object.keys(this.r.doc?.data.ink ?? {}).map(Number)])) this.updatePins(page)
  }

  dispose(): void {
    this.closePanel()
    cancelAnimationFrame(this.frameId)
    this.el.remove()
    for (const pin of this.pinLayers.values()) pin.layer.remove()
    this.pinLayers.clear()
  }
}
