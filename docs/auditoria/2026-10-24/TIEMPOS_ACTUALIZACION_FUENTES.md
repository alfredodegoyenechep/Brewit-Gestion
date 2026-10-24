# Tiempos de actualización de fuentes

Medición revisada el 24-10-2026. Este documento trata la **actualización de datos externos**, no el tiempo de abrir un informe con datos ya guardados. La proyección de compras, por ejemplo, es un cálculo local distinto.

## Cómo se midió

Se leyeron los manifiestos de trabajos completados en `uploads/.historical-control/runs`, el estado del último trabajo conjunto y el diagnóstico temporal de solicitudes públicas observado durante la actualización de ventas del 24-10. No se lanzaron nuevas descargas para fabricar repeticiones. La columna «mediana reciente» usa hasta cinco trabajos completos más recientes por fuente y local; son ejecuciones reales **no controladas**, con períodos, volumen y ocupación del servidor potencialmente distintos. Los tiempos incluyen espera, consulta, normalización y publicación. No permiten atribuir por sí solos la latencia del proveedor.

| Fuente / ubicación | Última ejecución exitosa | Tiempo último | Mediana reciente (hasta 5) | Proceso actual |
| --- | --- | ---: | ---: | --- |
| Ventas y detalle de pagos · La Concepción | 24-10, 15:47:55 UTC | **94,69 s** | 94,75 s | API pública TotEat; turno, ventanas de ventas, anulaciones cuando corresponda, validación y publicación conjunta. |
| Ventas y detalle de pagos · Portal Lyon | 24-10, 15:47:55 UTC | **110,17 s** | 110,17 s | Igual; comparte cola pública con La Concepción y compras. |
| Compras · La Concepción | 21-10 | **70,35 s** | 69,65 s | Movimientos contables por API pública; luego recepciones originales mediante sesión web; conciliación y publicación. |
| Compras · Portal Lyon | 21-10 | **89,39 s** | 90,82 s | Igual. |
| Maestros compartidos | 21-10 | **29,00 s** | 43,74 s | Productos, unidades, recetas, jerarquías, proveedores y bodegas; servicio interno y, al vencer la credencial directa, respaldo con sesión web. |
| Inventario y movimientos · La Concepción | 21-10 | **38,06 s** | 37,34 s | Sesión web; tomas, transferencias, transformaciones, movimientos entre locales y publicación del libro. |
| Inventario y movimientos · Portal Lyon | 21-10 | **21,47 s** | 19,98 s | Igual. |
| Tomas originales · La Concepción | 21-10 | **32,56 s** | 22,96 s | Paso separado del trabajo conjunto antiguo. El código actual reutiliza las tomas del paso de inventario en esa modalidad. |
| Tomas originales · Portal Lyon | 21-10 | **7,85 s** | 6,85 s | Misma salvedad. Una actualización individual de tomas todavía ejecuta su propia lectura. |
| Mercado Pago · ambos locales | 23-10 | **17,06 s** | Sin muestra suficiente | Navegador web, cuatro CSV, 590 transacciones nuevas, 180 filas idénticas omitidas después de la descarga. |
| Marketing, colaboradores, calibraciones | Sin trabajo de proveedor | No aplica | No aplica | Archivos cargados por el usuario; no tienen un conector externo ni una acción de sincronización comparable. |

Las dos ventas del 24-10 comenzaron prácticamente juntas. Su **tiempo de reloj conjunto fue 110,17 s**, no la suma de 94,69 y 110,17 s. En cambio, el último trabajo general guardado del 21-10 ejecutó nueve pasos en serie y duró **381,66 s (6 min 22 s)**. Ese trabajo usó el flujo anterior: las dos lecturas separadas de tomas consumieron 40,41 s en conjunto. El flujo general actual ya comparte esa captura; todavía no existe una medición real del trabajo general completo con ese cambio, por lo que 381,66 s no es una predicción de su duración actual.

## Dónde se pierde tiempo

### Ventas y pagos

Brewit consulta `shiftstatus` por local y ventanas de hasta 15 días de `sales`. En la medición original del 24-10 consultaba dos ventanas recientes por local. La actualización manual rápida implementada después consulta la ventana vigente, además de las ventanas faltantes y las necesarias por turnos abiertos; la revisión histórica explícita conserva la consulta de períodos anteriores. Después valida, normaliza pedidos y pagos y publica una versión conjunta si cambió el contenido. Los XLSX de ventas y detalle de pagos los **genera Brewit** desde JSON; no son libros descargados de TotEat. Las verificaciones `orderstatus` de anulaciones pueden añadir solicitudes cuando hay candidatos sin clasificación.

En la actualización del 24-10 se observaron seis solicitudes públicas: dos `shiftstatus` y cuatro `sales`. La red tardó entre **0,59 y 7,41 s por solicitud**; la suma de red de esas seis fue aproximadamente **21,55 s** y la lectura de cuerpos aproximadamente **0,86 s**. La cola de Brewit inicia solicitudes públicas con **21 s de separación** y es compartida por ambos locales y por compras. Seis inicios ocupan como mínimo unos **105 s entre el primero y el último**. Las esperas registradas para solicitudes simultáneas no se deben sumar, porque se superponen. El límite de 21 s es configuración de Brewit; **aún no está confirmado como contrato de TotEat**.

### Compras

La actualización normal consulta hasta tres ventanas contables recientes de 15 días por local en `accountingmovements` y excluye movimientos de caja ajenos a compras. Después valida **todas** las compras conservadas y lee las recepciones originales desde la fecha de emisión más antigua de los documentos acumulados hasta hoy. Esa segunda parte usa la aplicación autenticada de TotEat y puede recorrer muchos períodos antiguos aunque la consulta contable sea incremental. Identifica la bodega receptora, concilia documentos y publica una versión si cambió el contenido. Por ello, reducir solo las llamadas públicas no elimina el costo de la actualización de compras. No hay un desglose temporal guardado de «cola / recepciones / publicación» para los trabajos del 21-10.

### Maestros e inventario

Los maestros completos provienen de servicios internos autenticados. La credencial directa guardada figura vencida; el código intenta continuar por una sesión web autorizada. Esto añade inicio de navegador y obtención repetida de catálogo, jerarquías y bodegas, además de fragilidad por renovación de sesión. Las lecturas de inventario recorren por ventanas de 15 días tomas, transferencias y transformaciones dentro de su cobertura histórica, y consultan las transferencias entre locales por listas y detalles. No son simples consultas de saldo agregado. La API pública de inventario sigue como piloto; aún no demuestra equivalencia por documento, bodega y costo para reemplazar estas fuentes.

El trabajo general actual reutiliza la captura de tomas del paso de inventario y reconstruye una vez. Los tiempos individuales anteriores de «Tomas originales» sirven para cuantificar la duplicación eliminada en el flujo antiguo, pero no deben sumarse al flujo actual.

### Mercado Pago y archivos manuales

Mercado Pago abre la página de liquidaciones, recorre la tabla paginada, descarga los CSV cuyos períodos se superponen con el rango y **después** los importa y deduplica. Las 180 filas omitidas en la última ejecución ya habían consumido descarga y lectura. Un único trabajo de 17,06 s no permite afirmar que ésa sea su latencia típica. El adaptador de API oficial sigue en piloto, pendiente de token autorizado y comparación de campos, importes, comisiones y correcciones; no es el conector productivo.

Marketing, consumo de colaboradores y calibraciones se actualizan al subir archivos. Su duración depende de tamaño/formato y no existe en los manifiestos una medición comparable de una sincronización externa. No se les asigna un tiempo inventado.

## Mejoras ordenadas por impacto y riesgo

1. **Confirmar la cuota real de TotEat y medirla por ruta/cuenta/local.** Si el proveedor permite menos de 21 s o colas independientes por credencial, cambiar esa configuración puede reducir mucho la espera de ventas y compras. No bajarla a ciegas: un 429, bloqueo o dato incompleto sería peor. Registrar por trabajo inicios, espera, red, tamaño, filas, procesamiento y publicación, sin secretos.
2. **Ofrecer actualización reciente y revisión histórica como alcances visibles.** Ya existe la revisión manual de un período. Para el uso diario, conservar las ventanas necesarias para correcciones recientes; usar la revisión explícita o una política acordada para correcciones antiguas. No eliminar `shiftstatus` ni anulaciones sin una garantía de equivalencia.
3. **Hacer incrementales las recepciones y documentos de inventario con reconciliación segura.** Guardar documentos por identidad/versión y releer un solapamiento definido; revisar periódicamente períodos antiguos y pendientes. Esto requiere demostrar cómo TotEat expone modificaciones y eliminaciones. La prioridad inmediata es medir cuántas ventanas y documentos se repiten.
4. **Compartir sesión, catálogo y jerarquías dentro de un trabajo.** Cargar cada maestro una vez por local y reutilizarlo entre recepciones e inventario sin mezclar cuentas ni perder trazabilidad. Resolver la credencial soportada con TotEat para evitar renovaciones manuales del navegador.
5. **Ejecutar etapas independientes en paralelo controlado.** El coordinador general todavía espera un paso completo antes del siguiente; se puede solapar trabajo interno con la espera de la cola pública, respetando que el libro de inventario use versiones coherentes de ventas, compras y maestros. No lanzar sesiones web simultáneas sin comprobar que conviven.
6. **Evitar CSV de Mercado Pago repetidos.** Guardar identificador/versión/huella del reporte y saltar la descarga cuando la fuente confirme que no cambió, manteniendo revisión de correcciones. El piloto de API puede eliminar navegación frágil si logra paridad fila a fila con el reporte web.
7. **Separar descarga y publicación sin cambios.** Las huellas actuales evitan generar una versión final idéntica; aún se paga la consulta y parte de la normalización. Una señal fiable de «sin cambios» del proveedor permitiría evitar más trabajo, siempre que incluya correcciones y bajas.

La oportunidad de mayor magnitud observada hoy está en la **cola de ventas**, seguida por la lectura histórica repetida en **compras e inventario**. Los tiempos de otros informes calculados con fuentes guardadas se analizan aparte en [AUDITORIA_BREWIT.md](AUDITORIA_BREWIT.md) y [IMPLEMENTACION_CORRECCIONES.md](IMPLEMENTACION_CORRECCIONES.md).

La propuesta focalizada, con ahorro potencial, condiciones de integridad y secuencia de implementación, está en [PLAN_OPTIMIZACION_VENTAS_PAGOS.md](PLAN_OPTIMIZACION_VENTAS_PAGOS.md).
