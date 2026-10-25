# Brewit — Evaluación y especificación de la nueva vista de recurrencia
Fecha: 25 de octubre de 2026  
Destino: Codex / equipo de desarrollo  
Estado: especificación implementada con validación automatizada y conciliación local. Las limitaciones del proveedor permanecen explícitas; no constituye una certificación de identidad ni de cobertura histórica completa.

## 1. Instrucción para Codex

Rediseñar el reporte de recurrencia existente siguiendo esta especificación. Primero inspeccionar el repositorio, los modelos, las consultas, las reglas de identificación, los estados de pagos y los componentes reutilizables. Mantener las convenciones y arquitectura del proyecto. No crear un sistema paralelo ni reescribir integraciones sin necesidad.

Entregar:
1. Nueva vista con pestañas Resumen, Retorno, Compras y Calidad de datos.
2. Una definición compartida de regreso en otra fecha, usada por backend y todas las vistas.
3. Indicadores con numerador, denominador, alcance, cobertura y fecha de corte trazables.
4. Pruebas de los casos de aceptación de este documento.
5. Conciliación del reporte anterior con el nuevo, explicando cambios de metodología.
6. Breve documentación de archivos modificados, validaciones y limitaciones pendientes.

No pedir decisiones sobre detalles rutinarios que esta especificación ya resuelve. Si un campo requerido no existe, implementar el estado de información no disponible y documentar la limitación; no inventar valores ni garantías del proveedor.

## 2. Dictamen ejecutivo

El reporte actual tiene una base útil y varias decisiones correctas: consulta historial anterior al período, evita usar compras futuras en filas históricas, expresa cambios de tasas en puntos porcentuales, conserva pedidos sin vínculo confiable y exige seguimiento completo para el retorno a 30 días.

Sin embargo, necesita una revisión de metodología y presentación antes de tratarlo como un tablero claro de fidelización:

- Mezcla repetición de transacciones, instrumentos recurrentes y regreso en días distintos.
- Puede considerar recurrente un segundo pago del mismo día.
- Usa intervalos históricos para describir frecuencia, sin mostrar si el instrumento sigue activo.
- Presenta ausencia de información como 0%.
- Combina períodos, universos y bases monetarias diferentes en una pantalla muy densa.
- Da poco protagonismo a la pregunta más útil: de quienes observamos por primera vez, ¿cuántos regresan con el mismo tiempo de seguimiento?

Recomendación: conservar las integraciones y el trabajo útil del reporte actual; sustituir la vista principal y unificar las definiciones. La recurrencia observable es una estimación basada en instrumentos de pago, no un conteo de personas.

## 3. Evaluación de la captura

### 3.1 Qué se puede comprobar

Los siguientes cálculos se reconstruyen con los valores visibles; no certifican la extracción de datos:

| Indicador visible | Comprobación | Evaluación |
|---|---|---|
| Venta recurrente mensual | $458.546 / $3.387.847 = 13,535% | Compatible con 13,5% |
| Venta recurrente semana 19–25 octubre | $313.440 / $1.498.555 = 20,916% | Compatible con 20,9% |
| Grupos de frecuencia | 29 + 23 + 9 + 0 + 0 = 61 | Suman el contador de recurrentes MP |
| Instrumentos recurrentes del bloque observable | 54 / 477 = 11,321% | Compatible con 11,3% |
| Participación de venta del segmento recurrente observable | $571.059 / ($571.059 + $2.053.815 + $201.597) = 20,204% | Compatible con 20,2% |
| Retorno a 30 días | 0 instrumentos elegibles | Correcto mostrar «—», no 0% |
| Pedidos con vínculo, deducidos de los tres segmentos | (133 + 427) / (133 + 427 + 48) = 92,1% | Cobertura de vínculo por cantidad dentro de ese bloque |

Los 61 instrumentos sobre 497 equivalen a 12,3%. Es un porcentaje distinto del 15,0% de transacciones recurrentes: tienen denominadores y unidades diferentes. No deben compartir una etiqueta genérica de «recurrencia».

Los 54 y los 61 tampoco permiten concluir que exactamente siete instrumentos repitieron solo el mismo día: cambian tanto el criterio como la población identificada (477 frente a 497).

### 3.2 Hallazgos que requieren corrección

**A. Segundo pago del mismo día.**  
Puede corresponder a una compra adicional, un pago dividido o una segunda atención. Es útil conservarlo como transacción, pero no usarlo para afirmar que alguien volvió otro día. La nueva unidad será «día con compra»: un instrumento en una fecha local determinada.

**B. Frecuencia histórica sin actualidad.**  
Dos compras separadas por un día, seguidas por dos meses sin compras, conservan un intervalo de un día. El intervalo no está matemáticamente mal calculado; la interpretación como frecuencia vigente sí resulta engañosa. Mostrar actividad reciente y recencia por separado.

**C. Etiquetas de frecuencia.**  
«Más de 3 veces por semana» y «Más de 1 vez por semana» parecen categorías superpuestas. Además, convertir intervalos entre transacciones en visitas semanales resulta especialmente frágil con dos compras o pagos del mismo día. Sustituir por días con compra en una ventana explícita de 28 días.

**D. Ceros sin información.**  
Las filas anteriores a la cobertura y el día sin operaciones aparecen como 0,0%. Cuando el denominador es cero, el porcentaje es indefinido. Cuando faltan datos, ni siquiera se conoce el resultado. Distinguir ambos estados.

**E. Comparaciones sin base.**  
La captura muestra variaciones de porcentaje frente a períodos sin operaciones o sin base. No corresponde comunicar +15 puntos porcentuales contra un porcentaje anterior indefinido. Mostrar «Sin base comparable».

**F. Historial corto.**  
La captura muestra actividad concentrada en octubre, mientras el aviso cita cobertura desde el 14 de septiembre. Revisar por fuente: la cobertura de Toteat no demuestra cobertura de MercadoPago. Tampoco la fecha del primer pago demuestra que todo lo anterior esté correctamente cargado.

**G. Crecimiento de recurrencia en un local nuevo.**  
La secuencia semanal 2,2% → 9,4% → 20,9% de importe recurrente es descriptivamente favorable bajo la metodología actual, pero parte puede explicarse por acumulación natural de historial y diferencias de mezcla. No atribuirla por sí sola a una mejora de fidelización ni a una campaña.

**H. Diseño.**  
Hay demasiado ancho, texto pequeño, tablas repetidas, abreviaturas difíciles y productos mezclados con recurrencia. Los avisos se repiten y las limitaciones importantes compiten con datos de detalle. El usuario debe poder entender la vista principal sin leer un bloque técnico.

### 3.3 Control adicional de conciliación

Si las 586 operaciones del mes fueran todas identificables, correspondieran a 497 instrumentos y el método anterior contara cada operación posterior a la primera, habría al menos 586 − 497 = 89 operaciones recurrentes: 15,19%, que se mostraría como 15,2%, no 15,0%.

Esto NO prueba un error: puede haber operaciones sin identificador, filtros o universos distintos. Codex debe reconstruir los numeradores y denominadores antes de emitir un dictamen. No ajustar cifras a mano para hacerlas coincidir.

## 4. Preguntas que debe responder la nueva vista

1. ¿Cuántos instrumentos distintos compraron en el período y cuántos ya tienen compras en otra fecha?
2. ¿Qué proporción de los días con compra corresponde a regresos?
3. ¿Qué parte del importe cobrado identificado proviene de compras realizadas después del primer día?
4. ¿Cuántos de los instrumentos observados por primera vez vuelven en 7, 14 y 30 días?
5. ¿Cuántos días compran durante las últimas cuatro semanas?
6. ¿Cuánto tiempo llevan sin comprar los instrumentos previamente recurrentes?
7. ¿Qué compran en sus regresos y qué tan representativa es la información disponible?

No usar un único porcentaje para responder a todas estas preguntas.

## 5. Universo y reglas comunes

### 5.1 Instrumento, persona y alcance

Texto permanente bajo el título:
«Estimación basada en medios de pago. Un instrumento no equivale necesariamente a una persona.»

- Usar «instrumentos» o «medios de pago identificados» en cifras; no «clientes únicos».
- La combinación de prefijo y últimos cuatro dígitos es una clave aproximada: distintas tarjetas pueden coincidir y una persona puede usar varias tarjetas. Una tarjeta también puede pagar por varias personas.
- No afirmar que un hash convierte esa combinación en una identidad única. Si se usa HMAC para proteger la clave, conservar igualmente la calidad «aproximada».
- Revisar si la integración real dispone de un identificador estable documentado y comprobar su alcance entre locales/cuentas. No asumir que un token de transacción o cualquier card_id es estable ni global.
- No mezclar claves de distintas versiones sin una migración explícita.
- Instrumentos incompletos, campos vacíos o valores de relleno: «No identificable». Nunca agrupar todos los nulos como una tarjeta.
- No exponer dígitos de tarjetas ni nombres de personas en la vista o exportación; usar un alias opaco para el detalle.

### 5.2 Fuente principal

**Resumen, Retorno y Frecuencia:** pagos válidos de MercadoPago con identificación utilizable. No exigir vínculo con Toteat, para no perder instrumentos solo porque falte el emparejamiento.

**Compras:** pedidos válidos de Toteat con vínculo confiable a esos pagos, con información de productos y venta del pedido.

**Calidad:** todos los pagos y pedidos de los universos correspondientes, incluidos no identificables/no vinculados.

La misma regla de regreso debe utilizarse en las dos fuentes. Un pedido vinculado hereda el historial del instrumento en MP; no recalcular su primera aparición usando solamente pedidos que consiguieron vínculo.

### 5.3 Día y alcance territorial

- Zona horaria: America/Santiago, respetando cambios de hora.
- Día: fecha calendario local, no intervalo móvil de 24 horas.
- Día con compra: combinación única de alcance + instrumento + fecha local.
- Dos o más pagos del mismo instrumento el mismo día cuentan como un día con compra. Sus importes sí se suman.
- Alcance por defecto al seleccionar una cafetería: recurrencia en esa cafetería.
- Al seleccionar «Todas»: recurrencia en la cadena. Un instrumento que visita dos cafeterías el mismo día cuenta como un día con compra a nivel cadena.
- El total cadena se recalcula sobre la unión de datos; nunca se suman instrumentos únicos de las sucursales.
- Los importes y los pagos de cada cafetería sí mantienen su atribución.
- Si no se puede demostrar que la clave es comparable entre cuentas de pago, informar la limitación del consolidado y no prometer deduplicación real.

Primera versión: no añadir un selector ambiguo de «local/cadena» además de la cafetería. Si después se agrega una comparación «nuevo en este local, conocido en la cadena», mantener ambas dimensiones separadas.

### 5.4 Fechas y corte

Definir:
- P = período principal seleccionado, con fecha/hora inicial y final.
- T = instante efectivo de corte: menor entre el final solicitado y el último instante de cobertura confirmada de las fuentes necesarias.
- D = último día local completamente cubierto, no necesariamente el día de la consulta.
- H = historial válido anterior o igual a T del alcance seleccionado.

El filtro de período limita la actividad mostrada, no borra el historial previo usado para clasificarla.

En consultas históricas, no usar compras posteriores a T. La pestaña Retorno puede consultar compras posteriores a la fecha de entrada de una cohorte, pero nunca posteriores a su corte de seguimiento explícito.

Las métricas de cohortes y ventanas de 28 días usan días completos hasta D. Los datos de hoy pueden mostrarse provisionalmente en el período principal, rotulados «En curso hasta HH:mm». Evitar fingir que el día completo está observado.

### 5.5 Pagos y dinero

Codex debe localizar los campos reales y registrar su mapeo. Propuesta por defecto:
- Incluir compras aprobadas/capturadas de producción.
- Excluir pruebas, fallidas, pendientes, anuladas, duplicadas y devoluciones completas.
- Descontar devoluciones parciales del pago original; conservar el evento de compra si queda importe positivo.
- Un reembolso no es una visita.
- Usar identificador de pago con ámbito de cuenta/proveedor para deduplicar.
- No deduplicar por importe + hora: pueden existir dos compras reales iguales.
- Vincular ajustes a su operación original, con trazabilidad.

El importe de MP no debe llamarse automáticamente «venta»: puede incluir propinas u otros conceptos. Usar «Importe cobrado MP» y explicar su composición verificada. Si se separan propinas de manera fiable, mostrar esa base explícitamente.

Por defecto, las series se recalculan con el último estado conocido del pago. Si una devolución posterior cambia un mes anterior, indicarlo como revisión de datos. No presentar esta serie como una foto inmutable de lo conocido en aquella fecha. Si existen snapshots, permitir consultarlos por versión.

En Toteat:
- Usar la venta del pedido después de descuentos y devoluciones, sin propina.
- Obtener neto e IVA de los campos contables disponibles.
- No dividir indiscriminadamente MP por 1,19 para fabricar venta neta.
- Mantener CLP enteros para importes y precisión interna suficiente para porcentajes.

## 6. Diccionario de métricas

Todos los porcentajes deben permitir consultar numerador y denominador. No promediar porcentajes de locales, semanas o cohortes: agregar conteos/importes y dividir nuevamente.

### 6.1 Instrumentos activos

Instrumentos identificables distintos con al menos un pago válido en P.

Mostrar «Instrumentos activos en el período». No usar el total histórico como si fuese la base actual.

### 6.2 Activos con regreso observado

Instrumentos activos en P con al menos dos fechas de compra distintas en H hasta T.

Tasa = activos con regreso observado / instrumentos activos en P.

Incluye tanto conocidos antes del período como instrumentos que aparecen por primera vez en P y regresan dentro de P. No significa que todos sus pagos del período sean compras de regreso.

Ejemplo: primera compra lunes, regreso jueves. Al cierre aparece como instrumento con regreso; la compra del lunes sigue siendo de primera fecha.

### 6.3 Días con compra de regreso

Para cada instrumento i, sea primera_fecha_i la primera fecha válida en el historial del alcance.

- Primera fecha observada: día con compra cuya fecha es igual a primera_fecha_i.
- Día de regreso: día con compra cuya fecha es posterior a primera_fecha_i.

Tasa = días con compra de regreso en P / todos los días con compra identificados en P.

Cada instrumento puede aportar un día inicial y varios días de regreso. El número no es intercambiable con porcentaje de instrumentos.

### 6.4 Importe de compras de regreso

Numerador: importe válido de pagos identificados en P cuya fecha es posterior a primera_fecha_i.  
Denominador principal: importe válido de todos los pagos identificados en P.

Etiqueta: «% del importe identificado en compras de regreso».

Como detalle opcional, mostrar participación sobre todo MP, con tres componentes:
1. Compras de primera fecha.
2. Compras de regreso.
3. Importe no identificable.

Esta segunda participación no es la misma tasa: no mezclar denominadores entre gráficos. No presentar el porcentaje identificado como porcentaje de toda la venta Brewit.

Los pagos de la primera fecha permanecen en primera fecha, aunque sean varios o el instrumento regrese después. No reclasificarlos retroactivamente como importe de regreso.

### 6.5 Primera observación y conocidos antes del período

Partición de instrumentos activos:
- Primera observación en P: primera_fecha_i pertenece a P.
- Ya observados antes de P: primera_fecha_i es anterior al inicio de P.

Ambos grupos son excluyentes y suman los activos. Dentro del primero puede haber instrumentos que regresaron antes del cierre. No sumar «primera observación» + «activos con regreso» esperando obtener activos: se solapan.

«Primera observación» no significa adquisición comprobada de un cliente nuevo.

### 6.6 Frecuencia reciente en 28 días

Ventana W = 28 fechas completas terminadas en D, desde D−27 hasta D inclusive.

Para cada instrumento con actividad en W, contar fechas distintas en W:
- 1 día con compra.
- 2–3 días con compra.
- 4–7 días con compra.
- 8–11 días con compra.
- 12–28 días con compra.

Mostrar número de instrumentos y participación de cada grupo. Todos suman los instrumentos activos de W.

Indicador auxiliar:
Promedio de días con compra por instrumento activo = suma de fechas distintas por instrumento en W / instrumentos activos en W.

No denominarlo «visitas de cada cliente» ni «frecuencia de toda la base»: excluye instrumentos sin actividad.

Mostrar además, en detalle, el grupo con primera observación anterior al inicio de W. Permite comparar una base observada desde antes con quienes ingresaron hace pocos días. No anualizar ni normalizar a cuatro semanas a alguien observado durante dos días.

Si no existen 28 días de cobertura continua, mostrar «Historial insuficiente para 28 días» y una distribución provisional con el número real de días, sin comparar con ventanas completas.

### 6.7 Tiempo desde última compra

Población: instrumentos con al menos dos fechas distintas hasta D y alguna compra en los últimos 90 días completos (D−89 a D).

Agrupar según D − última_fecha:
- 0–7 días.
- 8–14 días.
- 15–30 días.
- 31–60 días.
- 61–89 días.

Los intervalos son excluyentes. Mostrar explícitamente el universo «Recurrentes con actividad en los últimos 90 días». Un contador opcional aparte puede mostrar los de 90 días o más; no incorporarlos silenciosamente a ese denominador.

No llamar «perdidos» a quienes llevan 15 o 30 días sin comprar. Usar «sin compra observada» y tratar cualquier umbral comercial como hipótesis, no como diagnóstico probado.

Si la cobertura de los últimos 90 días es incompleta, marcar la distribución como parcial o no disponible y explicar que una ausencia puede deberse a falta de datos.

### 6.8 Intervalos entre compras

Conservar solo como detalle secundario:
- Eliminar duplicaciones del mismo día.
- Calcular diferencias entre fechas consecutivas por instrumento.
- Para representar al instrumento típico, calcular primero la mediana de intervalos de cada instrumento y después la mediana entre instrumentos elegibles.
- Indicar población, ventana y número de instrumentos.
- Instrumentos con una sola fecha no tienen intervalo: null.
- No agregar artificialmente la espera desde la última compra como intervalo completado.
- La espera se informa en recencia.

No conservar la mediana agrupada de todos los intervalos bajo la misma etiqueta si se cambia el método: sobrepondera instrumentos muy frecuentes y es otra estadística.

## 7. Retorno después de la primera observación

### 7.1 Regla

Para un horizonte h de 7, 14 o 30 días calendario:
- f_i = primera fecha del instrumento en el historial del alcance.
- Elegible si f_i + h <= D, y existe cobertura continua suficiente desde f_i hasta f_i + h.
- Retornó si existe una fecha de compra d con 1 <= d − f_i <= h.
- Tasa = elegibles que retornaron / elegibles.

El mismo día nunca cuenta. El límite h se incluye. No exigir varias vueltas: una basta.

Si hay retornos tempranos de instrumentos todavía inmaduros, no incluirlos en el numerador de la tasa madura. Se pueden mostrar aparte como dato provisional, siempre con su población.

### 7.2 Tarjeta principal de retorno a 30 días

Para evitar mezclar edades, usar una ventana fija de entradas elegibles:
f_i entre D−119 y D−30, inclusive: 90 fechas de primeras observaciones que ya pueden completar 30 días.

Mostrar:
- «Volvieron dentro de 30 días».
- Porcentaje.
- «x de y instrumentos con seguimiento completo».
- Rango explícito de primeras observaciones.
- Fecha de corte.
- Cantidad excluida por cobertura incompleta, si existe.

Esta tarjeta tiene ventana propia; no fingir que es el mismo período de ventas seleccionado. Se recalcula con el corte D elegido. No incluir una flecha comparativa automática en la primera versión.

Si no hay elegibles: «Aún sin seguimiento suficiente» o «Sin instrumentos elegibles», según el motivo real; nunca 0%.

### 7.3 Tabla visual por cohorte

Pestaña Retorno:
- Filas: semana de primera observación, lunes a domingo; selector mensual para períodos largos.
- Columnas: instrumentos de la cohorte; retorno en 7 días; en 14 días; en 30 días.
- Celda: porcentaje y x/y; tooltip con elegibles, retornaron, pendientes y excluidos por datos.
- Intensidad de color en escala fija de 0% a 100%; sin semáforos de bueno/malo no calibrados.
- Cohorte con elegibilidad parcial: etiqueta «Parcial: y/n elegibles».
- Ninguno elegible: «Pendiente».
- Datos faltantes: «Sin cobertura».
- Base elegible menor de 30: «Base pequeña». Es una regla de presentación configurable, no garantía estadística para bases superiores.
- No rellenar pendientes con cero ni incluirlos en promedios.

Las tasas 7/14/30 pueden no crecer de izquierda a derecha si cambian los elegibles. Explicar esto en el tooltip. Añadir opción «Misma base con 30 días completos» para comparar horizontes sobre exactamente los mismos instrumentos; en esa opción sí debe cumplirse R7 <= R14 <= R30.

### 7.4 Sesgo de inicio del historial

Cuando la primera observación coincide con el comienzo de la captura, puede tratarse de alguien que ya compraba antes. Etiquetar las cohortes iniciales «Inicio del historial: adquisición no verificable».

Si se dispone de fecha real de apertura y carga completa desde ese día, indicarlo; sigue sin convertir instrumento en persona.

La cobertura necesaria para verificar que alguien retornó no demuestra que esa fuera su primera compra real. Mantener siempre el término «primera observación».

### 7.5 Retención semanal, como detalle adicional

Opcional después de la primera versión:
instrumentos activos en semana w que compran en w+1 / instrumentos activos en w.

Solo con ambas semanas completas y cubiertas. No confundir con retorno de una cohorte de primeras observaciones. Una persona puede regresar dentro de 30 días y no comprar en la semana siguiente.

## 8. Diseño de interfaz

### 8.1 Estructura general

Título: «Recurrencia y retorno».  
Subtítulo permanente: «Medios de pago observados; no personas identificadas».

Barra de controles:
- Cafetería / Todas.
- Período: últimos 28 días completos por defecto; hoy, esta semana, este mes, personalizado.
- Selector de detalle temporal semanal/mensual para evolución.
- Botón **Generar reportes** y fecha/hora de generación del resultado visible.

Pestañas:
1. Resumen.
2. Retorno.
3. Compras.
4. Calidad de datos.

Abrir la vista, cambiar filtros o navegar entre pestañas no inicia cálculos ni sincronizaciones externas. **Generar reportes** prepara Resumen y cohortes iniciales de MercadoPago. Compras y calidad de vínculos se preparan mediante acciones explícitas; navegar solo muestra lo ya disponible. Retorno conserva fechas de entrada independientes y requiere **Generar retorno** al modificarlas.

### 8.2 Resumen: orden de lectura

| Zona | Contenido | Pregunta |
|---|---|---|
| Franja de estado | Alcance, cobertura, corte y aviso único si hay datos parciales | ¿Qué estoy mirando? |
| Cuatro tarjetas | Activos; activos con regreso; importe identificado de regreso; retorno a 30 días | ¿Cuál es la situación? |
| Gráfico principal | Días con compra de primera fecha y de regreso por semana | ¿Está creciendo el regreso? |
| Dos paneles inferiores | Frecuencia 28 días; tiempo desde última compra | ¿Con qué intensidad y actualidad? |
| Enlace de detalle | Tabla exportable y definiciones | ¿Cómo compruebo las cifras? |

Tarjetas:
1. «Instrumentos activos»: n; debajo, primera observación / ya observados.
2. «Activos con regreso observado»: x/y y %; tooltip sobre dos fechas hasta el corte.
3. «Importe de compras de regreso»: % y $ numerador / $ identificado; composición MP aclarada.
4. «Volvieron en 30 días»: % y x/y; su ventana propia visible.

No mostrar simultáneamente seis porcentajes de recurrencia sin jerarquía.

### 8.3 Gráfico principal

Barras apiladas por semana:
- Primera fecha observada.
- Días de regreso.

Por defecto, 8 semanas; opción 12 y vista mensual de 6 meses. No forzar todas las barras dentro de 28 días si el gráfico declara una ventana de tendencia diferente.

Tooltip: rango, días iniciales, días de regreso, total identificado, % de regreso, instrumentos activos y cobertura.

Selector «Cantidad / Porcentaje». En cantidad, mostrar volumen. En porcentaje, barras al 100%. No usar doble eje.

Períodos antes del historial: omitirlos por defecto, con nota sobre el inicio; si se muestran, deben ser huecos «Sin cobertura». No conectar líneas a través de vacíos. Semana actual parcial con trama o marca visible; no comparar su volumen con semanas completas.

La tabla detallada puede contener también el importe de regreso, sin añadir otra serie monetaria al mismo gráfico.

### 8.4 Frecuencia

Barras horizontales ordenadas por días con compra: 1; 2–3; 4–7; 8–11; 12–28.

Mostrar conteo y porcentaje al extremo. Título «Días con compra durante 28 días completos» con fechas. La ventana termina en D, independientemente del inicio del filtro de ventas; mostrar esa diferencia de forma visible.

Evitar etiquetas ambiguas como «más de una vez».

### 8.5 Recencia

Barras horizontales con categorías de días desde la última compra, población explícita y número de instrumentos.

No usar rojo automáticamente para 15 días ni presentar estimaciones de dinero perdido.

### 8.6 Retorno

Priorizar la tabla visual de cohortes y una frase legible:
«De los y instrumentos elegibles de esta cohorte, x volvieron en otra fecha dentro de 30 días».

Mantener los detalles de seguimiento junto a la cifra, no escondidos en un párrafo inferior.

### 8.7 Compras

Título: «Qué compran en sus regresos — pedidos vinculados».

Comparar por defecto pedidos de primera fecha frente a pedidos de regreso, clasificados según la fecha del pedido y el historial MP, no según el estado futuro del instrumento.

Mostrar como máximo:
- Pedidos y venta neta sin IVA.
- Ticket mediano con IVA, sin propina.
- Unidades por pedido.
- Penetración de categorías.
- Tres productos principales.

Penetración de categoría = pedidos del segmento que incluyen al menos un producto de esa categoría / pedidos del segmento. Puede sumar más del 100% entre categorías.

Unidades por pedido = suma de cantidades de productos elegibles / pedidos. Definir cómo se tratan combos, modificadores y componentes para no contarlos dos veces.

Top productos: ordenar por porcentaje de pedidos que los contienen, mostrando base y unidades opcionales. No deducir causalidad: que un producto aparezca más entre regresos no prueba que cause la recurrencia.

Conservar en Calidad el grupo de pedidos no clasificables y su venta. Una cobertura alta por conteo no garantiza cobertura equivalente por importe o tipo de compra.

Modalidad «para llevar»: solo mostrar si el campo es confiable. Separar «sin información»; nunca interpretar nulos como consumo en local.

El análisis retrospectivo «todo lo que compran instrumentos recurrentes al cierre, incluida su primera compra» puede conservarse en un desplegable avanzado claramente rotulado. No usarlo como serie principal.

### 8.8 Calidad de datos

Mostrar tarjetas y tabla por local/fuente:
- Desde cuándo hay cobertura confirmada.
- Última fecha/hora sincronizada.
- Días faltantes y períodos parciales.
- Pagos totales válidos / identificables.
- Importe total MP / identificable.
- Pedidos válidos Toteat / con vínculo confiable / clasificables.
- Venta neta Toteat / venta neta de pedidos clasificables.
- Motivos de no clasificación.
- Versión de las reglas y fecha de generación.

Indicadores:
1. Identificación de pagos = pagos identificables / pagos válidos MP.
2. Identificación por importe = importe identificable / importe válido MP.
3. Vínculo de pedidos = pedidos con vínculo confiable / pedidos válidos Toteat.
4. Clasificación de pedidos = pedidos atribuibles a un único instrumento utilizable / pedidos válidos Toteat.
5. Cobertura de venta analizable = venta neta de pedidos clasificables / venta neta de pedidos válidos Toteat.

No llamar a ninguno «% de clientes identificados». No equiparar una tasa de vínculo con precisión verificada de la coincidencia.

### 8.9 Estilo y accesibilidad

- Mantener componentes y tipografía de Brewit existentes; usar verde corporativo para regreso y tono neutro para primera fecha.
- Texto principal legible, sin tablas comprimidas de diez columnas en la portada.
- Una decimal para porcentajes; dos solo si el detalle lo justifica.
- CLP con separadores de miles; mostrar valores completos en tooltip o detalle.
- No abreviar conceptos como «>1/15 DÍAS».
- Color acompañado de texto, contraste suficiente, navegación por teclado.
- Diseño adaptable: tarjetas en dos columnas o una según ancho; gráficos apilados verticalmente.
- Datos de ejemplo solo en tests/storybook; nunca en producción ni como sustituto de un error.
- Tabla técnica desplegable/exportable; no duplicar los gráficos enteros en tablas abiertas.
- Avisos deduplicados: uno por problema con opción «Ver detalle».

## 9. Comparaciones temporales y estados vacíos

### 9.1 Comparaciones

- Últimos 28 días completos: comparar con los 28 anteriores.
- Hoy: mismo día de la semana anterior hasta la misma hora local, siempre que ambos tramos estén completos en la fuente.
- Semana actual: lunes hasta el corte frente al mismo tramo de la anterior.
- Mes actual: mismos días ordinales y misma hora del mes anterior. Si no existe el día equivalente, limitar AMBOS a un tramo común y explicitar las fechas.
- Meses cerrados: se pueden comparar completos, advirtiendo diferencias de duración; no rotularlos «mismo tramo».
- Período personalizado: tramo previo de igual duración; mostrar fechas.
- Frecuencia de 28 días: ventana anterior de 28 días, solo si ambas completas.
- Retorno: comparar cohortes maduras con el mismo horizonte; no comparar cohortes con edades dispares.

Cambios de tasas: puntos porcentuales. Cambios de cantidades/importes: porcentaje si la base previa es mayor a cero; si es cero, mostrar diferencia absoluta y «Sin base porcentual».

No mezclar cobertura completa en un período con cobertura parcial en otro. Presentar valores provisionales si corresponde, pero suprimir flechas comparativas.

### 9.2 Estados

| Situación | Conteo/importe | Porcentaje |
|---|---|---|
| Cobertura completa, sin operaciones | 0 | — Sin operaciones |
| Hay operaciones, ninguna de regreso | Numerador 0 | 0,0% |
| No se cargaron datos | — Sin datos | — Sin datos |
| Datos parciales | Valor provisional identificado | Provisional, sin comparación |
| Cohorte inmadura | Pendientes identificados | — Pendiente |
| Sin denominador identificable | Conteos totales si existen | — Sin base identificable |
| Error de consulta | Mensaje y opción reintentar | Nunca 0% |
| Local aún no abierto, fecha confirmada | No operaba | No aplica |

## 10. Emparejamiento Toteat–MP

Conservar el enfoque conservador. Auditar cómo se garantiza que las coincidencias son únicas.

Orden:
1. Preferir referencia de pedido/pago explícita si realmente existe.
2. Como alternativa, local, moneda, fecha, importe comparable y cercanía horaria.
3. Tolerancia temporal configurable a partir de desfases observados; documentar valor usado.
4. Conciliar propinas, pagos mixtos, pagos divididos y devoluciones antes de comparar importes.
5. Si hay dos candidatos plausibles, no adjudicar por mero orden de consulta.

No reutilizar un pago para atribuir pedidos diferentes, salvo relación explícita comprobable; tampoco multiplicar pedidos al unir sus líneas de productos.

Pedido con varios pagos:
- Un único instrumento identificable y relación explícita: puede atribuirse a ese instrumento; contar el pedido una sola vez y rotular pagos mixtos.
- Varios instrumentos distintos: mantener en «Múltiples instrumentos / no clasificable» para análisis por instrumento. No duplicar toda su venta entre tarjetas.
- Coincidencia inferida por monto total en un pago dividido: no asumirla correcta.

El porcentaje de importe MP identificable y la venta neta de pedidos vinculados son medidas de fuentes distintas; no forzar su igualdad.

Validar una muestra de vínculos y revisar si los no vinculados se concentran por horario, local, propina o tamaño de ticket.

## 11. Datos y arquitectura de cálculo

Adaptar estos nombres conceptuales al repositorio:

### 11.1 Entidades

- Pago normalizado: cuenta, payment_id, local, fecha/hora, fecha local, estado, importe original, devoluciones, importe elegible, instrument_key, calidad de clave, versión de normalización.
- Día con compra: alcance, instrument_key, fecha local, número de pagos, importe elegible.
- Historial por instrumento: primera fecha, última fecha, número de fechas distintas, y fechas necesarias para ventanas/cohortes.
- Pedido normalizado: order_id, local, fecha/hora, venta neta, venta bruta sin propina, impuestos, propina separada, estado, líneas.
- Vínculo: pedido, pagos relacionados, método, estado, motivo y versión.
- Cobertura: fuente, local/cuenta, intervalo esperado, intervalo confirmado, huecos, última sincronización.
- Snapshot del reporte: filtros, corte, versión de datos y definición, resultado agregado.

### 11.2 Funciones compartidas

Implementar responsabilidades separadas:
- Normalizar y validar pagos.
- Obtener clave de instrumento.
- Agrupar por fecha local y alcance.
- Resolver primera fecha usando historial previo al período.
- Clasificar días y pagos de regreso.
- Agregar métricas y denominadores.
- Determinar elegibilidad por horizonte y cobertura.
- Construir cohortes.
- Vincular y clasificar pedidos.
- Resolver estados de ausencia/parcialidad.

Una sola implementación de cada definición, no fórmulas independientes por componente.

### 11.3 Contrato de resultado

Cada métrica debe poder transportar:
- value: número o null.
- numerator y denominator cuando corresponda.
- unit: count, percent, clp, days.
- period_start, period_end, as_of.
- population y source.
- status: complete, partial, no_data, no_activity, immature, error.
- comparison: valor anterior, delta y unidad o motivo de indisponibilidad.
- coverage y definition_version.

Preservar motivos específicos: un estado genérico null no basta para distinguir «sin datos» de «sin seguimiento».

Los estados numéricos no deben inferirse en el frontend usando expresiones que convierten null en cero.

### 11.4 Rendimiento y actualización

- Reutilizar almacenamiento sincronizado; no consultar toda la API al abrir la vista.
- Cachear por alcance, filtros, corte, versión de datos y metodología.
- Invalidar cuando cambian pagos, devoluciones, claves, vínculos o cobertura relevante.
- Una compra histórica cargada tarde puede adelantar la primera observación: recalcular los instrumentos y cohortes afectados, no solo sumar al día actual.
- Cargar Resumen primero; Compras y detalle técnico bajo demanda.
- Evitar consultas N+1 por instrumento.
- Indexar según motor existente, especialmente alcance/local, clave, fecha y payment_id.
- Filtrar temprano la actividad del período, pero no truncar el historial necesario para primera observación.
- Evitar condiciones de carrera al cambiar filtros: descartar respuestas obsoletas.
- Si se requiere trabajo asíncrono, mostrar progreso y conservar el resultado anterior con su fecha. No congelar la interfaz.
- Medir tiempo actual y posterior con volumen real; documentar el resultado sin prometer umbrales no medidos.

### 11.5 Historial y consolidación

- «Últimos seis meses» debe ser ventana de visualización, no eliminación del historial de identidad.
- Si el sistema conserva únicamente seis meses, informar «primera observación dentro del historial disponible» y no fingir antigüedad completa.
- Al consolidar locales con fechas de inicio distintas, mostrar cobertura por local.
- Para comparaciones de cadena, usar una base comparable de locales y períodos cubiertos, o marcar la comparación no disponible. No excluir locales silenciosamente.
- Abrir una nueva sucursal puede cambiar la mezcla de recurrencia: no atribuirlo automáticamente a pérdida de fidelización.
- No promediar tasas entre locales.

## 12. Casos de aceptación

### 12.1 Fixture numérico principal

Datos ficticios, CLP simplificados. Cobertura completa desde el 1 de septiembre. Todos los pagos son válidos. Misma cafetería.

| Instrumento | Fecha | Importe |
|---|---|---:|
| C | 20 septiembre | 10 |
| A | 1 octubre | 10 |
| A | 1 octubre | 5 |
| B | 2 octubre | 30 |
| C | 2 octubre | 40 |
| A | 3 octubre | 20 |
| No identificable | 3 octubre | 25 |

Para P = 1–7 octubre, T = cierre del 7:
- Pagos en P: 6; identificables: 5.
- Instrumentos activos identificados: 3 (A, B, C).
- Activos con regreso: 2 (A y C), 66,7%.
- Primera observación en P: 2 (A y B); conocidos antes: 1 (C).
- Días con compra identificados: 4.
- Días de primera fecha: 2 (A día 1; B día 2).
- Días de regreso: 2 (C día 2; A día 3), 50,0%.
- Importe identificado: 105.
- Importe de primera fecha: 45.
- Importe de regreso: 60; 60/105 = 57,1%.
- Importe total MP: 130; no identificable: 25.
- Cobertura de identificación por pagos: 5/6 = 83,3%.
- Cobertura por importe: 105/130 = 80,8%.
- Participación del importe de regreso sobre todo MP, solo en detalle: 60/130 = 46,2%.
- Los dos pagos de A del día 1 no prueban regreso.

Para una consulta separada de cohortes con seguimiento completo hasta el 10 de noviembre, sin compras adicionales:
- Cohorte de A y B: ambos elegibles a 30 días; A regresó y B no: 50%.
- C vuelve 12 días después de su primera observación: elegible y retornado a 14/30 días, no a 7.
- Una consulta con corte 7 de octubre no puede usar seguimiento de noviembre.

### 12.2 Casos adicionales obligatorios

1. **Mismo día:** dos pagos y ninguna otra fecha producen un instrumento, un día con compra, cero días de regreso y ninguna mediana de intervalos.
2. **Límite de día local:** dos pagos con diferentes fechas UTC pero misma fecha de Santiago cuentan como un día; probar también el caso inverso y cambio de horario.
3. **Historial anterior:** primera compra anterior a P y compra única dentro de P cuentan como regreso.
4. **Sin futuro:** una vuelta del mes siguiente no altera clasificación al cierre anterior.
5. **Cohorte inmadura:** f+30>D queda fuera de numerador y denominador aunque ya haya regresado.
6. **Límite 30:** regreso exactamente en f+30 cuenta; en f+31 no cuenta para R30.
7. **Hueco de datos:** no considerar seguimiento completo si faltan días; informar exclusiones.
8. **Cobertura frente a cero:** un día cargado sin ventas es distinto de un día no cargado.
9. **Sin denominador:** porcentaje null, no NaN/Infinity/0 por defecto.
10. **Multi-local:** primera compra en A, siguiente fecha en B: B puede ser primera observación local y regreso de cadena.
11. **Cadena mismo día:** dos locales en una fecha suman importes pero cuentan un día de cadena.
12. **Nulos:** dos pagos sin identificador no forman un instrumento recurrente.
13. **Importación repetida:** el mismo payment_id no aumenta métricas.
14. **Compras idénticas reales:** dos payment_id distintos con mismo importe/hora no desaparecen por deduplicación heurística.
15. **Reembolso completo/parcial:** no generan días adicionales y aplican la política monetaria documentada.
16. **Vínculo ambiguo:** no entra en compras clasificadas ni duplica importes.
17. **Pagos mixtos/múltiples instrumentos:** respetar la política de atribución sin multiplicar pedidos.
18. **Frecuencia:** cada instrumento activo de W pertenece a un solo intervalo; suma de categorías igual a activos de W.
19. **Recencia:** límites 7/8, 14/15, 30/31 y 60/61 sin solapamiento.
20. **Cambio de filtros:** respuesta lenta del filtro anterior no reemplaza el resultado actual.
21. **Carga histórica tardía:** actualiza primera fecha, cohorte y caché afectados.
22. **Mes desigual:** comparación usa mismo tramo común; no compara 31 días contra 28 bajo etiqueta de igualdad.
23. **Base común cohortes:** R7 <= R14 <= R30 con mismos instrumentos elegibles.
24. **Pagos de primera fecha:** nunca pasan a importe de regreso por una compra posterior.
25. **Fuente MP sin vínculo:** un instrumento válido sigue entrando al Resumen aunque no enlace a Toteat.
26. **Estados históricos revisados:** un reembolso tardío identifica revisión del resultado; no simula snapshot antiguo.
27. **Claves aproximadas:** la interfaz no etiqueta el resultado como personas únicas ni afirma precisión no comprobada.

## 13. Plan de implementación

### Etapa 1 — Correcciones prioritarias

- Auditar numeradores, denominadores, estados de pagos y cobertura.
- Corregir null/0 y comparaciones sin base.
- Cambiar el criterio principal a fechas distintas.
- Separar instrumentos, días con compra, pagos y dinero.
- Unificar historia MP para clasificar pedidos.
- Verificar el control 586/497/15,0% y documentar resolución.
- Conservar el reporte previo para conciliación interna durante la transición.

### Etapa 2 — Nueva vista

- Cuatro tarjetas y gráfico semanal.
- Frecuencia de 28 días y recencia.
- Retorno 7/14/30 con elegibilidad.
- Pestañas Compras y Calidad.
- Detalle de métricas y exportación con metadatos.

### Etapa 3 — Validación y adopción

- Ejecutar fixtures y casos límite.
- Conciliar una muestra con pagos y pedidos originales.
- Comparar cada local y el consolidado.
- Revisar cobertura y rendimiento con datos reales.
- Explicar cambios de cifras por metodología; no intentar conservar números antiguos a costa de la definición.
- Retirar de portada el reporte anterior después de validar la nueva vista.

Opcionales posteriores: retención semanal, comparación entre locales a igual antigüedad, patrones por día de semana, identificación de habituales que reducen frecuencia y evaluación de promociones con diseño específico. No bloquear la primera versión por estos extras.

## 14. Entrega esperada de Codex

- Explicación breve del antes/después.
- Tabla con métricas antiguas y nuevas, y motivo de cada diferencia.
- Resultados de pruebas y conciliación.
- Capturas de escritorio y vista estrecha, sin datos de pago sensibles.
- Confirmación de que los totales de cadena se deduplican, no se suman ingenuamente.
- Lista concreta de limitaciones que permanecen: identidad aproximada, cobertura, enlaces y base de seguimiento.
- Mapeo documentado de campos reales y fórmulas.
- Ninguna afirmación de «auditoría aprobada» si quedaron validaciones de datos pendientes.

## 15. Fuentes y alcance de evidencia

La evaluación inicial se basó en la captura suministrada por Alfredo y la conversación del 25 de octubre de 2026. La implementación posterior inspeccionó el repositorio, leyó los archivos locales e hizo consultas locales de conciliación; sus resultados y límites se documentan en [RECURRENCIA_VALIDACION.md](RECURRENCIA_VALIDACION.md). No se hicieron consultas a proveedores desde el flujo nuevo.

Referencias conceptuales consultadas:
- Google Analytics, exploración de cohortes: https://support.google.com/analytics/answer/9670133?hl=en
  Apoya la separación entre criterio de entrada, criterio de retorno y ventana temporal. Esta especificación adapta esos conceptos a compras de cafetería; no propone instalar Google Analytics para resolver el reporte.
- Mercado Pago, referencia de tarjetas guardadas: https://www.mercadopago.cl/developers/en/reference/online-payments/checkout-api/cards/get-customer-cards/get
  Referencia de esquema; no certifica que los campos de tarjetas guardadas estén presentes ni sean estables en la integración presencial de Brewit. Codex debe comprobar la fuente real.

Los horizontes de 7/14/30 días, ventanas de 28/90 días y diseño propuesto son decisiones de esta recomendación, no benchmarks de la industria ni promesas sobre el desempeño de Brewit.


## 16. Precisiones confirmadas e implementación

Estas decisiones complementan las secciones anteriores:

1. **Control manual.** Se mantiene **Generar reportes**. El valor inicial es últimos 28 días completos; también Hoy, Semana actual, Mes actual y Personalizado. Cambiar filtros conserva el resultado previo, identificado con sus fechas, hasta generar de nuevo.
2. **Retorno independiente.** Las entradas iniciales abarcan seis meses calendario, incluido el mes de D, desde el primero del mes D−5 hasta D. Sus fechas no sustituyen P; se pueden modificar explícitamente. El seguimiento permanece limitado al D del snapshot, nunca al futuro. La tarjeta R30 mantiene su ventana propia D−119…D−30.
3. **Cortes por fuente y bloque.** Resumen y Retorno dependen de MercadoPago. Compras añade ventas y detalle de pagos Toteat. Un atraso de Toteat no recorta MP. Los tramos acreditados proceden de descargas publicadas completas o snapshots API explícitos, limitados por la hora de recepción. Los extremos de transacciones/importaciones no prueban continuidad. Los días vacíos acreditados cuentan como cubiertos.
4. **Campos ausentes.** SETTLEMENT sin estado explícito se considera operación observada provisional, no aprobación acreditada. Sin referencia original de devolución no se imputa el ajuste a un pago. Sin impuestos y totales originales, venta neta es no disponible. No se infieren propinas ni se divide el importe MP por 1,19.
5. **Unidades.** Se cuentan productos vendidos raíz; extras, modificadores y componentes no duplican unidades. Si un código aparece como raíz y componente en el mismo pedido, solo se conserva la cantidad raíz. Los importes del pedido permanecen conciliados, sin restar silenciosamente el dinero de sus componentes.
6. **Identidad y consolidación.** Clave aproximada versionada y alias HMAC opacos. Cadena recalcula sobre la unión, sin sumar instrumentos ni promediar tasas. La ausencia de cuenta del proveedor impide acreditar identidad global entre cuentas; se informa. Deduplicación por cuenta/pago/tipo cuando existe cuenta y por local/pago/tipo en caso contrario; nunca por hora e importe.
7. **API y coherencia.** `/api/sales/recurrence` genera un identificador. Las secciones `summary`, `return`, `purchases`, `quality`, `details` y `export` se consultan bajo ese identificador. Cambios en fuentes necesarias antes o durante una preparación provocan 409 y exigen regenerar. Resultados ya preparados y exportaciones usan el snapshot retenido, sin mezclar nuevas lecturas.
8. **Procesamiento.** Worker local persistente, memoria limitada, cola acotada y caché por filtros/versiones/corte/metodología. Cancelar en la interfaz aborta la espera HTTP y descarta respuestas obsoletas; un trabajo ya iniciado puede terminar en el worker. Los snapshots son de sesión en memoria (máximo ocho, una hora); no son un archivo histórico persistente ni reconstruyen lo conocido antes de una devolución tardía.
9. **Transición.** Los endpoints anteriores se mantienen compatibles para conciliación y otros reportes. La interfaz nueva usa exclusivamente la metodología de fechas distintas, sin presentar métricas anteriores y nuevas como equivalentes.

Evidencia reproducible, rendimiento, muestras, capturas y pruebas: [RECURRENCIA_VALIDACION.md](RECURRENCIA_VALIDACION.md). Conciliación agregada: [RECURRENCIA_CONCILIACION.json](RECURRENCIA_CONCILIACION.json).

## 17. Ampliación: evolución mensual y cruces entre cafeterías

Se agregan una quinta pestaña **Evolución 12 meses** y una sexta **Cruces entre cafeterías**. Base confirmada: **importe MP total de cada mes**, incluidos los pagos no identificables. No equivale al porcentaje de toda la venta Brewit, que incluye otros medios de pago.

### Fórmula y calendario

Para cada pago válido identificado p en fecha local d e importe A, buscar al menos una compra del mismo instrumento en una fecha desde d−h hasta d−1 inclusive, para h = 30, 60, 90 y 180 días. Si existe, A entra una sola vez al numerador de esa ventana. Denominador: todo el importe MP observado en el mes y alcance de destino. Se suman los importes y se divide nuevamente; no se promedian porcentajes por instrumento o cafetería.

- La búsqueda se realiza antes de cada pago, no desde el inicio del mes ni según la condición del instrumento al cerrar el mes.
- Varias operaciones de la primera fecha no acreditan una visita previa. Una compra futura nunca recalifica la primera fecha.
- Se incluyen los límites exactos de 30/60/90/180 días. Las ventanas se superponen: 30 ⊆ 60 ⊆ 90 ⊆ 180; no se suman.
- Se muestran 12 meses calendario hasta el corte del snapshot, incluido el mes del corte, que se marca parcial si todavía no termina. El inicio del filtro principal no recorta esa ventana; su corte sí limita el seguimiento histórico.
- La cobertura debe abarcar el mes y los días previos necesarios para cada ventana. Huecos y estados no acreditados generan resultados provisionales; un mes sin base conserva porcentaje null.

### Quinta pestaña: historial en el alcance seleccionado

Si se selecciona una cafetería, los antecedentes se buscan en esa cafetería. Con Todas, se buscan en la unión de la red. El importe actual se cuenta una vez; el mismo día en varios locales no prueba regreso en otra fecha. Se presenta gráfico porcentual de cuatro series, selector de ventanas sin nuevas consultas y tabla con numeradores, denominadores y estados.

### Sexta pestaña: antecedentes en otras cafeterías

El destino es donde se cobra el importe analizado. Se buscan compras previas en locales diferentes del destino, aunque el instrumento también tenga antecedentes en el propio destino. Se presenta evolución de 12 meses, detalle por destino al elegir Todas y desglose origen→destino, acumulado o por mes. Por ejemplo: cobrado en Lyon con compra previa en La Concepción es una dirección distinta de lo cobrado en La Concepción con compra previa en Lyon.

Si un instrumento compró en varios orígenes, el pago del destino entra una sola vez en el total de cruces. Puede aparecer en varias filas del desglose de orígenes; esas filas no son segmentos excluyentes ni se suman. Un pago no identificable permanece en el denominador y no se atribuye a un origen inventado. La coincidencia de claves entre cuentas es aproximada y se indica explícitamente.

### Generación, API y exportación

Se mantienen los patrones manuales. Primero **Generar reportes**; luego **Generar evolución mensual** o **Generar cruces de la red**. Abrir pestañas y cambiar selectores del gráfico/desglose solo presenta datos disponibles.

- `GET /api/sales/recurrence/:id/monthly`: calcula y retiene la evolución sobre el historial MP del snapshot.
- `GET /api/sales/recurrence/:id/network`: lee explícitamente las fuentes MP locales de la red y valida la versión capturada al generar el reporte, antes y después de calcular. No sincroniza proveedores. Si cambió otro local, devuelve 409 y solicita regenerar.
- La exportación incluye únicamente secciones preparadas. Añade evolución mensual, cruces totales, destinos, orígenes, acumulados, cobertura y notas. Las series conservan cortes y versiones propios explícitos.

Motor: `recurrence-history.js`, metodología `mp-rolling-purchase-history-v1`, identificación compartida con `recurrence.js`. Pruebas: `test/recurrence-history.test.js`, API con worker real, y pruebas de interfaz/exportación en `test/recurrence-ui.test.js`. Se verifican límites, mismo día, ausencia de futuro, denominador con no identificables, dirección de cruces, superposición de orígenes, cadena, cobertura, devoluciones y coherencia de versiones.
