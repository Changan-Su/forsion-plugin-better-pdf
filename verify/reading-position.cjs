// Real Better PDF in Electron. Run under the Forsion devlock with a built GENESIS_DESKTOP.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const desktop = process.env.GENESIS_DESKTOP
if (!desktop) throw new Error('Set GENESIS_DESKTOP to a built desktop checkout')
const plugin = path.resolve(process.env.PLUGIN_SRC || path.join(__dirname, '..'))
const { launch, boot, enterSpace } = require(path.join(desktop, 'scripts/lib/uiux-electron.cjs'))
const { tinyPdf } = require(path.join(desktop, 'scripts/lib/tiny-pdf.cjs'))

async function main() {
  const env = await launch({ tag: 'better-pdf-reading-position', overrideHome: true, beforeLaunch: ({ home, vault }) => {
    const dest = path.join(home, 'plugins', 'pdf-reader')
    fs.mkdirSync(dest, { recursive: true })
    for (const file of ['main.js', 'manifest.json']) fs.copyFileSync(path.join(plugin, file), path.join(dest, file))
    const pdf = tinyPdf(Array.from({ length: 8 }, (_, i) => `Reading page ${i + 1}`))
    for (const file of ['Reading.pdf', 'Linked.pdf']) fs.writeFileSync(path.join(vault, file), pdf)
    fs.writeFileSync(path.join(vault, 'Links.md'), '# Links\n\n[[Linked.pdf#page=3|Jump to page three]]\n')
  } })
  const { app, win } = env
  const visible = selector => win.locator(selector).filter({ visible: true }).first()
  const root = visible('.pr-root')
  const pageInput = visible('.pr-pageinput')
  const readState = () => root.evaluate(el => ({
    page: Number(el.querySelector('.pr-pageinput').value),
    scale: el.querySelector('.pr-zoomsel').value,
    top: el.querySelector('.pr-container').scrollTop,
    left: el.querySelector('.pr-container').scrollLeft,
  }))
  const openRow = name => win.locator('.t2s-srow').filter({
    has: win.locator('.t2s-srow-title').filter({ hasText: name }), visible: true,
  }).first().click({ timeout: 10000 })
  const ready = () => visible('.pr-root .textLayer span').waitFor({ timeout: 15000 })
  const position = async page => {
    // Note links can open a split narrow enough to hide the zoom selector.
    await root.locator('.pr-zoomsel').evaluate(select => {
      select.value = '1.5'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await pageInput.fill(String(page))
    await pageInput.press('Enter')
    await visible(`.pr-root .page[data-page-number="${page}"] .textLayer span`).waitFor({ timeout: 15000 })
    await visible('.pr-container').evaluate(async el => {
      el.scrollTop += 220
      el.scrollLeft += 60
      // Let the real scroll event and PDF.js update run, then leave within the storage debounce.
      for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame)
    })
    const state = await readState()
    assert.equal(state.page, page)
    assert.equal(state.scale, '1.5')
    assert.ok(state.top > 1000 && state.left > 40, JSON.stringify(state))
    return state
  }
  const roundTrip = async (label, before) => {
    await root.evaluate(el => { window.previousPdfReader = el })
    assert.equal(await enterSpace(win, 'tangu', { real: true }), true)
    await win.waitForFunction(() => !window.previousPdfReader.isConnected)
    assert.equal(await enterSpace(win, 'amadeus', { real: true }), true)
    await ready()
    await win.waitForTimeout(400)
    const after = await readState()
    console.log(`${label}: ${JSON.stringify({ before, after })}`)
    assert.equal(after.page, before.page)
    assert.equal(after.scale, before.scale)
    // PDF.js reports page-space coordinates rounded to whole PDF points.
    assert.ok(Math.abs(after.top - before.top) <= 2 && Math.abs(after.left - before.left) <= 2)
  }

  try {
    await boot(app, win, { space: 'amadeus', width: 1440, height: 900 })
    await openRow(/^Reading\.pdf$/)
    await ready()
    await roundTrip('File tree → Tangu → Notes', await position(4))

    await openRow(/^Links$/)
    await win.locator('.wikilink').filter({ hasText: 'Jump to page three', visible: true }).click()
    await ready()
    await win.waitForFunction(() => [...document.querySelectorAll('.pr-pageinput')]
      .some(input => input.offsetWidth > 0 && input.value === '3'))
    await roundTrip('Page link → Tangu → Notes', await position(5))
  } finally { await env.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
