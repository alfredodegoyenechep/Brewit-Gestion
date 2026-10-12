# Almacenamiento de datos y retiro de fuentes

Brewit guarda los datos de planillas como registros internos comprimidos. El archivo original no es necesario después de una importación validada. Los nombres y URLs anteriores se mantienen como identificadores lógicos: físicamente existe un descriptor `<nombre>.records.json` que referencia datos deduplicados en `uploads/.records/blobs/<sha256>.json.gz`.

Se conservan valores tipados, comentarios, resultados de fórmulas, formatos numéricos necesarios para interpretar fechas, hojas y relaciones de cabeceras. No se guardan imágenes, macros ni presentación de las planillas. Las descargas se generan bajo demanda desde los registros; no reproducen el archivo original byte por byte.

Los índices existentes conservan rangos, versiones históricas de maestros, exclusiones, reemplazos y procedencia. Cada descriptor registra la huella del original importado y la versión del importador. Los datos de reconstrucción de inventario (`original.json`) son datos operativos necesarios y no se eliminan por llamarse “original”.

## Retención

Inventario, tomas, ventas y compras conservan la versión vigente y las dos anteriores, más referencias necesarias y lecturas activas. Se eliminan únicamente versiones reemplazadas dentro de una cobertura confirmada. Los maestros conservan cambios históricos; las capturas idénticas reutilizan registros. Los blobs compartidos solo se eliminan si no quedan descriptores que los referencien, no hay lectores activos y ha transcurrido una hora desde su creación.

La publicación ocurre mediante un puntero atómico después de escribir y validar sus datos. Los fallos de limpieza no invalidan una publicación. Las reconstrucciones idénticas no generan nuevas versiones. Los informes guardados, órdenes, cierres, credenciales y perfiles de conexión quedan fuera de la limpieza automática.

## Mantenimiento

El diagnóstico no borra archivos:

```sh
npm run storage:audit -- --output /tmp/brewit-storage-manifest.json
```

Para ejecutar una limpieza auditada, detener completamente el servidor, esperar a sus trabajos y comprobar que ya no escucha en el puerto. Aplicar el manifiesto con el mismo directorio de datos:

```sh
node scripts/storage-maintenance.js --apply /tmp/brewit-storage-manifest.json --offline --output /tmp/brewit-storage-cleanup.json
```

Se revalidan referencias, versión vigente, cobertura y cambios desde el diagnóstico. Los candidatos modificados se omiten; repetir la ejecución es seguro. `--offline` declara el corte; no detiene procesos automáticamente. Un bloqueo impide publicaciones o cargas de un servidor nuevo durante el mantenimiento.

La migración conserva los originales inicialmente:

```sh
npm run storage:migrate -- --offline --output /tmp/brewit-storage-migration.json
```

Reiniciar con sincronización temporalmente deshabilitada (`BREWIT_DISABLE_SYNC=1 node server.js`), verificar consultas y exportaciones, detener de nuevo y retirar únicamente originales con conversión válida:

```sh
npm run storage:migrate -- --offline --remove-originals --output /tmp/brewit-storage-migration-final.json
```

Un original que haya cambiado, una conversión no equivalente o registros corruptos quedan pendientes; no se eliminan. Los respaldos, documentos huérfanos no verificados y coberturas no sustituidas requieren revisión y se conservan. No unir documentos antiguos a ventanas actualizadas: una desaparición puede representar una anulación o reemplazo legítimo.
