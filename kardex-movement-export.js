(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KardexMovementExport = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const dateLabel = date => date.split('-').reverse().join('/');
  const hierarchy = item => item.hierarchyPath.join(' › ');

  function workbook(report, XLSX) {
    if (7 + report.dates.length * 2 > 16384) throw new Error('El período supera el límite de columnas de Excel. Selecciona un rango más corto.');
    const items = report.items.filter(item => item.initialInventory > 0 || item.finalInventory > 0 || item.physicalInventory > 0
      || item.hasIncoming || item.hasOutgoing);
    const headers = ['Jerarquía', 'Producto', 'Inventario inicial', 'Inventario final teórico', 'Inventario final físico', 'Total entradas', 'Total salidas',
      ...report.dates.map(date => `Entradas ${dateLabel(date)}`), ...report.dates.map(date => `Salidas ${dateLabel(date)}`)];
    const rows = [headers, ...items.map(item => [hierarchy(item), item.name, item.initialInventory, item.finalInventory, item.physicalInventory, item.incoming, item.outgoing,
      ...report.dates.map(date => item.days[date].incoming), ...report.dates.map(date => item.days[date].outgoing)])];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet['!cols'] = headers.map((_, index) => ({ wch: index === 0 ? 45 : index === 1 ? 45 : 22 }));
    sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ r: 0, c: 0 }, { r: rows.length - 1, c: headers.length - 1 }) };
    sheet['!brewitTextColumns'] = [0, 1];
    // XLSX stores canonical separators; Excel displays them using the user's
    // regional settings. Localized format codes do not mean the same thing.
    sheet['!brewitNumberFormat'] = '#,##0.00';
    sheet['!brewitInventoryStyle'] = { boldColumns: [0, 1], hasTotalRow: false, freezeColumns: 2 };
    sheet['!brewitColumnNumberFormats'] = Object.fromEntries(headers.slice(2).map((_, index) => [index + 2, { decimalPlaces: 2 }]));
    const context = XLSX.utils.aoa_to_sheet([
      ['Kardex · cantidades'], ['Ubicación', report.location],
      ['Movimientos desde', report.dateFrom], ['Movimientos hasta (incluido)', report.dateTo],
      ['Fecha saldo inicial', report.initialDate], ['Fecha saldo final', report.finalDate],
      ['Cantidades en la unidad de cada producto. Incluye productos con inventario inicial, final teórico o final físico mayor que cero, o con al menos una entrada o salida. Incluye consumibles que cumplan estas condiciones, sin aplicar los filtros de la tabla.'],
      ...report.notes.slice(1).map(note => [note]), [],
      ['Jerarquía', 'Producto', 'Código', 'Unidad', 'Ajustes por tomas', 'Compensaciones'],
      ...items.map(item => [hierarchy(item), item.name, item.code, item.unit, item.adjustments, item.compensation])
    ]);
    context['!cols'] = [45, 45, 18, 14, 24, 24].map(wch => ({ wch }));
    context['!brewitTextColumns'] = [0, 1, 2, 3];
    context['!brewitNumberFormat'] = '#,##0.00';
    context['!brewitColumnNumberFormats'] = { 4: { decimalPlaces: 2 }, 5: { decimalPlaces: 2 } };
    const book = XLSX.utils.book_new();
    book.Props = { Title: 'Kardex diario por producto', Subject: `${report.location} · ${report.dateFrom} – ${report.dateTo}` };
    XLSX.utils.book_append_sheet(book, sheet, 'Kardex diario');
    XLSX.utils.book_append_sheet(book, context, 'Contexto');
    return book;
  }

  function pdf(report, JsPDF, decimalSystem) {
    const items = report.items.filter(item => item.hasIncoming && item.hasOutgoing);
    if (!items.length) throw new Error('No hay productos con al menos una entrada y una salida en el período seleccionado.');
    const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const number = value => value == null ? 'No disponible' : value.toLocaleString(decimalSystem === 'dot' ? 'en-US' : 'es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true });
    const columns = [23, 48, 63, 28, 28], left = 10, bottom = 280;
    let y = 10, current;
    const text = (value, size = 9, bold = false) => {
      doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size);
      const lines = doc.splitTextToSize(String(value), 190);
      for (const line of lines) {
        if (y + 5 > bottom) { doc.addPage(); y = 10; }
        doc.text(line, left, y + 4); y += 5;
      }
    };
    const tableHeader = () => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
      doc.setFillColor(235, 235, 235); doc.rect(left, y, 190, 7, 'F');
      let x = left;
      ['Fecha', 'Movimiento', 'Documento / fuente', 'Entradas', 'Salidas'].forEach((label, index) => {
        doc.text(label, index > 2 ? x + columns[index] - 2 : x + 2, y + 4.5, { align: index > 2 ? 'right' : 'left' }); x += columns[index];
      });
      y += 7;
    };
    const productHeader = continued => {
      text('Kardex · movimientos por producto', 13, true);
      text(`${report.location} · ${dateLabel(report.dateFrom)} – ${dateLabel(report.dateTo)}`);
      text(hierarchy(current), 10, true);
      text(`${current.code} · ${current.name}${continued ? ' (continuación)' : ''}`, 11, true);
      text(`Unidad: ${current.unit} · Inventario inicial (${dateLabel(report.initialDate)}): ${number(current.initialInventory)}`);
      text(`Inventario final teórico: ${number(current.finalInventory)}`);
      y += 2; tableHeader();
    };
    const nextPage = () => { doc.addPage(); y = 10; productHeader(true); };
    const row = (values, bold = false) => {
      doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(8);
      const cells = values.map((value, index) => doc.splitTextToSize(String(value), columns[index] - 4));
      const lineCount = Math.max(...cells.map(lines => lines.length));
      for (let line = 0; line < lineCount; line++) {
        if (y + 5 > bottom) { nextPage(); doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(8); }
        let x = left;
        cells.forEach((lines, index) => {
          if (lines[line]) doc.text(lines[line], index > 2 ? x + columns[index] - 2 : x + 2, y + 3.5, { align: index > 2 ? 'right' : 'left' });
          x += columns[index];
        });
        y += 4.5;
      }
      doc.setDrawColor(210); doc.line(left, y + 1, 200, y + 1); y += 3;
    };
    items.forEach((item, index) => {
      current = item;
      if (index) { doc.addPage(); y = 10; }
      productHeader(false);
      for (const movement of item.entries) row([dateLabel(movement.date), movement.type, movement.document || '—',
        movement.effect > 0 ? number(movement.effect) : '', movement.effect < 0 ? number(-movement.effect) : '']);
      row(['', 'TOTAL', '', number(item.incoming), number(item.outgoing)], true);
      if (y + 20 > bottom) nextPage();
      text(`Ajustes por tomas: ${number(item.adjustments)} · Compensaciones: ${number(item.compensation)}.`);
      text('Las tomas y compensaciones se presentan separadas de las entradas y salidas. Solo documentos contabilizados; consumos según las fuentes del Kardex.', 8);
    });
    const pages = doc.getNumberOfPages();
    for (let page = 1; page <= pages; page++) {
      doc.setPage(page); doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
      doc.text(`Página ${page} de ${pages}`, 200, 290, { align: 'right' });
    }
    return doc;
  }
  return { workbook, pdf };
});
