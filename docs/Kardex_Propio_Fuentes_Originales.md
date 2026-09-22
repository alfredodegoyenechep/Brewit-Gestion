# Kardex propio desde documentos originales

Implementado el 22 de septiembre de 2026. La vista está en **Cargar archivos → Transacciones → Fuentes para el Kardex propio**.

## Uso

1. Seleccionar La Concepción, Lyon o Bodega Principal.
2. Indicar el período y pulsar **Actualizar fuentes de inventario**. Se leen las tres fuentes juntas y se publica una versión completa solamente si la lectura y validación terminan correctamente.
3. Pulsar **Ver Kardex propio y comparar** para consultar cantidades por producto, bodega y día. Se puede filtrar por bodega o código/nombre de producto.
4. **Descargar detalle y comparación** entrega las tablas locales, documentos, movimientos, Kardex, incidencias y diferencias con los archivos de control en un Excel.

Las compras y ventas deben estar sincronizadas previamente. El cálculo guarda las versiones de esas fuentes utilizadas. Al procesar el consolidado desde fuentes originales, se reconstruye la captura local con las ventas, compras y maestros compartidos disponibles; no requiere volver a consultar Toteat. Las tomas, transferencias y transformaciones se actualizan con su botón en Cargar archivos. No se presenta esta captura como una suscripción en tiempo real.

La carga tradicional de Kardex y Merma permanece disponible como control. **No se lee ningún Kardex para construir los saldos propios**: los archivos se consultan después de calcularlos, únicamente para comparar. Los reportes de inventario existentes mantienen su fuente anterior mientras esta nueva vista se valida.

## Tablas locales y fuentes

| Tabla | Origen | Contenido |
|---|---|---|
| Tomas | `/take-inventory/` | Documento, estado, bodega, fecha operativa, registro/aprobación, productos y cantidades contadas. |
| Transferencias entre bodegas | `/transfer-warehouse/` | Documento, origen/destino, estado, producto, unidad y cantidad; una salida y una entrada vinculadas. |
| Transformaciones | `/transformations/` | Producto y cantidad producida, bodega destino y detalle original de ingredientes consumidos con su bodega. |
| Compras | Sincronización de compras ya existente | Cantidad y unidad recibidas, fecha de recepción y bodega de cada línea; se conserva el signo de la cantidad recibida. |
| Consumo de ventas | Ventas ya sincronizadas y maestros compartidos | Descuento de unidades para productos con stock; expansión de receta para productos sin stock, respetando subrecetas, conversiones y rendimiento. |

Las tres rutas de inventario son **servicios internos autenticados de la aplicación de Toteat**, no endpoints certificados de su API pública con token. Requieren una sesión web vigente y pueden cambiar. La integración solo hace lecturas GET; no crea, aprueba ni revierte documentos en Toteat.

Se consultan ventanas de hasta 15 días y se validan IDs, local, bodegas y formato. Si se detecta paginación no resuelta, documentos repetidos entre ventanas o una lectura fallida, se conserva la última versión completa. La aplicación no presupone que un error significa un local sin movimientos.

La persistencia sigue la arquitectura local del proyecto: tablas JSON versionadas en `uploads/.integrations/toteat-api/stock/<ubicación>/<versión>/`, con `counts.json`, `transfers.json`, `transformations.json`, `original.json` y `state.json`. Un único `current.json` publica la versión de forma atómica. Repetir una actualización reemplaza la captura del período, sin sumar nuevamente movimientos. Las versiones anteriores se conservan; el período vigente queda visible en pantalla y no se fusionan ventanas incompletas de forma implícita.

Cada ambiente conserva sus referencias originales. La Bodega Principal corresponde a las bodegas 1 y 4 de La Concepción; no se confunde con la central de Lyon. La actualización desde Bodega Principal lee el ambiente completo de La Concepción y su vista filtra esas dos bodegas. Los maestros utilizados para el cálculo siempre proceden del maestro compartido de La Concepción. Se admiten nuevos locales activos con conexión configurada, aunque la asignación operativa de sus bodegas debe verificarse.

## Reglas y estado de validación

- Solo documentos `APPROVED` afectan el cálculo. Los pendientes, rechazados o revertidos quedan conservados para consulta. Un estado desconocido genera una incidencia.
- Las transferencias conservan sus dos lados y las líneas legítimas idénticas. La merma queda en su bodega destino.
- Las transformaciones usan sus cantidades originales: **no se recalculan con la receta actual**. La salida de ingredientes se contabiliza por línea a tres decimales de unidad de stock, regla observada en el piloto; también se conserva su cantidad exacta.
- Los productos con stock descuentan el producto al venderlo, no nuevamente sus ingredientes.
- Una toma aprobada establece el saldo al inicio de su fecha operativa. La diferencia con el saldo calculado anterior se muestra como ajuste, una sola vez. Dos tomas del mismo producto/bodega/día se marcan como ambiguas; no se inventa un orden.
- Sin inventario inicial conocido, el saldo aparece como no disponible hasta la primera toma. No se obtiene el saldo inicial del Kardex de control ni se reemplaza por cero.
- Los movimientos se conservan en su unidad original y se convierten a la unidad de stock del maestro compartido. La comparación no enfrenta unidades incompatibles.

**La vista es un borrador de cantidades; aún no sustituye íntegramente el Kardex de Toteat.** Las limitaciones están visibles en pantalla y en el Excel:

- Recetas históricas: el consumo de ventas utiliza la versión compartida observada actualmente. El cambio aproximado de 5% señalado para agosto puede explicar parte de las diferencias, pero no se aplica como tolerancia general para ocultarlas.
- Las órdenes con extras se incorporan cuando la referencia a su producto padre es válida. El consumo base incluye la receta del producto y la de los extras; el consolidado compensa posteriormente el ingrediente sustituido o el envase no utilizado, una sola vez. Las devoluciones e identidades ambiguas permanecen pendientes, con identificación del pedido.
- Las ventas se asignan a la bodega operativa de código 2, supuesto que debe verificarse para nuevos locales y otras configuraciones de consumo.
- Las fuentes actuales no certifican transferencias entre locales, anulaciones y todos sus reversos físicos. No se generan transferencias a partir de diferencias de saldo.
- Los documentos sin hora se comparan por día. No se afirma una conciliación de secuencia intradía.
- Hay referencias históricas que no están en el maestro vigente; se preservan sus identificadores y se señalan.
- No se calcula aún valoración a costo de última compra. El campo no disponible se mantiene vacío y no se reemplaza por costo estándar.

## Primera carga comprobada

Período de captura: **23 de agosto al 22 de septiembre de 2026**.

| Local | Tomas | Transferencias | Transformaciones |
|---|---:|---:|---:|
| La Concepción, incluidas bodegas central y merma | 6 documentos: 5 aprobados y 1 pendiente | 69 aprobadas | 208 aprobadas |
| Lyon | 0 | 0 | 0 |

En La Concepción se guardaron 823 líneas de tomas, 3.030 líneas de transferencia contabilizando ambos lados y 949 líneas de transformación incluyendo productos e ingredientes. Lyon devolvió las tres listas vacías correctamente; no se fabricó un inventario inicial cero.

## Contraste independiente: 23 al 30 de agosto

El piloto propio usa **5 tomas aprobadas, 15 documentos de transferencia y 62 transformaciones**, junto con compras y ventas locales. Es distinto del piloto anterior que reconstruía movimientos leyendo el propio Kardex detallado de Toteat.

Se compararon **30.022 celdas** con los archivos descargados. En las celdas comparables, transferencias y entradas/salidas de transformación coinciden. Las 90 diferencias iniciales de salida de transformación se explicaron íntegramente por el redondeo por línea a tres decimales.

Permanecen 935 diferencias: 302 en iniciales, 367 en finales, 261 en uso y 5 en compras. Los saldos arrastran diferencias de consumo y de cobertura; estos números no representan 935 causas independientes. Además, 5.706 celdas carecen de comparación, incluyendo costos no calculados, saldos desconocidos y referencias sin correspondencia. Las cifras se refieren a la captura y archivos usados, y pueden cambiar al corregir fuentes.

Se excluyeron 71 órdenes de venta que requieren resolver extras, sustituciones o reversos. Hay seis referencias históricas fuera del maestro y 128 combinaciones producto/bodega sin inventario inicial conocido al comienzo de la ventana. Entre las diferencias de compra, SSR017 y SSR018 aparecen en la bodega operativa de la fuente de compras y en la central de los archivos; no se reasignaron automáticamente para forzar coincidencia.

- [Excel del piloto independiente](../uploads/reports/inventory/own-kardex/Piloto_Kardex_Propio_23-30_Agosto.xlsx).
- [Resultado detallado del piloto](../uploads/reports/inventory/own-kardex/pilot-23-30.json).
- Reproducción desde las capturas locales: `node scripts/build-own-kardex-pilot.js`.

## Comprobaciones

Se probaron ventas de productos con stock, consumo original de transformación, redondeo por línea, transferencias equilibradas, conservación de líneas repetidas, exclusión de pendientes, ajustes por toma, cantidades negativas de recepción, inventarios iniciales desconocidos, referencias faltantes, aislamiento entre locales y publicación atómica/idempotente. La batería completa de 115 pruebas pasó antes de incorporar la prueba adicional de redondeo; las 14 pruebas focalizadas de inventario pasaron después del ajuste.

También se verificó en navegador la consulta de La Concepción, Lyon y Bodega Principal, los filtros y la ausencia de errores JavaScript. Las correcciones de recetas en Lyon siguen siendo una tarea separada: este trabajo no modifica maestros ni existencias en Toteat.

## Procesar el consolidado desde las fuentes originales

La pantalla **Inventario → Fuentes para el informe de inventario** ofrece ahora dos alternativas:

- **Procesar informe de inventario** conserva el flujo de archivos Kardex/Merma.
- **Procesar desde fuentes originales Toteat** utiliza la captura local sincronizada y no requiere un archivo Kardex. Se seleccionan dos fechas: inventario inicial y final. Los movimientos abarcan el día inicial inclusive hasta el día anterior al final.

La segunda alternativa abre el mismo consolidado y resumen ejecutivo, con impresión/PDF y exportación Excel. El informe identifica la fuente, la fecha de lectura, el carácter provisional y los productos excluidos por no tener una apertura reconstruible. El Excel conserva esa procedencia y añade hojas de productos excluidos e incidencias de captura.

El informe usa la bodega operativa del local o la Bodega Principal, según la ubicación seleccionada; la merma procede de su correspondiente bodega de merma. Marketing y colaboradores siguen usando sus archivos existentes y se identifican como tales: no se afirma que esas dos fuentes estén conectadas a Toteat. La valorización usa las compras y maestros disponibles del informe y es una estimación, no una réplica certificada del costo histórico de Toteat. Para la Bodega Principal, el resolver de costos utiliza compras de La Concepción, sin recurrir al Kardex de control de la central.

Se aplican las mismas reglas de sustituciones de LAC001, syrup/salsas y envases no utilizados que en el informe por archivos. Para fuentes originales se leen exclusivamente las ventas y detalles de pago de la API. Las compensaciones solo consideran pedidos incorporados al consumo base; se conserva el consumo antes del ajuste y se presenta el resultado ajustado por separado. El valor de inventario físico solo se presenta como tal si todos los productos incluidos tienen toma física en el saldo final inicial seleccionado. Los ajustes por tomas intermedias se incluyen una sola vez; no se suma otra vez el ajuste de la toma usada como saldo inicial.

Validación: 120 pruebas de la aplicación pasaron, incluyendo procesamiento sin ningún Kardex cargado, aislamiento de bodega, exclusión de saldos desconocidos y controles de cobertura. También se verificó en navegador el informe del 24–29 de agosto con saldos del 23 y 30, su impresión y exportación con procedencia.


### Sustituciones y envases comprobados con API

Actualización del 22 de septiembre: se eliminó la exclusión general de ventas con extras. La relación con el producto principal se obtiene de `lineReference`, incluso si hay varios productos en el pedido. Los extras huérfanos, las líneas duplicadas y los reversos ambiguos siguen identificados como pendientes. El consumo base conserva producto y extra; por eso las compensaciones del consolidado no se aplican de nuevo al movimiento base.

Para el 24–29 de agosto, con saldos del 23 y 30, la comprobación API da:

| Ajuste | Cantidad identificada | Costo no consumido |
|---|---:|---:|
| LAC001 sustituido | 9,305 L; 33 sustituciones resueltas de 34 | $9.416,66 |
| Syrup y salsas sustituidos | 22 sustituciones resueltas | $5.502,922 |
| Vasos y tapas no utilizados | 774 unidades | $47.786 |

El Detalle Pagos API permitió relacionar los 643 pedidos del período; 281 se clasificaron para servir en el local y cuatro tenían modalidad ambigua. No se interpreta modalidad desconocida como consumo en el local. La sustitución de leche no resuelta mantiene su advertencia, sin inventar volumen. Estos valores corresponden a la captura usada en la comprobación y coinciden con los importes de compensación del flujo por archivos.

Las cifras de exclusión del piloto inicial descritas arriba corresponden a la versión anterior, que descartaba pedidos con extras. Al procesar nuevamente se usa la nueva política. Las tres secciones, el total ajustado y los indicadores por ingrediente vuelven a estar disponibles en pantalla, impresión/PDF y Excel. Se verificaron 121 pruebas automatizadas.


## Criterios por fechas de inventario (22 de septiembre de 2026)

Ambas alternativas muestran calendarios con un recuadro en las fechas con toma física registrada para la bodega seleccionada. Una fecha marcada puede tener una toma parcial: la existencia de inventario se comprueba por producto. El período de movimientos se deriva automáticamente y no se edita por separado.

- Apertura con toma ese día: cantidad física registrada.
- Apertura sin toma: última toma anterior, más entradas menos salidas hasta el día anterior a la apertura solicitada. Incluye compensaciones de LAC001, syrup/salsas y vasos/tapas, y consumos de marketing y colaboradores disponibles. En archivos se admite el primer registro de apertura como base cuando no hay una toma identificada.
- Cierre con toma: cantidad física al inicio de la fecha final, comparada con los movimientos hasta el día previo.
- Cierre sin toma: saldo teórico compensado; cantidad física, diferencia y costo de diferencia quedan sin comparación. Con tomas parciales se conservan las comparaciones por producto, sin presentar un total físico completo.
- Tomas intermedias: se incorpora una sola vez el ajuste contra el saldo teórico compensado antes de esa toma.

La tabla identifica si la apertura es física o teórica y la fecha de su toma/registro base. El cálculo requiere cobertura diaria desde esa base; los productos sin base conocida se excluyen con motivo. Las recetas y fuentes mantienen las limitaciones históricas descritas anteriormente.

Validación con La Concepción: la apertura calculada del 25 de agosto coincide con el cierre teórico compensado de un informe del 23 al 25 para los 135 productos comunes. El cierre del 30 tiene 135 cantidades físicas; el 29 no tiene toma y no presenta comparación física. También se comprobaron los calendarios, la impresión y la exportación Excel en navegador.

### Compensaciones en el detalle del consolidado

La tabla incluye **Compensaciones** inmediatamente antes de **Inventario Final Teórico**. Expresa las cantidades de LAC001, salsas/syrup y vasos/tapas no consumidas, convertidas a la unidad del producto. El inventario final teórico mostrado incluye esas cantidades una sola vez. Se elimina la columna de diferencias después de compensaciones; el costo total sigue valorizando la diferencia entre el físico y ese teórico compensado. El resumen ejecutivo conserva sus indicadores antes y después del ajuste sin descontarlo dos veces. Sin toma física, el costo de diferencia sigue sin comparación. La impresión y Excel conservan esta disposición.
