# Brewit-Gestion

Brewit-Gestion is a management dashboard UI for the Brewit coffee shop, covering daily sales, service orders, menu performance, and inventory visibility.

## Project structure

- `index.html` — main dashboard structure.
- `styles.css` — full visual styling for the Brewit-Gestion layout.
- `script.js` — UI behavior for navigation and quick dashboard interactions.

## Local run

Install dependencies once, then start the application:

```bash
npm install
npm start
```

Visit <http://localhost:3000>. The same server delivers the dashboard, API, and uploaded-file downloads, so a second static server is not required.

Uploaded data is stored under `uploads/` and is intentionally excluded from Git. Back up that directory if the local upload history needs to be preserved.

## Tests

```bash
npm test
```

The integration suite covers app delivery, location rules, XLS/XLSX/CSV date detection, mandatory date confirmation, cumulative transaction imports, overlap replacement, downloads, and shared master files.

## Upload rules

- Choose a cafeteria or the main warehouse before selecting transaction files; no week key is required.
- Transaction categories are updated one at a time. Each row shows the most recently uploaded file and provides equally sized, right-aligned Preview, Delete, and Upload New File actions; the former batch “Detect dates and review” action is no longer used.
- “Último archivo subido” expands an inline history of every upload in that category, including filename, upload time, confirmed range, and whether it added records or replaced coincident dates. The separate latest-sales-transaction label is no longer shown on the upload screen.
- After a transaction file is selected and inspected, its detected dates, structure validation, and overlap options are presented in a modal confirmation window. Closing, cancelling, or pressing Escape abandons that pending selection; a successful result is reported back on the upload screen.
- Upload New File opens the operating-system file picker and immediately validates the selected category structure, detects its date range, and opens the existing-data review. No second inspection click is required.
- Each store accepts Kardex, waste, marketing consumption, employee consumption, purchases, sales, Detalle Pagos, and MercadoPago transactions.
- The main warehouse accepts only its Kardex.
- New transaction uploads are stored cumulatively by location and category. Existing week-based folders remain readable as legacy data but are no longer created by the UI.
- Accepted formats are CSV, XLS, XLSX, and TXT.
- Each file is limited to 50 MB.
- Brewit detects the date range inside the staged files and requires user confirmation before saving.
- Before accepting a transaction or master file, Brewit verifies its workbook sheets and required headers against the selected category. Recognized mismatches are blocked with an explicit explanation of the selected and detected file types; valid transaction reviews show an “Estructura verificada” confirmation.
- Detalle Pagos is stored as its own source. Spanish exports with `FechaCierre`, `Comanda`, and `Comentario General` are interpreted as day/month/year; English exports with `DateClosing`, `Ticket`, and `General Comment` are interpreted as month/day/year. Both receive strict structural validation, while other manually uploaded variants remain accepted when readable and non-empty.
- Consumption-mode sales use `A Pagar` in Spanish Detalle Pagos exports and `Due` in English exports as the final gross order amount, normalized to pesos and divided by 1.19 for the dashboard's net-sales basis. The Sales Totals amount remains the fallback when that field is absent.
- Kardex/Merma and marketing/employee consumption share structural families. Brewit uses standard filename and sheet-name signals to catch clear cross-selections while accepting genuinely ambiguous files only when their shared family matches the selected category.
- When uploaded dates overlap existing data, Brewit explains the affected range and asks whether to preserve existing records while adding only new ones or replace the coincident days with the new data.
- Delete offers two explicitly confirmed operations: revert the latest upload, which restores any older dates hidden by that upload, or remove every current and legacy upload for that location/category. The user must type `ELIMINAR` before either operation runs.
- Sales and purchases are de-duplicated by their transaction/document identities. Detalle Pagos and MercadoPago omit exact repeated rows; MercadoPago is still accepted without structural validation until a reference export is available. Kardex, waste, and consumption processing combine all active source dates and honor replacement exclusions.
- “Descargar Ventas desde web” sequentially downloads, validates, de-duplicates, and saves both Ventas Totales and Detalle Pagos, while preserving authentication, restaurant-selection, route fallback, and diagnostics handling for each report.
- The shared master categories are the combined Products / Ingredients / Extras workbook, product hierarchy, ingredient hierarchy, extras hierarchy, recipes, and suppliers.
- Every master requires a “Válido desde” date. A duplicate category/date combination must be explicitly replaced or cancelled.
- Saved masters include an in-app spreadsheet preview and permanent deletion with explicit per-file confirmation.

## Location management

- Configuración can create and rename cafeterías or bodegas; the transaction upload selector reads this registry dynamically.
- Cafeterías accept every transaction category, while bodegas accept only Kardex.
- Moving a location to trash requires two warnings and typing its exact name.
- Trashed locations disappear from transaction uploads and both their legacy and cumulative data move under protected `uploads/trash/locations/` storage.
- Restore returns the location and all of its transaction files. There is no permanent location deletion action.

## Sales dashboard

- Ventas is backed by the cumulative sales records and can show all cafeterias together or one active cafeteria.
- Vista Grilla lets the user compare the existing period-end cost valuation with an experimental sale-date valuation. The latter only uses purchases, catalog and recipes effective by each sale date; a positive cost in the sales export is an unverified fallback, while an unsupported zero leaves margin unavailable. The period-end method remains the default backup until historical coverage is validated.
- Auditoría Transacciones marks negative amounts/quantities and explicit cancellation, refund, or credit-note labels for manual review. It does not infer physical returns or modify sales automatically, and those flagged orders are not treated as ordinary payment mismatches.
- The headline indicators show net sales excluding VAT for today, yesterday, the current Monday-to-date week, and the current month-to-date period. Day comparisons use the equivalent weekday from the prior week; week and month comparisons use the same elapsed portion of the preceding period.
- A location table separates current day, prior day, week, and month sales. Product rankings and sales participation by product hierarchy can be switched between day, week, and month. Hierarchy participation is interactive: selecting a row drills into its child hierarchy and ultimately lists every sold product ordered by net sales in a scrollable panel, with units, code, share, contribution margin, and a back/breadcrumb control. Contribution margin uses `(net sales excluding VAT - line cost) / net sales excluding VAT`; the sales export's `Costo` is already a line total and is not multiplied by quantity again.
- MercadoPago analytics read `SETTLEMENT` records and de-duplicate them by `SOURCE_ID`. A customer is identified only when both `CARD_INITIAL_NUMBER` and zero-padded `LAST_FOUR_DIGITS` are available; the combined value is used internally and is never displayed.
- A MercadoPago transaction is recurrent when the same card key has an earlier transaction in the selected cafeteria scope. Day, week, and month metrics show total sales and transactions, recurring transaction and sales shares, and the comparable preceding period.
- Recurrent customers are grouped into mutually exclusive average-frequency bands: more than three visits per week, more than one per week, more than one every 15 days, more than one per month, and less-frequent recurrent customers.
- Below the current indicators, MercadoPago history shows the latest six calendar months and eight Monday-based weeks. Every period includes recurring sales as a share of total MercadoPago sales, identified cards, recurrent customers active in the period, and their frequency distribution calculated from visits accumulated through that period's closing date.

## Inventory workspace

- Inventario has its own workspace instead of reusing the general dashboard mockup.
- Selecting an active location shows its latest Kardex, waste, marketing consumption, and employee consumption files, chosen by each file's detected data-through date.
- Cafeterias require all four sources. Warehouses require only Kardex and mark waste and the two consumption sources as not applicable.
- Available sources can be previewed or downloaded, and the update action opens Cargar Archivos with the same location selected. Every inventory-source preview first asks for an inclusive date range, defaulting to the previous Monday through Sunday; Kardex/Merma date groups and consumption date columns are filtered to that range.
- Waste, marketing-consumption, employee-consumption, and processed inventory results open in large scrollable modal windows instead of being appended below the source list. Print/PDF, Excel export, and close actions remain available inside each result window.
- Inventory PDF printing temporarily moves the report out of the browser's modal layer, removes height and overflow limits, paginates every report section and long table, repeats table headers, and keeps individual rows together instead of clipping the output to the first consumption block. The modal is restored after printing.
- In the consolidated Kardex table, Code, Product, Unit, and Unit Cost remain fixed while the movement and balance columns scroll horizontally. Long product names are clipped within the fixed area and remain available as hover text.
- Every consolidated Kardex column can be sorted in ascending or descending order from its header. The table can be searched by product code/name and filtered by total-cost sign or an optional minimum/maximum amount; its visible-row count and total cost update with the active filters.
- The location header no longer carries a shared report range. Processing opens a confirmation dialog with independent opening-balance date/basis, closing-balance date/basis, and inclusive movement dates.
- Defaults are the previous Monday using its opening inventory, the current Monday using its opening inventory, and the complete previous Monday-through-Sunday movement period.
- Merma includes its own inclusive-period summary that consolidates every incoming movement by item, shows unit and total costs from the applicable shared catalog, and hides items whose total additions are zero. MOV-IN and total additions remain visible; other incoming movement columns appear only when their period total is nonzero. A footer totals every visible movement column, total additions, and total cost without incorrectly summing unit costs. Marketing and employee consumption provide equivalent independent-period summaries.
- Spreadsheet previews show up to 400 rows and 400 columns per sheet and indicate when additional content was truncated.
- Merma, standalone consumption summaries, and the complete consolidated inventory report can be printed/saved as PDF or exported as real XLSX workbooks. Consolidated exports place report metadata and each visible table on separate worksheets.
- The workspace enables inventory processing once all required sources are ready and the Kardex date structure is valid.
- Kardex processing detects its dated column groups automatically. Opening and closing balances can each use either the initial or final inventory recorded on their selected Kardex date, while movement columns are consolidated across their separate inclusive range.
- Before consolidating the Kardex, inventory processing builds the Merma additions summary and separate marketing and employee consumption reports over the confirmed movement range.
- In multi-sheet consumption workbooks, the product-structured sheet with the greatest coverage of the selected dates is used. Annotated quantities keep their leading numeric value and non-numeric notes are ignored.
- Each consumption report contains a product summary priced from the applicable shared catalog (falling back to the source workbook only when needed) and an ingredient summary calculated from the recipe master and product/ingredient/extra catalog, including quantities, normalized base-unit costs, totals, and warnings for missing recipes, costs, or unit conversions.
- Ingredient consumption is consolidated into standard units before grouping: grams are converted to kilograms and milliliters to liters, so the same ingredient is shown only once even when its recipes use mixed units.
- Recipe yield is included in ingredient usage and cost: required usage is `consumed products × recipe quantity ÷ (yield percentage / 100)`, before converting and consolidating units.
- For each Kardex item, the report shows its catalog unit cost, selected opening balance, and every movement type consolidated across the confirmed period. Employee and marketing consumption (including recipe-derived ingredient quantities converted to the Kardex unit) appear immediately after the Kardex movements. Both are subtracted when calculating theoretical closing inventory: `opening inventory + Kardex movements − employee consumption − marketing consumption`. The definitive difference is `closing inventory − theoretical closing inventory`, and the total cost is `unit cost × inventory difference`. Kardex quantities use four decimal places, monetary columns use whole CLP, and a footer totals the final cost column without summing unit costs. Negative differences are red, positive values blue, and zero black.

## Financial results workspace

- Resultados Financieros builds a partial income statement for an inclusive date range and one or all active cafeterias.
- Its direct product cost has the same selectable period-end backup and experimental sale-date valuation as Vista Grilla. The selected basis is displayed with the statement, and cost coverage remains explicit; operating expenses retain their existing period calculations.
- When historical cost is unavailable, a separate table lists the affected product, reason, first/last sale dates, line count, and net sales to resolve. Consumption workbooks are parsed once per source while preserving the existing per-day sheet choice and duplicate precedence.
- Revenue is net of VAT and reconciled to order totals. Every product-hierarchy line shows sales, sales share, contribution-margin percentage, and contribution-margin amount.
- Each hierarchy expands into two mutually reconciling views: Barra Caliente / Barra Fría / Sin Barra from the product catalog's BA.001 and BA.002 assignments, and Café / Matcha / Otros from recipe components SUB005 and CAF008. Sold extras inherit the base product classification in their order.
- Known operating expenses reuse the inventory calculations for marketing consumption, employee consumption, waste, and valued inventory difference. The inventory difference uses the same executive-summary adjustment for LAC001 milk substitutions, syrup/sauce substitutions, and unused dine-in cups/lids. Inventory shortages become positive expenses and surpluses reduce expense.
- MercadoPago expense sums the absolute `FEE_AMOUNT` (or another recognized fee column) for de-duplicated `SETTLEMENT` rows in the selected period, then divides that gross commission by 1.18 to report its net value. The response exposes the gross amount, net amount, VAT factor, detected fields, and coverage warnings.
- The bottom line is deliberately labeled partial while any selected location lacks a required source or while future operating-expense categories remain outside the system.

## Purchases workspace

- Compras replaces the dashboard mockup with the purchase lines stored in the cumulative cafeteria data.
- The view filters by location, initial date, final date, supplier, and product/ingredient code or name, and groups the resulting purchases by supplier.
- Purchase spreadsheets do not identify the destination warehouse. Cafeteria purchases are therefore associated with the location selected when the file is uploaded. Selecting Bodega Principal instead reads its nonzero `BUY - Compras` movements from Kardex and labels them as `Ingresos BUY según Kardex`; supplier and invoice are shown as unavailable because Kardex does not establish them.
- The filtered purchase history can open the browser's landscape print/PDF preview or export to an XLSX workbook with an information sheet, raw numeric purchase data, and an autofilter.
- Each line shows the purchased item, quantity, purchase unit (UDC), units per UDC and resulting base unit from the catalog conversion valid on the purchase date, recorded UDC cost, base-unit cost calculated as `recorded UDC cost ÷ units per UDC`, discount, effective unit price after discount, previous effective price for the same supplier/item/cafeteria, percentage change, and total amount. Missing conversion definitions are shown explicitly rather than inferred.
- Overlapping purchase files are de-duplicated by cafeteria, date, supplier, document, line, and item before reporting.
- Every purchase-history column can be sorted ascending or descending from its header. The `Variaciones de costo 30 días` report identifies any positive or negative base-unit cost fluctuation in the latest 30 calendar days, keeps comparisons separated by location/supplier/item/purchase unit, groups results by supplier, and supports PDF printing and Excel export.

## Purchase projection workspace

- Proyección de Compras is available below Compras and requires an active cafeteria or warehouse selection.
- Thirty-day demand sums every applicable outgoing Kardex column for each day, including `USO`, `TRL-OUT`, `MOV-OUT`, and `TRN-OUT`; this avoids dropping transformations when several outgoing movement types coexist on the same date. The most recent Kardex final inventory is used as current stock, falling back to that date's initial inventory only when no final-inventory column exists.
- Current inventory, 30-day consumption, daily average, and current coverage display two decimals. Coverage below the configured minimum is highlighted in red.
- Every Kardex item has persistent location-specific minimum and maximum coverage criteria, defaulting to 7 and 14 days. Replenishment activates at or below the minimum and targets the maximum.
- A persistent checkbox defines which items are actively managed in the projection. The view can independently filter to purchase needs and/or managed items; only managed items contribute to projection totals and purchase orders.
- Suggested internal quantity is converted through the applicable catalog conversion and rounded up to a whole purchase unit (UDC). Missing conversions are shown and are never guessed.
- Suppliers are taken from the latest known purchase and can be explicitly assigned per item from the supplier master. Historical supplier matches from another location are labeled as suggestions until saved.
- Projections can be grouped or filtered by supplier. Selecting one assigned supplier enables a landscape purchase-order PDF preview with UDC quantities, internal equivalents, estimated prices, and an explicit verification notice.

## Products workspace

- Productos reads every product from the latest applicable shared catalog and organizes it by the complete product hierarchy path.
- The view can aggregate all active cafeterias or filter a single cafeteria, and includes a code/name search without hiding products that have no sales.
- Each product shows gross base selling price, net selling price calculated as `selling price / 1.19`, catalog cost, margin calculated as `(net selling price - cost) / net selling price`, average weekly units over the latest rolling 56 days divided by eight (always displayed with one decimal), units sold in the latest rolling seven days including today, and the percentage change of those seven days against the eight-week weekly average.
- Every main product-table header is sortable in ascending or descending order without losing the hierarchy grouping.
- `Cambios Relevantes` preserves those hierarchies and columns but includes only products averaging at least 5 weekly units whose latest-seven-day variation exceeds 20% in absolute value. All matching hierarchies open expanded, and the report supports PDF printing and numeric XLSX export. If a prior snapshot for the same cafeteria scope exists within 30 days, a changed selling price shows the saved value as a blue `(ant. $…)` reference in both the main table and the relevant-changes report.

## Ingredients workspace

- Ingredientes combines the applicable ingredient catalog, recipes, purchase history, suppliers, and operational activity for a user-selected inclusive period (the latest 30 days by default).
- The view supports all cafeterias together, each cafeteria, or the main warehouse; it can filter by supplier, search by ingredient code/name, and isolate ingredients whose purchase cost changed during the selected period.
- Cafeteria usage is calculated from sold product quantities expanded through each recipe, including recipe yield. Main-warehouse usage instead reads actual `USO`, `TRL-OUT`, `MOV-OUT`, and `TRN-OUT` Kardex movements because the warehouse has no direct sales.
- Each ingredient shows its catalog cost, most recent comparable purchase cost as of the selected closing date, first-to-last cost change within the period, consumed quantity, valued consumption, supplier, and every product recipe that uses it. Recipe details show stated quantity, unit, yield, and yield-adjusted effective quantity.
- A top-ten ranking orders ingredients by valued consumption for the selected scope and period. All main-table columns support ascending/descending sorting.

### Sales by ingredients

- Ventas por Ingredientes is available between Ventas and Productos. It supports all cafeterias or one cafeteria, an inclusive date range, and multiple simultaneous selections.
- Recipe ingredients are browsed by ingredient hierarchy and can be searched by code or name. Product quantities are expanded through the applicable recipes, including yield, so packaging and ingredient requirements are reported in their normalized unit alongside product units and net sales excluding VAT.
- Active `SUB` items stored in the Extras catalog are also available as individual recipe filters when they are referenced by at least one recipe. They appear under an `Extras con receta` hierarchy and use the same recipe quantity and yield calculation as regular ingredients.
- Preparation classifications such as Barra Caliente and Barra Fría come from the extras hierarchy assigned to products. Every selection is rendered as an independent block, ordered by units sold, with product detail and totals.
- The final summary counts matching products only once even when the same product belongs to several selected ingredients or classifications; each block remains independent for participation analysis.
- Every result block can be collapsed independently. Collapsing hides only the product rows and keeps the column headings and total footer visible; its state survives report refreshes until the selection is cleared.
- Product rows also show the total line cost and contribution margin. The sales export's `Costo` is treated as an already-extended line total; group and deduplicated overall margins are calculated from aggregate net sales and aggregate cost, rather than averaging row percentages.
- Proyección de Compras likewise supports ascending/descending sorting from every table header while preserving editable management, supplier, and min/max settings.
- Inactive catalog products remain visible and are labeled as inactive.
- Product views can be saved as dated snapshots for the selected cafeteria scope. One snapshot is retained per date and scope, with explicit confirmation before replacement.
- A saved snapshot can be compared with the current catalog to report added or removed products and changes in gross/net selling price, cost, and net margin.

## Análisis de la demanda

- La vista se encuentra debajo de Resultados Financieros. Permite seleccionar una, varias o todas las cafeterías; día, semana, mes, acumulado, período personalizado o todo el historial; producto, categoría, modalidad, segmento orientativo de nombre y recurrencia observable. Canal y tamaño solo se habilitan si las exportaciones contienen campos explícitos. Las franjas horarias y los intervalos de precio son editables; los precios parten con cortes de CLP 500.
- La capa de hechos reúne pedidos, venta neta, ticket promedio/mediano con IVA, descuento ponderado, margen con costo completo, comparación por local y red, productos, categorías, combinaciones con soporte/confianza/lift, distribuciones de gasto y precio pagado, mapa día-hora y evolución. Cada gráfico o tabla abre los pedidos que lo sustentan.
- Los filtros de producto y categoría seleccionan **pedidos que contienen** esas líneas; el ticket, la venta y el margen del resumen corresponden a la canasta completa de esos pedidos. Los cuadros de productos/categorías muestran las líneas base contenidas en el conjunto filtrado.
- La capa de interpretación etiqueta las hipótesis, alternativas, información faltante y prueba sugerida. La capa de acciones prioriza mediante una regla ordinal transparente; no estima ingresos adicionales sin experimento.
- Para comparar períodos se exige fecha de apertura, días y horarios habituales de operación, cierres excepcionales y rangos de ventas cargados. Estos datos se administran en Configuración. Un archivo con rango declarado no prueba por sí solo integridad de todas sus fechas, y el horario actual no reconstruye cambios históricos. Si no existe base comparable, se muestra «—» en lugar de cero.
- Ocasiones de consumo cruzan franjas configurables, modalidad, día, categoría y producto. La segmentación denominada **género estimado por nombre** es agregada, conservadora y mantiene categorías indeterminada/sin nombre; no confirma identidad ni género y no genera recomendaciones por sí sola.
- La recurrencia se calcula solo sobre instrumentos de pago pseudonimizados cuyo pedido coincide de forma unívoca por local, fecha, monto y hora con MercadoPago. No se presenta como clientes únicos: coincidencias ambiguas, pagos potencialmente divididos y pedidos sin vínculo permanecen visibles. Las cohortes usan «primera compra observada» y corrigen el tiempo disponible para retornar.
- La exploración de precios separa precio pagado y precio base cuando existe, muestra distribuciones configurables y señales antes/después con ventanas declaradas. No publica elasticidad causal ni barreras de precio sin promociones, stock, surtido y exposición verificables. Estacionalidad anual y demanda perdida continúan bloqueadas hasta contar con cobertura suficiente. Las vistas anteriores permanecen disponibles.

## Weekly sales report

Las definiciones oficiales de venta, costo, margen, descuento y ticket promedio se documentan en [METRICAS.md](METRICAS.md). Como regla general, los importes de gestión son netos de IVA; el ticket promedio y los precios observados por el cliente incluyen IVA.

- Resumen General Ventas consolidates the sales files from all active cafeterias; warehouses are excluded.
- Its monthly, weekly, daily, and equivalent-day histories also show average ticket including VAT. Each value uses gross sales after signed discounts divided by the number of unique orders in that period; variations follow the same comparisons as the net-sales histories.
- A third set of histories shows discounts granted as a weighted percentage of gross sales before discounts. Its comparisons are expressed as percentage-point changes (`pp`) for monthly, weekly, daily, and equivalent-day periods.
- Sales imports are incremental across the complete history of each cafeteria. Existing order IDs are discarded from a new export, while every row belonging to a genuinely new order is retained. Rows without an order ID use a stable content fingerprint.
- Sales imports keep only new order identities unless the user explicitly replaces coincident dates.
- Net sales exclude VAT and are calculated per transaction as `(gross sale + signed discounts) / 1.19`. The sales export already represents discounts as negative values.
- By default, the reference card uses the previous day and shows its rank against every available sales day, its rank against the same weekday, and its difference from the average of the previous eight occurrences of that weekday. The “Incluir venta de hoy” toggle changes this reference and all three comparisons to today.
- The cutoff toggle is placed inside the lower-right corner of the main reference card and identifies the active mode as “Venta hoy” or “Venta día anterior”.
- Sales files are managed through Cargar Archivos. Resumen General Ventas can download sales from TotEat and refreshes after the new data is stored.
- Weekly sales accumulate from Monday through the selected cutoff, and monthly sales accumulate from the first day of the month through that cutoff. The default cutoff is yesterday; the toggle extends both totals through today.
- The intraday section compares today's cumulative sales against the best prior equivalent weekday, the best prior day in the current month, and the best prior historical day. Reference dates are shown in each column.
- Four compact two-column blocks below the intraday section show the latest 14 calendar months, 14 Monday–Sunday weeks, 14 individual days, and 14 equivalent weekdays. Every series ends at the selected report cutoff and follows the cafeteria filter.
- Each historical amount includes a one-decimal variation against the preceding period, shown in blue for zero or positive and red for negative. Daily history compares each date with the same weekday one week earlier; the oldest visible record omits the variation.
- Intraday cutoffs are 08:59:59, 10:59:59, 12:59:59, 14:59:59, 16:59:59, 18:59:59, and 23:59:59. The first row also includes sales before 07:00, and the final row includes every sale from 19:00 through the end of the day.
- Repeated orders found in overlapping uploads are counted once per location using the order ID.

## Display preferences

- The Brewit Studio footer in the sidebar provides global A− / A+ font controls from 80% to 200% in 10-point steps. The preference applies to the complete application, persists in the browser, and remains available when the sidebar is collapsed.

## Toteat master downloads

### Primera conexión por API

La validación real de ventas, pagos y compras de La Concepción, sus diferencias y reglas de conversión están en [Validación API Toteat — 21/09/2026](docs/Validacion_API_Toteat_2026-09-21.md).

En **Configuración → Conexión API de Toteat**, selecciona la cafetería e ingresa Restaurant ID, Local ID, Usuario ID y token. El dueño obtiene estos datos en Toteat, en **Configuración → Print Server & API → API Config → Agregar API**, con versión estable y las rutas `/products`, `/sales` y `/shiftstatus` habilitadas en Seguridad. La configuración de Toteat exige un canal de origen incluso para acceso de lectura. Consulta la [documentación oficial](https://developers.toteat.com/#tag/Configuracion-API).

**Probar conexión y guardar** consulta `GET /products` (incluye inactivos). Solo una respuesta válida guarda las credenciales por ubicación. Después, elige la fecha inicial y la frecuencia en **Actualización de ventas por API**, y pulsa **Guardar y sincronizar**. Esta segunda operación comprueba el turno e importa ventas y detalle de pagos para los reportes existentes.

La actualización automática corre cada 5 o 15 minutos mientras el servidor Brewit está encendido. También puede dejarse manual. Consulta órdenes cerradas, con ventanas de hasta 15 días y solicitudes separadas al menos 21 segundos. Refresca las dos ventanas recientes y el turno abierto, y revisa todo el histórico una vez al día. **Revisar todo el histórico** fuerza esa revisión cuando se necesita recuperar una corrección antigua.

Cada cafetería tiene credenciales, fecha inicial y estado independientes; los locales futuros se agregan desde Configuración y siguen el mismo procedimiento. Una respuesta válida sin ventas muestra **Conectado · sin ventas todavía** y permite preparar el local antes de abrir. Un error de autorización nunca se interpreta como ventas cero.

Las dos fuentes (ventas y detalle de pagos) se publican juntas en `uploads/.integrations/toteat-api/sales/`. Los reportes dan preferencia a las órdenes de API y conservan los archivos originales para el resto del histórico, evitando duplicados. Ante un fallo se mantiene la última versión válida. La fuente API admite vista previa y exportación; no se elimina desde Cargar Archivos. Se conservan las últimas tres versiones completas. La fecha inicial se fija tras la primera carga para impedir cambios que dejen huecos silenciosos.

La equivalencia de detalle tiene límites: no hay fecha/hora de pedido individual ni origen en esta respuesta; el costo viene redondeado y ciertas anulaciones no incluyen productos. Estos campos no se inventan. Los pagos sin productos conservan sus importes y se advierten en pantalla, con identificación en el estado de sincronización y en el XLSX. Las notas de crédito revierten el detalle cuando Toteat lo devuelve con signo positivo. La excepción del extra gratuito descrita en la validación sigue pendiente; no debe usarse esta integración para declarar conciliación exacta de unidades o consumo físico.

El token se guarda con permisos `0600` en `uploads/.integrations/toteat-api/credentials.json`, fuera de las rutas de archivos servidos y excluido de Git. No se devuelve al navegador ni se registran respuestas o errores externos. No está cifrado en disco: proteger este directorio y sus respaldos como el perfil de sesión existente. La aplicación continúa bajo el alcance privado/local descrito en `SEGURIDAD_Y_RESPALDOS.md`.

Para probar de nuevo se puede dejar el token vacío; para reemplazarlo, ingresar el nuevo. Una prueba fallida conserva las credenciales anteriores. Las pruebas se separan al menos 21 segundos en cada proceso del servidor, con timeout de 20 segundos. No se siguen redirecciones HTTP para evitar reenviar credenciales a otro destino; si la cuenta legacy requiere una, habrá que verificar el destino oficial antes de habilitarlo. La base de conexión es fija de producción.

### Compras por API

La misma conexión admite compras con el permiso de lectura `/accountingmovements`. En **Configuración → Compras por API de Toteat**, usando la cafetería seleccionada arriba, define la fecha inicial y una frecuencia de 15 minutos, una hora o manual. **Guardar y sincronizar compras** inicia la carga. El panel Compras también tiene **Actualizar compras por API**. Un local nuevo puede conectarse aunque su respuesta todavía esté vacía.

Se consulta `GET /accountingmovements` con `include_sales=false`, compartiendo con ventas la cola de solicitudes separadas al menos 21 segundos. Se actualizan las últimas tres ventanas de 15 días y se revisa todo el histórico diariamente, para recuperar compras ingresadas con fechas antiguas. El botón **Revisar histórico de compras** fuerza esa revisión.

El adaptador conserva proveedor y RUT, documento y tipo, SKU, cantidades facturadas y recibidas, ambas unidades y los importes de línea, incluidos los negativos. Usa `sku`, no el identificador interno del producto. Los totales se toman de `total_price`; nunca se reconstruyen multiplicando el precio unitario redondeado. Se conservan por separado la cabecera y las diferencias de suma. El ID de bodega Toteat queda como referencia, sin asignarlo automáticamente a una bodega Brewit.

Toteat también devuelve entradas manuales de caja (`CASH_FLOW`) dentro de la respuesta contable, incluso con `include_sales=false`. Se excluyen del archivo de compras; solo se importan movimientos de proveedores (`PROVIDERS`). Una clase desconocida detiene la actualización para revisión. Si Toteat ha eliminado la identificación de un producto, se conservan sus cantidades e importe con SKU vacío y una advertencia; esa línea no se enlaza a un ingrediente inventado.

Los campos ausentes (usuario, forma de pago, costo negociado, monto neto anterior al descuento y descuento de línea) permanecen vacíos o **No disponible**. La API no permite certificar por sí sola la base neta de costos usada en los controles tributarios existentes. El costo efectivo unitario se calcula a partir del importe de línea y la cantidad, y se conserva además el precio unitario reportado.

Los reportes de compras, referencias de proveedores y costos leen la fuente publicada en `uploads/.integrations/toteat-api/purchases/`. El identificador de movimiento conserva documentos y líneas repetidas legítimas; el cruce por proveedor, tipo y número de documento evita sumar otra vez el archivo anterior. Los números originales se conservan, normalizando ceros iniciales solo para el cruce. Las eliminaciones posteriores no hacen reaparecer documentos desde archivos viejos. Una respuesta inválida, una compra de otro local o un documento sin detalle conserva la última versión válida. Los archivos originales permanecen disponibles como respaldo y se conservan las últimas tres versiones completas de la fuente API.

## Maestros de inventario y piloto de Kardex

**La Concepción (store-1 / local 001) es la fuente única de los maestros de Brewit.** En Cargar Archivos → Archivos maestros compartidos y en Configuración, el botón “Actualizar maestros desde La Concepción” lee productos/ingredientes/extras, las tres jerarquías, recetas y proveedores. Publica las seis categorías juntas en el índice compartido existente, con vigencia desde el día de lectura en Chile y conservando el historial. Todos los locales, bodegas y futuros locales usan estas versiones; las capturas independientes antiguas de Lyon quedan como evidencia y no participan en la selección de maestros.

La actualización consulta JSON de los servicios autenticados de la aplicación web de Toteat; no descarga reportes ni usa el token público de ventas/compras. Es manual mediante el botón y requiere sesión vigente. Los originales completos quedan privados, incluidas recetas y conversiones, y se generan vistas XLSX compatibles para los lectores existentes. La vista previa, descargas y las etiquetas “Última vigencia” muestran la publicación compartida. No modifica los maestros dentro de Toteat.

El navegador puede ser el perfil administrado existente de Toteat o una sesión local de Chrome mediante `TOTEAT_CDP_ENDPOINT=http://127.0.0.1:9224 npm start`. Esta variable solo acepta un endpoint de este equipo. Se requiere `playwright-core` y Chrome, como en las descargas existentes. Una sesión vencida conserva el último maestro e informa el fallo.

El piloto del 23 al 30 de agosto está disponible en Configuración y se reproduce con `node scripts/toteat-inventory-pilot.js` sobre las capturas privadas. `--capture` vuelve a consultar las fuentes con la sesión autorizada. No reemplaza aún los archivos operativos del Kardex. Alcance, resultados y diferencias: [informe del piloto](docs/Piloto_Kardex_2026-08-23_2026-08-30.md).

### Fuentes originales para el Kardex propio

En **Cargar archivos → Transacciones** se pueden actualizar tomas de inventario, transformaciones y transferencias entre bodegas para cada local. Las tablas locales conservan documentos, estados, líneas y versiones; Bodega Principal usa el ambiente de La Concepción. La vista propia combina esas fuentes con compras y ventas ya sincronizadas y permite exportar el cálculo y contrastarlo con los archivos Kardex/Merma existentes.

El cálculo no usa saldos del Kardex de control. Se presenta como borrador mientras se resuelven consumos con extras/reversos, referencias históricas y cobertura de inventarios iniciales; todavía no incluye valoración a costo última compra. Los reportes anteriores mantienen su fuente actual. Detalles, primera carga y resultados del piloto en [Kardex propio desde fuentes originales](docs/Kardex_Propio_Fuentes_Originales.md).
