# Validación real de la API Toteat — La Concepción

Fecha de revisión: 21 de septiembre de 2026. Restaurante Brewit, local Toteat 1, ubicación Brewit `store-1`, usuario API 1001.

## Resultado

**El acceso y la correspondencia de ventas, pagos y compras quedaron comprobados para la muestra.** Los importes concilian usando las reglas de conversión documentadas abajo. Queda una excepción en el detalle de un extra de importe cero; no debe declararse equivalencia absoluta de cantidades y costos hasta resolverla.

No se importaron estas muestras ni se reemplazaron los archivos vigentes, y no se habilitó sincronización automática. Todas las consultas fueron de lectura. Los permisos activos son menú, ventas/pagos, movimientos contables y reporte de anulaciones; permanecen desactivadas las operaciones de escritura.

## Muestra y método

- Período comparado: **7–20 de septiembre de 2026**, excluyendo el día en curso. Las ventas presentes en ambas fuentes corresponden al 7–17 de septiembre; no se infiere a partir de ello si el local operó los días restantes.
- `/sales`: consulta por turnos del 6–20 de septiembre, con un día anterior de margen y `detail_cancel_order=true`; filtrado posterior por fecha real de apertura en `America/Santiago`. Las fechas de la respuesta se interpretaron como UTC, según la documentación. Los días de las 854 órdenes coinciden con el reporte.
- `/accountingmovements`: consulta del 7–20 de septiembre, sin solicitar ventas contables.
- `/orders/cancellation-report`: consulta del 7–20 de septiembre, habilitada después de autorización expresa para investigar las discrepancias.
- Comparación inicial contra archivos vigentes, respetando las exclusiones por reemplazo del índice: 60 archivos de ventas, 55 de pagos y cuatro de compras.
- Segunda comparación contra **tres reportes recién descargados de Toteat**, del mismo local y período, guardados como evidencia sin importarlos.
- Cruce de ventas/pagos por `paymentId`, comprobando orden y folio. Cruce de líneas como multiconjunto por pago, producto, cantidad, importe, descuento e impuesto: se conserva la multiplicidad de extras iguales. Compras por fecha de emisión, proveedor, documento y SKU, agregando líneas repetidas del mismo producto. Se normalizan los ceros iniciales del documento solo para este cruce; los valores originales se conservan.
- Los CSV nuevos se leyeron preservando texto: así `6.300` en Detalle Pagos se interpreta como 6.300 pesos y no como 6,3 pesos. No se ajustaron importes para forzar igualdad contra la API.

## Ventas

| Comprobación | Resultado |
|---|---|
| Órdenes y pagos | 854 en API y reporte; todos identificados en ambas fuentes |
| Venta final con IVA, sin propina | **$6.089.390**, exacta después de descuentos |
| Descuentos | **-$5.370**, dos pagos; coincidencia exacta |
| Impuestos informados | **$972.234**, coincidencia exacta por pago |
| Detalle | 1.562 líneas de API emparejadas con el reporte; tres líneas adicionales de importe cero en el archivo |
| Importes, descuentos e impuestos de líneas emparejadas | Coincidencia exacta |
| Costos de líneas emparejadas | Los 1.562 coinciden al redondear el costo del archivo a pesos enteros; diferencia máxima $0,50 por línea |

### Reglas necesarias

1. **No descontar dos veces.** En esta muestra, `total` de la API ya es el importe final; equivale a `Pago total + Descuentos` del archivo. El archivo suma $6.094.760 antes de los descuentos negativos. Volver a aplicar `discounts` al `total` API reduciría indebidamente las ventas en $5.370.
2. **Conservar IDs de línea y referencias.** La respuesta incluye `lineId`, `lineReference`, `unitCost`, `totalCost` y `unitPriceBeforeTaxes`. Hay 133 líneas con referencia distinta de cero. Las líneas iguales de extras pueden ser legítimas y no deben eliminarse por igualdad de contenido.
3. **El costo pierde decimales.** En las líneas emparejadas, el redondeo de la API acumula una diferencia de **+$18,95** respecto del archivo. Si se necesita precisión de centavos para costos, ese campo de `/sales` no reproduce exactamente el archivo.

### Líneas omitidas y anulaciones

El reporte de anulaciones respondió HTTP 200 y devolvió cinco órdenes con anulaciones totales o parciales. Aunque la documentación pública lo describe como exclusivo de legacy, funcionó en esta cuenta; se informa el comportamiento observado, sin inferir la versión interna del restaurante.

De las tres líneas adicionales del archivo:

- `B1180`: una unidad, importe cero, costo $1.272,99. Confirmada como `canceled=true` en el reporte de anulaciones, vinculada al pago correspondiente.
- `B1270`: una unidad, importe cero, costo $792,15. Confirmada del mismo modo.
- `BX1010`: una unidad, importe cero, costo $788,70. No aparece en `/sales` ni quedó explicada por el reporte de anulaciones consultado. **Pendiente de verificar con Toteat.** No se asume que esté anulada ni que represente consumo real.

Las dos líneas anuladas no deben contarse automáticamente como unidades vendidas ni como consumo físico. El archivo también contiene extras gratuitos legítimos: no es correcto eliminar todas las líneas cuyo importe sea cero.

## Pagos

**854 de 854 pagos conciliados** con el nuevo Detalle Pagos: identificadores de orden, folios, importe final, descuentos, propinas, monto pagado y comentario general coinciden.

- Propinas: **$303.217**.
- `payed` / Pagos, que incluye efectivo recibido antes del vuelto: **$6.409.607**.
- Vuelto: **$17.000**, en siete pagos en efectivo.
- Cobro retenido después del vuelto: **$6.392.607**, igual a ventas finales más propinas.
- Formas de pago: 831 pagos se corresponden con `m1_574` del archivo y el ID API `5008`; 23 con `Cash` y el ID `1000`. La API distingue nombres de tarjeta (`DEBIT_CARD`, `CREDIT_CARD`, `PREPAID_CARD`, etc.) dentro del mismo ID 5008. Esta correspondencia se verificó para este local, no se debe fijar globalmente para otros locales.
- En efectivo, `paymentForms.amount` representa dinero recibido: restar `change` para compararlo con la columna Cash del reporte. Tras esa conversión, todos los importes por medio de pago coinciden. La muestra tiene un solo medio por pago; no prueba cómo repartir el vuelto en pagos mixtos.
- Las propinas ya están dentro del monto recibido de los medios de pago observados: no sumarlas nuevamente a `amount`.
- El comentario general coincide en los 854 pagos y puede seguir alimentando la clasificación servir/llevar que usa Brewit.

Los archivos previamente importados presentan distintas representaciones de miles en los valores de propina. La comparación definitiva se hizo con el CSV nuevo preservando sus cadenas originales. La API evita esa ambigüedad de formato.

## Compras

**18 documentos y 33 líneas** en la API y el reporte nuevo. Incluyen un documento negativo de compra. Las 33 líneas concilian por proveedor/documento/producto, cantidad facturada y recibida, unidades y monto total.

- Suma de `Monto total` / `products.total_price`: **$1.038.019** en ambas fuentes.
- Once precios unitarios tienen decimales en el archivo y están redondeados en la API; diferencia máxima $0,45. No reconstruir importes multiplicando el precio unitario redondeado.
- Las cabeceras API suman **$1.038.018**: existe una diferencia de $1 entre cabecera y suma de líneas de un documento. Conservar ambos niveles y tratar el redondeo explícitamente.
- En esta cuenta, el código que coincide con `Cod` del reporte es **`products.sku`**. `product_id` devuelve un identificador interno numérico; usarlo como SKU rompería el enlace con nuestros maestros.
- No usar `amount` de cabecera como total monetario: se observaron, por ejemplo, `amount=3` y `total_amount=29881`. La semántica de `amount` no quedó validada. Para la comparación se usaron `products.total_price` y `total_amount`.
- Las bodegas están presentes por línea; aún no se verificó la correspondencia entre esos IDs y las ubicaciones de inventario de Brewit.
- Los archivos vigentes tenían 27 líneas por $792.524. Las **seis líneas adicionales, por $245.495**, también aparecen en el reporte recién exportado. Por tanto, no son datos inventados por la API: hay una diferencia de cobertura respecto de las cargas actuales. No se investigó cuándo se incorporaron a Toteat ni se actualizaron automáticamente las compras almacenadas.

## Diferencia detectada en el procesamiento actual

Al reproducir la eliminación de filas idénticas utilizada por el análisis de ventas actual, desaparecen tres apariciones legítimas de extras repetidos en dos pagos, por **$2.100**. El reporte nuevo contiene esas filas y la API las distingue con sus IDs. Esto explica la diferencia de ingresos por línea de la comparación inicial; no es una pérdida de información de la API.

No se modificó ese procesamiento ni sus datos como parte de esta validación. El futuro adaptador debe conservar la identidad y multiplicidad de líneas; corregir el procesamiento histórico requiere una tarea específica.

## Alcance aprobado y límites

- **Ventas monetarias y pagos:** equivalencia comprobada en la muestra con descuentos, propinas y efectivo con vuelto.
- **Compras:** equivalencia comprobada en la muestra usando SKU y montos de línea, con redondeos explícitos.
- **Cantidades y costos de ventas:** correspondencia comprobada para las líneas emparejadas; dos omisiones explicadas por anulación y una pendiente.
- La muestra de `/sales` contiene boletas BE, sin notas de crédito fiscales ni órdenes con múltiples pagos. El reporte de anulaciones sí contiene intentos de pago abortados, lo que no equivale a validar notas de crédito o división de cuentas. Tampoco se probó exhaustivamente el histórico, otros locales ni la recuperación de turnos excepcionalmente largos.
- Las tres descargas existentes deben mantenerse como respaldo durante el desarrollo del adaptador y la conciliación paralela. Esta validación no activa la sustitución automática.

## Evidencias reproducibles

Las muestras y resultados se guardaron fuera de las rutas públicas y de Git en `uploads/.integrations/toteat-api/validation-2026-09-21/`:

- `sales.json`, `purchases.json`, `cancellations.json`: respuestas API; la captura de ventas excluye el objeto de cliente.
- `fresh-sales.csv`, `fresh-payment-details.csv`, `fresh-purchases.xls`: nuevas exportaciones de control.
- `comparison.json`, `comparison-fresh.json`, `extra-checks.json`: resultados detallados.
- `compare.cjs`, `extra-checks.cjs`: scripts de comparación sin escrituras sobre las importaciones. Ejecutar `compare.cjs` con `BREWIT_COMPARE_FRESH=1` selecciona los reportes nuevos.

Son datos privados de operación; este informe no incluye tokens ni datos personales de clientes.

Referencias públicas consultadas: [ventas](https://developers.toteat.com/paths/sales.yaml), [movimientos contables](https://developers.toteat.com/paths/accountingmovements.yaml), [esquemas](https://developers.toteat.com/components/schemas.yaml) y [anulaciones](https://developers.toteat.com/paths/orders_cancellation_report.yaml). Las conclusiones numéricas provienen de las pruebas reales, no solo de la documentación.

## Puesta en marcha de ventas por API — 21/09/2026

Esta etapa posterior implementa la sustitución de las fuentes de ventas y detalle de pagos en Brewit. Los resultados anteriores corresponden a la validación inicial; compras continúa con su flujo de archivos.

| Cafetería | Identificación Toteat | Cobertura inicial | Resultado |
|---|---|---|---|
| La Concepción | Restaurante 1774666275011576, local 1 | Desde 18/05/2026 hasta 21/09/2026 | 9.507 pagos, 9.502 órdenes, $67.761.480 de ventas finales con IVA |
| Portal Lyon | Mismo restaurante, local 2 | Desde su creación, 14/09/2026 | Conexión válida, 0 ventas; lista para la apertura |

Lyon requiere una configuración API propia: el token de La Concepción no autorizó el local 2. Se creó la conexión de Lyon con lectura de productos, ventas y estado de turno, sin activar Delivery. Las credenciales se guardaron por cafetería. El alta de próximas cafeterías utiliza el mismo formulario y no requiere cambios de código.

La actualización se configuró cada cinco minutos en ambas cafeterías, mientras el servidor esté funcionando. Las ventanas recientes y el turno abierto se refrescan; todo el histórico se revisa diariamente o con el botón de revisión histórica. Los archivos anteriores se conservan y las órdenes ya cubiertas por API no se suman nuevamente. Una falla conserva la última actualización válida de ventas y detalle de pagos.

La primera carga reveló **10 pagos sin productos en 6 órdenes**, en mayo, junio y agosto. Incluyen cuatro pares de cobro/reverso que netean cero y dos pagos positivos por $2.700 y $10.000. Se mantienen los importes en ventas y detalle de pagos; no se inventan unidades ni productos. Su importe conjunto es $12.700. El aviso se muestra en la interfaz y los identificadores quedan en el estado privado de sincronización. El detalle XLSX señala las filas sin productos.

También se observó una NC por **-$5.000** con productos positivos por $5.000. El adaptador invierte una sola vez cantidades e importes de esos productos para que el original y su reverso concilien, conservando intacta la respuesta original. Las divisiones de cuenta con líneas distintas se agregan por orden; si una misma línea se repite ambiguamente entre pagos, se detiene la actualización para revisión.

La API no aporta fecha/hora de pedido por producto ni origen en la respuesta observada. Esos campos permanecen vacíos. Subsisten el redondeo de costos y la excepción de `BX1010` ya descrita: la fuente en línea no implica equivalencia absoluta de cantidades o consumo físico.

Los encabezados conservan la semántica del CSV: `Pago total` y `Total a pagar` muestran el importe anterior al descuento; `Total con propina` agrega la propina a ese importe. El precio base unitario se obtiene como `(payed - discounts) / quantity`; `netPrice` de la API ya puede incorporar el descuento y no equivale al precio base del archivo. `Valor de boleta`, el detalle de pagos y los cálculos de ventas mantienen los importes finales.

**Verificación:** 94 pruebas automáticas aprobadas, incluyendo conversión de descuentos, vuelto, notas de crédito, extras repetidos, publicación conjunta, errores sin pérdida de datos, repetición sin duplicados y turnos antiguos. En el servidor real se verificaron vistas previas de ambas fuentes y reportes para los dos locales, sin errores de lectura. La muestra 07–20/09 conserva exactamente 854 pagos, 1.562 líneas y $6.089.390. El navegador confirmó Lyon sin ventas, actualización cada cinco minutos y credenciales ocultas.

Una segunda actualización real desde el servicio activo mantuvo 9.507 pagos en La Concepción y cero en Lyon, sin duplicados ni errores. Después de ajustar los encabezados y el precio base, las 15 pruebas específicas de API y sincronización volvieron a pasar.

## Puesta en marcha de compras por API — 21/09/2026

Se activó la actualización de compras por cafetería mediante `/accountingmovements`, con `include_sales=false`. La Concepción ya tenía el permiso de lectura validado; se habilitó también para Lyon. No se otorgó permiso para crear compras ni modificar inventario.

| Cafetería | Cobertura consultada | Primera carga |
|---|---|---|
| La Concepción | 18/05–21/09/2026 | 234 movimientos de proveedores, 453 líneas, $24.513.968 según importes de línea |
| Portal Lyon | 14/09–21/09/2026 | Respuesta válida, sin compras registradas |

La frecuencia quedó en 15 minutos, compartiendo con ventas la cola de consultas. El servicio refresca las tres ventanas recientes de 15 días y revisa todo el histórico diariamente; también permite revisión histórica manual. Los archivos anteriores se conservan. Compras, referencias de proveedores y costos ya consumen la fuente API, que admite vista previa y exportación XLSX.

**Casos adicionales encontrados en el histórico:**

- La respuesta incluye dos movimientos `CASH_FLOW` de caja que no pertenecen al archivo de compras. Se excluyeron; solo se importan movimientos `PROVIDERS`. Este hallazgo explica el primer rechazo de la carga por falta de proveedor/documento.
- Hay tres líneas de junio sin producto ni SKU, con cantidades e importes disponibles. Corresponden a $6.320, -$6.320 y -$3.160. Se conservan dentro del total, con SKU vacío y una advertencia; no se vinculan a un ingrediente. No se concluye a partir de esto que las dos notas de crédito sean duplicadas.
- Nueve documentos presentan diferencias entre cabecera y suma de líneas. Se mantienen ambos valores; los reportes suman `products.total_price`, igual que la columna `Monto total` del archivo.
- El histórico contiene `WITHOUT_DOCUMENT` y `EXEMPT_INVOICE`, además de facturas, boletas y notas de crédito. Se conciliaron con «Sin Documento» y «Factura Exenta» del archivo para evitar duplicarlos. Se conserva el identificador de movimiento en cada línea, incluso si dos movimientos tienen el mismo folio.

**Campos disponibles y límites:** proveedor/RUT, documento/tipo, fechas de emisión y pago cuando existe, SKU, nombre de producto cuando existe, cantidades facturadas y recibidas, ambas unidades, precio unitario reportado e importe de línea. Usuario, forma de pago, costo negociado y desglose neto/descuento por línea no vienen en esta respuesta: se dejan vacíos y el descuento se muestra como «No disponible». No se sustituyen por cero ni se reconstruyen con el precio unitario redondeado. Los controles existentes no consideran verificada la base neta de costos de estas líneas solo por venir de la API.

**Conciliación real:** el panel de compras muestra exactamente 453 líneas por $24.513.968 en el histórico. Para 07–20/09 muestra 33 líneas por $1.038.019, coincidiendo con el reporte independiente validado anteriormente. Los 33 registros de ese archivo se reconocieron en el cruce de documentos, sin sumarlos otra vez. Se verificaron vistas previas y exportaciones de ambos locales; el navegador confirmó Lyon sin compras y la frecuencia de 15 minutos.

Las respuestas publicadas y su procedencia se conservan de forma privada en `uploads/.integrations/toteat-api/purchases/`. Una falla no reemplaza la última versión válida; los rechazos de conversión conservan una captura privada para poder investigarlos.

**Verificación final:** 97 pruebas automáticas aprobadas. La segunda actualización real del servicio terminó sin errores y mantuvo 234 documentos y 453 líneas en La Concepción; Lyon volvió a confirmar cero compras. La actualización automática quedó activa en ambas cafeterías.
