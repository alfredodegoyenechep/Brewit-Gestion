# Kardex propio de Brewit a partir de los datos de Toteat

Revisión del 21 de septiembre de 2026. Alcance: investigación de fuentes, bodegas y diseño; no se activó una sincronización de inventario ni se modificaron existencias.

## Conclusión

Hay una vía concreta para construir un Kardex propio: importar los registros que alimentan el **Kardex detallado de Toteat** y generar sobre ellos nuestras vistas de movimientos y resumen diario. Se comprobó su lectura en la sesión autorizada. Esto todavía no demuestra una integración completa y estable para todas las bodegas y todos los tipos de operación.

La API pública `/inventorystate` es útil como control de saldos y agregados. Su esquema publicado no demuestra que permita reproducir por sí solo todas las columnas del Kardex actual. Las fuentes detalladas observadas son **servicios internos de la aplicación web**, distintos de la API pública que ya usa Brewit. No se accedió directamente a una base de datos de Toteat.

## Bodegas verificadas en la cuenta

Se consultó el selector y la respuesta de bodegas de ambos locales. Hay cuatro bodegas en cada ambiente, no dos bodegas centrales idénticas en Lyon.

| Ambiente Toteat | Código observado (`custom_id`) | Nombre vigente en Toteat | Interpretación en Brewit |
|---|---:|---|---|
| Local 001 | 1 | Bodega Central Local 001 La Concepcion | Bodega Principal de Brewit |
| Local 001 | 2 | Bodega Local 001 La Concepcion | Inventario operativo de La Concepción |
| Local 001 | 3 | Bodega Merma Local 001 Local La Concepcion | Merma de La Concepción |
| Local 001 | 4 | Bodega Merma Central Local 001 La Concepcion | Merma de la Bodega Principal |
| Local 002 | 1 | Bodega Central Local 002 Lyon | Central de Lyon; uso operativo por definir |
| Local 002 | 2 | Bodega Local 002 Lyon | Inventario operativo de Lyon |
| Local 002 | 3 | Bodega Merma Local 002 Lyon | Merma de Lyon |
| Local 002 | 4 | Bodega Central Merma Local 002 Lyon | Merma de la central de Lyon; uso operativo por definir |

Los códigos 1–4 se repiten entre locales. Debemos guardar restaurante, local de origen, referencia interna de bodega y código externo. La correspondencia exacta de estos códigos con `warehouse_id` de la API pública aún requiere una prueba de ese endpoint. Los nombres tienen versiones anteriores: la identidad no debe depender del texto visible.

La Bodega Principal será una ubicación lógica de Brewit con origen técnico en el Local 001. Una compra o movimiento leído con credenciales de La Concepción no debe atribuirse automáticamente a su bodega operativa: hay que consultar la bodega de cada línea. La central de Lyon no será un alias de la Bodega Principal.

## Fuentes comprobadas y límites

### Kardex detallado de la aplicación web

La interfaz consultó rutas `/kardex/` y `/kardex/{product_ref}`, además del directorio de bodegas. En el detalle se observaron filtros `local_ref`, `warehouse_ref`, `init_date`, `finish_date` y `timezone`.

La respuesta observada contiene:

| Campo | Uso propuesto |
|---|---|
| `product_ref`, `warehouse_ref` | Identidades originales de producto y bodega |
| `quantity`, `measure_unit_ref` | Cantidad y unidad del movimiento |
| `registration_date` | Fecha/hora de registro; verificar su relación con fecha operativa y turno |
| `move_id`, `type_move_id` | Sentido y clasificación; validar el catálogo completo de códigos |
| `description` | Referencia visible, por ejemplo transformación o transferencia numerada |
| `quantity_total` | Saldo informado después del registro |
| `cost`, `cost_average`, `cost_last_inbound`, `cost_total` | Costos y valoración originales, conservados por separado |

Para `CAF001` se observaron dos registros en la Bodega Principal y ocho en la bodega del local dentro del período seleccionado en la interfaz. El detalle incluyó una transformación y transferencias entre bodegas; algunas cantidades eran cero y deben conservarse como evidencia, sin convertirlas en salidas ficticias.

Para **`LAC001`, en la bodega operativa de La Concepción**, se obtuvo una muestra de septiembre de **1.121 registros**: 1.106 salidas por venta, cuatro movimientos de compra y once registros de transferencia entre bodegas. Se observaron combinaciones `move_id=1` para entradas y `move_id=2` para salidas; `type_move_id=2` para compra, `3` para venta y `8` para transferencia entre bodegas. En la muestra de café se observó `6` para transformación. Son correspondencias observadas, no un catálogo completo de tipos.

La suma firmada de esa secuencia fue **296 L de entradas netas y 341,399 L de salidas**. Las cantidades recibidas de las cuatro líneas de compras ya importadas para ese ingrediente también sumaron 296 L: 120 + 120 − 4 + 60, incluyendo una nota de crédito. No deben convertirse todas las cantidades a valor absoluto. El saldo anterior al primer movimiento, inferido desde su cantidad y saldo posterior, fue **168,741 L**; el saldo final resultó **123,342 L**. Las 1.120 transiciones entre filas conciliaron con tolerancia de 0,000001 L. Esto valida la consistencia interna de la muestra, no un conteo físico independiente ni todo el Kardex.

La primera referencia de venta consultada coincidió con `orderId` de nuestra API de ventas, y su `registration_date` coincidió con `dateClosed`. Esa referencia no era el ID del pago. La transformación de fechas a hora chilena debe respetar esta evidencia y verificarse especialmente en cambios de día; la consulta interna también incluye un parámetro de zona horaria.

**Advertencia de identidad:** `move_id` se repite: se observaron valores 1 y 2 asociados a entradas y salidas. No es un identificador único de transacción. La muestra tampoco entregó un ID único explícito de línea de movimiento. Antes de sincronizar incrementalmente hay que conseguir ese ID o reemplazar particiones completas de producto/bodega/período, conservando multiplicidad y versiones. Eliminar filas idénticas por contenido podría perder movimientos legítimos.

Estos servicios prueban que la aplicación dispone de datos más detallados. Falta confirmar su acceso soportado para integradores, paginación, límites, cobertura histórica, correcciones y lectura masiva. Una sesión web no equivale a un contrato de API estable.

### API pública de inventario

El esquema de `/inventorystate` contempla producto, unidad, bodegas y registros diarios con saldo inicial, indicador de toma física, compras, uso, transformación, saldo final y costo. No publica campos separados para transferencias locales/entre bodegas ni para entradas y salidas brutas de transformación. Un neto de transformación cero podría ocultar entradas y salidas iguales. [Esquema oficial](https://developers.toteat.com/components/schemas.yaml).

La ruta limita las consultas a 15 días, trabaja con turnos y describe su costo como estándar. La explicación de `use` y el ejemplo del esquema no son uniformes en el signo: debe comprobarse con operaciones reales. Brewit descarga actualmente el Kardex con **Costo Última Compra**; no debemos sustituirlo silenciosamente por costo estándar. [Ruta oficial de inventario](https://developers.toteat.com/paths/inventorystate.yaml).

No se probó una respuesta real de `/inventorystate` en esta revisión. Sus posibles campos adicionales siguen pendientes de validar.

### Ventas, compras, recetas y transferencias

- Las compras ya importadas aportan documento, producto, cantidades y bodega de línea. Para stock interesa la **recepción física**, su unidad y su fecha, no simplemente la cantidad facturada o la fecha de emisión. Las recepciones parciales y las notas de crédito requieren comprobar el movimiento físico.
- Las ventas sirven para conciliar `USO`. Recalcular consumo exige recetas y subrecetas vigentes a la fecha, extras, sustituciones, rendimientos y reversos de inventario reales. Una devolución de dinero no implica que el ingrediente vuelva al stock.
- La ruta pública `/products` es un menú comercial; no se verificó allí una tabla completa de recetas históricas. Los maestros existentes pueden apoyar un cálculo propio, pero no deben hacerse pasar por el consumo efectivamente registrado por Toteat. [Menú público](https://developers.toteat.com/paths/products.yaml).
- Existe un webhook de transferencias multilocal, sujeto a Inventario Avanzado, modo multilocal y ambiente migrado. Notifica estados; no demuestra por sí solo acceso al histórico ni a transferencias internas de bodega. No se activó. [Webhook oficial](https://developers.toteat.com/webhooks/transfer_webhooks.yaml).

## Modelo propuesto

| Tabla propia | Contenido |
|---|---|
| Bodegas | Identidad técnica, ubicación lógica, tipo operativa/central/merma, vigencia y estado |
| Productos y equivalencias | Referencias originales, SKU, unidad base, conversiones con vigencia y productos inactivos |
| Capturas de origen | Respuestas originales, filtros, fecha de consulta, versión y resultado de validación |
| Movimientos de inventario | Fuente, referencia, fecha efectiva y de registro, tipo, estado, documento, relación con reverso/corrección |
| Líneas de movimiento | Bodega, producto, entrada/salida, unidad y cantidad originales, cantidad base, costo y saldo informados |
| Conteos y saldos de control | Toma física, turno si está disponible, saldo inicial/final y diferencias de conciliación |
| Recetas y producciones | Versiones y lotes para explicar transformaciones; separar datos originales de estimaciones propias |
| Kardex diario | Vista calculada sobre los movimientos, con las mismas columnas del archivo actual |

Los importes y cantidades deben conservar precisión decimal. Los IDs originales, referencias a documentos y estados deben persistirse sin reemplazarlos por nombres.

## Reglas para reproducir el Kardex actual

La vista diaria debe conservar `II`, `BUY`, `TRL-IN`, `TRL-OUT`, `MOV-IN`, `MOV-OUT`, `TRN-IN`, `TRN-OUT`, `USO`, `IF` y el costo elegido. Se verificaron esas columnas en los archivos actuales de Bodega Principal, La Concepción y Merma.

La igualdad de control será: **saldo final = saldo inicial + entradas − salidas**, incluyendo los ajustes que correspondan al intervalo. Si una toma física reinicia el inventario inicial de un turno, la diferencia con el saldo anterior debe explicarse una sola vez; no agregar además un ajuste ya incorporado en ese saldo.

Una transferencia conserva dos líneas vinculadas: salida de origen y entrada en destino. Para envíos pendientes de recepción conviene representar stock en tránsito. El movimiento a una bodega de merma se registra como salida de la bodega operativa y entrada en merma; no se contabiliza como dos pérdidas. La vista de stock disponible para venta excluye merma.

**Ejemplo real del archivo actual:** `B2770` en La Concepción, el 04/08, muestra inventario inicial 2, transformación entrante 10, consumo por ventas 12 y final 0. La producción de esos diez sándwiches ya puede haber consumido ingredientes. Descontar otra vez toda su receta al venderlos duplicaría el consumo. Por eso recomendamos utilizar el movimiento de stock original como fuente principal y las ventas/recetas como conciliación.

No se deben fabricar transferencias a partir de la diferencia entre inventario inicial y final. Tampoco usar el saldo diario y, además, descontar otra vez las compras o ventas ya incorporadas.

## Piloto recomendado antes de sustituir los archivos

1. Guardar el mapa de las ocho bodegas, confirmando el uso operativo de las dos centrales de Lyon.
2. Confirmar con Toteat una lectura soportada del libro de movimientos: endpoint, ID único de cabecera/línea, tipos, fechas, turnos, paginación, modificaciones, anulaciones y bajas de productos. La consulta observada sirve como referencia concreta para esa conversación.
3. Leer una semana cerrada de las cuatro bodegas del Local 001. Comparar el detalle original, el resumen reconstruido y los archivos de control, por SKU/bodega/día y por cada clase de movimiento.
4. Exigir que concilien saldos iniciales/finales y movimientos, explicando todos los cambios de conteo y diferencias de valoración. Probar repetición sin duplicados, correcciones retroactivas, una transferencia, una transformación, una merma y una recepción parcial.
5. Incorporar Lyon desde sus primeras recepciones y transferencias, incluso antes de sus primeras ventas. La apertura comercial no es necesariamente el inicio del inventario.
6. Publicar el Kardex propio después de la conciliación; conservar como respaldo los archivos y distinguir los datos originales de cualquier cálculo estimado.

La recomendación es reconstruir **la presentación y los controles** sobre el libro de inventario original. Si Toteat no ofrece acceso suficiente a ese libro, podemos calcular un inventario teórico con fuentes parciales, pero no certificarlo como equivalente al Kardex de Toteat.

Las muestras de café y leche y el resumen de verificación quedaron en `uploads/.integrations/toteat-api/inventory-review-2026-09-21/`, con permisos privados y fuera de las rutas públicas y de Git. No contienen credenciales. Esta revisión no activó webhooks ni escribió movimientos en Toteat.
