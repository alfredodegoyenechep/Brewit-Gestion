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
