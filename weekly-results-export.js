(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WeeklyResultsExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const states = { 'no-data': 'Sin datos', 'no-physical-count': 'Sin toma física',
    'no-opening-inventory': 'Sin inventario inicial', incomplete: 'Incompleto', pending: 'Pendiente',
    partial: 'Parcial', 'not-included': 'No incluido', 'not-applicable': '—' };
  const compactKeys = new Set(['grossSales', 'discounts', 'grossSalesAfterDiscounts', 'mercadoPagoTips', 'cashTips', 'centralWarehouseInbound', 'directSupplierInbound', 'cogs', 'otherVariableCosts']);
  const borderlessKeys = new Set(['netSales', 'grossSales', 'discounts', 'tips', 'mercadoPagoTips', 'suppliesInbound', 'centralWarehouseInbound', 'variableCosts', 'cogs']);
  const defaults = { bg: '#f7f2ea', soft: '#fffdf8', text: '#33291e', muted: '#9d968a',
    border: '#e6ded5', positive: '#3f8c61', difference: '#d17045' };
  const date = iso => iso ? iso.split('-').reverse().join('-') : '—';
  const clp = amount => `$${amount.toLocaleString('es-CL', { maximumFractionDigits: 0 })}`;
  const percent = amount => `${amount.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  const reportTitle = data => data.options?.period === 'month' ? 'Resultados Mensuales' : 'Resultados Semanales';
  function periodLabel(data, index) {
    const monthly = data.options?.period === 'month', offset = index + (data.options?.includeCurrent === false ? 1 : 0);
    return offset === 0 ? (monthly ? 'Mes actual' : 'Semana actual')
      : `Hace ${offset} ${monthly ? (offset === 1 ? 'mes' : 'meses') : (offset === 1 ? 'semana' : 'semanas')}`;
  }
  function reportContext(data) {
    const monthly = data.options?.period === 'month', cutoff = data.weeks[0]?.period.through || data.date;
    return `Consulta: ${date(data.date)} · ${data.locations.filter(location => location.type !== 'warehouse').length} sucursales${data.locations.some(location => location.type === 'warehouse') ? ' + Bodega Principal' : ''} · ${data.weeks.length} ${monthly ? 'meses' : 'semanas'} · Inventario ${data.options?.includeInventory === false ? 'no incluido' : 'incluido'} · ${data.options?.includeCurrent === false ? (monthly ? 'Mes actual excluido' : 'Semana actual excluida') : (monthly ? 'Mes actual incluido' : 'Semana actual incluida')} · Datos hasta ${date(cutoff)}`;
  }

  function model(data, palette = {}, fontSize = 12) {
    const colors = { ...defaults, ...palette };
    let cellStart = 0;
    const columns = data.weeks.flatMap((week, weekIndex) => data.locations.map((location, storeIndex) => {
      const units = location.type === 'warehouse' ? 1 : 2, start = cellStart; cellStart += units;
      return { units, cellStart: start,
        weekIndex, weekStart: storeIndex === 0, location: location.name,
        week: `${periodLabel(data, weekIndex)} · ${date(week.period.from)} – ${date(week.period.to)}`,
        result: week.locations.find(result => result.locationId === location.id)
      };
    }));
    const rows = data.metrics.map(([key, label]) => {
      const compact = compactKeys.has(key), subtotal = ['netSales', 'inventoryConsumptionTotal'].includes(key);
      const cells = columns.flatMap(column => {
        const metric = column.result?.values[key], available = metric?.available && Number.isFinite(metric.amount);
        const inventory = column.result?.inventory;
        const note = available && key === 'finalInventory' && metric.date
          ? `${metric.basis === 'physical' ? 'Físico' : 'Inventario teórico'} · ${date(metric.date)}${metric.status === 'partial' ? ' · Parcial' : ''}`
          : key === 'centralWarehouseInbound' && column.units === 1 ? `Reversas / devoluciones${available && metric.status === 'partial' ? ' · Parcial' : ''}`
          : available && key === 'inventoryShortage' && inventory?.initialDate && inventory?.finalDate
          ? `${date(inventory.initialDate)} → ${date(inventory.finalDate)}`
          : available && metric.status === 'partial' && key !== 'inventoryShortage' ? 'Parcial' : '';
        const color = compact || !available ? colors.muted
          : key === 'collectionDifference' ? metric.amount === 0 ? colors.positive : colors.difference : colors.text;
        const hasPercent = metric?.showPercent !== false, knownPercent = hasPercent && metric?.percent != null && available;
        return [{ value: available ? metric.amount : states[metric?.status] || 'Sin datos',
          text: available ? clp(metric.amount) : states[metric?.status] || 'Sin datos', note, color, numeric: available, format: 'currency',
          fontSize: compact ? fontSize - 3 : available ? fontSize : Math.min(fontSize, 9.75) },
        { value: knownPercent ? metric.percent / 100 : hasPercent ? '—' : '',
          text: knownPercent ? percent(metric.percent) : hasPercent ? '—' : '', color: colors.muted,
          note: knownPercent && metric.percentPartial && key !== 'inventoryShortage' ? 'Parcial' : '', numeric: knownPercent, format: 'percent',
          fontSize: compact ? fontSize - 3 : fontSize }].slice(0, column.units);
      });
      return { key, label, compact, subtotal, separator: !borderlessKeys.has(key), cells };
    });
    return { title: reportTitle(data), date: data.date, colors, fontSize, columns, rows,
      context: reportContext(data),
      notes: ['Control de diferencias = Mercado Pago − MP Teorico. Descuentos incluye IVA.',
        'MP Teorico antes de Comision = MP Teorico + comisión MercadoPago.',
        `Inventario y consumibles: intervalo entre tomas físicas. Merma, marketing y consumo personal: ${data.options?.period === 'month' ? 'mes' : 'semana'} calendario.`],
      warnings: data.warnings || [] };
  }

  function pdf(report, JsPDF) {
    const doc = new JsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4', compress: true });
    doc.setProperties({ title: report.title, subject: report.context, author: 'Brewit' });
    const width = doc.internal.pageSize.getWidth(), height = doc.internal.pageSize.getHeight();
    const margin = 20, conceptWidth = 220, top = 58, bottom = height - 42;
    const branches = report.columns.filter(column => column.weekIndex === 0).length || 1;
    const capacity = branches <= 4 ? Math.floor(4 / branches) * branches : 4;
    const baseFont = Math.min(9, report.fontSize), compactFont = baseFont * (report.fontSize - 3) / report.fontSize;
    const text = content => String(content).replaceAll('→', ' a ');
    const font = (size, bold = false, color = report.colors.text) => {
      doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); doc.setTextColor(color);
    };
    const lines = (content, maxWidth, size, bold = false) => {
      font(size, bold); return doc.splitTextToSize(text(content), maxWidth);
    };
    const box = (x, y, w, h, fill) => { doc.setFillColor(fill); doc.rect(x, y, w, h, 'F'); };
    const rule = (x1, y1, x2, y2, heavy = false) => {
      doc.setDrawColor(report.colors.border); doc.setLineWidth(heavy ? 1 : .4); doc.line(x1, y1, x2, y2);
    };
    const plans = [];
    for (let offset = 0; offset < report.columns.length;) {
      const count = branches > capacity ? Math.min(capacity, branches - offset % branches) : capacity;
      const columns = report.columns.slice(offset, offset + count);
      const weights = columns.map(column => column.units === 1 ? .68 : 1);
      const unitWidth = (width - margin * 2 - conceptWidth) / weights.reduce((sum, weight) => sum + weight, 0);
      const positions = [0];
      const columnWidths = weights.map(weight => weight * unitWidth);
      columnWidths.forEach(w => positions.push(positions.at(-1) + w));
      const cellLayout = columns.flatMap((column, index) => column.units === 1
        ? [{ x: positions[index], width: columnWidths[index] }]
        : [{ x: positions[index], width: columnWidths[index] * .68 },
          { x: positions[index] + columnWidths[index] * .68, width: columnWidths[index] * .32 }]);
      const sliceCells = row => row.cells.slice(columns[0].cellStart, columns.at(-1).cellStart + columns.at(-1).units);
      let weekHeaderHeight = 26;
      for (let start = 0; start < columns.length;) {
        let end = start + 1;
        while (end < columns.length && columns[end].weekIndex === columns[start].weekIndex) end++;
        weekHeaderHeight = Math.max(weekHeaderHeight, lines(columns[start].week, positions[end] - positions[start] - 10, 8, true).length * 9 + 8);
        start = end;
      }
      const nameHeaderHeight = Math.max(19, ...columns.map((column, index) => lines(column.location, columnWidths[index] - 12, 9, true).length * 10.5 + 5));
      const headerHeight = weekHeaderHeight + nameHeaderHeight + 17;
      let heights = report.rows.map(row => {
        const size = row.compact ? compactFont : baseFont, padding = row.compact ? 2 : 3.5;
        let contentHeight = lines(row.label, conceptWidth - (row.compact ? 22 : 14), size, !row.compact).length * size * 1.15;
        sliceCells(row).forEach((cell, index) => {
          const cellWidth = cellLayout[index].width;
          const cellSize = cell.fontSize / report.fontSize * baseFont;
          const mainHeight = lines(cell.text, cellWidth - 12, cellSize, row.subtotal).length * cellSize * 1.15;
          const noteHeight = cell.note ? lines(cell.note, cellWidth - 12, 6.5).length * 7.5 + 2 : 0;
          contentHeight = Math.max(contentHeight, mainHeight + noteHeight);
        });
        return contentHeight + padding * 2;
      });
      const fittingScale = (bottom - top - headerHeight) / heights.reduce((sum, h) => sum + h, 0);
      // Fit modest overflow as a single complete table; retain vertical pages
      // for larger overflow instead of making the body unreadably small.
      const scale = fittingScale >= .85 ? Math.min(1, fittingScale) : 1;
      heights = heights.map(h => h * scale);
      const blocks = [];
      for (let index = 0; index < report.rows.length; index++) {
        const block = [index];
        if (['netSales', 'tips', 'suppliesInbound', 'variableCosts'].includes(report.rows[index].key)) {
          while (report.rows[index + 1]?.compact) block.push(++index);
        }
        blocks.push(block);
      }
      let pageRows = [], used = 0;
      for (const block of blocks) {
        const blockHeight = block.reduce((sum, index) => sum + heights[index], 0);
        if (pageRows.length && used + blockHeight > bottom - top - headerHeight + .01) {
          plans.push({ offset, columns, positions, columnWidths, cellLayout, sliceCells, heights, pageRows, scale, headerHeight, weekHeaderHeight, nameHeaderHeight }); pageRows = []; used = 0;
        }
        pageRows.push(...block); used += blockHeight;
      }
      if (pageRows.length) plans.push({ offset, columns, positions, columnWidths, cellLayout, sliceCells, heights, pageRows, scale, headerHeight, weekHeaderHeight, nameHeaderHeight });
      offset += columns.length;
    }
    plans.forEach((plan, pageIndex) => {
      if (pageIndex) doc.addPage('a4', 'landscape');
      const { offset, columns, positions, columnWidths, cellLayout, sliceCells, heights, pageRows, scale, headerHeight, weekHeaderHeight, nameHeaderHeight } = plan;
      box(0, 0, width, height, report.colors.bg);
      font(16, true); doc.text(report.title, margin, 31);
      font(8, false, report.colors.muted); doc.text(report.context, margin, 46);
      box(margin, top, width - margin * 2, headerHeight, report.colors.soft);
      font(baseFont, true); doc.text('Concepto', margin + 7, top + 36);
      let start = 0;
      while (start < columns.length) {
        let end = start + 1;
        while (end < columns.length && columns[end].weekIndex === columns[start].weekIndex) end++;
        const x = margin + conceptWidth + positions[start], w = positions[end] - positions[start];
        const title = lines(columns[start].week, w - 10, 8, true);
        font(8, true); doc.text(title, x + w / 2, top + 11, { align: 'center', lineHeightFactor: 1.15 });
        rule(x, top + weekHeaderHeight, x + w, top + weekHeaderHeight); start = end;
      }
      columns.forEach((column, index) => {
        const x = margin + conceptWidth + positions[index], pairWidth = columnWidths[index];
        const amountWidth = column.units === 1 ? pairWidth : pairWidth * .68;
        const name = lines(column.location, pairWidth - 12, 9, true);
        font(9, true); doc.text(name, x + pairWidth / 2, top + weekHeaderHeight + 11, { align: 'center' });
        font(8, true); doc.text('Importe', x + amountWidth / 2, top + headerHeight - 6, { align: 'center' });
        if (column.units === 2) doc.text('%', x + amountWidth + (pairWidth - amountWidth) / 2, top + headerHeight - 6, { align: 'center' });
        rule(x, top + weekHeaderHeight + nameHeaderHeight, x + pairWidth, top + weekHeaderHeight + nameHeaderHeight);
      });
      rule(margin, top + headerHeight, width - margin, top + headerHeight);
      let y = top + headerHeight;
      for (const rowIndex of pageRows) {
        const row = report.rows[rowIndex], h = heights[rowIndex], size = (row.compact ? compactFont : baseFont) * scale;
        if (row.subtotal) box(margin, y, width - margin * 2, h, report.colors.soft);
        const padding = (row.compact ? 2 : 3.5) * scale, indent = row.compact ? 15 : 7;
        const label = lines(row.label, conceptWidth - indent - 7, size, !row.compact);
        font(size, !row.compact); doc.text(label, margin + indent, y + padding + size, { lineHeightFactor: 1.15 });
        sliceCells(row).forEach((cell, index) => {
          const x = margin + conceptWidth + cellLayout[index].x;
          const cellWidth = cellLayout[index].width;
          const cellSize = cell.fontSize / report.fontSize * baseFont * scale;
          const content = lines(cell.text, cellWidth - 12, cellSize, row.subtotal);
          font(cellSize, row.subtotal, cell.color); doc.text(content, x + cellWidth - 6, y + padding + cellSize, { align: 'right', lineHeightFactor: 1.15 });
          if (cell.note) {
            const note = lines(cell.note, cellWidth - 12, 6.5 * scale);
            font(6.5 * scale, false, report.colors.muted);
            doc.text(note, x + cellWidth - 6, y + padding + content.length * cellSize * 1.15 + 8 * scale, { align: 'right', lineHeightFactor: 1.15 });
          }
        });
        if (row.separator) rule(margin, y + h, width - margin, y + h);
        y += h;
      }
      rule(margin, top, margin, y); rule(width - margin, top, width - margin, y);
      columns.forEach((column, index) => {
        if (!index || column.weekStart) rule(margin + conceptWidth + positions[index], top, margin + conceptWidth + positions[index], y, true);
      });
      font(7, false, report.colors.muted);
      report.notes.forEach((note, index) => doc.text(note, margin, height - 30 + index * 10));
      doc.text(`Página ${pageIndex + 1} de ${plans.length}`, width - margin, height - 8, { align: 'right' });
    });
    return doc;
  }

  function workbook(report, XLSX) {
    const sheet = {}, styles = {}, merges = [], heights = [];
    const lastColumn = report.columns.reduce((sum, column) => sum + column.units, 0);
    const cellColumns = report.columns.flatMap(column => Array.from({ length: column.units }, (_, unit) => ({ column, unit })));
    const put = (r, c, value, style, format) => {
      const address = XLSX.utils.encode_cell({ r, c });
      sheet[address] = { t: typeof value === 'number' ? 'n' : 's', v: value,
        ...(format ? { z: format === 'currency' ? '"$"#,##0;"$"-#,##0;"$"0' : '0.0%;-0.0%;0.0%' } : {}) };
      styles[address] = { ...style };
    };
    const base = { size: report.fontSize, color: report.colors.text, fill: report.colors.bg, bold: false, align: 'right' };
    const fillRow = (r, style) => { for (let c = 0; c <= lastColumn; c++) put(r, c, '', style); };
    const heading = { ...base, fill: report.colors.soft, bold: true, align: 'center', bottom: true };
    fillRow(0, { ...base, bold: true, align: 'left', size: 18 });
    put(0, 0, report.title, styles.A1); heights[0] = { hpt: 28 };
    fillRow(1, { ...base, align: 'left', color: report.colors.muted, size: 10 });
    put(1, 0, report.context, styles.A2); heights[1] = { hpt: 23 };
    merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: lastColumn } }, { s: { r: 1, c: 0 }, e: { r: 1, c: lastColumn } });
    for (let r = 2; r <= 4; r++) { fillRow(r, heading); heights[r] = { hpt: r === 2 ? 30 : 22 }; }
    put(2, 0, 'Concepto', { ...heading, align: 'left', right: true });
    merges.push({ s: { r: 2, c: 0 }, e: { r: 4, c: 0 } });
    let start = 0;
    while (start < report.columns.length) {
      let end = start + 1;
      while (end < report.columns.length && report.columns[end].weekIndex === report.columns[start].weekIndex) end++;
      put(2, report.columns[start].cellStart + 1, report.columns[start].week, { ...heading, left: true });
      merges.push({ s: { r: 2, c: report.columns[start].cellStart + 1 }, e: { r: 2, c: report.columns[end - 1].cellStart + report.columns[end - 1].units } }); start = end;
    }
    report.columns.forEach(column => {
      const c = column.cellStart + 1;
      put(3, c, column.location, { ...heading, left: column.weekStart });
      if (column.units === 2) merges.push({ s: { r: 3, c }, e: { r: 3, c: c + 1 } });
      put(4, c, 'Importe', { ...heading, left: column.weekStart }); if (column.units === 2) put(4, c + 1, '%', heading);
    });
    let r = 5;
    for (const row of report.rows) {
      const annotated = row.cells.some(cell => cell.note), size = row.compact ? report.fontSize - 3 : report.fontSize;
      const rowStyle = { ...base, size, fill: row.subtotal ? report.colors.soft : report.colors.bg, bottom: row.separator && !annotated };
      put(r, 0, row.label, { ...rowStyle, align: 'left', bold: !row.compact, indent: row.compact ? 1 : 0, right: true });
      const labelLines = Math.ceil(row.label.length / ((row.compact ? 34 : 38) * 11 / size));
      const cellHeight = Math.max(...row.cells.map((cell, index) => Math.ceil(cell.text.length / ((cellColumns[index].unit ? 10 : 18) * 11 / cell.fontSize)) * cell.fontSize * 1.15));
      heights[r] = { hpt: Math.max(row.compact ? 14 : 23, Math.max(labelLines * size * 1.15, cellHeight) + (row.compact ? 4 : 6)) };
      row.cells.forEach((cell, index) => put(r, index + 1, cell.value, { ...rowStyle, size: cell.fontSize, color: cell.color, bold: row.subtotal,
        left: cellColumns[index].unit === 0 && cellColumns[index].column.weekStart }, cell.numeric ? cell.format : null));
      if (annotated) {
        const noteStyle = { ...base, fill: rowStyle.fill, color: report.colors.muted, size: 7.5, bottom: row.separator };
        fillRow(r + 1, noteStyle); styles[XLSX.utils.encode_cell({ r: r + 1, c: 0 })].right = true;
        // Preserve the label as a single cell alongside its supplemental line.
        merges.push({ s: { r, c: 0 }, e: { r: r + 1, c: 0 } });
        styles[XLSX.utils.encode_cell({ r, c: 0 })].bottom = row.separator;
        row.cells.forEach((cell, index) => put(r + 1, index + 1, cell.note, { ...noteStyle,
          left: cellColumns[index].unit === 0 && cellColumns[index].column.weekStart }));
        heights[r + 1] = { hpt: 13 }; r++;
      }
      r++;
    }
    for (const note of [...report.notes, ...report.warnings]) {
      const style = { ...base, size: 9, color: report.colors.muted, align: 'left' };
      fillRow(r, style); put(r, 0, note, style);
      merges.push({ s: { r, c: 0 }, e: { r, c: lastColumn } }); heights[r] = { hpt: 24 }; r++;
    }
    sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: r - 1, c: lastColumn } });
    sheet['!merges'] = merges; sheet['!rows'] = heights;
    sheet['!cols'] = [{ wch: 38 }, ...report.columns.flatMap(column => column.units === 1 ? [{ wch: 18 }] : [{ wch: 18 }, { wch: 10 }])];
    sheet['!margins'] = { left: .25, right: .25, top: .35, bottom: .35, header: .15, footer: .15 };
    sheet['!weeklyStyles'] = styles;
    sheet['!weeklyPalette'] = report.colors;
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, report.title);
    book.Props = { Title: report.title, Subject: report.context, Author: 'Brewit' };
    book.Workbook = { Names: [{ Name: '_xlnm.Print_Titles', Sheet: 0,
      Ref: `'${report.title}'!$A:$A,'${report.title}'!$1:$5` }] };
    return book;
  }

  // SheetJS CE preserves numbers and merges, but needs explicit OOXML styles.
  function styledWorkbookBytes(book, XLSX, Parser = DOMParser, Serializer = XMLSerializer) {
    const bytes = new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx', cellStyles: true }));
    const zip = XLSX.CFB.read(bytes, { type: 'array' });
    const decoder = new TextDecoder(), encoder = new TextEncoder();
    const parse = name => {
      const entry = XLSX.CFB.find(zip, '/' + name);
      if (!entry) throw Error(`Falta ${name} en el archivo XLSX.`);
      const document = new Parser().parseFromString(decoder.decode(new Uint8Array(entry.content)), 'application/xml');
      if (document.querySelector('parsererror')) throw Error('No se pudo preparar el formato XLSX.');
      return document;
    };
    const save = (name, document) => XLSX.CFB.utils.cfb_add(zip, '/' + name, encoder.encode(new Serializer().serializeToString(document)));
    const document = parse('xl/styles.xml'), ns = document.documentElement.namespaceURI;
    const element = (doc, name, attributes = {}) => {
      const node = doc.createElementNS(ns, name);
      Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value))); return node;
    };
    const append = (parent, node) => { const id = parent.children.length; parent.appendChild(node); parent.setAttribute('count', parent.children.length); return id; };
    const table = name => document.getElementsByTagNameNS(ns, name)[0];
    const argb = color => 'FF' + color.replace('#', '').toUpperCase();
    const formats = new Map();
    const sheetDocument = parse('xl/worksheets/sheet1.xml');
    for (const cell of sheetDocument.getElementsByTagNameNS(ns, 'c')) {
      const style = book.Sheets[book.SheetNames[0]]['!weeklyStyles'][cell.getAttribute('r')];
      if (!style) continue;
      const original = Number(cell.getAttribute('s') || 0), key = `${original}:${JSON.stringify(style)}`;
      if (!formats.has(key)) {
        const font = element(document, 'font');
        if (style.bold) font.appendChild(element(document, 'b'));
        font.appendChild(element(document, 'sz', { val: style.size }));
        font.appendChild(element(document, 'color', { rgb: argb(style.color) })); font.appendChild(element(document, 'name', { val: 'Arial' }));
        const fontId = append(table('fonts'), font);
        const fill = element(document, 'fill'), pattern = element(document, 'patternFill', { patternType: 'solid' });
        pattern.appendChild(element(document, 'fgColor', { rgb: argb(style.fill) })); pattern.appendChild(element(document, 'bgColor', { indexed: 64 }));
        fill.appendChild(pattern); const fillId = append(table('fills'), fill);
        const border = element(document, 'border');
        for (const side of ['left', 'right', 'top', 'bottom', 'diagonal']) {
          const edge = element(document, side, style[side] ? { style: side === 'bottom' ? 'thin' : 'medium' } : {});
          if (style[side]) edge.appendChild(element(document, 'color', { rgb: argb(reportColor(book, 'border')) }));
          border.appendChild(edge);
        }
        const borderId = append(table('borders'), border), xf = table('cellXfs').children[original].cloneNode(true);
        Object.entries({ fontId, fillId, borderId, applyFont: 1, applyFill: 1, applyBorder: 1, applyAlignment: 1 }).forEach(([key, val]) => xf.setAttribute(key, val));
        for (const child of [...xf.getElementsByTagNameNS(ns, 'alignment')]) child.remove();
        xf.appendChild(element(document, 'alignment', { horizontal: style.align, vertical: 'center', wrapText: 1, ...(style.indent ? { indent: style.indent } : {}) }));
        formats.set(key, append(table('cellXfs'), xf));
      }
      cell.setAttribute('s', formats.get(key));
    }
    const view = sheetDocument.getElementsByTagNameNS(ns, 'sheetView')[0];
    view.setAttribute('showGridLines', '0'); view.setAttribute('zoomScale', '80');
    view.replaceChildren(element(sheetDocument, 'pane', { xSplit: 1, ySplit: 5, topLeftCell: 'B6', activePane: 'bottomRight', state: 'frozen' }),
      element(sheetDocument, 'selection', { pane: 'bottomRight', activeCell: 'B6', sqref: 'B6' }));
    let properties = sheetDocument.getElementsByTagNameNS(ns, 'sheetPr')[0];
    if (!properties) { properties = element(sheetDocument, 'sheetPr'); sheetDocument.documentElement.insertBefore(properties, sheetDocument.documentElement.firstChild); }
    const setupProperties = properties.getElementsByTagNameNS(ns, 'pageSetUpPr')[0] || element(sheetDocument, 'pageSetUpPr');
    setupProperties.setAttribute('fitToPage', '0'); properties.appendChild(setupProperties);
    const pageSetup = sheetDocument.getElementsByTagNameNS(ns, 'pageSetup')[0] || element(sheetDocument, 'pageSetup');
    Object.entries({ paperSize: 9, orientation: 'landscape', scale: 80, fitToWidth: 0, fitToHeight: 0 })
      .forEach(([key, val]) => pageSetup.setAttribute(key, String(val)));
    // CT_Worksheet requires pageSetup after pageMargins and before ignoredErrors
    // and the remaining trailing elements. Appending it makes Excel repair the file.
    const following = new Set(['headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches',
      'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture',
      'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst']);
    const root = sheetDocument.documentElement;
    root.insertBefore(pageSetup, [...root.children].find(child => following.has(child.localName)) || null);
    save('xl/worksheets/sheet1.xml', sheetDocument); save('xl/styles.xml', document);
    return XLSX.CFB.write(zip, { type: 'array', fileType: 'zip', compression: true });
  }
  function reportColor(book, key) { return book.Sheets[book.SheetNames[0]]['!weeklyPalette']?.[key] || defaults[key]; }
  return { model, pdf, workbook, styledWorkbookBytes, reportTitle, periodLabel, reportContext };
});
