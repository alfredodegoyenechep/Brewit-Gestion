# Validación de tiempos de entrega de TotEat

Fecha: 05-10-2026. Local: La Concepción. Revisión final: 12:02 de Santiago.

**Alcance actualizado por el usuario el 06-10-2026:** medir preparación hasta Finalizado KDS. Se excluye entrega física al cliente; su observación ya no es un requisito para implementar estos reportes. Las referencias posteriores a entrega corresponden a la investigación inicial.

## Seguimiento del 06-10-2026

Se repitió el piloto de lectura a las 15:01 de Santiago con ventas sincronizadas a las 14:16:44 del mismo día. Cinco pedidos respondieron HTTP 200 y `ok=true`; todas sus líneas públicas siguen indicando `statusKDS = NOT_STATUS`, sin historial de finalización. La lectura nativa no pudo realizarse (`session-unavailable`). Esto no confirma ausencia de eventos: no se pudo consultar su fuente nativa.

Muestra nueva: pedidos de local `1791306256958783`, `1791305811292026` y `1791305719008473`; para llevar `1791306839919112` y `1791306189858954`. El primero cubre también varios productos. Evidencia privada: `uploads/.integrations/toteat-api/delivery-review/probe-da901582-c4a7-4060-884d-595fdc323ab9.json`. No se modificaron permisos, estaciones ni webhooks. Las seis pruebas del piloto pasaron.

**Decisión para Análisis y Estadísticas:** todavía no está validado el reporte de entrega al cliente. La evidencia del 5 de octubre permite calcular intervalos hasta finalización KDS para 3 de 5 pedidos (60% de esa muestra, sin extrapolar a la operación). Los tres son de local; para llevar tiene 0 de 2 pedidos con finalización completa. La cobertura histórica sigue sin confirmar.

Reglas para la futura implementación:

- Separar tiempo hasta finalización KDS de tiempo hasta entrega al cliente. Usar 110 como indicador de entrega únicamente después de contrastarlo con observaciones reales y documentar el procedimiento y su cobertura.
- Por pedido: apertura hasta la última finalización de todas sus líneas vigentes. Por producto: ingreso de la línea hasta su evento correspondiente. Validar anulaciones, reaperturas y productos añadidos antes de automatizar.
- Cruzar ventas y eventos por IDs de pedido y línea. Los IDs de producto de ventas y de la fuente nativa usan representaciones distintas; requieren correspondencia explícita antes de agrupar por producto.
- Mantener tiempos faltantes como desconocidos. Mostrar pedidos elegibles, medibles, incompletos y cobertura junto a promedio, mediana y percentiles. Calcular estadísticas solo con intervalos válidos y mostrar el tamaño de muestra.
- Separar local, para llevar y modalidad desconocida. Presentar fechas en `America/Santiago` y calcular diferencias entre instantes UTC.
- Confirmar una fuente estable y su retención antes de programar sincronización. La consulta pública actual no proporciona estos eventos y la lectura nativa depende de una sesión interactiva.

Pendiente externo: sesión nativa vigente y cinco entregas observadas (dos local, dos para llevar y una con varios productos, incluyendo entregas separadas), con IDs, horas de entrega y marcas KDS. Consultar estados no certifica una entrega física.

### Prueba de DELIVERY_INFORMATION

El 06-10-2026 a las 15:22 de Santiago se consultaron los mismos cinco pedidos con `body_detail_type=DELIVERY_INFORMATION`, omitiendo `det`. Las cinco respuestas fueron HTTP 200, `ok=true`, con identidad de pedido confirmada. Todas devolvieron `status=CLOSED` y `status_kds=NOT STATUS`. La fecha `creation_date` coincide con la apertura de la muestra; este formato no aportó eventos de finalización ni horas de entrega para calcular intervalos.

La respuesta incluye productos y datos de despacho, pero no resuelve la falta de historial KDS detectada con `det=true`. Cierre y pago no certifican entrega. Evidencia privada sin credenciales ni datos de clientes: `uploads/.integrations/toteat-api/delivery-review/delivery-information-c3e38853-02d4-498e-b71d-b637af1c4b25.json`. No se modificó TotEat.

Referencias verificadas: [endpoint orderstatus](https://developers.toteat.com/paths/orderstatus.yaml), [esquemas](https://developers.toteat.com/components/schemas.yaml) y [webhook de pedidos](https://developers.toteat.com/webhooks/order_webhooks.yaml). La documentación pública asigna 180 a entrega en `deliveryStatusId`; no debe mezclarse con 130 del KDS nativo. `time` del webhook describe la generación de la notificación. Soporte debe confirmar exposición de eventos KDS y sus timestamps efectivos.

### Fuente adicional: Operaciones Avanzado / KDS

El usuario aportó una captura del reporte nativo el 06-10-2026. Muestra pestañas KDS / Resumen y Detalle, tiempos entre estados y una serie diaria de duración de órdenes. Entre los valores visibles: Pendiente → Preparando 3m 34.7s y Preparando → Finalizado 41.5s. No se verificaron los filtros, local, denominador ni consulta de esos valores; no se usan para certificar la muestra anterior ni como promedio general.

Se comprobó mediante lectura del código público de la aplicación que `/reportes/operations` usa `AnalyticsCtrl` y carga un dashboard Apache Superset con el SDK de integración. El controlador consulta `GET /analytics/dashboard_id/?type=operations` para obtener `dashboard_id` y `superset_uri`, y `GET /analytics/login/?type=operations` para obtener un token de invitado. Ambos usan la autenticación de la sesión de TotEat, distinta del token de API pública. En `res8.toteat.com`, el código configura `SSLdomain=https://api.toteat.com`.

Fuente técnica: `https://res8.toteat.com/scripts/toteat.min.1.00260929.1062.js`, enlazada por el HTML público de la aplicación. Esto identifica otra vía de investigación; todavía no confirma acceso programático a los datasets ni a exportaciones del dashboard.

Se identificó la pestaña de Chrome abierta en `https://res8.toteat.com/#/reportes/operations`. El puerto CDP configurado rechaza conexiones y Chrome deshabilita ejecución de JavaScript desde Apple Events. Se solicitó al usuario habilitar esta última opción para inspeccionar la sesión existente sin reiniciar el navegador.

Siguiente verificación: resolver el dashboard con la sesión vigente, inspeccionar consultas y columnas de KDS / Detalle, comprobar filtros y alcance del local, y extraer una muestra de eventos o intervalos que pueda contrastarse con pedidos. Los tiempos entre estados registrados pueden analizarse sin observación física; validar que un estado representa entrega efectiva sigue siendo una comprobación separada.

### Lectura Analytics recuperada y comprobada

Con Apple Events habilitado se recuperó el acceso del dashboard desde la sesión existente, sin guardar tokens. Dashboard 42, «Operaciones Avanzado», datasets `order_summary` (128) y `order_product` (127). Las consultas de datos se ejecutan con el contexto del dashboard y sus gráficos autorizados, conservando las restricciones de acceso de TotEat. La configuración local de la sesión confirma restaurante `1774666275011576`, local 1.

Se consultó el período `2026-09-29 : 2026-10-07` (fin exclusivo). Se recuperaron 714 pedidos únicos y 1.288 filas de productos, sin alcanzar el límite de filas: 709 pedidos / 1.281 filas de «Brewit» y 5 pedidos / 7 filas de «Brewit 2». Debe conservarse el alcance por restaurante; no mezclar ambos locales en indicadores. La correspondencia exacta del nombre de Analytics con el registro de locales debe quedar explícita al integrar.

Para «Brewit», excluyendo los dos pedidos `CANCELED`, hay 707 pedidos:

| Intervalo | Campo | Pedidos medibles | Promedio |
| --- | --- | ---: | --- |
| Pendiente → Preparando | `kds_p_ip` | 15 | 3m 34,7s |
| Preparando → Finalizado | `kds_ip_f` | 12 | 41,5s |
| Finalizado → En Delivery | `kds_f_d` | 0 | Sin datos |
| Pendiente → Finalizado | `kds_p_f` | 272 | 4m 52,8s |

Los primeros dos promedios coinciden con la captura del usuario. Los intervalos están en milisegundos. La mediana Pendiente → Finalizado es 4m 6,8s. Cobertura de ese intervalo: 272/707 = 38,5%; no representa a todos los pedidos. No se usan los nulos como cero. Estas cifras corresponden a la consulta capturada, no a un período certificado como completamente sincronizado.

Cruce por `legacy_id` con la muestra nativa del 5 de octubre:

| Pedido | Historial nativo (segundos) | Analytics `kds_p_f` (milisegundos) |
| --- | ---: | ---: |
| 1791211025471468 | 394 | 394067 |
| 1791210591015915 | 307 | 306202 |
| 1791209559962763 | 247 | 246555 |
| 1791210805717915 | Sin finalización | null |
| 1791210730688356 | Sin finalización | null |

Las diferencias inferiores a un segundo son compatibles con distinta precisión de timestamps; no se exige igualdad exacta entre segundos y milisegundos. La fuente permite recuperar intervalos reales registrados KDS sin depender de `/orderstatus`.

Limitaciones verificadas:

- `created_at` de Analytics aparece tres horas antes del instante UTC nativo en los casos cruzados, coincidiendo con la hora local de Santiago. No convertirlo automáticamente como UTC ni reconstruir entrega sumando intervalos antes de resolver esta semántica. Los intervalos numéricos evitan ese problema para medir duraciones.
- Las 1.288 filas de producto devuelven `order_type=Take Away`, incluyendo pedidos de la muestra seleccionados como local. Esta clasificación no está validada para segmentar consumo local / para llevar.
- Los datasets disponibles exponen intervalos; esta lectura no recuperó el historial completo de transiciones, IDs de línea ni un evento de entrega física. No certifica tiempos hasta entrega al cliente.
- El lector depende de Chrome con sesión vigente y permiso Apple Events. La ejecución independiente funciona, pero no es todavía una integración desatendida soportada.

Reproducción de lectura, sin modificar TotEat:

```sh
node scripts/validate-toteat-kds-analytics.js 2026-09-29 2026-10-07
```

Script comprobado de extremo a extremo: 714 pedidos y 1.288 filas de productos. Evidencia privada sin tokens ni datos personales: `uploads/.integrations/toteat-api/delivery-review/analytics-kds-982c7c4f-7d01-4cd7-9599-9cd2ac838acd.json`.

**Decisión actualizada:** es viable implementar en Análisis y Estadísticas reportes de tiempos KDS registrados, con cobertura y tamaño de muestra por etapa y local. Para automatizar, falta resolver acceso estable, correspondencia de locales y semántica de fechas. La modalidad y el tiempo de entrega física siguen pendientes de validación; no deben bloquear el análisis de preparación KDS ya recuperado.

### Auditoría completa de cobertura de preparación

El 06-10-2026 se cruzaron los **707 pedidos no anulados de Brewit** del período anterior con `GET /resto/orders/procesa`: 707 identidades confirmadas, cero fallos. Se leyeron exclusivamente campos de estado, impresora y eventos, sin guardar datos de clientes ni credenciales. Las dos estaciones están activas, enrutan por impresora (101 → 3, 102 → 4) y admiten pedidos de mesa, delivery y virtuales. Las líneas históricas consultadas usan esas impresoras: 539 líneas en 3 y 761 en 4; dos líneas anuladas (175), las otras 1.298 en 200. Todos los pedidos contienen al menos una línea principal vigente en esas impresoras, por lo que no se detectaron pedidos fuera del enrutamiento KDS en este conjunto. No se certifica visualización física en cada pantalla ni se reconstruyen configuraciones históricas diferentes.

| Resultado | Pedidos |
| --- | ---: |
| Sin finalización de líneas principales vigentes ni intervalo Analytics | 400 |
| Solo algunas líneas principales finalizadas, sin intervalo Analytics | 35 |
| Con finalización de encabezado e intervalo Analytics | 272 |
| De los anteriores, con todas las líneas principales vigentes finalizadas | 271 |

Los 272 intervalos Analytics coinciden con la diferencia entre evento inicial y final del encabezado nativo; máxima diferencia 942 ms (precisión de segundos frente a milisegundos). No hubo pedidos sin intervalo Analytics que tuvieran finalización de encabezado ni todas sus líneas principales finalizadas. Los faltantes ya existen en el historial nativo: no hay evidencia, en este cruce, de que Analytics esté perdiendo finales registrados.

**Excepción de pedido completo:** `1790766048090545` registra final del encabezado a las 11:10:37 UTC del 30 de septiembre y `kds_p_f=589633`, pero añade otra línea a las 13:55:25 UTC que permanece en 0. El encabezado 110 no basta para declarar completo el contenido vigente. Para el reporte de pedido completo hay que validar sus líneas y detectar adiciones posteriores al final. Cobertura estricta: **271/707 = 38,3%**; para reproducir el indicador de finalización de encabezado de TotEat: 272/707 = 38,5%.

La explicación comprobada de la cobertura es falta de evento final y finalización parcial de productos. Tener un inicio permite mostrar un cronómetro; no produce automáticamente un fin registrado. Los registros no distinguen entre omisión de marcado, falta de guardado/sincronización o retención del historial: no se atribuye el problema al personal ni a una falla específica de TotEat sin observar el flujo de guardado. No se sustituyen estos finales por cobro o cierre.

La muestra diagnóstica inicial fue de 28 pedidos (dos con y dos sin intervalo por cada fecha disponible). Evidencia privada: `coverage-native-sample-2026-10-06.json`. La auditoría completa y el caso excepcional quedan en `uploads/.integrations/toteat-api/delivery-review/coverage-native-full-2026-10-06.json`.

Para Análisis y Estadísticas: informar inicio → final KDS y cobertura, distinguir finalización del encabezado de pedido completo, mantener los incompletos como desconocidos y no exigir estados intermedios para el intervalo total. El alcance ya excluye entrega física. Antes de pretender cobertura total, verificar operacionalmente el marcado y guardado de finales de todas las líneas, especialmente adiciones posteriores al final del encabezado.

### Revisión del flujo KDS

Se revisaron la guía oficial, el código público del POS y la configuración guardada de las estaciones, mediante lecturas de la sesión actual. No se cambiaron estados de pedidos ni configuración.

Flujo documentado por TotEat: el pedido aparece con su tiempo de creación; seleccionar un producto cambia su estado; aparece el botón de diskette para guardar; al guardar el último estado el producto desaparece; cuando todos los productos finalizan se retira la tarjeta. Fuente: [Cómo usar el KDS](https://toteat.com/es-co/ayuda/ayuda-detalle/como-usar-el-kds). Selección visual y persistencia son pasos distintos según esta guía; no se observó una operación real en la pantalla del local.

Configuración comprobada en ambas estaciones:

- Estados `[0,100,110]`, último estado 110.
- `jst=true`: se permite saltar estados. La transición directa 0 → 110 explica que haya tiempo total sin intervalo de preparación intermedio.
- `bst=true`: se permite volver a estados anteriores.
- `vis=false`: no están en modo solo visualización.
- Todos los canales de pedido habilitados; enrutamiento por impresoras 3 y 4.
- `closeOrderByKds=0`: no se configura el cierre automático de la cuenta al finalizar KDS. Esto no establece la conducta inversa de la pantalla al cerrar desde caja.

Evidencia privada: `uploads/.integrations/toteat-api/delivery-review/kds-flow-config-2026-10-06.json`.

Hallazgo adicional del código público del POS: la asignación KDS calcula `statusAmostrar=configKDS.sts.slice(0, configKDS.sts.slice.length-1)`. Una comprobación aislada con `[0,100,110]` devuelve `[0]`; usar la longitud del arreglo devolvería `[0,100]`. Es una posible anomalía de enrutamiento al recalcular líneas en preparación. No se verificó su ejecución efectiva en las pantallas ni demuestra la causa de los 400 pedidos sin finalización. Debe contrastarse con TotEat antes de atribuir efectos operativos.

Límite de la revisión: el Chrome accesible tiene Analytics, no las pantallas KDS operativas. Se solicitó la URL de esas pantallas para inspeccionar su implementación de guardado, confirmación del servidor, errores/reintentos y filtros de pedidos cerrados. Con la evidencia actual no se distingue omisión de guardado de falla de persistencia/sincronización ni se concluye que cerrar la cuenta retire automáticamente un pedido del KDS.

## Resultado de la revisión del 05-10-2026

**Cobertura insuficiente para validar la entrega efectiva al cliente.** Se identificaron las líneas de cinco pedidos reales en ambas fuentes; tres tienen eventos de finalización KDS y dos no. Ninguno tiene un evento explícito de entrega. No se sustituyó ese dato por el cierre de cuenta, la última modificación ni la hora de una notificación.

El usuario informa que el equipo finaliza KDS al entregar al cliente. Sin embargo, las dos estaciones están configuradas para terminar en **110, Terminado de Preparar**, no en **130, Entregado a Cliente**. El evento 110 podría servir como indicador de entrega bajo ese procedimiento operativo, pero no se observaron físicamente las cinco entregas. Por tanto, el criterio de cinco correspondencias inequívocas todavía no se cumple. Esta revisión no declara que un evento de entrega física no exista: declara que las fuentes verificadas no lo distinguen suficientemente.

## Acceso habilitado y comprobado

- API existente de Brewit, local `store-1`: se habilitó únicamente **Can get an order**, propiedad `cf.sec.go`.
- La lectura posterior confirmó que la única diferencia de configuración fue `cf.sec.go`, de `false` a `true`.
- Se conservaron el token de TotEat y el archivo de credenciales local; los demás permisos y ajustes coinciden antes y después.
- Las cinco consultas públicas de `/orderstatus?det=true` ahora responden HTTP 200 y `ok=true`. Inicialmente respondían `Not Authorized`.
- El Webhook Global y el webhook de pedidos de esta API siguen desactivados. No se añadieron receptores, pantallas ni rutas a Brewit.

La primera sesión guardada permitía leer configuración, pero rechazaba guardarla por expiración. El cambio se completó mediante la sesión activa del navegador conectado. No se renovó ni reemplazó el token público.

## Fuentes contrastadas

| Fuente | Evidencia obtenida | Uso posible |
| --- | --- | --- |
| Ventas sincronizadas | IDs de pedido y línea, apertura, cierre y modalidad inferida del comentario | Elegir la muestra y cruzar identidades; cierre no equivale a entrega |
| API pública `/orderstatus`, detalle completo | Creación, modificación, pedido cerrado y `document.line[].statusKDS = NOT_STATUS` en los cinco pedidos | Consulta de pedidos autorizada; no aporta el historial KDS de esta muestra |
| Lectura nativa autenticada `GET /resto/orders/procesa` | Por línea: `li`, `ip`, `lk`, `fp`, `stk` y `lstk` | Recuperar los cambios KDS que realmente fueron registrados |
| Configuración nativa, módulos 5005 y 5097 | Estaciones, estados disponibles, sincronización con delivery y Webhook Global | Interpretar los eventos sin mezclar sus códigos con los estados públicos de delivery |

Estaciones activas: **101, KDS BEBIDAS CALIENTES**, y **102, KDS BEBIDAS FRIAS Y FOOD**. Ambas usan `[0, 100, 110]`. La sincronización KDS/delivery, `syncdvy`, está desactivada. No se modificaron estos ajustes.

El visor de logs de la aplicación de TotEat interpreta `lstk` como fecha, estación/actor y estado. Su código añade `-0000` a la fecha; se conservó el instante UTC y se presentó en `America/Santiago`. No se tomó la fecha de modificación del pedido como fecha de cambio KDS.

## Cinco pedidos revisados

Horas del 05-10-2026 en Santiago. La modalidad se seleccionó por señales explícitas «servir»/«llevar», sin conservar nombres ni comentarios de clientes en la evidencia del piloto.

| ID de pedido | Modalidad | Líneas cruzadas | Apertura | Última finalización KDS registrada | Entrega efectiva validada |
| --- | --- | --- | --- | --- | --- |
| 1791211025471468 | Local | 2/2 | 11:37:05 | 11:43:39, estado 110 | Pendiente |
| 1791210591015915 | Local | 2/2 | 11:29:50 | 11:34:57, estado 110 | Pendiente |
| 1791210805717915 | Para llevar | 1/1 | 11:33:25 | Sin evento final; permanece en 0 | Pendiente |
| 1791210730688356 | Para llevar | 2/2 | 11:32:10 | Sin evento final; permanece en 0 | Pendiente |
| 1791209559962763 | Local, varios productos | 3/3 | 11:12:39 | 11:16:46, estado 110 | Pendiente |

En el último pedido, dos productos finalizaron en la estación 101 a las **11:15:44**, y el tercero en la estación 102 a las **11:16:46**: diferencia de **62 segundos**. Esto confirma eventos separados por producto, no una observación física de entregas separadas. Para un eventual cálculo de pedido completo, corresponde usar la última entrega de todas sus líneas vigentes, excluyendo anuladas; no la primera finalización.

Los tres pedidos con finalización admiten intervalos hasta el evento 110 de 6:34, 5:07 y 4:07 respectivamente. Son intervalos hasta **finalización KDS**; no se publicaron como tiempos de entrega. La falta de eventos en los otros dos pedidos no se interpretó como espera cero ni se completó con el cierre de cuenta.

Se revisaron ocho candidatos adicionales con varias categorías para encontrar el caso de eventos separados. Sus resultados se conservaron aparte de la muestra final.

## Histórico

Se recuperaron además pedidos del **21 y 30 de septiembre y 2 de octubre** mediante la lectura nativa. Sus líneas conservan eventos iniciales de estado 0, pero no tienen finalizaciones 110 ni entregas 130. Otro pedido del 7 de septiembre tampoco aportó finalizaciones.

Esto demuestra lectura de pedidos y eventos iniciales anteriores, pero no garantiza cobertura histórica de entregas. No permite distinguir entre finalizaciones nunca registradas y eventos no retenidos. Tampoco demuestra que sea obligatorio empezar desde la activación de un webhook: el historial nativo ya permite recuperar eventos registrados hoy sin activarlo.

## Evidencia y reproducción

La evidencia mínima, sin tokens ni datos de clientes, queda en el directorio privado y excluido de Git `uploads/.integrations/toteat-api/delivery-review/`:

- `permission-audit.json`: único permiso cambiado y conservación del token/configuración.
- `kds-config-audit.json`: estaciones, estados, sincronización y webhook.
- `final-review.json`: muestra final, respuestas públicas y logs nativos, con **0/5 entregas validadas**.
- `historical-orders.json` y `additional-native-orders.json`: comprobaciones adicionales.

El script independiente no cambia datos de TotEat ni publica fuentes. Sin argumentos prepara una muestra nueva; `--query` consulta la API pública y `--native` lee el navegador ya conectado, que debe tener una sesión vigente de La Concepción:

```sh
node scripts/validate-toteat-delivery.js --query --native
node --test test/toteat-delivery-review.test.js
```

La selección automática busca dos pedidos de local, dos para llevar y otro con varios productos; no presupone que tengan finalizaciones separadas. La muestra final documentada se refinó con los logs reales. Los archivos nuevos se guardan por ejecución y nunca se certifican automáticamente como entregas validadas.

## Condición para construir el reporte

Primero contrastar con el equipo cinco entregas efectivas y sus eventos KDS, incluyendo para llevar y productos entregados por separado. Si el procedimiento confirmado usa 110 al entregar, documentar esa correspondencia y medir su cobertura; si se distingue preparación de entrega, acordar el registro explícito de entrega antes de modificar las estaciones. No cambiar los estados KDS como parte de esta revisión.

La fuente candidata para los timestamps ya registrados es el historial nativo autenticado, sujeto a sesión vigente. La API pública y un eventual Webhook Global requieren confirmación de TotEat sobre exposición de eventos KDS y timestamps reales. La solicitud a soporte está preparada en `docs/Solicitud_Toteat_Tiempos_KDS.md`, sin enviar.

Fuentes oficiales consultadas el 05-10-2026: [configuración API](https://developers.toteat.com/tags/config_tag.yaml), [consulta de estados](https://developers.toteat.com/paths/orderstatus.yaml), [esquemas](https://developers.toteat.com/components/schemas.yaml), [webhooks de pedidos](https://developers.toteat.com/webhooks/order_webhooks.yaml) y [operación KDS](https://toteat.com/es-co/ayuda/ayuda-detalle/como-usar-el-kds). Los campos internos y la configuración descritos se verificaron mediante lecturas reales y el visor de logs de la aplicación.
