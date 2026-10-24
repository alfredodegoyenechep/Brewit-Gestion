# Auditoría de Brewit: fuentes, esperas y experiencia de uso

Fecha: 24-10-2026. Diagnóstico local ejecutado; propuestas de corrección sin aplicar al producto. Prioridad: TotEat, Mercado Pago, cargas de pantalla y administración del dueño.

Seguimiento posterior a la implementación: [medición de tiempos de actualización de todas las fuentes](TIEMPOS_ACTUALIZACION_FUENTES.md). Distingue la actualización de ventas del 24-10 de los trabajos generales históricos y documenta el flujo actual que reutiliza las tomas de inventario.

## Conclusiones principales

1. **La demora tiene dos causas diferentes.** TotEat combina esperas de una cola compartida, consultas repetidas y navegación con sesión. Dentro de Brewit, reconstruir y recorrer libros tabulares repetidamente consume segundos o minutos aunque no se consulte ningún proveedor.
2. **Brewit no depende exclusivamente de descargas de Excel de TotEat.** Ventas/pagos y compras usan JSON de la API pública. Maestros y documentos complementarios usan servicios internos, algunos mediante navegador. Los archivos internos son también un formato de compatibilidad generado por Brewit.
3. **La proyección de compras requiere atención inmediata:** mediana de 64,23 segundos en cinco ejecuciones con la copia de datos. Una muestra registró 540 lecturas de libros y 1.240 conversiones a filas. El perfil ubicó el trabajo repetido en las correcciones de inventario que vuelven a leer ventas por intervalo.
4. **La lista de órdenes es rápida, pero puede esperar al servidor ocupado.** Su mediana fue 2,84 ms en reposo; desde un navegador independiente, al coincidir con resultados financieros, esperó una mediana de 10,43 segundos. No se encontró una reconstrucción de inventario dentro de la ruta de listado.
5. **Dos defectos de consistencia fueron reproducidos:** una respuesta financiera antigua puede sobrescribir la selección actual; una corrección de Mercado Pago con la misma identidad se descarta como duplicada aunque cambie el importe. El segundo se probó con datos sintéticos, sin afirmar todavía perjuicio en los registros reales.
6. **El modo manual ya está guardado para todas las fuentes.** No hay que cambiar esa configuración para lograr el objetivo acordado. Sí hace falta distinguir consulta, recálculo y actualización externa, y hacer explícita la revisión de correcciones históricas.

## Evidencia y condiciones de medición

- Código base `3910b29f7cb7`, incluyendo los cambios locales existentes. La huella del diff y versión de Node están en [EVIDENCIA_AGREGADA.json](EVIDENCIA_AGREGADA.json).
- Equipo: Apple M4 Pro, 14 CPU lógicas, 24 GiB RAM; macOS arm64; Node `v24.13.0`; Chrome local en modo headless.
- Copia privada: 8.213 archivos, 1.356.127.035 bytes, sin credenciales ni perfiles de navegador. Se comprobó estabilidad de tamaño/fecha durante la copia de cada archivo y se conservaron hashes en el manifiesto privado. No es una certificación de snapshot transaccional de la instalación en ejecución.
- Sincronizadores y mantenimiento automático desactivados en la copia; sin PostgreSQL operativo; navegación y fetch instrumentados para bloquear consultas externas. Las pruebas de fuentes inyectan respuestas/descargas sintéticas.
- Se analizaron 1.595 manifiestos históricos. Los tiempos históricos no son repeticiones controladas: abarcan distintos días, volúmenes, errores y competencia por la cola.
- Se hicieron cinco consultas por cada uno de diez recorridos HTTP, cinco aperturas por ocho vistas y cinco pruebas de concurrencia desde otro proceso. No se informa P95 con cinco muestras.
- Las aperturas del navegador se midieron invocando el mismo despachador de vistas que usa la navegación. Incluyen una espera de estabilización de 200–300 ms; no equivalen al tiempo exacto de pintura. Inventario tuvo una comprobación adicional de oportunidad de renderizado entre 25 y 33 ms.
- Se perfiló CPU durante tres segundos de la proyección y se inspeccionó brevemente el proceso aislado. Las medidas son diagnósticas, no un compromiso de servicio. «Primera consulta» no significa caché de disco fría ni reinicio completo entre muestras.
- La instrumentación inicial utilizó un selector incorrecto para el estado de inventario y un parámetro incorrecto de fecha de costos. Se corrigieron y se repitieron cinco veces esas comprobaciones; los resúmenes finales usan la comprobación corregida. Se conservaron las muestras originales identificables.

## Tiempos observados

### Consultas de Brewit con fuentes guardadas

| Acción | Mediana, cinco muestras | Rango | Resultado |
| --- | ---: | ---: | --- |
| Listar órdenes de La Concepcion | 0,003 s | 0,003–0,004 s | HTTP 200 |
| Abrir una orden guardada | 0,001 s | 0,001–0,001 s | HTTP 200 |
| Estado de fuentes | 0,172 s | 0,167–0,400 s | HTTP 200 |
| Compras de octubre, La Concepcion | 0,158 s | 0,145–0,434 s | HTTP 200 |
| Ingredientes de octubre, La Concepcion | 4,548 s | 4,526–4,744 s | HTTP 200 |
| Revisión de costos al 23-10, La Concepcion | 0,630 s | 0,595–0,678 s | HTTP 200 |
| Resumen de ventas de la red | 6,417 s | 6,376–6,777 s | HTTP 200 |
| Resultados financieros de octubre, red | 9,900 s | 9,727–10,076 s | HTTP 200 |
| Inventario de Bodega Principal | 0,587 s | 0,582–0,908 s | HTTP 200 |
| Proyección de Bodega Principal | 64,230 s | 63,459–64,795 s | HTTP 200 |

Detalle: [TIEMPOS_API.csv](TIEMPOS_API.csv), [TIEMPOS_UI.csv](TIEMPOS_UI.csv) y [MUESTRAS_SOLICITUDES.csv](MUESTRAS_SOLICITUDES.csv). Un HTTP 200 no certifica exactitud financiera ni cobertura completa.

### Dónde se consume el tiempo interno

| Muestra | Tiempo de servidor | Lecturas de libros | Tiempo dentro del lector de libros | Lecturas de disco |
| --- | ---: | ---: | ---: | ---: |
| Ingredientes | 4,62 s | 44 | 3,76 s | 326 / 0,038 s |
| Resumen de red | 6,77 s | 55 | 4,11 s | 381 / 0,071 s |
| Resultados financieros | 9,90 s | 207 | 6,98 s | 1.257 / 0,257 s |
| Proyección de compras | 64,23 s | 540 | 47,94 s | 1.933 / 0,359 s |

Son mediciones anidadas: **no deben sumarse** las columnas como tiempos independientes. El lector `record-store.readWorkbook` puede transformar registros a XLSX y volver a analizarlos para conservar compatibilidad con SheetJS. Su caché es de 16 MiB y excluye libros mayores de 2 MiB; aun los aciertos realizan copia profunda. Por eso «hay caché» no garantiza un recorrido barato.

El perfil de CPU confirmó trabajo en lectura/reconstrucción de libros, serialización XML y extracción de filas, dentro de `projectionInventory → inventoryCorrection → periodSalesData`. La optimización debe reutilizar filas/contextos de ventas y calcular correcciones por intervalos necesarios sin reconstruir el mismo libro. Cambiar de disco o sustituir TotEat por otra fuente no elimina este trabajo.

Las rutas síncronas también retienen el hilo que atiende otras solicitudes. La medición global observó una pausa máxima del event loop de aproximadamente 64,8 s durante la proyección sin streaming. La interfaz usa streaming para esa proyección y puede ceder entre etapas; una etapa pesada sigue siendo síncrona. No se atribuye automáticamente ese bloqueo completo al recorrido de streaming sin medirlo.

### Actualizaciones históricas de proveedores

La actualización completa guardada del 20-10 a las 22:57 de Santiago —inicio UTC 21-10 01:57:23— duró **381,66 s**. Sus nueve pasos se ejecutaron secuencialmente: maestros 29,00 s; ventas Concepcion 47,57 s; compras Concepcion 70,35 s; inventario Concepcion 38,06 s; tomas Concepcion 32,56 s; ventas Lyon 45,38 s; compras Lyon 89,39 s; inventario Lyon 21,47 s; tomas Lyon 7,86 s.

En el conjunto de ejecuciones completas registradas desde octubre: ventas Concepcion, 74 muestras, mediana 94,8 s; ventas Lyon, 73 muestras, 110,4 s; compras Concepcion, 10 muestras, 70,4 s; compras Lyon, 9 muestras, 89,3 s. Son duraciones de trabajos que incluyen cola y procesamiento, no latencia pura de TotEat. Mercado Pago solo tiene una ejecución web completa conservada en ese conjunto, de 17,1 s: no permite obtener un tiempo típico confiable.

Los [conectores y sus causas](FUENTES_Y_CONECTORES.md) están desarrollados por fuente. La [traza histórica de ventas](TRAZA_VENTAS_HISTORICA.csv) muestra respuestas intercaladas de dos locales, coherentes con la cola compartida. Falta instrumentación de inicio/fin de cada solicitud real para atribuir exactamente espera de cola, red y proveedor.

## Consistencia, cobertura y controles que sí funcionan

- Cinco pruebas sintéticas de ventas sin cambios conservaron la versión publicada: las huellas excluyen campos volátiles. No se confirmó que una nueva fecha de sincronización por sí sola genere nuevos libros. Sí se normalizan datos para decidir que no cambiaron, y conservar una recepción histórica sigue teniendo costo.
- El caso de ventas inicial necesitó 12 solicitudes simuladas, mientras una repetición normal necesitó tres. Una corrección de mayo quedó invisible en la repetición incremental y apareció al pedir `full:true`. No existe una revisión completa diaria efectiva si el programador que la inicia está desactivado.
- Compras redujo de once a tres consultas contables, pero volvió a pedir recepciones desde el 18-05 al 24-10 en el caso sintético. Las versiones sin cambios se conservaron.
- Mercado Pago descargó el reporte en cada intento; la importación idéntica no duplicó filas. Sin embargo, ante `REAL_AMOUNT=900` con la misma identidad que el registro existente de 1.000, conservó 1.000 y contó un duplicado, en cinco repeticiones.
- Las pruebas existentes validaron preservación de versión ante fallo, rechazo de paginación incompleta, anulaciones, pagos divididos, independencia de tomas y control histórico. Son controles a conservar al optimizar.
- La [cobertura de fuentes](COBERTURA_FUENTES.csv) no es uniforme: ventas llegaban al 24-10, mientras compras y movimientos/tomas llegaban al 20-10 en la copia. Concepcion tenía 11.963 órdenes / 11.974 pagos y Lyon 580 / 581. Las incidencias de normalización existentes se conservaron; su número no equivale a documentos perdidos ni se cerró una conciliación monetaria integral en esta auditoría.
- La lectura `stock.current()` puede reconstruir el libro si cambiaron sus dependencias. Esto afecta llamadas de estado/lectura y contradice una expectativa estricta de «recalcular solo al pulsar el botón». Hace falta separar invalidación, reconstrucción y lectura conservando la coherencia; eliminar la reconstrucción sin mostrar vigencia produciría saldos antiguos presentados como actuales.

## Interfaz

Hay mensajes de carga visibles en las principales pantallas medidas; la ausencia concreta se encontró al abrir Datos y sincronización. Compras, ingredientes, costos y resultados presentan oportunidades para preparar filtros antes de consultar. La proyección ya espera una acción explícita al entrar y no lanzó consultas en cinco aperturas.

Se reprodujeron dos solicitudes al modificar dos fechas de compras. Se reprodujo cinco veces la sobrescritura de resultados financieros al entrar, modificar el período, salir y volver, con respuestas invertidas. Los filtros muestran el período nuevo mientras el estado final proviene de la respuesta vieja.

La [propuesta de UI](PROPUESTA_UI.md) incluye navegación por tareas, criterios de carga y recorridos; el [esquema HTML](PROPUESTA_UI.html) permite revisar los estados propuestos sin conectarse a datos reales.

## Pruebas y alcance completado

- Grupo de 18 archivos relevantes: **105 pruebas, 104 aprobadas y una fallida**, sin omisiones. La falla está en un selector del test de Control histórico: `getByText('Promedio diario')` encuentra también el encabezado del modal de órdenes. No prueba por sí sola un defecto de producto. La propuesta es limitar el selector al panel correspondiente.
- Grupo adicional de compras/órdenes/recaudación: **4 pruebas aprobadas**, sin fallos ni omisiones. Total de estas ejecuciones: **109 pruebas; 108 aprobadas y una fallida**.
- Reproducciones adicionales: 20 escenarios de ventas, 10 de compras y 15 de Mercado Pago; cinco comprobaciones de conservación ante fallo/segundo local y cinco de contenido corregido. Son reproducciones con aserciones, no una cifra agregada de cobertura del sistema.
- Mediciones: 50 consultas HTTP; 40 aperturas de vistas; cinco pares concurrentes desde Chrome; cinco inversiones de respuestas por navegación. Los controles de stock y costos se verificaron de nuevo tras corregir instrumentación.

Las pruebas y artefactos no cambian APIs, esquemas, cálculos ni navegación del producto. Los cambios locales preexistentes se conservaron.

Los comandos y resultados de las pruebas existentes están en [PRUEBAS.txt](PRUEBAS.txt). Se verificaron además la sintaxis de los cinco scripts de auditoría, todos los enlaces locales y la estructura de los CSV. El esquema HTML se abrió en Chrome a 1440 × 1000 sin errores de JavaScript ni desbordamiento horizontal. La huella del diff de los archivos de producto coincidió con la línea base al terminar.

## Pendientes que requieren evidencia externa

1. **TotEat:** confirmar límite oficial y alcance de la cuota, credenciales soportadas para maestros/documentos e incrementalidad por fecha de modificación. No se redujo la separación de 21 s.
2. **Mercado Pago:** disponer de un token autorizado de las cuentas correspondientes y comparar el reporte API con el actual. La documentación prueba la existencia de la alternativa, no el acceso de nuestras cuentas. No se habilitaron permisos ni se enviaron mensajes.
3. **Inventario público:** el piloto anterior dejó diferencias y cobertura pendiente. Se revalidaron el adaptador y sus pruebas; no se repitió una extracción real ni se certificó equivalencia con el libro actual.
4. **Rendimiento remoto:** los manifiestos conservados no desglosan completamente cada fase. No se ejecutaron descargas reales repetidas para fabricar una muestra. Medir login, red y proveedor por separado requiere observar una próxima actualización solicitada por el usuario con instrumentación por solicitud.
5. **Uso humano y despliegue:** la evaluación de UI no incluye una sesión de usabilidad con el dueño, ni una auditoría completa de red pública, respaldo o PostgreSQL operativo.

Estos límites afectan las conclusiones señaladas, no las reproducciones locales confirmadas. El [plan de correcciones](PLAN_CORRECCIONES.md) ordena el trabajo y define cómo validar cada cambio.

## Reproducción

Desde la raíz del repositorio: ejecutar `preparar.cjs`, `medir.cjs`, `reproducir.cjs`, `verificar-ui.cjs` y `resumir.cjs` de esta carpeta, en ese orden. Los scripts de servidor/navegador requieren permisos para localhost y Chrome. `preparar.cjs` crea una nueva copia privada; las mediciones tardan varios minutos, especialmente las cinco proyecciones. No ejecutarlos simultáneamente para comparar tiempos.

El manifiesto de hashes, los perfiles de CPU y las capturas originales permanecen en la carpeta privada de `/private/tmp` indicada por `/private/tmp/brewit-audit-current.txt`; no están publicados en Git. Los CSV y JSON de esta carpeta contienen agregados, rutas sin identificadores de órdenes y resultados sintéticos. Revisar los scripts antes de reutilizarlos con otro entorno o política de acceso.
