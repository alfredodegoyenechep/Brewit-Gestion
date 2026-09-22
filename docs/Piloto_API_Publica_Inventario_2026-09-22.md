# Piloto de API pública de inventario — 22 de septiembre de 2026

## Resultado

**La API pública permite obtener el Kardex diario por producto y bodega**, con saldos, compras, consumos de ventas, transferencias y transformaciones. El piloto es favorable para incorporar esta fuente, pero aún no acredita una sustitución completa: quedan diferencias de cantidades y costos, registros sin identificación y cobertura pendiente de merma central.

Se habilitó únicamente el permiso de lectura **Can get Inventory Movements** en la API existente de La Concepción. La consulta respondió HTTP 200 y `ok: true` el 22-09-2026 a las 14:28:46 UTC (11:28:46 de Santiago). No se reemplazaron las fuentes activas de Brewit ni se modificaron existencias en Toteat.

## Consulta y alcance

GET `/mw/or/1.0/inventorystate`, La Concepción, `initial_date=20260823`, `final_date=20260830`. Para comparar datos se incluyeron los días devueltos del 23 al 30 de agosto. Esto no cambia la regla del informe de Brewit: inventario inicial del 23, movimientos del 23 al 29 y toma final del 30.

Se obtuvieron 148 registros: **142 productos identificados**, con **1.164 filas producto/bodega/día**, y seis registros sin SKU ni ID de producto, con 25 filas adicionales. Estos últimos tienen saldos y entradas/salidas diarias en cero; se conservaron separados y no se incorporaron a las comparaciones de productos.

| Bodega | Productos identificados | Filas diarias | Filas con `is_taken` |
| --- | ---: | ---: | ---: |
| Principal, central de La Concepción (1) | 116 | 145 | 116 |
| Local La Concepción (2) | 138 | 724 | 269 |
| Merma del local La Concepción (3) | 137 | 295 | 274 |
| Merma central (4) | No devuelta | — | — |

Los productos pueden aparecer en varias bodegas. `is_taken` es una marca por producto/día; la tabla no cuenta documentos de toma de inventario.

**Merma del local sí está incluida.** Merma central no apareció; en la fuente local hay 16 filas para el período, todas sin saldos ni movimientos distintos de cero y sin tomas. Esto es compatible con ausencia de actividad, pero no demuestra que la API devuelva esa bodega cuando tenga movimientos. Debe probarse un período con actividad antes de dar por cubierta esa bodega. Lyon no forma parte de este piloto.

## Datos efectivamente recibidos

La respuesta utiliza `warehouses[].inventory[]` y entrega:

- Saldo inicial, saldo final, fecha y marca de toma física.
- Compras y consumo (`use`).
- Transferencias entre locales y entre bodegas, con entradas y salidas separadas.
- Transformaciones de entrada y salida.
- Entradas, salidas y movimiento neto diario.
- Costos `cost`, `cost_average`, `cost_last_inbound`, `cost_resupply`, `cost_standard` y `cost_total`.
- Campo `productions`, sin valores distintos de cero en este piloto; su comportamiento con actividad queda pendiente.

No es una entrega de documentos originales: no proporciona en estas filas los identificadores de compras, transferencias, transformaciones o tomas, ni el historial de recetas. Tampoco reemplaza el maestro completo de productos, ingredientes, extras, recetas, jerarquías o proveedores.

Las salidas se reciben como magnitudes que se restan en el saldo. Deben adaptarse a la presentación con signo de Brewit. Además, se observó una compra negativa: no se debe convertir indiscriminadamente todo movimiento a valor absoluto.

## Comparación con Kardex descargados

Se compararon **12.804 valores** de las 1.164 filas identificadas: 11 campos por fila. Todos encontraron contraparte compatible en los archivos. Tolerancia: 0,000001 para cantidades y 0,001 para costo de última compra.

| Campo | Valores distintos |
| --- | ---: |
| Saldo inicial | 5 |
| Saldo final | 6 |
| Compras | 1 |
| Consumo de ventas | 0 |
| Transferencias de entrada/salida, entre locales y bodegas | 0 |
| Transformaciones de entrada/salida | 0 |
| Costo de última compra | 80 |
| **Total** | **92** |

Las **12 diferencias de cantidades** se concentran en:

| Código y bodega | Fecha | Diferencia API − archivo |
| --- | --- | --- |
| SSR001, principal | 28-08 | Inicial y final: API 27,2; archivo 20,68; diferencia +6,52 |
| SSR002, principal | 28-08 | Inicial y final: API 28,56; archivo 21,714; diferencia +6,846 |
| SAN009, local | 26-08 | Compra API −1 frente a 0 del archivo; saldo final menor en 1 |
| SAN009, local | 27 al 29-08 | Saldos inicial y final menores en 1 cada día |

La diferencia de SAN009 es aritméticamente consistente con la compra negativa del 26. No se verificó su documento de origen. Tampoco se determinó aún el origen de las diferencias de SSR001/SSR002 o de los 80 costos; no deben atribuirse automáticamente a cambios de recetas ni a redondeos.

**Límite de la comparación:** acredita coincidencia en los campos y días efectivamente devueltos, no cobertura completa de todas las filas de los archivos. La API devuelve días dispersos. La cuadrícula local contiene 2.188 filas sin fila equivalente de API; esto por sí solo no demuestra movimientos faltantes. Una integración debe resolver continuidad de saldos y distinguir ausencia de fila de un saldo cero.

## Comparación con la reconstrucción local

Sobre las filas comunes, compras difieren en cuatro celdas y consumo en 213; las transferencias, transformaciones y marcas de toma física coinciden. Hay 177 diferencias en saldos iniciales y 220 en finales, sobre 1.137 saldos conocidos de cada tipo; otros 27 saldos de cada tipo no son comparables por falta de dato local. La fuente reconstruida no tiene costo de última compra comparable para estas filas.

Esto debe distinguirse del contraste con los XLSX: el consumo de API sí coincide con esos archivos en todas las celdas comparadas. La reconstrucción local usa sus fuentes y recetas disponibles; las diferencias no prueban por sí solas una causa ni validan una tolerancia del 5%.

Controles sobre las 1.164 filas identificadas: sin claves duplicadas, sin valores no numéricos en los campos comparados y sin diferencias en las identidades `saldo final = saldo inicial + movimiento neto` y `movimiento neto = entradas − salidas`.

## Cómo incorporarla

1. Crear un adaptador de lectura de esta API para el inventario diario, conservando la respuesta original, identificadores de bodega, unidades, costos y fecha de captura.
2. Validar días omitidos, las tres diferencias por código y el criterio de costo histórico; mantener separados los seis registros sin identidad.
3. Probar merma central con actividad y ejecutar el mismo contraste para Lyon.
4. Comparar el informe completo antes de sustituir su fuente. Debe comprobarse especialmente que las compensaciones de leche, syrup/salsas y vasos/tapas se apliquen una sola vez, y conservar los consumos de marketing y colaboradores.

La conclusión es favorable para usar API pública en el **Kardex diario**. El acceso a **documentos originales de inventario y maestros completos** sigue siendo una necesidad distinta, no resuelta por este endpoint.

## Evidencia y reproducción

Carpeta: `uploads/reports/inventory/public-api-pilot-2026-08-23_2026-08-30/`.

- `request-result.json`: resultado y fecha de consulta, sin URL autenticada ni token.
- `response.json`: respuesta original exitosa.
- `comparison.json`: estadísticas y diferencias contra la reconstrucción local.
- [Comparacion_API_Inventario.xlsx](../uploads/reports/inventory/public-api-pilot-2026-08-23_2026-08-30/Comparacion_API_Inventario.xlsx): filas de API, registros sin identidad, diferencias locales, días sin contraparte, diferencias con archivos y control aritmético. La columna `calculated` en «Diferencias archivos» representa el valor recibido de la API.

Snapshot local: `d6250792-122c-4ecc-863c-709a4c781e3f`. Archivos utilizados:

- `1788306228602-bbfa2b9e_kardex_kardex_report__19_.xlsx`
- `1788299194662-a1cd04a7_kardex_kardex_report__29_.xlsx`
- `1789644017412-6bddc803_kardex_kardex_report__BLC_.xlsx`
- `1788197371033-d5d1740d_waste_kardex_report__3_.xlsx`

Recalcular el análisis sin conexión ni cambios en las fuentes activas:

```sh
node scripts/compare-public-inventory-pilot.js d6250792-122c-4ecc-863c-709a4c781e3f
```

El análisis reutiliza los archivos registrados en los índices locales; sus nombres quedan documentados en `comparison.json`. Si se incorporan nuevas descargas del mismo período, la selección de referencia puede cambiar.

## Adopción autorizada de la API pública

Tras la decisión del usuario de utilizar la API, se incorporó `inventorystate` a la actualización manual y programada de inventario de ambas cafeterías. Se habilitó exclusivamente el permiso de lectura de movimientos en Lyon y se actualizaron ambos locales del 23-08 al 22-09-2026. La Concepción entrega datos; Lyon respondió correctamente sin movimientos identificados. La Bodega Principal y sus bodegas de merma se consultan con La Concepción.

El informe usa las cantidades y el costo de última compra de API por bodega y fecha de corte, incluidos los ceros y las compras negativas. Los costos de productos sin dato directo pueden calcularse desde sus recetas usando costos API de sus ingredientes; no se sustituye silenciosamente un costo API por el costo del archivo o del maestro. El consumo de ventas ya no se reconstruye con las recetas actuales. Las compensaciones y consumos internos siguen aplicándose en el consolidado.

La fuente conserva los agregados diarios y la respuesta original en cada versión local; no presenta esos agregados como documentos individuales de tomas, transferencias o transformaciones. Se conservan las versiones anteriores. `last-api-read.json` permite revisar la última lectura completa incluso si falla su publicación. Las consultas comparten la cola y el límite de frecuencia de ventas/compras.

Durante la ampliación al mes completo aparecieron dos discrepancias internas de API el 09-09-2026 en la bodega del local: PAC008 tiene una diferencia de +2 UN entre el saldo informado y el calculado con sus movimientos, y SUB005 una de +0,018 KG. Se conservan ambos valores como incidencia `api-balance-discrepancy`; no se inventa un movimiento compensatorio. Un movimiento neto incompatible con sus componentes, valores inválidos o una lectura rechazada sí impiden publicar la nueva versión.

Los días omitidos se completan con el último saldo conocido entre extremos iguales, antes de una nueva toma física y hasta el fin de una consulta completa sin nuevos movimientos informados. Se marcan como `carriedForward`, nunca como nuevas tomas. Un cambio de saldo sin toma que impida explicar un intervalo se deja pendiente y no se rellena. El informe excluye productos sin cobertura suficiente.

Verificación real del consolidado del 23 al 30 de agosto: respuesta correcta, 131 productos incluidos con toma final, 10 excluidos por criterios de cobertura/identidad, todos los costos directos del consolidado con origen `toteat-api`, 34 sustituciones de leche y nueve códigos de envases evitados. La cifra de productos difiere de la reconstrucción anterior; no se completaron saldos desconocidos con ceros.

La opción principal se identifica como «Procesar inventario desde API Toteat»; el procesamiento desde archivos anteriores sigue disponible para contraste. La vista de inventario al día utiliza los saldos y costos de API cuando la ubicación ya tiene esta fuente activa; distingue ese saldo informado del consolidado con ajustes de Brewit.

**Alcance pendiente:** maestros completos siguen mediante servicios internos autenticados de Toteat; MercadoPago, marketing y colaboradores siguen con carga manual. Este cambio no convierte esas fuentes en API pública ni certifica la cobertura de merma central cuando tenga actividad.

### Corrección de valorización: prioridad a última compra

A petición del usuario, el consolidado, la merma y la consulta de inventario al día priorizan ahora la última compra comparable hasta la fecha de corte, buscando en los locales y en las compras centrales recibidas por La Concepción. Se aplican las conversiones disponibles y se excluyen devoluciones/notas de crédito de la selección de precio. No se utiliza una compra futura para valorizar un período anterior.

Sin compra comparable, se consulta el último costo positivo de inventario API disponible hasta el corte; si corresponde, se calcula la receta con los costos disponibles. Un cero API sin respaldo ya no se presenta como costo conocido: se informa «Sin costo». No se usa el maestro para inventar una compra histórica.

Verificación inicial del 23 al 30 de agosto: 62 productos valorizados desde compras; LAC001 utiliza $1.012 de la compra del 28-08. PAC014, PAC018, PAC005 y PAC002 no tienen costo verificable en las fuentes consultadas y quedan identificados sin costo. Las cantidades de inventario no se modificaron.

### Respaldo solicitado: costo del maestro

El usuario solicita usar los maestros cuando no exista compra comparable. El criterio queda: última compra hasta el corte → costo positivo del maestro compartido de ingredientes/productos, convertido a la unidad del informe → respaldo API positivo o receta cuando tampoco exista costo directo de maestro. La prioridad del maestro directo también aplica a productos con receta. Se mantiene visible el origen «Maestro» y «Sin costo» cuando no hay un antecedente utilizable. Este criterio sustituye la exclusión del maestro descrita en la corrección anterior.

## Proyección de compras con inventario API

Proyección de compras usa ahora la fuente API cuando la ubicación está migrada, sin consultar su Kardex descargado. El cálculo comparte con el informe consolidado las tomas, el avance diario, las compensaciones por leche/syrup/salsas/envases y el consumo de marketing y colaboradores disponible. Los saldos se reconstruyen desde una apertura conocida, con reinicio en las tomas intermedias; no se vuelve a sumar una transformación calculada por receta sobre la transformación API.

Para el consumo se consideran ventas, transferencias salientes y transformaciones salientes, se agregan consumos internos y se restan compensaciones. Las compras, transferencias entrantes y transformaciones entrantes modifican inventario, pero no se cuentan como consumo. La bodega operativa de cafetería es la 2 y la principal es la 1 del ambiente de La Concepción; las bodegas de merma no se suman como inventario disponible ni como una segunda salida. La transferencia hacia merma sí sale del inventario operativo.

La ventana objetivo es de 30 días hasta la fecha actual, limitada a la cobertura sincronizada. Para productos sin 30 días continuos, se reconstruye desde una toma/apertura disponible y se divide el consumo por los días efectivamente cubiertos, con advertencia visible y detalle por producto. No se tratan días desconocidos como consumo cero. Sin registros, Lyon presenta una proyección vacía y advertencia, sin fabricar inventario ni necesidades.

Se conservan criterios administrados, proveedores, UDC, empaques, órdenes seleccionadas y consolidación de demanda de las cafeterías hacia la Bodega Principal. Los productos con manejo de stock también pueden aparecer para administrar su reposición. El respaldo de costos usa compras y maestros conforme al informe de inventario.

Validación real al 22-09-2026: La Concepción presenta 140 ítems elegibles (10 con historial parcial entre los productos reconstruidos); Bodega Principal, 119; Lyon, ninguno por ausencia de inventario informado. La comparación con el consolidado del 24-08 al cierre del 22-09 coincide en los 131 productos comparados. SAN021: 0,081 UN; SAN010: 0,003 KG. Pruebas: 141 aprobadas, incluyendo reinicios por toma física, compensaciones, transformaciones, aislamiento de bodegas y cobertura parcial.

## Recuperación de actualización de maestros compartidos

El 22-09-2026 se corrigió la conexión del lector: estaba utilizando un perfil de navegador distinto de la sesión autenticada. Ahora permite configurar el navegador local en `uploads/.integrations/toteat/browser-connection.json` (`cdpEndpoint`), con prioridad para la configuración explícita y la variable `TOTEAT_CDP_ENDPOINT`, y reutiliza la pestaña autenticada sin cerrarla al terminar. El endpoint debe ser localhost.

Se comprobaron dos lecturas consecutivas y la publicación mediante el botón de actualización: a las 17:05 de Santiago quedaron publicados los seis maestros, con 240 productos, 128 ingredientes, 53 extras, 286 recetas (1.187 líneas), jerarquías de productos/ingredientes/extras de 22/13/15 registros y 42 proveedores. El estado del proceso pasó a completado.

Los maestros completos siguen dependiendo de los servicios internos y de una sesión web vigente; no se presentan como API pública. Si el navegador no está disponible o no se confirma el local, el proceso informa un diagnóstico específico y conserva la última versión compartida completa. El navegador conectado debe permanecer abierto para las actualizaciones programadas.

## Hallazgos: fuentes sincronizadas y saldos corregidos

Hallazgos prioriza las ventas API por fecha de cierre cuando existe una sincronización, sin mezclarlas con descargas anteriores. Las compras API se auditan por bodega: 2/3 para cafeterías y 1/4 para Bodega Principal desde La Concepción. Las líneas sin bodega reconocida se advierten; no se asignan arbitrariamente. La fecha documental de compras se mantiene para auditoría comercial; los movimientos del inventario provienen del saldo diario API.

El inventario utiliza el mismo cálculo de Proyección de compras y del informe de inventario: apertura conocida, movimientos, tomas intermedias, compensaciones y consumos de marketing/colaboradores. El cálculo acepta el período de Hallazgos, además del predeterminado de 30 días. La falta de cobertura o de inventario en Lyon no se considera stock cero. Solo ubicaciones sin inventario API conservan la lectura histórica, identificada en las fuentes.

Los costos priorizan la última compra comparable entre locales, excluyen notas de crédito y cantidades no positivas, y utilizan el maestro como respaldo antes de la receta. Los productos con manejo de stock no generan la alerta de venta sin receta. Las comparaciones de costos maestros y compras convierten las unidades antes de calcular el porcentaje.

Las fuentes mostradas incluyen los seis maestros compartidos, ventas, compras, inventario, consumos internos disponibles y órdenes locales. Se conservan identificadores, observaciones y cierres. Los hallazgos abiertos del modelo anterior que no se reconocen en la nueva revisión quedan guardados, pero no se suman a las alertas actuales; la pantalla informa cuántos son.

Validación real del 24-08 al 22-09-2026 para todas las ubicaciones: 4.273 filas de ventas, 105 líneas de compras y 6 órdenes; 30 hallazgos abiertos y 2 cerrados. Se conservaron 178 registros abiertos de fuentes anteriores fuera de esta revisión. Se informan coberturas parciales de inventario y el inicio de sincronización de Lyon el 14-09.
