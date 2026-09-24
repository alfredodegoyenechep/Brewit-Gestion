# Solicitud de acceso de integración a maestros completos

Estado: borrador para Toteat; no enviado. Revisión de documentación: 24-09-2026.

Necesitamos sincronizar en modo de solo lectura los maestros completos de La Concepción, fuente compartida de Brewit, sin login interactivo, captura de cabeceras del navegador ni renovación dependiente de una sesión personal.

La API pública funciona con token para ventas, pagos, compras e inventario. `/products?activeProducts=false` devuelve el menú y extras, pero la especificación publicada no cubre todos los ingredientes, recetas, conversiones y proveedores requeridos.

Solicitamos confirmar si existe una API para integradores o una credencial de servicio soportada para leer:

1. Productos, ingredientes y extras, activos e inactivos, con costos, unidades y configuración de stock.
2. Jerarquías completas y asignaciones de productos, ingredientes y extras.
3. Recetas y subrecetas con cantidades, unidades, rendimiento y restricciones de transformación.
4. Conversiones, presentaciones y empaques.
5. Proveedores y bodegas.

Las lecturas completas utilizadas hoy por la aplicación son `/locals/{localRef}/products/`, `/locals/{localRef}/providers/`, `/locals/{localRef}/warehouses/` y `/resto/setupconfig` para los módulos 5100, 5115 y 5110. ¿Están soportadas para integradores? ¿Qué mecanismo de autenticación de servicio, permisos de lectura y renovación ofrecen? Si existe otra API, solicitamos su contrato, paginación, límites, expiración, revocación y alcance por restaurante/local.

No adjuntar tokens, contraseñas ni cabeceras de sesión a esta solicitud.

Fuentes oficiales revisadas:
- https://developers.toteat.com/toteatApi_v2.yaml
- https://developers.toteat.com/paths/products.yaml
- https://developers.toteat.com/tags/config_tag.yaml

Hasta recibir y validar una alternativa soportada, Brewit mantiene el último maestro completo y muestra la dependencia de sesión y los intentos fallidos. No se reemplaza el maestro por un menú parcial.
