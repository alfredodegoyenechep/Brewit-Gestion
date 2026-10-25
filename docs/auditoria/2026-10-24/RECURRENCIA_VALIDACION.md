# Recurrencia y retorno — implementación y validación

Fecha: 25 de octubre de 2026. Base de comparación: commit `7f6429b`. Se sustituye el contenido de «Clientes recurrentes» dentro de «Estadísticas por producto y horario». La revisión usa archivos locales; no certifica identidad de personas, continuidad histórica completa ni exactitud de todos los enlaces.

## Resultado entregado

Cuatro pestañas internas: **Resumen, Retorno, Compras y Calidad de datos**. El período principal parte en últimos 28 días completos acreditados; permite Hoy, Semana actual, Mes actual y Personalizado. La evolución permite ocho/doce semanas o seis meses, con cantidades o porcentajes. Retorno conserva fechas de entrada independientes, inicialmente seis meses calendario, y detalle semanal/mensual. R30 usa primeras observaciones entre D−119 y D−30.

Abrir, navegar y modificar filtros no genera consultas de recurrencia. **Generar reportes** prepara el snapshot MP y las cohortes iniciales. **Generar retorno**, **Preparar Compras** y **Preparar calidad de vínculos** son acciones explícitas. Las consultas no llaman a Toteat ni MercadoPago: leen el almacenamiento actual. Los resultados anteriores conservan su contexto durante la carga o un error; respuestas obsoletas se descartan.

`recurrence.js` normaliza pagos y comparte la historia de fechas con los pedidos. `recurrence-source.js` adapta archivos y evidencias actuales. `recurrence-service.js` retiene snapshots y verifica dependencias. `recurrence-loader.js` / `recurrence-worker.js` procesan fuera del hilo HTTP. `recurrence-view.js`, `index.html` y `styles.css` presentan resultados y XLSX. `server.js` registra la API y adapta los importes/estructuras Toteat existentes. La especificación y README reflejan la implementación.

Los endpoints anteriores `/api/sales/dashboard` y `/api/sales/observable-recurrence` siguen disponibles para conciliación y consumidores actuales. Las demás vistas no cambiaron de metodología. La interfaz nueva muestra exclusivamente la definición de regreso en otra fecha.

## Conciliación del caso 586 / 497 / 15,0%

Consulta: Portal Lyon (`store-2`), **1–25 octubre de 2026**. Corte efectivo MP **24 octubre, 19:45:50 de Santiago**; último día completo acreditado D = **23 octubre**. Solicitar hasta el 25 no inventa actividad posterior al corte.

| Medida | Cálculo anterior | Cálculo nuevo | Explicación |
|---|---:|---:|---|
| Operaciones MP observadas | 586 | 586 | Se conserva la población observada |
| Pagos identificables | 585 | 585 | Un pago de $5.200 no es identificable |
| Instrumentos activos aproximados | 497 | 497 | No son personas únicas |
| Operaciones recurrentes | 88 / 586 = 15,0% | 83 pagos en fechas posteriores | La definición anterior permitía repeticiones dentro de la primera fecha |
| Activos con regreso en otra fecha | No equivalente al 15,0% | 57 / 497 = 11,5% | Denominador de instrumentos, no de pagos |
| Días con compra de regreso | No equivalente | 79 / 576 = 13,7% | Agrupa pagos del mismo instrumento y fecha |
| Importe de regreso | $458.546 / $3.387.847 = 13,5% | $443.140 / $3.382.647 = 13,1% | Numerador por fecha posterior; denominador principal identificado |
| Primera fecha observada | Mezclada en repetición transaccional | $2.939.507 | Incluye todos los pagos de la primera fecha |
| R30 principal | No homologable | — Sin datos verificables para esa ventana | No se fabrica un 0% |

Se encontraron **cinco pagos adicionales en la primera fecha, por $15.406**. Explican exactamente `88 − 83 = 5` y `$458.546 − $443.140 = $15.406`. Entre los 83 pagos de regreso hay cuatro pagos adicionales dentro de días de regreso: `83 − 79 = 4`. En total hay nueve pagos identificados adicionales al agrupar por fecha: `585 − 576 = 9`. Por tanto, 15,0%, 11,5%, 13,7% y 13,1% responden a preguntas diferentes.

Los $3.387.847 totales se descomponen en $2.939.507 de primera fecha, $443.140 de regreso y $5.200 no identificables. Ninguna cifra MP se divide por 1,19 ni se etiqueta automáticamente como venta neta.

### Compras vinculadas y muestra

Portal Lyon: **608 pedidos** observados; **560 clasificables** (92,1%): **481 de primera fecha y 79 de regreso**. Permanecen en Calidad 20 pedidos ambiguos y 28 sin vínculo confiable. No se distribuyen entre instrumentos ni se multiplican importes. La venta analizable se calcula sobre los importes originales con impuestos verificados; la cobertura por conteo no se presenta como precisión del vínculo.

Muestra reconstruida sin publicar referencias de pedido/pago ni identificadores de tarjeta:

| Fecha local | Segmento | Ticket sin propina | Impuesto original | Neto verificado | Productos raíz |
|---|---|---:|---:|---:|---:|
| 2 octubre | Primera fecha | $2.700 | $431 | $2.269 | 1 |
| 5 octubre | Primera fecha | $6.800 | $1.086 | $5.714 | 2 |
| 8 octubre | Primera fecha | $10.600 | $1.692 | $8.908 | 2 |

La coincidencia es estimada y única por local, fecha, importes disponibles y proximidad de hasta dos minutos; tolerancia monetaria del patrón existente: máximo de $2 y 0,1% del importe candidato. Los ejemplos concilian dinero y estructura; **no certifican la titularidad de la tarjeta ni la precisión estadística del emparejamiento**. No hay referencia explícita Toteat–MP acreditada en estos ejemplos. La concentración de pedidos no vinculados por propina, horario y ticket requiere una validación de negocio adicional.

### Locales frente a cadena

| Alcance | Instrumentos activos | Con regreso observado | Días con compra | Días de regreso |
|---|---:|---:|---:|---:|
| Portal Lyon | 497 | 57 | 576 | 79 |
| La Concepción | 1.194 | 449 | 1.506 | 695 |
| Todas | 1.682 | 517 | 2.081 | 792 |

La suma local sería 1.691 instrumentos, pero la unión tiene 1.682: nueve claves aproximadas aparecen en ambos locales. La cadena recalcula historia, días y tasas sobre la unión. Por eso los días de regreso de cadena no tienen que ser la suma local: una primera fecha de sucursal puede ser un regreso de cadena. El importe total sí concilia: $15.270.198 tanto al sumar los locales como en la unión. Sin cuenta de proveedor no se acredita que una clave igual represente un mismo instrumento entre cuentas.

## Cobertura, campos reales y estados

Para el período de control se acreditaron **12 de 25 fechas de MP** en Portal Lyon. Faltan evidencias del 1–11 y del 24–25 de octubre como fechas completas. La existencia de transacciones en esas fechas no demuestra continuidad. No se excluyen las operaciones observadas de las cifras provisionales, pero no se habilitan comparaciones completas ni seguimiento maduro sin evidencia. Las ventanas de frecuencia/recencia terminan en D y muestran sus propias fechas, distintas de P.

La cobertura procede de manifiestos publicados, recepción completa, datasets completos y rango declarado por el proveedor, o snapshots API Toteat explícitos. Se limita el último día completo al anterior a la recepción y al anterior a hoy; el corte parcial conserva hora local. Un archivo faltante/ilegible invalida la continuidad del local en el cálculo nuevo. Un archivo legible acreditado sin filas sí permite distinguir cero operaciones de falta de datos. Los rangos inferidos al importar filas no acreditan cobertura. La revisión detectó además un archivo registrado como MP en La Concepción cuyo encabezado corresponde a ventas Toteat (intervalo declarado 17 de agosto). No se reinterpretó como pagos ni se modificó la integración/archivo. Se avisa la omisión; la política conservadora de lectura no acredita continuidad completa para ese local y el consolidado, por lo que D queda no disponible y esas ventanas son provisionales. Resolver su clasificación en origen permitirá recuperar una evaluación de cobertura y caché sin esa incidencia.

| Concepto | Campos/origen real | Tratamiento nuevo |
|---|---|---|
| Pago MP | `SOURCE_ID`, `TRANSACTION_TYPE` | SETTLEMENT positivo observado; deduplicación por cuenta/local, ID y tipo |
| Fecha MP | `TRANSACTION_DATE` | Offset a Santiago, respetando horario de verano; fecha/hora sin offset ya local |
| Dinero MP | `TRANSACTION_AMOUNT` | Importe cobrado observado; no usar `REAL_AMOUNT` posterior a comisiones como venta |
| Otros importes presentes | `FEE_AMOUNT`, `REAL_AMOUNT`, `TAXES_AMOUNT` | No sustituyen IVA/propina del pedido ni prueban estados del pago |
| Instrumento | `CARD_INITIAL_NUMBER`, `LAST_FOUR_DIGITS` | Validación conservadora, relleno de sufijo, HMAC y alias opaco versionado |
| Referencias disponibles | `EXTERNAL_REFERENCE`, `PURCHASE_ID` | No se asume equivalencia con ID de pedido Toteat sin evidencia |
| Estado/cuenta MP | No presentes en la muestra | Operación observada provisional; aprobación y ámbito global de cuenta no acreditados |
| Devolución MP | Sin original/importe reembolsado verificables en estos archivos | No se imputa; estado no disponible. El motor admite `REFUNDED_AMOUNT` y ajustes con referencia original cuando existen |
| Ticket Toteat | `total − discounts`; venta importada conciliada | Debe concordar con el importe del pedido; no incluye `gratuity` |
| Neto Toteat | Ticket menos `taxes` originales | Solo con campos finitos, coherentes y conciliados con el pedido ya procesado; si no, null |
| Unidades | Líneas, `quantity`, `lineReference`, clasificación de extras | Productos raíz; se excluyen extras/componentes sin alterar el total del pedido |
| Devoluciones/anulaciones Toteat | Señales/estados y notas del proceso actual | Pedidos con señales de reversión no se clasifican como compras ordinarias; no se reescribe la integración |

Los archivos originales inspeccionados contienen identificadores, métodos de pago y referencias, pero carecen de estado explícito de aprobación, cuenta del proveedor y datos suficientes para verificar todas las devoluciones/propinas. **586/586** operaciones del control no tienen estado ni cuenta explícitos. Esto no demuestra rechazo ni ausencia de devolución: obliga a mostrar provisionalidad. El consolidado lee 12.253 filas MP, con una fila no positiva excluida; no se modifica el almacenamiento original.

`recurrence-dates-v2` y `mp-prefix-last4-approximate-v1` aparecen en interfaz y exportación. Las series usan el último estado conocido: un ajuste tardío puede revisar una serie histórica. Los snapshots retenidos son coherentes en memoria durante una hora (máximo ocho), no un archivo persistente de lo conocido en cada fecha. Las secciones verifican versiones antes y después de leer dependencias; un cambio produce 409 y requiere regenerar. Cambiar únicamente Toteat no invalida Resumen/Retorno de MP. La exportación fija también la selección de cohortes preparada, evitando mezclar selecciones concurrentes.

## Pruebas ejecutadas

- **44/44** pruebas específicas y de pantallas relacionadas: motor, fuente, API, worker real, interfaz, exportación XLSX, navegación y otros reportes de estadísticas.
- Fixture numérico de la sección 12.1: reproduce 3 activos, 2/3 con regreso, 2/4 días de regreso y $60/$105 de importe de regreso.
- Los **27 casos obligatorios de la sección 12.2** están cubiertos por pruebas nombradas por número en `test/recurrence.test.js`, junto con `test/recurrence-ui.test.js` para el caso 20 y la evidencia de etiquetas/identidad del 27. Algunos casos relacionados comparten una prueba; no se confunde el número de tests con el de casos.
- Pruebas adicionales: igualdad de bases maduras, inclusión de no retornados, primer día con varios pagos, devolución sin operación original, corte MP independiente de Toteat, impuestos no disponibles, raíz/componente con igual código, versiones de manifiesto por fuente, cambio durante preparación, caché por corte efectivo y exportación de cohortes seleccionadas.
- Interfaz: cero consultas de recurrencia al abrir/cambiar pestañas; tres acciones explícitas en la captura (generar, preparar compras y preparar calidad), ninguna adicional al navegar. Sin errores JS y sin desbordamiento horizontal. Se verificaron 390, 768 y 1500 px; pestañas con flechas/Home/End, controles de teclado, detalle paginado y exportación real abierta nuevamente como XLSX.
- Suite completa: **554 tests, 551 aprobados, 2 fallidos y 1 omitido**. Los dos fallos se reprodujeron sin cambios sobre `7f6429b` en una copia temporal independiente: `test/data-cleanup.test.js:18` espera visible un botón dentro de un bloque cerrado; `test/sales-clusters-ui.test.js:20` espera análisis automático al entrar, incompatible con el comportamiento manual ya existente. No se alteraron estas pruebas ni sus pantallas para ocultar los fallos.
- `git diff --check` y comprobación de sintaxis de los módulos/scripts: sin errores.

Comandos reproducibles:

```sh
node --test test/recurrence.test.js test/recurrence-source.test.js test/recurrence-api.test.js test/recurrence-ui.test.js test/sales-margin-ui.test.js test/ui.test.js
npm test
node scripts/reconcile-recurrence.js /private/tmp/recurrencia.json
node scripts/capture-recurrence.js /private/tmp/recurrencia-capturas
```

Los dos últimos comandos requieren localhost iniciado. No sincronizan proveedores. La conciliación JSON conserva agregados y muestras sin referencias personales ni de tarjeta. Las pruebas usan fixtures temporales; el script de capturas usa los datos locales visibles y no abre el detalle de pagos.

## Rendimiento medido

| Alcance | Anterior (ms) | Resumen inicial (ms) | Segunda consulta (ms) | Reutiliza snapshot | Compras (ms) | Exportación JSON (ms) |
|---|---:|---:|---:|---|---:|---:|
| Portal Lyon | 2772 | 1050 | 11 | Sí | 11525 | 15 |
| La Concepcion | 12410 | 2977 | 2346 | No: incidencia de lectura | 6979 | 23 |
| Todas las cafeterías | 12189 | 2639 | 2552 | No: incidencia de lectura | 7253 | 30 |

Medición: `2026-10-25T19:46:32.024Z`. Portal Lyon reutiliza caché. En La Concepción y Todas se vuelve a leer por una incidencia de esquema en un archivo, conservando el aviso y la provisionalidad; no se promete un acierto de caché ante fuentes ilegibles.

Son mediciones individuales en este equipo, con la suite de pruebas y la aplicación local; no constituyen percentiles ni garantías de latencia. «Anterior» consulta el dashboard completo y, por tanto, hace más trabajo: se informa como costo del flujo sustituido, no como un benchmark aislado del algoritmo. Resumen no carga pedidos Toteat; Compras prepara el cruce una vez y reutiliza el resultado. El payload de exportación medido no incluye el tiempo de construir/escribir XLSX en el navegador.

El worker separa el cálculo del hilo HTTP, limita memoria a 512 MB y admite hasta seis solicitudes pendientes. El tiempo máximo es 120 s; un agotamiento produce error visible, nunca resultados ficticios. Cancelar en la interfaz no detiene un cálculo síncrono ya iniciado en el worker; sí aborta la espera y evita presentar su respuesta como resultado de los filtros nuevos.

## Capturas y evidencia

- [Resumen, escritorio](capturas/recurrencia-resumen-escritorio.png).
- [Retorno, escritorio](capturas/recurrencia-retorno-escritorio.png).
- [Compras, escritorio](capturas/recurrencia-compras-escritorio.png).
- [Calidad de datos, escritorio](capturas/recurrencia-calidad-escritorio.png).
- [Resumen, móvil de 390 px](capturas/recurrencia-resumen-movil.png).
- [Retorno, móvil de 390 px](capturas/recurrencia-retorno-movil.png).
- [Verificación de consultas y errores](capturas/verificacion-interfaz.json).
- [Conciliación y tiempos por alcance](RECURRENCIA_CONCILIACION.json).

Quedan como límites de los datos: identidad aproximada entre cuentas, estados/devoluciones/propinas de MP no acreditados, cobertura histórica incompleta y enlaces estimados sin referencia explícita verificada. Los importes y fechas observados se muestran con esos límites; no se inventan aprobaciones, adquisiciones de clientes nuevos ni tasas maduras donde falta seguimiento.
