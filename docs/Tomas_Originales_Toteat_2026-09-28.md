# Tomas originales de inventario de Toteat

Se verificó la fuente interna autenticada `https://inventory.toteat.com/take-inventory/`, consultada por `local_ref`, `init_date` y `finish_date`. Se accede con la sesión local de Toteat autorizada por el usuario. Las lecturas son GET; no se crean ni modifican tomas en Toteat.

La fuente entrega ID de documento, estado, bodega, fecha operativa (`registration_date`), fechas de creación/aprobación y detalle `take_inventory_products` por producto, cantidad y unidad. Los estados no aprobados se conservan, pero no se marcan como contabilizados. Los ceros se conservan como conteos válidos.

Actualización inicial: 23-08-2026 a 28-09-2026.

| Local / bodega | Fecha operativa | Documento | Líneas | Estado |
|---|---|---:|---:|---|
| La Concepción · Local | 23-08-2026 | 28815 | 135 | APPROVED |
| La Concepción · Merma local | 23-08-2026 | 29690 | 143 | APPROVED |
| La Concepción · Central | 28-08-2026 | 29471 | 119 | APPROVED |
| La Concepción · Local | 30-08-2026 | 29630 | 144 | APPROVED |
| La Concepción · Merma local | 30-08-2026 | 29691 | 143 | APPROVED |
| La Concepción · Local | 18-09-2026 | 32640 | 139 | APPROVED |

Total: 6 documentos, 823 líneas. Portal Lyon devolvió 0 documentos dentro del mismo rango; no se infieren tomas ni existencias cero.

## Integración

- Guardado independiente y versionado en `uploads/.integrations/toteat-api/original-counts/<local>/`, con respuesta original y registros normalizados. La publicación utiliza un puntero atómico y preserva la versión anterior si falla la lectura.
- Datos y sincronización → Tomas de Inventario consulta ahora documentos originales. Bodega Principal muestra las tomas centrales, leídas desde La Concepción.
- La actualización general y la actualización de inventario incluyen una lectura de tomas originales mediante la sesión autorizada. Las fuentes de movimientos agregados y tomas tienen estado y cobertura propios.
- Ruta específica: `POST /api/integrations/toteat/counts/sync` con `location`, `from`, `to`; estado en `GET /api/integrations/toteat/counts/status`.
- CLI: `node scripts/sync-toteat-counts.js store-1 YYYY-MM-DD YYYY-MM-DD`.
- Las respuestas paginadas o incompletas se rechazan; no se publica silenciosamente una parte del período.

Esta integración actualiza la fuente y consulta de tomas físicas. No cambia todavía el motor activo de movimientos/saldos, que sigue usando `inventorystate`. La reconstrucción completa del Kardex requiere integrar y verificar los documentos originales de los demás movimientos. No se sustituyen entradas, saldos ni diferencias del Kardex activo solo con este cambio.

Se corrigió además una importación ausente de `readNative` en el lector de documentos de la sesión web. Se verificó la lectura real en ambos locales y 16 pruebas de integración/modelo.
