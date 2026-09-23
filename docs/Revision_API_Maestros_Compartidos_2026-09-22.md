# Revisión de API pública para maestros compartidos

Fecha: 22-09-2026. Local comprobado: La Concepción.

## Fuentes oficiales revisadas

- https://developers.toteat.com/#tag/Configuracion-API
- https://developers.toteat.com/toteatApi_v2.yaml
- https://developers.toteat.com/tags/config_tag.yaml
- https://developers.toteat.com/paths/products.yaml
- https://developers.toteat.com/paths/inventorystate.yaml
- https://developers.toteat.com/paths/create_purchase_movements.yaml

La página carga una especificación OpenAPI dividida en archivos. Se revisaron los paths publicados y la configuración de Productos, Información del Integrador y Seguridad.

## Comprobación real, sin publicación

GET `/mw/or/1.0/products`, con `activeProducts=false`, utilizando las credenciales existentes del local. Resultado a las 22:54 UTC: HTTP 200, `ok=true`, 284 registros: 235 productos y 49 extras según `isModifier`.

Campos recibidos: active, alcohol, category, categoryId, description, id, idToteat, images, isModifier, localCode, modificationDate, modifiers, name, price, referencePrice, sorting.

No se recibieron campos de recetas, costos, unidades base, conversiones de compra o proveedores. LAC001 y PAC001 no están en la respuesta; SUB005 sí aparece. La presencia de algún insumo vendible no constituye un catálogo completo de ingredientes. `modifiers` describe categorías de extras, no una receta con cantidades y rendimientos.

La consulta no modificó las credenciales ni publicó/reemplazó los maestros.

## Cobertura y conclusión

| Fuente requerida | Cobertura pública verificada |
| --- | --- |
| Productos y extras | Menú y atributos comerciales; faltan atributos del maestro operativo |
| Ingredientes | No se verificó un catálogo completo |
| Jerarquía de productos | Categoría inmediata por producto; no árbol completo independiente |
| Jerarquía de extras | Categorías asociadas a modificadores; no garantía de árbol completo |
| Jerarquía de ingredientes | No se encontró endpoint de maestro en la especificación revisada |
| Recetas | No se encontró endpoint de lectura documentado |
| Proveedores | No se encontró endpoint de lectura documentado |
| Unidades y conversiones | No aparecen en la respuesta comprobada de productos |

La configuración Productos define el menú, su lista de precios y jerarquías. La configuración de información externa puede agregar datos a ciertas respuestas, pero no documenta por sí misma endpoints para descargar todos los maestros. `inventorystate` entrega saldos y movimientos, no sustituye los maestros de recetas y conversiones. `purchasemovements` documenta POST para registrar compras: requiere productos y proveedores preexistentes y no es una descarga de su maestro.

Con la documentación y respuesta verificadas no es posible afirmar que los seis maestros completos puedan reemplazarse hoy por esta API pública. Esto no descarta una API adicional o permisos que Toteat proporcione a integradores fuera de la documentación pública. La lectura actual completa utiliza servicios internos autenticados; todavía depende de sesión web.

## Consulta concreta para Toteat (borrador, no enviada)

Necesitamos sincronizar en modo solo lectura los maestros completos de La Concepción mediante credenciales de integración, sin sesión interactiva del navegador. La API pública `/products?activeProducts=false` funciona, pero entrega un menú sin recetas, costos, unidades/conversiones ni proveedores.

¿Disponen de una API para integradores, scopes adicionales o credenciales de servicio que permitan consultar:

1. Productos, ingredientes y extras, incluidos inactivos, con unidad base, costo y manejo de stock.
2. Árbol completo y asignaciones de jerarquías de productos, ingredientes y extras.
3. Recetas con ingredientes, cantidades, unidades, rendimiento y restricciones de transformación.
4. Conversiones de unidades y empaques de compra por producto.
5. Maestro de proveedores.

Solicitamos endpoints, esquema de respuestas, autenticación admitida, permisos, paginación y límites. Si los endpoints usados por la aplicación web son aptos para integradores, ¿qué autenticación de servicio soportada ofrecen para evitar depender de una sesión web?

## Conexión directa mediante API interna — implementada

Con autorización explícita del usuario para reutilizar y guardar la autenticación de su sesión, se verificó una alternativa a la API pública: las lecturas JSON que utiliza Toteat para sus maestros completos.

- Catálogo completo y recetas: GET `/locals/{localRef}/products/`.
- Proveedores: GET `/locals/{localRef}/providers/`.
- Bodegas: GET `/locals/{localRef}/warehouses/`.
- Jerarquías completas: GET `/resto/setupconfig`, módulos 5100, 5115 y 5110.
- Todas las peticiones se realizan contra `https://api.toteat.com`, exclusivamente con GET, sin seguir redirecciones.

La prueba directa desde Node, después de cerrar la pestaña de captura, recuperó 421 registros (240 productos, 128 ingredientes y 53 extras), 286 recetas, 42 proveedores y jerarquías de 22/13/15 registros. No es una lectura del menú comercial ni una descarga de archivos de Toteat.

El adaptador `toteat-direct-masters.js` conserva el contrato del publicador existente. El catálogo, los costos, las recetas y las conversiones se obtienen de la respuesta actual. La comparación con el maestro previo confirmó igualdad de costos, manejo de stock y asignaciones principales en los 421 registros. La API moderna normaliza las unidades a mayúsculas y puede devolver precio comercial cero en ingredientes que no se venden; ese precio no reemplaza el costo. Se preservó también el factor de conversión cero que Toteat trae para SUB014, sin inventar una conversión positiva.

### Autenticación y renovación

La conexión reside en `uploads/.integrations/toteat/direct-masters/connection.json`, con permisos 0600 y dentro de un directorio privado. Contiene material de autenticación: no debe compartirse, registrarse en Git, imprimirse en consola ni incluirse en reportes. La aplicación no publica ese directorio mediante HTTP.

Las actualizaciones manuales y programadas usan directamente el servidor cuando esa conexión existe. No abren Playwright ni renuevan la sesión de forma silenciosa. Si vence/revoca la autenticación o llega una respuesta incompleta, se informa el error y se conserva la versión compartida anterior; no se vuelve automáticamente a un catálogo parcial.

Para conectar o renovar, abrir la sesión autorizada de Toteat en el navegador local configurado, seleccionar La Concepción y ejecutar:

```sh
node scripts/connect-toteat-direct-masters.js
```

El comando abre y cierra únicamente su propia pestaña, verifica restaurante/local y guarda las cuatro peticiones necesarias. No cambia permisos de Toteat ni captura credenciales de otros sitios.

**Límite:** esto elimina la navegación web de cada actualización, pero sigue usando autenticación de sesión de la API interna. No equivale a un token público permanente ni garantiza renovación indefinida. Sigue pendiente la respuesta de Toteat para credenciales de integración oficialmente soportadas.

Publicación real finalizada a las **20:13:41 de Santiago** (23:13:41 UTC), mediante el endpoint local de sincronización de maestros y la nueva lectura directa: 240 productos, 128 ingredientes, 53 extras, 286 recetas / 1.187 líneas, 42 proveedores, 4 bodegas y jerarquías 22/13/15. Estado sin errores. Validación: 60 pruebas aprobadas para servidor, maestros, conexión directa y seguimiento de cargas.
