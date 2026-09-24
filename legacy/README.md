# Recuperación local de fuentes antiguas

Las cargas/descargas de Toteat por navegador y las importaciones históricas ya no están disponibles en el servidor normal. Los reportes operativos mantienen su política de fuentes sincronizadas. Los archivos existentes no se borran ni se migran.

- `toteat-automation.js`: automatización histórica y utilidades de lectura nativa aún compartidas con el conector de maestros.
- `download-view.js`, `upload-workspace.html`, `browser-scenarios.txt`: referencia de la interfaz retirada; no se sirven ni cargan en Brewit.
- `server.js`: servidor de recuperación exclusivamente en `127.0.0.1:3001`, sin sincronizadores automáticos. No debe ejecutarse simultáneamente sobre datos que otro proceso esté modificando.

Para una recuperación excepcional, detener el servidor habitual, respaldar los datos y ejecutar:

```sh
BREWIT_UPLOADS_ROOT=/ruta/a/copia-de-recuperacion node legacy/server.js
```

Sin `BREWIT_UPLOADS_ROOT`, utiliza `uploads` del proyecto. No carga ni copia credenciales a otro repositorio. Para detenerlo, Ctrl+C.

Las rutas históricas habilitadas únicamente aquí incluyen `/upload/master`, `/api/uploads/weekly/inspect`, `/api/uploads/weekly/confirm` y `/api/integrations/toteat/{connect,download-sales,download-payment-details,master-downloads/*,transactional-downloads/*}`. Los protocolos de confirmación y validación siguen vigentes. Las descargas web requieren sesión autorizada; no automatizan el login.

La recuperación de un archivo no cambia por sí sola la política `synchronized` ni hace que los reportes lo consuman. No activar fuentes históricas como solución implícita a una API caída.

Las pruebas de regresión que necesitan construir datos históricos habilitan explícitamente `enableLegacyTools: true`. Las pruebas de la UI actual y de bloqueo de rutas usan el modo normal.
