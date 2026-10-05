# Solicitud a TotEat: historial y tiempos de KDS

**Borrador preparado el 05-10-2026. No enviado.**

**Asunto:** Acceso de lectura a eventos KDS por producto y tiempos de entrega — La Concepción

Necesitamos medir en Brewit el tiempo desde el pedido hasta la entrega al cliente para pedidos ingresados directamente en caja, de consumo en local y para llevar.

Inicialmente `/orderstatus` respondía `Not Authorized`. Habilitamos únicamente **Can get an order** en la API existente, conservando su token. Las consultas detalladas ahora responden correctamente. En cinco pedidos reales, las líneas públicas devuelven `statusKDS = NOT_STATUS`; no recibimos el historial de cambios ni sus timestamps.

La aplicación web permite leer eventos por línea en `lstk`, con fecha, estación/actor y estado. Encontramos finalizaciones separadas por producto y estación. Las dos estaciones activas están configuradas con estados 0, 100 y 110; 110 corresponde a «Terminado de Preparar». El equipo indica que finaliza los productos al entregarlos, pero algunos pedidos revisados no tienen evento final. La sincronización KDS/delivery está desactivada. El Webhook Global y el webhook de pedidos de esta API también están desactivados.

Solicitamos confirmar:

1. ¿Qué endpoint de lectura soportado expone el historial KDS por línea, incluidos hora de pedido, cambios de estado, estación y marca de tiempo real del evento? Necesitamos relacionarlo con los IDs de pedido y línea de ventas.
2. ¿Por qué `/orderstatus?det=true` devuelve `NOT_STATUS` cuando la aplicación web conserva `stk = 110` y logs KDS para las mismas líneas? ¿Depende de la versión del ambiente o de permisos adicionales?
3. ¿Los cambios KDS de productos ingresados en caja generan notificaciones del **Webhook Global**? ¿Qué payload y nivel de detalle incluye los IDs de línea y la hora efectiva de cada cambio, diferenciada de la última modificación y de la generación de la notificación?
4. ¿Cuál es la retención y cobertura histórica de esos eventos? ¿Es posible recuperar finalizaciones y entregas anteriores? ¿Cómo distinguir un evento nunca registrado de uno no retenido?
5. ¿Cómo se recomienda registrar «Entregado a Cliente» para consumo en local y para llevar, distinguiéndolo de «Terminado de Preparar», sin afectar cobros, liberación de pedidos ni el flujo actual?
6. ¿Qué autenticación de integración soportada permite esta lectura sin depender de una sesión interactiva? Indicar permisos, paginación y límites de consultas.

Por ahora solicitamos información y acceso de lectura. **No activar notificaciones todavía**: primero debemos preparar el receptor y confirmar la asignación del Webhook Global, dado que la documentación lo limita a una API estándar por local.

No necesitamos crear órdenes, cambiar estados desde Brewit ni modificar inventario. No adjuntamos credenciales ni datos personales de clientes.
