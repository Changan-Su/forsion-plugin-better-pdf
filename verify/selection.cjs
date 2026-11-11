// Real PDF.js + native extension regression. Called by ONLY=selection smoke.cjs.
const path = require('path')
module.exports = async ({ app, win, check, until, SHOTS, dragSelect, S1, SELPOP }) => {
  // The user's system clipboard may change while this isolated fixture runs.
  await win.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', { value: async (text) => { window.__pdfCopied = text } }))
  const formula = async (w, cross = false) => {
    await w.evaluate(() => {
      const spans = [...document.querySelectorAll('.pr-root .textLayer span')]
      const first = spans.find((e) => e.firstChild?.nodeType === 3 && e.firstChild.textContent.includes('Formula start:'))
      if (!first) throw new Error('Formula fixture missing')
      const c = document.querySelector('.pr-container')
      c.scrollTop += first.getBoundingClientRect().top - c.getBoundingClientRect().top - 300
    })
    await w.waitForTimeout(400)
    if (cross) {
      await w.locator('.pr-root .page[data-page-number="2"] .textLayer span').first().waitFor({state:'attached'})
    }
    return w.evaluate((cross) => {
      const spans = [...document.querySelectorAll('.pr-root .page[data-page-number="1"] .textLayer span')]
      const first = spans.find((e) => e.firstChild?.nodeType === 3 && e.firstChild.textContent.includes('Formula start:'))
      const last = cross ? [...document.querySelectorAll('.pr-root .page[data-page-number="2"] .textLayer span')].find(e=>e.firstChild?.nodeType===3) : spans.filter(e=>e.firstChild?.nodeType===3).at(-1)
      const walker = (el) => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); return w.nextNode() }
      const a = walker(first), b = walker(last)
      document.querySelector('.pr-container').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 999, button: 0 }))
      const r = document.createRange(); r.setStart(a, 0); r.setEnd(b, b.length)
      const s = getSelection(); s.removeAllRanges(); s.addRange(r)
      document.querySelector('.pr-container').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 999, button: 0 }))
      const box = first.getBoundingClientRect()
      return { top: box.top, bottom: box.bottom, text: s.toString(), wrapperTop: r.getBoundingClientRect().top }
    }, cross)
  }
  await formula(win)
  await win.locator(SELPOP).waitFor({state:'visible'})
  await win.waitForTimeout(300)
  const paint = await win.evaluate(() => ({
    native: getComputedStyle(document.querySelector('.pr-container .textLayer span'), '::selection').backgroundColor,
    paths: document.querySelectorAll('.pr-selection path').length,
    bands: document.querySelector('.pr-selection path')?.getAttribute('d'),
    text: getSelection().toString(),
  }))
  check('Formula selection uses a single paint path, hides duplicate native paint and preserves text', paint.paths === 1 && paint.native === 'rgba(0, 0, 0, 0)' && paint.text.includes('factors give'), JSON.stringify(paint))
  await win.screenshot({path: path.join(SHOTS, 'selection-formula.png')})
  await win.locator(`${SELPOP} [data-act="copy"]`).click()
  const copied = await win.evaluate(() => window.__pdfCopied)
  check('Copy retains formula text', copied === paint.text.replace(/\s+/g, ' ').trim(), copied)
  await formula(win)
  await win.locator(SELPOP).waitFor({state:'visible'})
  await win.locator(`${SELPOP} [data-act="translate"]`).click()
  const card = win.locator('[data-testid="inline-ai-panel"]')
  check('Translation has fixture result', !!await until(()=>card.innerText().then(t=>t.includes('译文')),8000))
  await win.evaluate(() => {
    const node = document.querySelector('.amx-pluginfile-mount')
    window.__pdfHeld = { node, parent: node.parentNode, next: node.nextSibling }
    node.remove()
  })
  await win.waitForTimeout(300)
  check('Hidden owner hides its translation card', await card.evaluate(el=>!!el.closest('[data-anchor-hidden]')))
  await win.evaluate(() => { const {node,parent,next}=window.__pdfHeld; parent.insertBefore(node,next); delete window.__pdfHeld })
  check('Reattached owner restores the same translation card anchor', !!await until(()=>card.evaluate(el=>!el.closest('[data-anchor-hidden]')),4000))
  await card.locator('[data-act=discard]').click()
  await card.waitFor({state:'detached'})
  const range = await formula(win, true)
  await win.locator(SELPOP).waitFor({state:'visible'})
  await win.waitForTimeout(300)
  const menu = await win.locator(SELPOP).boundingBox()
  check('Cross-page menu stays next to the first selected line, not the top of the page', Math.min(Math.abs(menu.y + menu.height - range.top), Math.abs(menu.y - range.bottom)) < 45, JSON.stringify({menu, range}))
  await win.screenshot({path: path.join(SHOTS, 'selection-cross-page.png')})
  await win.locator(`${SELPOP} [data-act="underline"]`).click()
  const marks = await win.evaluate(() => [...document.querySelectorAll('.pr-ul')].map(e=>{const r=e.getBoundingClientRect();return {height:r.height,width:r.width}}))
  check('Cross-page annotation excludes page-sized wrapper quads', marks.length >= 2 && marks.every(r=>r.height < 100), JSON.stringify(marks))
  await win.evaluate(() => {document.querySelector('.pr-container').scrollTop=0})
  await win.waitForTimeout(300)
  await dragSelect(win, S1)
  await win.locator(SELPOP).waitFor({state:'visible'})
  const original = await win.locator('.pr-root').evaluate(el => {el.dataset.selectionTest='original'; return document.querySelector('.pr-container').scrollTop})
  await win.locator(`${SELPOP} [data-act="ask"]`).click()
  check('Ask opens native extension and includes the quote', !!await until(()=>win.locator('.wb-extend .pr-chat').innerText().then(t=>t.includes(S1)),10000))
  check('Original PDF stays mounted beside chat', await win.locator('.pr-root[data-selection-test="original"]').isVisible())
  await win.screenshot({path:path.join(SHOTS,'selection-ask-main.png')})
  await win.locator('.wb-extend-close').click()
  await win.locator('.wb-extend').waitFor({state:'detached'})
  check('Close returns to the same PDF and scroll', await win.locator('.pr-root[data-selection-test="original"]').isVisible() && Math.abs(await win.locator('.pr-container').evaluate(e=>e.scrollTop)-original)<2)
  const pending = app.waitForEvent('window')
  await win.evaluate(()=>window.tangu.openDetached([{type:'amadeus-plugin-file',params:{filePath:'文献/Reading Fixture.pdf'}}]))
  const detached = await pending
  await detached.waitForSelector('.pr-root .textLayer span',{timeout:30000})
  await detached.waitForTimeout(1000)
  await dragSelect(detached,S1)
  await detached.locator(SELPOP).waitFor({state:'visible'})
  await detached.locator(`${SELPOP} [data-act="ask"]`).click()
  check('Detached PDF: Ask opens extension with quote', !!await until(()=>detached.locator('.wb-extend .pr-chat').innerText().then(t=>t.includes(S1)),10000), await detached.locator('.wb-extend').innerText())
  check('Detached PDF remains visible', await detached.locator('.pr-root').isVisible())
  await detached.screenshot({path:path.join(SHOTS,'selection-ask-detached.png')})
  await detached.locator('.wb-extend-close').click()
  await detached.locator('.wb-extend').waitFor({state:'detached'})
  check('Detached extension closes back to PDF', await detached.locator('.pr-root').isVisible())
  await detached.close()
}
