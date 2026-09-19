# Seguridad y respaldos: estado de la etapa 1

**Estado actual: uso privado/local solamente. No publicar Brewit en Internet todavía.**

La aplicación no incorpora inicio de sesión ni permisos por usuario. El servidor sirve archivos cargados desde rutas `/uploads/...` y permite operaciones de lectura, carga y eliminación por API sin una capa de autorización. Los datos de ventas, pagos, compras, inventario y perfiles de sesión de TotEat son sensibles. TLS por sí solo no controla quién puede leerlos o modificarlos.

Antes de habilitar acceso externo se deben acordar e implementar, como mínimo:

1. Identidad y sesiones: usuarios autorizados, cierre de sesión, recuperación de acceso y protección de contraseñas o un proveedor de identidad.
2. Permisos por función y local: dirección, administración, operación y consulta; restringir descargas, borrados y configuración.
3. Protección de archivos y APIs: ninguna ruta de `/uploads` debe ser pública; las vistas previas y descargas deben verificar permisos. Añadir registro auditable para cambios y eliminaciones.
4. Transporte y secretos: HTTPS; perfil de TotEat, tokens y futuras credenciales fuera de respuestas, logs y respaldos accesibles al público.
5. Respaldo restaurable: respaldar `uploads/` y configuración de forma cifrada, con retención, destino externo y prueba periódica de restauración. Decidir expresamente si se respaldan los perfiles de sesión bajo `uploads/.integrations/`; contienen credenciales persistentes y requieren protección adicional. No incluir archivos temporales de `uploads/.staging/` salvo necesidad justificada.

Quedan pendientes dos decisiones del propietario antes de implementar acceso o respaldos automáticos: **quiénes serán los usuarios y qué puede hacer cada rol**, y **dónde se guardarán los respaldos cifrados con qué retención**. Hasta entonces, mantener el servicio en un equipo o red privada controlada. La suite de pruebas funcionales no equivale a una auditoría de seguridad.
