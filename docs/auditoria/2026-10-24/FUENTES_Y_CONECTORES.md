# Fuentes y conectores: diagnóstico de TotEat y Mercado Pago

Auditoría del 24-10-2026. Las rutas se identificaron en código; los tiempos reales provienen de registros ya existentes. No se hicieron nuevas consultas con credenciales a proveedores. Las pruebas de fallos y repetición usan fuentes simuladas.

## 1. Respuesta a la duda principal

**Brewit sí tiene conectores directos a TotEat.** Ventas/pagos y movimientos contables llegan como JSON mediante su API pública. Para los maestros completos existe una conexión a servicios internos autenticados. Otros documentos de inventario se consultan por HTTP después de obtener una sesión de la aplicación web.

Los nombres `.xlsx` no prueban que Brewit haya descargado Excel desde TotEat. Los publicadores convierten respuestas JSON en libros compatibles con los lectores actuales; el almacenamiento puede persistirlos como descriptores y registros comprimidos. Después, algunos lectores vuelven a construir y analizar un XLSX en memoria. Ese recorrido tiene un costo importante medido en los reportes.

Mercado Pago sí utiliza navegación automatizada y descarga de CSV. Es el candidato más claro para evaluar la API oficial de reportes, sujeto a acceso y equivalencia de campos.

## 2. Inventario de fuentes

| Fuente | Obtención actual | Alcance y tratamiento | Diagnóstico / decisión |
| --- | --- | --- | --- |
| Ventas y detalle de pagos | GET público `/mw/or/1.0/sales`, token por cafetería | Ventanas fijas de hasta 15 días; pagos normalizados; turnos y fechas de operaciones diferenciados; publicación conjunta de ventas y pagos | Mantener la API; optimizar procesamiento y política de revisión histórica. |
| Turno abierto | GET público `/shiftstatus` antes de ventas | Incluye la ventana del turno abierto aunque sea antiguo; comprueba identidad del local | Mantener esta protección. Medir su costo dentro de la cola, sin eliminarla por ahorrar una llamada. |
| Anulaciones | GET público `/orderstatus` por orden candidata | Pagos positivos sin productos y sin clasificación confirmada; conserva estados conocidos | Optimizar la reevaluación de candidatos no resueltos con vigencia explícita; no omitir anulaciones. |
| Compras contables | GET público `/accountingmovements`, `include_sales=false` | Últimas tres ventanas de 15 días en actualización normal; excluye `CASH_FLOW`; versiones por documento | Mantener. El formato público no reemplaza por sí solo la evidencia de bodega receptora. |
| Recepciones de compras | GET autenticado `inventory.toteat.com/purchases/`, `source=web` | Inicia una lectura nativa; recorre desde la compra más antigua necesaria, en ventanas de 15 días | Optimizar rango/reutilización y separar catálogo de documentos. No atribuir todo este tiempo a la API pública de compras. |
| Productos, ingredientes, extras y recetas | Servicio interno `/locals/{localRef}/products/` | Identidades, tipos, unidades, conversiones, costos y recetas; comprueba que la colección esté completa | Mantener contenido completo; resolver credencial soportada con TotEat. El menú público no acredita equivalencia. |
| Proveedores y bodegas | Servicios internos `/locals/{localRef}/providers/` y `/warehouses/` | Se obtienen junto con maestros o lecturas nativas según el flujo | Reutilizar una captura coherente durante un trabajo; conservar identidad de local. |
| Jerarquías | Servicio interno `/resto/setupconfig`, módulos 5100/5115/5110 | Tres consultas; validación de estructura | Mantener; evitar repetirlas en cada sublectura de una actualización completa cuando no sea necesario. |
| Tomas físicas | GET autenticado `/take-inventory/` | Ventanas de 15 días; estados de documentos preservados; solo aprobados afectan el saldo | Mantener documentos originales. Evitar la doble lectura en «Inventario» y «Tomas originales» del mismo trabajo. |
| Transferencias entre bodegas | GET autenticado `/transfer-warehouse/` | Documentos originales, identificadores, estados y líneas | Mantener; revisar incrementalidad y correcciones tardías. |
| Transformaciones | GET autenticado `/transformations/` | Entradas y salidas originales; receta/consumo sin contabilizar dos veces | Mantener; evitar reconstruir todo el rango cuando una actualización acotada sea suficiente. |
| Transferencias entre locales | Servicio web `RESTsolicitudes`, módulos 5911/5912 | Seis consultas de listas por fechas de creación/recepción/pendientes, más un detalle por solicitud única | Optimizar los detalles repetidos. Confirmar contrato y alternativa soportada con TotEat. No ejecutar endpoints que generen movimientos. |
| Inventario/Kardex usado por los reportes | Libro propio construido desde documentos, ventas, compras y maestros | `sourceKind=native-documents`; depende de las versiones publicadas de las fuentes | Preservar trazabilidad. Separar reconstrucción del libro y consultas de estado/lectura. |
| Inventario público piloto | GET `/inventorystate` | Adaptador disponible; agregado por producto/bodega/día, no documentos originales | No sustituir el libro actual. La búsqueda de usos encontró el adaptador expuesto internamente y sus pruebas, pero no un consumidor activo del flujo de actualización normal. |
| Liquidaciones Mercado Pago | Navegador persistente, tabla `settlement_v2`, descargas CSV | Paginación de reportes; filtra superposición temporal; después importa y deduplica por local | Evaluar sustitución por API oficial de reportes; validar acceso, columnas, períodos y correcciones. |

Implementaciones: [cliente público](../../../toteat-api.js), [lectura nativa](../../../toteat-native.js), [maestros directos](../../../toteat-direct-masters.js), [transferencias multilocal](../../../toteat-local-transfers.js), [coordinador](../../../upload-overview.js), [Mercado Pago](../../../mercadopago-sync.js).

## 3. Qué explica las esperas de TotEat

### Cola compartida y cantidad de consultas

Ventas y compras de todos los locales comparten una cola que permite iniciar una solicitud cada 21 segundos como mínimo. Una actualización incremental de ventas suele necesitar turno + dos ventanas: tres solicitudes por cafetería. Seis solicitudes de dos cafeterías requieren al menos 105 segundos entre el primer y el sexto inicio si comparten esa cola y no hay otra espera mayor. Es una consecuencia de la configuración, no una medición de latencia del proveedor.

La [traza histórica](TRAZA_VENTAS_HISTORICA.csv) muestra respuestas de ambos locales intercaladas. Los tiempos se registran al recibir/guardar respuestas: no permiten separar con precisión espera de cola, red y servicio remoto. La auditoría no inventa esa separación.

La documentación pública consultada confirma ventanas máximas de 15 días para [ventas](https://developers.toteat.com/paths/sales.yaml) e [inventario](https://developers.toteat.com/paths/inventorystate.yaml), y el comportamiento de ventas por turnos. No se encontró en los archivos consultados una definición del límite de 21 segundos ni de su alcance por token/local/restaurante. **No se propone reducirlo sin confirmación.** [Especificación consultada](https://developers.toteat.com/toteatApi_v2.yaml).

### Lecturas completas y repetidas en el camino autenticado

Una lectura nativa abre productos, obtiene catálogo/jerarquías/bodegas y navega a una vista de inventario para obtener la autenticación correspondiente. Luego consulta los documentos solicitados. Ese inicio se repite para recepciones, inventario y tomas cuando se ejecutan como pasos separados.

El coordinador ejecuta «Inventario» con las clases por defecto, que incluyen tomas. A continuación ejecuta «Tomas originales» para el mismo período. Existe una duplicación de consulta comprobable por la cadena de llamadas, aunque las dos publicaciones tengan propósitos distintos.

La actualización de inventario mantiene el inicio histórico de su cobertura; no es incremental por documento. Compras sí reduce las ventanas contables, pero la lectura de recepciones conserva el inicio antiguo requerido por los documentos acumulados. Las pruebas sintéticas registran ambos rangos.

### Maestros directos y sesión vencida

La inspección local de vigencia encontró la credencial de maestros directos vencida desde el 30-09-2026. Esto se basa en el vencimiento registrado, sin probar un token contra TotEat. `readMastersWithSession` permite recurrir a la lectura con navegador cuando recibe `TOTEAT_AUTH_REQUIRED`.

La última actualización completa guardada registró el paso de maestros como exitoso en aproximadamente 29 segundos y su método como «credencial vencida». Es consistente con el mecanismo alternativo, pero el registro no desglosa qué solicitudes tomó cada vía.

La documentación de septiembre afirmaba que no se recurría automáticamente al navegador; esa afirmación ya no describe el código actual. El estado debe distinguir «API pública», «servicio interno directo» y «sesión web» efectivamente usados, además de mostrar la vigencia de credenciales.

### Actualización manual e historia antigua

En la configuración copiada, ventas, compras, maestros, inventario y Mercado Pago ya están en modo manual. No se modificó esa configuración.

Los programadores de ventas y compras contemplan revisiones completas periódicas cuando están habilitados. La actualización manual normal del coordinador no solicita `full:true`. Por tanto, con programación desactivada, no debe asumirse que esa revisión completa diaria sigue ocurriendo. Las correcciones fuera de las ventanas recientes requieren una revisión histórica explícita. Las pruebas sintéticas comparan una corrección antigua antes y después de una actualización completa.

## 4. Mercado Pago: riesgos y alternativa

La búsqueda inicial lee los archivos guardados para obtener la última fecha por local; la descarga empieza en la fecha más antigua entre esos puntos. Recorre páginas y descarga cada reporte que se superpone. La deduplicación de transacciones ocurre **después de descargar y leer archivos**; no evita la transferencia de reportes repetidos.

La identidad de deduplicación utiliza `SOURCE_ID`, `TRANSACTION_TYPE` y el instante de `TRANSACTION_DATE`, dentro del historial del local. Los importes no forman parte de la identidad. Debe distinguirse «registro idéntico» de «misma identidad con contenido corregido», y el punto de avance temporal debe permitir revisar correcciones anteriores. La reproducción sintética y su resultado están en `EVIDENCIA_AGREGADA.json`.

La API oficial documenta [listado](https://www.mercadopago.cl/developers/es/reference/settlements-report/query-report/get) y [descarga](https://www.mercadopago.cl/developers/es/reference/settlements-report/download-report/get) de reportes. No se encontró un conector a esa API en Brewit ni variables de credenciales de Mercado Pago en `.env`. No se dispone aquí de un token autorizado para probar la cuenta: **la viabilidad está documentada; la equivalencia y el acceso efectivo permanecen pendientes**.

La comparación futura debe usar el mismo reporte, cuenta, moneda, local, zona horaria y período; conciliar `REAL_AMOUNT`, fees, tipos de movimiento y cantidad de registros. No sustituir liquidaciones por una búsqueda genérica de pagos ni por el Reporte de Liberaciones sin demostrar que conserva el significado requerido.

## 5. Preguntas preparadas para los proveedores

No se enviaron mensajes a terceros.

**TotEat:** límite oficial por endpoint y alcance de la cuota; soporte de `Retry-After`; credencial de servicio para maestros y documentos internos; renovación sin navegador; endpoints de documentos modificados desde una fecha; tratamiento de eliminaciones/correcciones y su horizonte; paginación de inventario; cobertura por bodega y diferencias entre costos/documentos y agregados de `/inventorystate`.

**Mercado Pago:** acceso de las cuentas actuales a `settlement_report`; correspondencia con `settlement_v2`; disponibilidad de `STORE_ID`, `REAL_AMOUNT` y comisiones; identificación de reportes regenerados; horizonte de correcciones; límites de búsqueda/descarga y estados de generación.

Las consultas documentales no constituyen una confirmación contractual del proveedor ni una autorización para habilitar nuevos permisos.
