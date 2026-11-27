const fs = require('node:fs')
const path = require('node:path')
const { PDFDocument, PDFName, PDFNumber, StandardFonts } = require('pdf-lib')

const firstLine = 'First narrow line'
const secondLine = 'Second line has a different length'
const scaledLine = 'Text on a page with a custom unit'
const pageHeight = 792
const fontSize = 18
const firstBaseline = 600
const secondBaseline = 582

exports.makePdf = async (file) => {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([612, pageHeight])
  page.drawText(firstLine, { font, size: fontSize, x: 65, y: firstBaseline })
  page.drawText(secondLine, { font, size: fontSize, x: 65, y: secondBaseline })
  const scaled = pdf.addPage([400, 510])
  scaled.setCropBox(13, 19, 351.7, 460.3)
  scaled.node.set(PDFName.of('UserUnit'), PDFNumber.of(2))
  scaled.drawText(scaledLine, { font, size: 14, x: 65, y: 370 })
  fs.writeFileSync(file, await pdf.save())
}

const selector = (page) => `.pr-root .page[data-page-number="${page}"]`
const box = (span) => span.evaluate((el) => {
  const range = document.createRange()
  range.selectNodeContents(el)
  const { left, top, right, bottom } = range.getBoundingClientRect()
  return { left, top, right, bottom }
})
const boxes = (marks) => marks.evaluateAll((nodes) => nodes.map((el) => {
  const { left, top, right, bottom } = el.getBoundingClientRect()
  return { left, top, right, bottom }
}))
const aligned = (actual, expected) => actual.length === expected.length && actual.every((mark, i) =>
  ['left', 'top', 'right', 'bottom'].every((edge) => Math.abs(mark[edge] - expected[i][edge]) < 2))

exports.verify = async ({ win, check, until, SHOTS, readSidecar }) => {
  const marks = (page) => win.locator(`${selector(page)} .pr-marks:not(.pr-ghosts) > .pr-ul`)
  const text = (page, value) => win.locator(`${selector(page)} .textLayer`).getByText(value, { exact: true })
  const closePalette = () => win.keyboard.press('Escape')

  const underline = async (page, values) => {
    const spans = values.map((value) => text(page, value))
    await spans[0].waitFor()
    await spans[0].evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await win.locator('.pr-toolbar [data-v="underline"]').click()
    const expected = await Promise.all(spans.map(box))
    const start = expected[0], end = expected.at(-1)
    await win.mouse.move(start.left + 0.5, (start.top + start.bottom) / 2)
    await win.mouse.down()
    await win.mouse.move(end.right - 0.5, (end.top + end.bottom) / 2, { steps: 12 })
    const ghost = win.locator(`${selector(page)} .pr-ghosts .pr-ul`)
    await ghost.first().waitFor({ state: 'attached' })
    const preview = await boxes(ghost)
    await win.mouse.up()
    await marks(page).first().waitFor({ state: 'attached' })
    const actual = await boxes(marks(page))
    check(`Page ${page}: underline preview and committed marks align with the selected text`,
      aligned(preview, expected) && aligned(actual, expected), JSON.stringify({ expected, preview, actual }))
    await closePalette()
    await win.locator(`${selector(page)}`).screenshot({ path: path.join(SHOTS, `mark-alignment-${page}.png`) })
  }

  await underline(1, [firstLine, secondLine])
  const fixture = await PDFDocument.create()
  const font = await fixture.embedFont(StandardFonts.Helvetica)
  const nextInkTop = secondBaseline + font.heightAtSize(fontSize, { descender: false })
  const stroke = await marks(1).first().evaluate((mark, { pageHeight, firstBaseline, nextInkTop }) => {
    const page = mark.closest('.page').getBoundingClientRect()
    const { top, height } = mark.getBoundingClientRect()
    const style = getComputedStyle(mark)
    const thickness = parseFloat(style.backgroundSize.split(' ')[1]) * height / parseFloat(style.height)
    const offset = parseFloat(style.backgroundPositionY) / 100
    const strokeTop = top + (height - thickness) * offset
    return {
      top: strokeTop,
      bottom: strokeTop + thickness,
      baseline: page.top + page.height * (1 - firstBaseline / pageHeight),
      nextInkTop: page.top + page.height * (1 - nextInkTop / pageHeight),
    }
  }, { pageHeight, firstBaseline, nextInkTop })
  check('The first underline is drawn in the space between the two rows',
    stroke.top >= stroke.baseline - 1 && stroke.bottom < stroke.nextInkTop, JSON.stringify(stroke))
  const pageInput = win.locator('.pr-pageinput')
  await pageInput.fill('2')
  await pageInput.press('Enter')
  await underline(2, [scaledLine])
  const saved = await until(() => readSidecar()?.annots.length === 2 && readSidecar())
  check('Saved markup preserves the page and separate rows',
    saved?.annots[0].page === 0 && saved.annots[0].quads.length === 2 && saved.annots[1].page === 1,
    JSON.stringify(saved?.annots.map((a) => [a.page, a.quads.length])))

  const zoom = win.locator('.pr-zoomsel')
  await zoom.selectOption('1')
  const span = text(2, scaledLine)
  await span.waitFor()
  await span.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  const expected = [await box(span)]
  const actual = await boxes(marks(2))
  check('Custom page unit remains aligned after changing PDF zoom',
    aligned(actual, expected), JSON.stringify({ expected, actual }))
}
