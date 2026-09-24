# Limpieza de fuentes antiguas — validación

Versión activada en el servidor local el 24-09-2026, después de comprobar que no había sincronizaciones en curso. No se eliminaron archivos históricos ni se trasladaron credenciales.

## Interfaz y rutas

- «Datos y sincronización» conserva actualización por API, frecuencias y consulta de registros. Las cargas manuales son MercadoPago, marketing y colaboradores por cafetería.
- No se sirve el espacio antiguo de cargas ni sus controles de descarga web. Las rutas históricas solo se registran con `enableLegacyTools: true`; el procedimiento excepcional está en `legacy/README.md`.
- El aviso, enlace y consulta automática del piloto se retiraron. Las evidencias y el script histórico permanecen en el repositorio.
- Las exportaciones de resultados y antecedentes de Brewit se conservan.

## Comprobaciones

- Suite completa: 170 pruebas, 168 aprobadas, una omitida y una espera de navegador agotada. La prueba que agotó la espera pasó en la repetición junto con las pruebas de limpieza y conservación de maestros (8/8).
- Las tres cargas manuales y la persistencia de frecuencias se comprobaron en navegador con el servidor en modo normal.
- Se probaron rechazos de rutas históricas, importaciones Toteat en el endpoint manual y ausencia de controles antiguos. La prueba de maestros verifica que un fallo conserve el catálogo anterior y que el error sobreviva a una nueva instancia.
- Navegador contra el servidor real tras reiniciar: sin errores de JavaScript, seis botones manuales (tres por cafetería), sin controles de carga/descarga Toteat ni aviso del piloto.
- Comparación JSON exacta antes y después, con los mismos filtros: ventas semanales consolidadas; compras de todas las ubicaciones, septiembre 1–24; ingredientes de La Concepción, septiembre 1–24. Los tres resultados fueron idénticos.
- Consulta de registros de compras: HTTP 200 para La Concepción, Portal Lyon y Bodega Principal. Fuentes y frecuencias se conservaron: ventas/pagos cada 15 y 5 minutos; compras cada 60 y 15 minutos, respectivamente. Bodega Principal comparte las fuentes de La Concepción.

## Dependencia pendiente

El maestro completo conserva su lectura exitosa del 22-09-2026, 20:32:13 (Chile), con 240 productos, 128 ingredientes, 53 extras, 286 recetas y 42 proveedores. El último intento fallido, del 24-09-2026, 15:36:03, se muestra por separado y se recupera del estado histórico al reiniciar.

La autenticación sigue dependiendo de sesión. `Solicitud_Toteat_Credencial_Maestros.md` contiene el borrador técnico, no enviado, para solicitar una integración oficial sin login interactivo. No se sustituyeron maestros por el menú público ni se automatizó el login.
