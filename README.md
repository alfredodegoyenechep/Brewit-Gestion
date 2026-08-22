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
- Each store accepts Kardex, waste, marketing consumption, employee consumption, purchases, sales, and MercadoPago transactions.
- The main warehouse accepts only its Kardex.
- New transaction uploads are stored cumulatively by location and category. Existing week-based folders remain readable as legacy data but are no longer created by the UI.
- Accepted formats are CSV, XLS, XLSX, and TXT.
- Each file is limited to 50 MB.
- Brewit detects the date range inside the staged files and requires user confirmation before saving.
- Before accepting a transaction or master file, Brewit verifies its workbook sheets and required headers against the selected category. Recognized mismatches are blocked with an explicit explanation of the selected and detected file types; valid transaction reviews show an “Estructura verificada” confirmation.
- Kardex/Merma and marketing/employee consumption share structural families. Brewit uses standard filename and sheet-name signals to catch clear cross-selections while accepting genuinely ambiguous files only when their shared family matches the selected category.
- When uploaded dates overlap existing data, Brewit explains the affected range and asks whether to preserve existing records while adding only new ones or replace the coincident days with the new data.
- Delete offers two explicitly confirmed operations: revert the latest upload, which restores any older dates hidden by that upload, or remove every current and legacy upload for that location/category. The user must type `ELIMINAR` before either operation runs.
- Sales and purchases are de-duplicated by their transaction/document identities. MercadoPago files are currently accepted without structural validation and exact repeated rows are omitted; once a reference export is available, its category-specific identity rules can be tightened. Kardex, waste, and consumption processing combine all active source dates and honor replacement exclusions.
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
- Spreadsheet previews show up to 200 rows and 300 columns per sheet and indicate when additional content was truncated.
- Merma, standalone consumption summaries, and the complete consolidated inventory report can be printed/saved as PDF or exported as real XLSX workbooks. Consolidated exports place report metadata and each visible table on separate worksheets.
- The workspace enables inventory processing once all required sources are ready and the Kardex date structure is valid.
- Kardex processing detects its dated column groups automatically. Opening and closing balances can each use either the initial or final inventory recorded on their selected Kardex date, while movement columns are consolidated across their separate inclusive range.
- Before consolidating the Kardex, inventory processing builds the Merma additions summary and separate marketing and employee consumption reports over the confirmed movement range.
- In multi-sheet consumption workbooks, the product-structured sheet with the greatest coverage of the selected dates is used. Annotated quantities keep their leading numeric value and non-numeric notes are ignored.
- Each consumption report contains a product summary priced from the applicable shared catalog (falling back to the source workbook only when needed) and an ingredient summary calculated from the recipe master and product/ingredient/extra catalog, including quantities, normalized base-unit costs, totals, and warnings for missing recipes, costs, or unit conversions.
- Ingredient consumption is consolidated into standard units before grouping: grams are converted to kilograms and milliliters to liters, so the same ingredient is shown only once even when its recipes use mixed units.
- Recipe yield is included in ingredient usage and cost: required usage is `consumed products × recipe quantity ÷ (yield percentage / 100)`, before converting and consolidating units.
- For each Kardex item, the report shows its catalog unit cost, selected opening balance, and every movement type consolidated across the confirmed period. Employee and marketing consumption (including recipe-derived ingredient quantities converted to the Kardex unit) appear immediately after the Kardex movements. Both are subtracted when calculating theoretical closing inventory: `opening inventory + Kardex movements − employee consumption − marketing consumption`. The definitive difference is `closing inventory − theoretical closing inventory`, and the total cost is `unit cost × inventory difference`. Kardex quantities use four decimal places, monetary columns use whole CLP, and a footer totals the final cost column without summing unit costs. Negative differences are red, positive values blue, and zero black.

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

## Weekly sales report

- Resumen General Ventas consolidates the sales files from all active cafeterias; warehouses are excluded.
- Sales imports are incremental across the complete history of each cafeteria. Existing order IDs are discarded from a new export, while every row belonging to a genuinely new order is retained. Rows without an order ID use a stable content fingerprint.
- Sales imports keep only new order identities unless the user explicitly replaces coincident dates.
- Net sales exclude VAT and are calculated per transaction as `(gross sale + signed discounts) / 1.19`. The sales export already represents discounts as negative values.
- By default, the reference card uses the previous day and shows its rank against every available sales day, its rank against the same weekday, and its difference from the average of the previous eight occurrences of that weekday. The “Incluir venta de hoy” toggle changes this reference and all three comparisons to today.
- The cutoff toggle is placed inside the lower-right corner of the main reference card and identifies the active mode as “Venta hoy” or “Venta día anterior”.
- Sales files can be uploaded directly from Resumen General Ventas. A specific cafeteria filter goes straight to file selection; the all-cafeterias scope first asks which cafeteria owns the file. Structure validation, date detection, overlap handling, replacement choices, and deduplication reuse the same transaction-upload workflow as Cargar Archivos, and the report refreshes after confirmation.
- Weekly sales accumulate from Monday through the selected cutoff, and monthly sales accumulate from the first day of the month through that cutoff. The default cutoff is yesterday; the toggle extends both totals through today.
- The intraday section compares today's cumulative sales against the best prior equivalent weekday, the best prior day in the current month, and the best prior historical day. Reference dates are shown in each column.
- Four compact two-column blocks below the intraday section show the latest 14 calendar months, 14 Monday–Sunday weeks, 14 individual days, and 14 equivalent weekdays. Every series ends at the selected report cutoff and follows the cafeteria filter.
- Each historical amount includes a one-decimal variation against the preceding period, shown in blue for zero or positive and red for negative. Daily history compares each date with the same weekday one week earlier; the oldest visible record omits the variation.
- Intraday cutoffs are 08:59:59, 10:59:59, 12:59:59, 14:59:59, 16:59:59, 18:59:59, and 23:59:59. The first row also includes sales before 07:00, and the final row includes every sale from 19:00 through the end of the day.
- Repeated orders found in overlapping uploads are counted once per location using the order ID.
