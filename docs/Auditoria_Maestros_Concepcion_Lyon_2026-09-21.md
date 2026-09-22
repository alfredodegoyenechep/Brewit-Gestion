# Auditoría de maestros: La Concepción y Lyon

Fecha de revisión: 21 de septiembre de 2026, aproximadamente 23:37, hora de Chile.

**Los maestros no son idénticos.** Las tres jerarquías coinciden; las diferencias que requieren mayor atención están en las recetas de Lyon. El catálogo y los proveedores tienen los mismos códigos en ambos locales, pero algunos campos difieren.

Esta auditoría es de lectura. No modifica Toteat ni publica nuevas versiones de los maestros compartidos de Brewit. La Concepción continúa siendo la fuente de esos maestros compartidos.

## Resultado de los seis maestros

| Maestro | La Concepción / Lyon | Resultado |
|---|---:|---|
| Productos, ingredientes y extras | 421 / 421 | Mismos códigos; 246 registros iguales y 175 diferentes, excluyendo recetas, comparadas aparte. |
| Jerarquía de productos | 22 / 22 | Iguales, incluyendo raíz, nombres, relaciones y orden. |
| Jerarquía de ingredientes | 13 / 13 | Iguales, incluyendo raíz, nombres, relaciones y orden. |
| Jerarquía de extras | 15 / 15 | Iguales, incluyendo raíz, nombres, relaciones y orden. |
| Recetas con componentes | 286 / 283 | Tres vacías en Lyon y 114 recetas comunes con componentes faltantes. Además, 53 recetas comunes difieren solamente en costo. |
| Proveedores | 42 / 42 | Mismos códigos; 41 iguales y una diferencia de ingredientes asociados a UPA. |

## Recetas: corrección prioritaria en Lyon

La Concepción tiene 1.187 líneas de componentes y Lyon 1.035. Las **152 líneas faltantes** en Lyon corresponden exclusivamente a:

| Componente | Nombre | Recetas afectadas |
|---|---|---:|
| SUB005 | SUB BLEND 702 GRANO 1KG INTERNO | 96 |
| SUB014 | CREMA CHANTILLY SIFON | 56 |

Son **117 recetas distintas afectadas**: algunas llevan ambos componentes. De ellas, tres quedan completamente vacías y otras 114 conservan solo parte de sus componentes. No hay líneas adicionales en Lyon ni cambios de cantidad, unidad, rendimiento o visibilidad en los componentes conservados. Ambos subproductos existen en los dos catálogos y tienen sus propias recetas; faltan sus referencias dentro de las recetas que los utilizan. La causa de esa omisión no se ha determinado.

Las tres recetas vacías en Lyon son:

| Código | Receta | Componente que tiene La Concepción |
|---|---|---|
| BX1040 | Crema Adicional | SUB014: 30 G |
| BX1290 | Shot SImple Cafe | SUB005: 12 G |
| BX1300 | Shot Doble Cafe | SUB005: 18 G |

Ejemplo comprobado: **B1000, Expresso Doble (Exp)**, tiene vaso y 18 G de SUB005 en La Concepción; en Lyon solamente tiene el vaso. Según la regla de consumo de recetas utilizada para construir el Kardex, esa composición no permitiría calcular el consumo de café de la venta correctamente. Conviene corregir estas composiciones antes de comenzar a operar Lyon y comprobar después una venta y su consumo de inventario.

Entre las 283 recetas con componentes en ambos locales, 116 coinciden íntegramente y 167 presentan alguna diferencia. Estas últimas se descomponen en 114 con diferencia de composición y 53 con diferencia solo de costo. En total, 155 recetas comunes tienen costos distintos; este número se superpone con las diferencias de composición y no debe sumarse al anterior.

El costo guardado de una receta no demuestra que su composición esté completa: B1000 mantiene prácticamente el mismo costo en ambos locales, aunque Lyon no tiene la línea de café.

## Catálogo: costos y dos artículos internos

Los nombres, precios de venta, estados, unidades base, indicadores de manejo de stock y asignaciones de jerarquía coinciden. No faltan códigos en Lyon.

De los 175 registros con diferencias:

- **173 difieren únicamente en costos.** Hay 157 diferencias en `cost`, 16 en `cost_last_purchase` y 21 en `cost_weighted_average`; un artículo puede aparecer en más de un campo. Los costos de última compra y promedio pueden depender del historial de cada local, por lo que una diferencia no demuestra por sí sola un error de configuración. La auditoría no determina la causa de cada diferencia de costo.
- **Dos son artículos internos de Toteat:** `TOTEATDVYCOST` (Costo Delivery) y `TOTEATDVYERROR` (Producto ERROR Integraciones). En Lyon tienen listas o valores vacíos donde La Concepción conserva configuraciones de conversión, bodega, fabricación, transferencia y datos alternativos. Se detallan en el Excel; no corresponden a las omisiones de café y crema.

La auditoría compara bodegas por su código dentro de cada local, no por su identificador interno ni por su nombre específico de sucursal. Esta equivalencia sirve para comparar la configuración del maestro y no implica que las bodegas físicas sean la misma entidad en el Kardex de Brewit.

## Proveedores

La única diferencia funcional encontrada es el proveedor **15, UPA**:

- La Concepción tiene asociados `CCB003` (Crumble Cookies) y `SAN014` (Queso Mantecoso Quilque laminado Soprole).
- Lyon tiene asociado únicamente `SAN014`: falta la asociación de `CCB003`.

Los proveedores se identificaron por su código, no por RUT, porque hay códigos distintos que comparten RUT en ambos locales. No se detectaron otras diferencias funcionales de proveedores.

## Evidencia y método

Se compararon capturas nuevas de los servicios internos autenticados de Toteat. Estas fuentes contienen el maestro completo utilizado por su aplicación; no se trata de consultas SQL ni de afirmar que todos estos campos estén disponibles en la API pública con token.

- Captura La Concepción: `2026-09-22T02:36:47.402Z`.
- Captura Lyon: `2026-09-22T02:37:04.620Z`.
- Emparejamiento por códigos de artículos, recetas, proveedores y nodos de jerarquía.
- Se excluyeron identificadores propios de cada local, usuarios, marcas temporales, versiones y procedencia de copias. Se normalizaron listas vacías frente a campos ausentes y el orden de listas sin significado funcional.
- Se usó tolerancia absoluta de `0,00000001` para evitar falsos positivos por representación decimal. No se aplicó la tolerancia de aproximadamente 5% contemplada para el piloto histórico de consumo: esta revisión compara maestros actuales.
- Se verificaron código, cantidad, unidad, rendimiento y visibilidad de los componentes contra la representación del maestro que utiliza la aplicación de Toteat, para todos los artículos de ambos locales: **cero discrepancias entre las dos representaciones**.
- Las sumas cierran: 1.187 − 152 = 1.035 líneas; cero líneas adicionales en Lyon.

El resultado describe el estado de las capturas, no acredita igualdad histórica ni cambios posteriores.

## Archivos entregables

- [Excel con detalle completo](../uploads/reports/masters/audit-2026-09-21/Auditoria_Maestros_Concepcion_Lyon.xlsx): resumen, campos distintos del catálogo, las 152 líneas faltantes con código de receta y cantidad, recetas vacías, costos, estado de cada receta, proveedores, jerarquías y método.
- [Comparación estructurada JSON](../uploads/reports/masters/audit-2026-09-21/comparison.json).
- [Script reproducible](../scripts/audit-toteat-masters.js): ejecutar desde la raíz del repositorio con `node scripts/audit-toteat-masters.js`. Lee las capturas privadas existentes; no obtiene una nueva captura ni escribe en Toteat o en los maestros publicados.

Para homologar Lyon, la primera acción es restaurar las referencias a SUB005 y SUB014 de las 117 recetas indicadas, tomando La Concepción como referencia; luego agregar CCB003 al proveedor UPA y revisar los costos según su naturaleza. Usar los maestros compartidos de La Concepción en Brewit no corrige automáticamente las recetas que Toteat tiene guardadas para Lyon.
