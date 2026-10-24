# Optimización de la actualización de ventas y pagos

Análisis del 24-10-2026. Alcance: actualización explícita desde TotEat, no cálculo ni visualización de informes guardados.

## Estado de implementación

La modalidad rápida quedó aplicada a los botones «Actualizar ventas recientes» y al trabajo conjunto «Actualizar fuentes recientes». Consulta la ventana vigente por local, además de ventanas faltantes y cualquier ventana de un turno abierto actual o anterior. «Revisar dos últimas ventanas de ventas» permite una comprobación más amplia desde Datos y sincronización; la revisión histórica por fechas y «Revisar todo el histórico» conservan su alcance. El estado de la fuente muestra el último período comprobado y la duración, aunque no haya cambiado la versión publicada. Cada trabajo de ventas guarda tiempos por llamada, ruta y ventana, sin URL, token ni identificadores de órdenes.

La separación global de 21 s se conservó porque ambos locales comparten usuario y restaurante. Las pruebas usaron respuestas simuladas; **no se inició una actualización real de TotEat** durante la implementación. La primera medición posterior dependerá de la próxima acción explícita de actualización.

Validación: 40 pruebas dirigidas de ventas, API, sincronización e interfaz y 63 pruebas adicionales de servidor, UI e histórico, todas aprobadas. El 24-10 se reinició la instancia local en `localhost:3000`, se verificaron los nuevos controles y se comprobó que ninguna fuente quedó sincronizando al arrancar.

## Diagnóstico medido

La actualización de ambos locales iniciada a las 15:47:55 UTC terminó cuando Portal Lyon completó a las 15:49:45 UTC: **110,17 s de reloj**. La Concepción completó en **94,69 s**. Se observaron seis llamadas públicas: `shiftstatus` y dos bloques de `sales` por cada local. Ventas y detalle de pagos llegan en las mismas respuestas; Brewit no hace una segunda descarga de pagos. No hubo llamadas `orderstatus` en esta ejecución.

La cola de Brewit separa **21 s el inicio de solicitudes** y es común a ventas y compras de ambos locales. Las seis llamadas necesitan al menos 105 s entre el primer y el último inicio. La red sumó aproximadamente 21,55 s y la lectura de cuerpos 0,86 s entre las seis respuestas; esas duraciones se superponen con la espera de la cola y no se suman al reloj. El último archivo fuente de La Concepción quedó guardado aproximadamente 4,17 s antes de que concluyera su trabajo; el de Portal Lyon, aproximadamente 0,10 s antes. Eso sitúa la normalización/publicación final muy por debajo de la cola para esta muestra.

La Concepción releyó la ventana cerrada que comenzó el 30-09 (1.079 pagos) y la vigente que comenzó el 15-10 (694). Portal Lyon releyó las iniciadas el 29-09 (144) y el 14-10 (445). Ambas cafeterías tenían un turno abierto el 24-10, por lo que `shiftstatus` aporta información para incluir su ventana. Los pagos actuales eran 11.989 y 589, respectivamente. No había candidatos pendientes de `orderstatus`. El procesamiento local de ambos históricos ocurre, pero no explica la mayor parte de estos 110 s.

Los dos locales usan tokens diferentes, pero pertenecen al mismo restaurante y usuario de TotEat. Por eso **no se puede suponer** que el proveedor permita colas independientes por token. La separación de 21 s está configurada en Brewit; su alcance contractual sigue sin confirmar.

## Cambios posibles

| Cambio | Ahorro esperable en una actualización de dos locales | Condición de integridad |
| --- | --- | --- |
| Reducir de dos a una ventana `sales` por local en una modalidad rápida | Dos llamadas menos: unos **42 s de separación de cola**. Tiempo total orientativo de 65–75 s si no hay otros trabajos; **no medido**. | Mostrar que se actualiza la ventana vigente; conservar revisión explícita de ventanas anteriores y su fecha de última comprobación. Las correcciones antiguas no aparecerían en la modalidad rápida hasta revisarlas. |
| Evitar releer una ventana cerrada ya verificada en el mismo día | Hasta 42 s en repetición dentro del día; ninguna mejora en la primera actualización diaria. | Guardar por ventana la última verificación exitosa, no tratar una respuesta fallida como «sin cambios» y permitir forzar revisión. |
| Cola por token/local en vez de global | Las dos cadenas de tres llamadas podrían terminar alrededor de 45–55 s en condiciones parecidas; **estimación condicional**. | Confirmación de TotEat de si la cuota es por token, usuario o restaurante. Como comparten restaurante/usuario, no probar paralelismo agresivo sin acuerdo. |
| Menor separación global | Potencialmente el mayor efecto, proporcional al límite autorizado. | Contrato o prueba autorizada del proveedor; manejo de 429 y `Retry-After`, control de errores y comparación de conteos/importes. |
| Consulta de cambios desde última actualización, si existe | Podría reducir volumen y número de ventanas, sin cifra sustentable aún. | TotEat debe ofrecer cambios, cancelaciones y eliminaciones con semántica completa; no inferirlo de `ini/end`. |
| Optimizar normalización/XLSX | Segundos, no decenas de segundos en la muestra observada. | Mismas órdenes, pagos, importes, anulaciones y versión atómica de ambas fuentes. Prioridad menor. |

## Recomendación de implementación

1. **Persistir el desglose por trabajo**, además del diagnóstico temporal en memoria: llamadas por ruta/local/ventana, espera de cola, red, lectura, filas, validación, publicación y tiempo total. No guardar URL, token ni datos personales en la traza. Así podremos comparar una actualización posterior con la línea base de 110,17 s.
2. **Introducir dos alcances explícitos:** «Actualizar ventas recientes» (ventana vigente de cada local, más cualquier ventana de turno abierto) y «Revisar ventas anteriores» (ya existe selección manual de período; incluir también una opción visible para las dos últimas ventanas). Mostrar en la pantalla qué períodos quedaron comprobados y cuáles conservan la fecha de revisión anterior. Si se prefiere mantener una sola acción, usar la optimización conservadora de no releer una ventana cerrada dos veces el mismo día, con botón para forzarla.
3. **Solicitar a TotEat una respuesta precisa**: cuota mínima entre llamadas a `shiftstatus`, `sales` y `orderstatus`; alcance por token, usuario y restaurante; posibilidad de solicitudes simultáneas para locales distintos; existencia de lectura incremental por modificación; máximo período de `sales`; tratamiento de anulaciones y pagos eliminados. Hasta entonces conservar los 21 s globales.
4. **Ensayar con datos capturados en copia aislada** las modalidades, incluidas corrección en ventana anterior, eliminación, turno abierto antiguo, pago sin productos, nota de crédito y respuesta incompleta. Comparar IDs de órdenes/pagos, venta neta, medios de pago y cobertura por fecha. Después medir una actualización real solicitada por el usuario, sin repetir descargas solo para aumentar la muestra.

La opción que puede implementarse sin depender de TotEat es **separar actualización rápida de revisión de ventanas anteriores**, siempre que la interfaz indique claramente su cobertura. La opción de mayor ahorro potencial es **validar una cola menos restrictiva**, pero depende del contrato de TotEat. No conviene quitar `shiftstatus`, ignorar anulaciones ni aceptar datos incompletos para ganar segundos.
