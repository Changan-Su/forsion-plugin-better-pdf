// 右栏的三个视图:批注列表 / 大纲 / 对话。它们不属于某一个标签,跟着「最近操作过的那份 PDF」走。
import { KIND_ICON, chat, esc, fmtTime, getActive, onActive, type Reader } from './reader'
import { baseOf } from './store'
import { icon } from './icons'
import { locale, t } from './i18n'

/** 当前 PDF 换了、或它有变化(批注 / 选中 / 翻页)时调 draw。返回卸载函数。 */
function follow(draw: (r: Reader | null) => void): () => void {
  let offReader: (() => void) | null = null
  const bind = (): void => {
    offReader?.()
    const r = getActive()
    offReader = r ? r.subscribe(() => draw(r)) : null
    draw(r)
  }
  const offActive = onActive(bind)
  const offLocale = ctx.subscribeLocale?.(() => draw(getActive()))
  bind()
  return () => { offActive(); offLocale?.(); offReader?.() }
}

const empty = (text: string): string => `<div class="pr-panel-empty">${esc(text)}</div>`

export function mountAnnots(host: HTMLElement): () => void {
  host.innerHTML = '<div class="pr-panel"><div class="pr-listhead"><b></b><input class="pr-listfilter" type="search"></div><div class="pr-list"></div></div>'
  const head = host.querySelector('.pr-listhead') as HTMLElement, count = head.querySelector('b')!, input = head.querySelector('input')!, list = host.querySelector('.pr-list') as HTMLElement
  let filter = '', last = '', lastSel: string | null = null

  const draw = (r: Reader | null): void => {
    const doc = r?.doc
    // 翻页也会走到这里;内容没变就不重画(重画会打断正在进行的滚动和悬停)。
    const key = JSON.stringify([r?.pdfPath, !!doc, r?.selected, filter, locale(), doc?.data.annots.map((a) => a.modified), doc && Object.entries(doc.data.ink).map(([p, l]) => [p, l.length, r?.ink?.thumb(Number(p)).length])])
    if (key === last) return
    last = key
    input.placeholder = t('list.filter')
    head.hidden = !doc
    if (!r || !doc) { list.innerHTML = empty(t('list.noPdf')); return }
    const items: { page: number; html: string }[] = []
    const match = (...parts: (string | undefined)[]): boolean => !filter || parts.some((p) => p?.toLowerCase().includes(filter))
    for (const a of doc.sorted()) {
      if (!match(a.text, a.comment, ...(a.tags ?? []).map((g) => `#${g}`))) continue
      items.push({ page: a.page, html: `<button class="pr-item${a.id === r.selected ? ' sel' : ''}" data-id="${a.id}" style="--c:${a.color}">
        <span class="pr-item-top"><span class="pr-kind">${icon(KIND_ICON[a.type], 11)}</span><span>${esc(t(`kind.${a.type}`))} · ${esc(t('card.page', { n: a.page + 1 }))}</span><span class="pr-flex"></span><span>${esc(fmtTime(a.created))}</span></span>
        ${a.text ? `<span class="${a.type === 'text' ? 'pr-cmt' : 'pr-quote'}">${esc(a.text)}</span>` : ''}${a.comment ? `<span class="pr-cmt">${esc(a.comment)}</span>` : ''}
        ${a.tags?.length ? `<span class="pr-tags">${a.tags.map((g) => `<span>#${esc(g)}</span>`).join('')}</span>` : ''}</button>` })
    }
    let inkPages = 0
    for (const [p, els] of Object.entries(doc.data.ink)) {
      if (!els.length) continue
      inkPages++
      if (filter) continue
      items.push({ page: Number(p), html: `<button class="pr-item" data-page="${Number(p) + 1}" style="--c:#2b4acb">
        <span class="pr-item-top"><span class="pr-kind">${icon(KIND_ICON.ink, 11)}</span><span>${esc(t('kind.ink'))} · ${esc(t('card.page', { n: Number(p) + 1 }))}</span></span>
        <span class="pr-inkthumb">${r.ink?.thumb(Number(p)) ?? ''}</span></button>` })
    }
    count.textContent = t('list.count', { n: doc.data.annots.length + inkPages })
    items.sort((a, b) => a.page - b.page)
    list.innerHTML = items.length ? items.map((i) => i.html).join('') : empty(t(filter ? 'list.noMatch' : 'list.empty'))
    if (r.selected !== lastSel) list.querySelector('.pr-item.sel')?.scrollIntoView({ block: 'nearest' })
    lastSel = r.selected
  }

  input.addEventListener('input', () => { filter = input.value.trim().toLowerCase(); draw(getActive()) })
  list.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.pr-item'), r = getActive()
    if (!b || !r) return
    if (b.dataset.id) r.reveal(b.dataset.id)
    else if (b.dataset.page) r.viewer.currentPageNumber = Number(b.dataset.page)
  })
  return follow(draw)
}

export function mountOutline(host: HTMLElement): () => void {
  let shown: unknown = undefined, lang = ''
  const draw = (r: Reader | null): void => {
    const pdf = r?.pdf ?? null
    if (pdf === shown && lang === locale()) return
    shown = pdf; lang = locale()
    if (!r || !pdf) { host.innerHTML = empty(t('outline.noPdf')); return }
    void pdf.getOutline().then((outline: any[] | null) => {
      if (shown !== pdf) return
      if (!outline?.length) { host.innerHTML = empty(t('outline.empty')); return }
      const dests: unknown[] = []
      const walk = (items: any[], depth: number): string => items.map((it) => {
        dests.push(it.dest)
        return `<button data-i="${dests.length - 1}" style="padding-left:${8 + depth * 14}px" title="${esc(it.title || '')}">${esc(it.title || t('outline.untitled'))}</button>${it.items?.length ? walk(it.items, depth + 1) : ''}`
      }).join('')
      host.innerHTML = `<div class="pr-panel"><div class="pr-outline">${walk(outline, 0)}</div></div>`
      host.querySelector('.pr-outline')!.addEventListener('click', (e) => {
        const i = (e.target as HTMLElement).closest<HTMLElement>('[data-i]')?.dataset.i
        if (i != null && dests[Number(i)] != null) void r.linkService.goToDestination(dests[Number(i)])
      })
    }).catch(() => { if (shown === pdf) host.innerHTML = empty(t('outline.empty')) })
  }
  return follow(draw)
}

export function mountChat(host: HTMLElement): () => void {
  let folder: string | null | undefined
  let handle: HostChatMount | null = null
  let lastQuote: string | null = null
  const drop = (): void => {
    if (handle && chat.owner === handle) { chat.owner = null; chat.quote = null; chat.folder = null }
    handle?.dispose()
    handle = null
  }
  const open = (r: Reader, withFolder: boolean): void => {
    host.innerHTML = '<div class="pr-chat"></div>'
    const dir = r.folder
    const h = ctx.tangu!.mountChat!(host.firstElementChild as HTMLElement, { folder: (withFolder && dir) || undefined, title: t('chat.title', { name: dir ? baseOf(dir) : baseOf(r.pdfPath) }) })
    handle = h
    chat.owner = h
    chat.folder = dir
    chat.quote = (text) => { lastQuote = text; h.quote(text) }
    if (!withFolder && lastQuote) h.quote(lastQuote) // 退路重挂:刚才递给上一份的引文补给这一份
    // 给了工作目录、却在这台设备上落不了地(引擎不在本机跑,比如网页版):退成不带工作目录的对话。
    // 引文照常递得过去,只是 Agent 自己读不到这份文件。等 ready 之后再问 hostPath:应用刚启动时它会先答 null。
    if (withFolder && dir) void h.ready.then((res) => { if (!res.ok && handle === h && ctx.app.hostPath && ctx.app.hostPath(dir) == null) { drop(); open(r, false) } })
  }
  const draw = (r: Reader | null): void => {
    const next = r ? r.folder : null
    if (next === folder) return
    folder = next
    lastQuote = null
    drop()
    if (!r || !ctx.tangu?.mountChat) { host.innerHTML = empty(t(r ? 'chat.unavailable' : 'chat.noPdf')); return }
    // 对话按文件夹一条(宿主的规则):工作目录就是这份 PDF 所在的文件夹,Agent 用相对路径就能读到它。
    // ponytail: 放在库根的 PDF 没有文件夹可给,对话不带工作目录(引文照常递得过去,Agent 自己读不到文件)。
    open(r, true)
  }
  const off = follow(draw)
  return () => { off(); drop(); host.replaceChildren() }
}
