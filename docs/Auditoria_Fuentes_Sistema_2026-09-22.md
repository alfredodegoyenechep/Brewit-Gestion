# Auditoría de fuentes del sistema — 22 septiembre 2026

## Política activa

Esta instalación tiene `uploads/config/source-policy.json` con `mode: synchronized`. Los selectores compartidos de ventas, pagos, compras y maestros excluyen las descargas históricas. El selector de inventario/merma lee los registros diarios de API pública. No se borraron archivos antiguos.

Una fuente sincronizada puede estar materializada en un XLSX local generado por Brewit: esto no es una descarga manual antigua. Los módulos consumen la última sincronización guardada, no realizan una consulta en vivo a Toteat por cada pantalla. Las frecuencias y las fechas de lectura siguen siendo relevantes.

La política es global: también aplica a nuevos locales sin sincronización. No se recupera un archivo antiguo si falta la fuente API. Las instalaciones sin esta política conservan compatibilidad histórica; las pruebas de compatibilidad no deben confundirse con el modo activado en Brewit.

## Módulos y fuentes

| Módulo | Fuente de cálculo con la política activa |
|---|---|
| Resumen general, ventas semanales y red de cafeterías | Ventas sincronizadas Toteat |
| Ventas y detalle de pagos | Datos API guardados; sin mezcla con descargas |
| Demanda, análisis horario y análisis de productos | Ventas API, maestros compartidos sincronizados y costos de compras API |
| Productos, ingredientes, extras y jerarquías | Maestros compartidos sincronizados desde La Concepción |
| Recetas y consumo/ventas por ingredientes | Recetas compartidas sincronizadas; ventas y movimientos API |
| Compras | API, separada por bodegas 2/3 de cafetería y 1/4 de Bodega Principal; Central se incluye una vez en la consulta global |
| Costos, variaciones y proveedores | Compras API y maestros sincronizados; última compra comparable, sin notas de crédito como costo de reposición |
| Proyección de compras | Inventario API con tomas, movimientos, compensaciones y consumos internos; compras y maestros sincronizados |
| Inventario consolidado y calendario | Tomas y movimientos API; fechas inicial/final como límites; no Kardex descargado |
| Inventario al día | Saldo informado por API, identificado como tal; el consolidado/proyección incorporan ajustes propios de Brewit |
| Merma y fuentes de inventario | Bodegas de merma API; vista previa de registros diarios sincronizados |
| Resultados financieros | Ventas/compras API y maestros sincronizados; marketing/colaboradores, MercadoPago y gastos locales como fuentes explícitas |
| Diferencia de inventario en resultados financieros | Cálculo de apertura/movimientos/compensaciones con conteo físico de cierre; no disponible cuando falta cierre físico completo o costo verificable |
| Hallazgos | Selectores sincronizados, inventario corregido y órdenes locales; conserva historial de observaciones/cierres |
| Conciliación/auditoría de transacciones | Ventas y pagos API frente a MercadoPago manual |
| Cargar archivos y ventanas de consulta | Fuentes sincronizadas actuales; cargas manuales autorizadas para MercadoPago, marketing y colaboradores |
| Órdenes de compra, gastos, configuración y criterios | Registros propios de Brewit; no son fuentes Toteat |

## Excepciones explícitas

- Los maestros completos utilizan servicios internos de Toteat con sesión web, **no la API pública con token**. Sigue siendo necesario mantener esa conexión disponible.
- MercadoPago, marketing y colaboradores siguen siendo archivos cargados manualmente. No se ha inventado una integración API para estas fuentes.
- Los informes/snapshots guardados y los archivos históricos conservan su carácter histórico. No son entradas de la nueva selección operativa. Los endpoints explícitos de vista previa de archivos y los scripts de conciliación histórica permiten inspeccionarlos; no alimentan los cálculos actuales.
- Sin historial maestro sincronizado anterior a un período, se usa el maestro observado disponible. Esto se informa en la política visible; no certifica las recetas o los costos maestros originales de agosto.
- Fuera de cobertura API no se puede concluir actividad cero. La política visible muestra los inicios de sincronización por local y las respuestas de reportes advierten cuando el rango empieza antes de la cobertura.

## Verificación

Pruebas de regresión incluyen archivos descargados de venta/Kardex deliberadamente presentes: con la política sincronizada no se leen, incluso sin primera sincronización API. También se comprueba que un maestro manual más nuevo no reemplace al sincronizado.

Se verificaron respuestas reales satisfactorias de resumen de ventas, reporte semanal, compras, productos, ingredientes de Bodega Principal, ventas por ingredientes, resultados financieros, fuentes de inventario, merma, proyección de cafetería, proyección de Bodega Principal y análisis de demanda. Se comprobó que resultados financieros indica diferencia no disponible cuando no existe cierre físico completo, en lugar de deducir una pérdida desde saldos teóricos.

Los avisos de calidad/cobertura son parte del resultado: no constituyen una garantía de que Toteat o las recetas observadas no contengan errores. Esta revisión elimina el uso implícito de las descargas obsoletas en los selectores operativos.

Validación final: 144 pruebas aprobadas. También respondieron correctamente conciliación de transacciones, revisión y variaciones de costos, análisis de productos, análisis horario, inventario API y calendario. Una solicitud a procesar inventario con `source: files` devolvió `Inventario API pública Toteat`, verificando que el servidor impide la vuelta al Kardex descargado incluso desde una interfaz anterior.

## Corrección de comparabilidad de costos por unidad

El historial anterior separaba referencias por unidad de compra. Así, una compra nueva en UN podía compararse con una compra antigua en UN, ignorando cajas posteriores convertibles al mismo producto. Se unificó la secuencia por ubicación, proveedor, código y unidad comparable. El costo base usa el precio efectivo dividido por la conversión; el precio registrado por presentación se conserva por separado. Las notas de crédito y cantidades no positivas no reemplazan la referencia de costo. Las unidades no convertibles no se comparan como si fueran unidades base.

Compras, variaciones y Hallazgos usan esta comparación. Los resolutores compartidos de costos reciben el costo efectivo convertido; Ingredientes evita atribuir al precio de un envase una unidad base cuando falta conversión. Proyección deja de escoger una presentación distinta para completar la conversión de una compra existente. Los precios proyectados por UDC permanecen expresados en la misma UDC utilizada para la cantidad sugerida.

Caso BOL008: 25-08, 1 CAJ de 36 UN a $38.960 = $1.082,222222 por UN; 22-09, 36 UN a $1.082,50 por UN. Variación real +0,025667%, sin hallazgo de caída de 97,2%. Se regeneró Hallazgos conservando registros y observaciones históricos. El documento del 08-07 figura como 1 UN a $38.000; se conserva esa información y no se infiere una caja sin confirmación documental.

## Diferencia de inventario mensual digitada

La tabla de Gastos Generales incorpora Diferencia de Inventario ajustada para cada cafetería. Se guarda por ubicación y mes: vacío (`null`) conserva el cálculo automático, cero es un reemplazo explícito y un monto firmado reemplaza el resultado automático del mes. Positivo representa gasto/pérdida; negativo representa sobrante. Se prorratea por días incluidos, igual que el resto de la base mensual. En períodos que abarcan varios meses, los no informados conservan su cálculo automático; si falta esa información, se indica cobertura incompleta.

El valor se presenta únicamente en la fila `inventoryDifference` del estado de resultados, sin agregar otra fila de gasto general. La pantalla identifica el uso de valores manuales. No altera Kardex, tomas físicas ni movimientos Toteat.
