# Implementación del plan de correcciones

Cambios aplicados sobre el sistema tras la auditoría del 24-10-2026. La ejecución normal (`npm start`) usa actualización manual de fuentes externas. Los archivos originales, versiones y configuraciones anteriores permanecen disponibles.

Seguimiento de rendimiento: [actualización rápida de ventas y pagos, cobertura visible y medición por trabajo](PLAN_OPTIMIZACION_VENTAS_PAGOS.md).

## Entregado

| Corrección | Estado | Comportamiento |
| --- | --- | --- |
| C01 | Aplicada | Resultados financieros identifica la solicitud por los filtros completos, cancela la anterior e impide que una respuesta o error atrasado modifique el resultado vigente. El mismo control cubre Ingredientes, Compras y Costos. |
| C02 | Parcial, segura | MercadoPago distingue repetición idéntica de fila con igual identidad y contenido cambiado. Conserva el importe y registro publicados y, ante conflicto, archiva el reporte nuevo original y su huella en evidencia privada; muestra el número de correcciones pendientes. Todavía no sustituye automáticamente importes: falta validar precedencia de reportes del proveedor. |
| C03 | Aplicada para ventas, compras y MercadoPago | Datos y sincronización permite elegir local, fuentes y período anterior. Ventas y compras consultan completas las ventanas que cruzan el rango; MercadoPago deja de limitar esa revisión por el último día importado. Se conserva la fecha de la última revisión histórica. Navegar no consulta proveedores. |
| C04 | Aplicada a libros de ventas y compras | Una solicitud reutiliza las filas convertidas de cada archivo, con límite de memoria y clave de archivo/versión. La proyección pasó de 64,23 s a 17,34 s de mediana en la copia auditada. |
| C05 | Aplicada a resultados financieros, ingredientes y proyección de compras | Un trabajador aislado ejecuta cada cálculo pesado. El servidor principal atiende listados mientras tanto, limita a un trabajo activo y uno en espera, y termina el trabajador cuando el cliente cancela o vence el plazo. Las bases de órdenes generadas por proyecciones se comparten en una caché privada de cuatro horas para confirmar sin repetir inventario. |
| C06 | Aplicada | Leer el estado de inventario no reconstruye saldos. Si cambiaron sus dependencias, la versión anterior aparece como pendiente de recálculo; una actualización explícita reconstruye. |
| C07 | Parcial | La actualización conjunta publica las tomas físicas tomadas del mismo recorrido de inventario y reconstruye una vez, sin segunda descarga de tomas. Sigue pendiente reutilizar sesión y catálogos entre maestros, inventario y recepciones. |
| C08 | Parcial; contrato externo pendiente | Se mantiene la separación de 21 s de la API pública. El diagnóstico local de la API muestra espera de cola, red, lectura y filas sin URL ni token. Siguen pendientes la confirmación de cuota y autenticación soportada por TotEat. |
| C09 | Piloto local listo; acceso externo pendiente | Adaptador de solo lectura para listar y descargar reportes existentes de MercadoPago y comparador fila a fila con el CSV web. No modifica el conector productivo. Requiere token autorizado y paridad comprobada antes de usarlo. |
| C10 | Aplicada en pantallas medidas | Resultados, Ingredientes, Compras y Costos esperan la acción de consulta después de elegir filtros; filtros visuales permanecen inmediatos. Datos y sincronización avisa al comenzar a cargar. |
| C11 | Aplicada para revisión de uso | Navegación organizada por tareas, nombres de análisis específicos y acceso directo a órdenes guardadas sin calcular proyección. Conserva las funciones existentes. La validación con el dueño queda pendiente. |
| C12 | Aplicada | El selector de la prueba de Control histórico se limita al panel activo. |

## Medición local comparable

Cinco ejecuciones sobre la copia aislada de la auditoría, sin conexiones a proveedores. [Resultados](MEDICIONES_CORRECCIONES.csv). La proyección directa después de la caché tuvo mediana de **17,34 s** frente a **64,23 s** antes. En trabajador, mediana de **19,40 s** por el inicio del proceso aislado; las órdenes concurrentes respondieron en mediana de **9,3 ms**. Con resultados financieros en trabajador, las órdenes respondieron en mediana de **7,4 ms** frente a **10,43 s** de espera observada antes.

Ingredientes no obtuvo una mejora de latencia: mediana de **4,55 s** antes, **4,76 s** con caché en el proceso principal y **5,40 s** en trabajador. Su beneficio actual es que no retiene las consultas livianas durante el cálculo; conviene perfilar esta ruta por separado antes de prometer menor espera del propio reporte. Resultados financieros en trabajador tuvo mediana de **10,80 s** frente a **9,90 s** antes, por el costo de iniciar el proceso aislado y copiar la respuesta.

Una ejecución adicional de proyección aislada registró **195 MB** de RSS inicial y **1.829 MB** de RSS máximo del proceso con trabajador, a intervalos de 25 ms, durante **18,89 s**. Es una medición local de proceso completo, no una cota por trabajador ni una garantía para producción. El límite de un trabajo pesado activo y otro en espera evita multiplicar ese consumo, pero conviene supervisar RSS real antes de cambiar la concurrencia o el tamaño del servidor.

La suite completa con concurrencia limitada terminó con **495 pruebas aprobadas, 0 fallidas y 1 omitida**. Tras agregar el archivo privado de evidencia de conflictos de MercadoPago se repitieron **19 pruebas dirigidas**, todas aprobadas. `git diff --check` y las comprobaciones de sintaxis de los archivos cambiados terminaron sin errores.

**Verificación posterior en la instancia local:** el 24-10 el usuario observó 57 s porque el proceso `node server.js` había arrancado a las 10:23, antes de cargar estos cambios. Se confirmó que las sincronizaciones estaban inactivas y se reinició Brewit. La misma proyección de La Concepción en `localhost:3000` tardó **16,39 s por API** y **16,46 s desde el botón en Chrome**, con 138 ingredientes y sin errores de página. Una recarga del navegador no sustituye el código ya cargado en el proceso Node; después de actualizar el servidor hay que reiniciar ese proceso.

## Pendientes de proveedor y aceptación final

- **TotEat:** confirmar alcance de la cuota de 21 s por cuenta, token y local; vigencia y renovación de la credencial interna; posibilidad de sesión/catálogo compartidos y un mecanismo de cambios de documentos. No se reducirá la espera de cola ni se reemplazarán servicios internos por agregados públicos sin equivalencia de documentos, bodega y costos.
- **MercadoPago:** proporcionar al entorno un token autorizado como `BREWIT_MP_REPORT_TOKEN` y contrastar un reporte cerrado y uno reciente con CSV web, incluyendo devolución, comisión y corrección. El piloto es `node scripts/mercadopago-api-pilot.js` para listar, o `node scripts/mercadopago-api-pilot.js NOMBRE.csv RUTA_CSV_WEB` para comparar. Usa únicamente [listado](https://www.mercadopago.cl/developers/es/reference/settlements-report/query-report/get) y [descarga](https://www.mercadopago.cl/developers/es/reference/settlements-report/download-report/get); no crea reportes. Si dos versiones comparten identidad y difieren, permanece una advertencia hasta establecer precedencia.
- **Interfaz:** observar los seis recorridos administrativos con el dueño y ajustar nombres/orden según esa sesión. La evaluación automatizada verifica acceso y ausencia de cálculos al abrir órdenes, pero no mide éxito humano.

Para volver al procesamiento en el hilo principal existe la opción de inicio `enableBackgroundCalculations:false`; el modo manual externo se controla con `manualExternalSources:true`. La caché de proyecciones está en `uploads/.cache/purchase-projections` y vence a las cuatro horas; eliminarla invalida únicamente proyecciones todavía sin guardar.
