# Inventario independiente del Kardex de Toteat

Activado el 28-09-2026. La sincronización operativa ya no consulta `inventorystate` ni usa sus saldos o costos. Las capturas anteriores se conservan como histórico; el modo de fuentes sincronizadas exige `native-documents`.

## Fuentes y cálculo

- Tomas físicas, transformaciones y transferencias entre bodegas: documentos originales de Toteat, con sesión autorizada. Solo documentos aprobados afectan cantidades.
- Compras: API de compras, por fecha y cantidad recibidas y bodega de cada línea.
- Ventas: órdenes y recetas del maestro compartido. Los productos con control de stock consumen producto terminado; sus transformaciones consumen ingredientes.
- Marketing, colaboradores, calibraciones y compensaciones de sustituciones/envases: se incorporan en los reportes y saldos ajustados, una sola vez.
- Valoración: compras y maestros/recetas. Sin antecedente, el costo queda no disponible.

Los cambios de versión de compras, ventas o maestro reconstruyen el cálculo local desde los documentos conservados. No requieren una nueva lectura del Kardex de Toteat. Una sincronización de inventario vuelve a leer los documentos originales.

## Verificación con datos reales

Captura desde 23-08-2026 hasta 28-09-2026 para La Concepción y sus bodegas: 6 tomas, 82 transferencias y 266 transformaciones aprobadas; 2.826 órdenes incorporadas. Portal Lyon no devolvió documentos originales en este período y conserva advertencias de cobertura.

Reporte HTTP de inventario desde apertura 30-08-2026 hasta apertura 19-09-2026:

| Producto | Ubicación | Compras |
|---|---|---:|
| CCB001 | La Concepción | 0 kg |
| CCB001 | Bodega Principal | 3,40 kg |

Ambos reportes identifican su fuente como «Kardex propio Brewit · documentos originales». La factura 22978 ya no genera una compra local. El documento conserva ambas líneas en Bodega Principal.

## Límites visibles

Las recetas corresponden al maestro observado, no a una historia certificada de recetas. Las tomas se aplican al inicio de su fecha operativa. Se conservan 47 incidencias de referencias históricas ausentes del maestro y una advertencia agregada de aperturas desconocidas en La Concepción. Los productos sin apertura conocida se excluyen, no se consideran saldo cero. Las devoluciones ambiguas y transferencias entre locales no certificadas se informan; no se inventan movimientos. Sin una toma física de cierre no se presenta una diferencia física definitiva.

Pruebas de regresión cubren reemplazo de compras al corregir bodega, movimientos y transformaciones, conteos intermedios, compensaciones, valoración sin costos del Kardex externo y preservación de versiones ante una lectura fallida.
