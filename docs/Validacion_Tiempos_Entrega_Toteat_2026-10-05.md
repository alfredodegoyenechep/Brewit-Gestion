# Validación de tiempos de entrega de TotEat

Fecha: 05-10-2026. Local: La Concepción. Revisión final: 12:02 de Santiago.

## Resultado

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
