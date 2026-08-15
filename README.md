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
- Each store accepts Kardex, waste, marketing consumption, employee consumption, purchases, and sales.
- The main warehouse accepts only its Kardex.
- New transaction uploads are stored cumulatively by location and category. Existing week-based folders remain readable as legacy data but are no longer created by the UI.
- Accepted formats are CSV, XLS, XLSX, and TXT.
- Each file is limited to 50 MB.
- Brewit detects the date range inside the staged files and requires user confirmation before saving.
- When uploaded dates overlap existing data, Brewit explains the affected range and asks whether to preserve existing records while adding only new ones or replace the coincident days with the new data.
- Sales and purchases are de-duplicated by their transaction/document identities. Kardex, waste, and consumption processing combine all active source dates and honor replacement exclusions.
- The shared master categories are the combined Products / Ingredients / Extras workbook, product hierarchy, ingredient hierarchy, extras hierarchy, recipes, and suppliers.
- Every master requires a “Válido desde” date. A duplicate category/date combination must be explicitly replaced or cancelled.
- Saved masters include an in-app spreadsheet preview and permanent deletion with explicit per-file confirmation.

## Location management

- Configuración can create and rename cafeterías or bodegas; the transaction upload selector reads this registry dynamically.
- Cafeterías accept every transaction category, while bodegas accept only Kardex.
- Moving a location to trash requires two warnings and typing its exact name.
- Trashed locations disappear from transaction uploads and both their legacy and cumulative data move under protected `uploads/trash/locations/` storage.
- Restore returns the location and all of its transaction files. There is no permanent location deletion action.

## Inventory workspace

- Inventario has its own workspace instead of reusing the general dashboard mockup.
- Selecting an active location shows its latest Kardex, waste, marketing consumption, and employee consumption files, chosen by each file's detected data-through date.
- Cafeterias require all four sources. Warehouses require only Kardex and mark waste and the two consumption sources as not applicable.
- Available sources can be previewed or downloaded, and the update action opens Cargar Archivos with the same location selected. Every inventory-source preview first asks for an inclusive date range, defaulting to the previous Monday through Sunday; Kardex/Merma date groups and consumption date columns are filtered to that range.
- The location header no longer carries a shared report range. Processing opens a confirmation dialog with independent opening-balance date/basis, closing-balance date/basis, and inclusive movement dates.
- Defaults are the previous Monday using its opening inventory, the current Monday using its opening inventory, and the complete previous Monday-through-Sunday movement period.
- Merma includes its own inclusive-period summary that consolidates every incoming movement by item, shows unit and total costs from the applicable shared catalog, and hides items whose total additions are zero. MOV-IN and total additions remain visible; other incoming movement columns appear only when their period total is nonzero. A footer totals every visible movement column, total additions, and total cost without incorrectly summing unit costs. Marketing and employee consumption provide equivalent independent-period summaries.
- Spreadsheet previews show up to 200 rows and 300 columns per sheet and indicate when additional content was truncated.
- The workspace enables inventory processing once all required sources are ready and the Kardex date structure is valid.
- Kardex processing detects its dated column groups automatically. Opening and closing balances can each use either the initial or final inventory recorded on their selected Kardex date, while movement columns are consolidated across their separate inclusive range.
- Before consolidating the Kardex, inventory processing builds the Merma additions summary and separate marketing and employee consumption reports over the confirmed movement range.
- In multi-sheet consumption workbooks, the product-structured sheet with the greatest coverage of the selected dates is used. Annotated quantities keep their leading numeric value and non-numeric notes are ignored.
- Each consumption report contains a product summary priced from the applicable shared catalog (falling back to the source workbook only when needed) and an ingredient summary calculated from the recipe master and product/ingredient/extra catalog, including quantities, normalized base-unit costs, totals, and warnings for missing recipes, costs, or unit conversions.
- Ingredient consumption is consolidated into standard units before grouping: grams are converted to kilograms and milliliters to liters, so the same ingredient is shown only once even when its recipes use mixed units.
- Recipe yield is included in ingredient usage and cost: required usage is `consumed products × recipe quantity ÷ (yield percentage / 100)`, before converting and consolidating units.
- For each Kardex item, the report shows its catalog unit cost, selected opening balance, every movement type consolidated across the confirmed period, theoretical closing inventory, selected closing balance, and inventory difference. It then adds employee and marketing consumption (including recipe-derived ingredient quantities converted to the Kardex unit), calculates adjusted difference as `inventory difference + employee consumption + marketing consumption`, and values it as `unit cost × adjusted difference`. Kardex quantities use four decimal places, monetary columns use whole CLP, and a footer totals the final cost column without summing unit costs. Negative adjusted differences are red, positive values blue, and zero black.

## Purchases workspace

- Compras replaces the dashboard mockup with the purchase lines stored in the cumulative cafeteria data.
- The view filters by cafeteria, initial date, final date, and supplier, and groups the resulting purchases by supplier.
- Each line shows the purchased item, quantity and unit, recorded unit cost, discount, effective unit price after discount, previous effective price for the same supplier/item/cafeteria, percentage change, and total amount.
- Overlapping purchase files are de-duplicated by cafeteria, date, supplier, document, line, and item before reporting.

## Products workspace

- Productos reads every product from the latest applicable shared catalog and organizes it by the complete product hierarchy path.
- The view can aggregate all active cafeterias or filter a single cafeteria, and includes a code/name search without hiding products that have no sales.
- Each product shows gross base selling price, net selling price calculated as `selling price / 1.19`, catalog cost, margin calculated as `(net selling price - cost) / net selling price`, average weekly units over the latest rolling 56 days divided by eight, units sold in the latest rolling seven days including today, and the percentage change of those seven days against the eight-week weekly average.
- Inactive catalog products remain visible and are labeled as inactive.
- Product views can be saved as dated snapshots for the selected cafeteria scope. One snapshot is retained per date and scope, with explicit confirmation before replacement.
- A saved snapshot can be compared with the current catalog to report added or removed products and changes in gross/net selling price, cost, and net margin.

## Weekly sales report

- Reporte Semanal consolidates the sales files from all active cafeterias; warehouses are excluded.
- The transaction upload screen shows the most recent sales transaction date and time available for the selected cafeteria.
- Sales imports are incremental across the complete history of each cafeteria. Existing order IDs are discarded from a new export, while every row belonging to a genuinely new order is retained. Rows without an order ID use a stable content fingerprint.
- Sales imports keep only new order identities unless the user explicitly replaces coincident dates.
- Net sales exclude VAT and are calculated per transaction as `(gross sale + signed discounts) / 1.19`. The sales export already represents discounts as negative values.
- The previous-day card shows its rank against every available sales day, its rank against the same weekday, and its difference from the average of the previous eight occurrences of that weekday.
- Weekly sales accumulate from Monday through the previous day. Monthly sales accumulate from the first day of the month through the previous day.
- The intraday section compares today's cumulative sales against the best prior equivalent weekday, the best prior day in the current month, and the best prior historical day. Reference dates are shown in each column.
- Intraday cutoffs are 08:59:59, 10:59:59, 12:59:59, 14:59:59, 16:59:59, 18:59:59, and 23:59:59. The first row also includes sales before 07:00, and the final row includes every sale from 19:00 through the end of the day.
- Repeated orders found in overlapping uploads are counted once per location using the order ID.
