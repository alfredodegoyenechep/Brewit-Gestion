'use strict';
const { jsPDF } = require('jspdf');
const PptxGenJS = require('pptxgenjs');
const { lines } = require('./board-deck');
async function exportFiles(report) {
  const { deck } = report;
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: [1280, 720], compress: true });
  pdf.setProperties({ title: `Brewit · Directorio ${report.month}`, subject: `Cierre ${report.id}`, author: 'Brewit', creator: report.version });
  const pptx = new PptxGenJS(); pptx.defineLayout({ name: 'BREWIT', width: 13.333333, height: 7.5 }); pptx.layout = 'BREWIT'; pptx.author = 'Brewit'; pptx.subject = `Cierre ${report.month} · ${report.id}`; pptx.title = `Directorio ${report.month}`; pptx.lang = 'es-CL';
  for (const [index, page] of deck.pages.entries()) {
    if (index) pdf.addPage([1280, 720], 'landscape');
    const slide = pptx.addSlide(); slide.background = { color: 'FAF8F3' };
    for (const e of page.elements) {
      if (e.type === 'rect') {
        pdf.setFillColor(e.fill); pdf.rect(e.x, e.y, e.w, e.h, 'F');
        slide.addShape(pptx.ShapeType.rect, { x: e.x / 96, y: e.y / 96, w: e.w / 96, h: e.h / 96, line: { transparency: 100 }, fill: { color: e.fill.slice(1) }, radius: 0 });
      } else {
        const rendered = lines(e);
        pdf.setFont('helvetica', e.bold ? 'bold' : 'normal'); pdf.setFontSize(e.size); pdf.setTextColor(e.color);
        rendered.forEach((line, i) => pdf.text(line.replace(/→/g, '>').replace(/≥/g, '>='), e.x + (e.align === 'right' ? e.w : e.align === 'center' ? e.w / 2 : 0), e.y + e.size + i * e.size * 1.15, { align: e.align }));
        // Text and chart geometry remain native editable objects, never slide screenshots.
        slide.addText(rendered.join('\n'), { x: e.x / 96, y: e.y / 96, w: e.w / 96, h: e.h / 96, fontFace: 'Arial', fontSize: e.size * .75, bold: e.bold, color: e.color.slice(1), margin: 0, breakLine: false, valign: 'top', align: e.align, paraSpaceAfterPt: 0, lineSpacingMultiple: 1.15 });
      }
    }
    slide.addNotes(`${page.title}\n${page.subtitle}\n${page.notes.join('\n')}`);
  }
  return { pdf: Buffer.from(pdf.output('arraybuffer')), pptx: await pptx.write({ outputType: 'nodebuffer' }) };
}
module.exports = { exportFiles };
