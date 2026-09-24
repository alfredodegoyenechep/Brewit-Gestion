# Operación propia de Brewit — implementación y estado

## Alcance de esta entrega

El plan completo **no está terminado ni habilitado como fuente de producción**. Se implementó una plataforma operativa de preparación, integrada en el menú mediante **Operación Brewit · Preparación** (`/operaciones`).

### Dónde consultar el avance

Abrir `http://localhost:3000/operaciones` o el enlace **Operación Brewit · Preparación** del menú principal. El cuadro **Avance de implementación** es visible sin iniciar sesión y separa seis bloques de desarrollo, sus pendientes y los siguientes pasos. La conexión PostgreSQL se consulta al abrir la página; el resto del cuadro es un resumen del desarrollo entregado, no un porcentaje automático.

Se corrigió el `Cannot GET /operaciones` reiniciando el proceso local que aún utilizaba el servidor anterior, después de comprobar que no había sincronizaciones activas. Se verificó HTTP 200 y la pantalla en Chrome. El entorno local informa **PostgreSQL conectado**. La base `brewit_operations` está disponible únicamente en `127.0.0.1:55433`, con volumen persistente y secretos locales privados. El servidor fue reiniciado y la conexión verificada también en Chrome.

La base nueva usa PostgreSQL y está separada de los archivos y cálculos actualmente utilizados. La tabla de configuración solo admite `mode = preparation`; no existe una acción HTTP que pueda activar prematuramente el cambio de fuentes. Las sincronizaciones actuales de Toteat no escriben en los nuevos maestros ni en su Kardex.

### Implementado

- Esquema transaccional repetible; cantidades y valores `numeric(28,8)` y cálculos con Decimal. Publicaciones seriadas mediante bloqueo transaccional para evitar carreras entre documentos y conteos.
- Usuarios con contraseña scrypt, autenticación TOTP, secreto TOTP cifrado con AES-256-GCM, sesiones HTTP-only revocables y limitación persistente de intentos. El segundo factor es obligatorio para todos los usuarios de este módulo.
- Roles y ubicaciones. El autor de un documento no puede publicarlo. Solo Dirección/Administración publican órdenes de compra, facturas y pagos.
- Catálogo editable, versiones con vigencia, unidad base, conversiones, barra, políticas de consumo, recetas y equivalencias de códigos Toteat por local. Las equivalencias ya utilizadas no se reasignan a otro artículo.
- Proveedores y bodegas propios. La preparación inicial contempla `store-1`, `store-2` y `main-warehouse`.
- Documentos de apertura, recepción, orden de compra, consumo, marketing, colaboradores, merma, conteo, producción, despacho, recepción de transferencia, devolución física, factura y pago.
- Publicación atómica, idempotencia, movimientos inmutables, trazabilidad al documento y versión del artículo. Se impide actualizar/eliminar movimientos, versiones y auditoría también desde SQL.
- Reversos auditables para operaciones sin movimientos dependientes posteriores. Las operaciones financieras y transferencias vinculadas no admiten todavía reverso aislado.
- Costo promedio por artículo/bodega y último costo de compra separado. Las recepciones convierten costo y cantidad desde la presentación comprada.
- Transferencias con bodega de tránsito propia por despacho, recepción parcial y conservación de valor.
- Producción con insumos reales y distribución explícita del costo entre resultados en la API; el formulario inicial captura un resultado por documento.
- Recetas y subrecetas con detección de ciclos; preparados almacenados no vuelven a explotar ingredientes al venderse. El motor admite sustituciones explícitas; falta su configuración comercial y vinculación automática con extras Toteat.
- Lotes, fechas de vencimiento y asignación automática FEFO identificada. Se bloquean salidas de lotes vencidos. Una venta sin lote disponible conserva la cantidad y crea incidencias de faltante/asignación, sin inventar un lote físico.
- Facturas, pagos parciales y prevención de duplicados/sobrepagos. Ninguno modifica inventario. Esta primera factura captura un total; todavía no concilia sus líneas con recepciones.
- Interfaz de catálogo, recetas, bodegas, proveedores, documentos, existencias, lotes, Kardex, cuentas por pagar e incidencias. Paginación de 50 filas sin truncar la consulta; exportación CSV e impresión/PDF de todos los resultados filtrados.
- Revisión estructural de la última captura sincronizada de maestros, sin publicarla automáticamente. La captura revisada contiene 421 artículos, 42 proveedores y cuatro bodegas; se detectó una conversión inválida de KG en SUB014. Esto no certifica las reglas de negocio de todos los artículos.

## Configuración realizada y siguiente paso

- Usuarios creados: **ADG** (`alfredodegoyenechep@gmail.com`), Dirección; **alfredo** (`adegoyeneche@codecorp.cl`), Administración. Ambos tienen alcance sobre las tres ubicaciones y están inactivos hasta completar su activación personal.
- Las invitaciones se guardaron como archivos HTML privados en `uploads/.integrations/brewit/activation/`. Abrir el archivo correspondiente en el navegador y seguir su enlace local. Cada persona elige su contraseña y registra su autenticador; luego inicia sesión con el siguiente código. Los enlaces son de un solo uso y vencen 48 horas después de su creación. No se enviaron correos ni se establecieron contraseñas compartidas.
- Importados a revisión **803 registros** de la captura API normalizada: 421 artículos, 286 recetas, 42 proveedores, 4 bodegas y 50 registros de jerarquías. Se preservaron los originales. Reimportar la misma captura no duplica registros.
- Después de ingresar a `/operaciones`, abrir **Maestros importados** para consultar originales, conversiones, ingredientes, rendimientos y observaciones. La acción **Revisar y corregir** permite guardar una revisión pendiente o aprobar y publicar cada maestro en la operación de preparación.
- Revisar **SUB014 — CREMA CHANTILLY SIFON**: su conversión KG → KG tiene numerador cero. No se inventó un factor. Las cuatro bodegas necesitan confirmar su correspondencia con ubicaciones y políticas.
- Se comprobaron referencias, unidades, rendimientos y ciclos de recetas. Esta validación técnica no sustituye la revisión de las recetas reales por el responsable.
- El siguiente paso es revisar y publicar los maestros desde la bandeja, antes de cargar aperturas físicas o conectar consumo automático de ventas.

Los archivos privados tienen permisos restringidos y están excluidos de Git. No se sirven por HTTP. La base persiste en Docker, pero el respaldo automático externo sigue pendiente. No se publicaron movimientos del negocio ni se cambiaron las fuentes activas de los reportes.

## Preparar el entorno local

Requisitos: Node compatible con las dependencias del proyecto, Docker para PostgreSQL o un servidor PostgreSQL 18, y una aplicación autenticadora TOTP.

1. Copiar `.env.example` a `.env` y completar la contraseña PostgreSQL y una clave aleatoria de 32 bytes para `BREWIT_AUTH_KEY`. `.env` está excluido de Git. No reutilizar secretos de Toteat.
2. Iniciar únicamente la base de preparación:

   ```sh
   docker compose --env-file .env -f compose.operations.yml up -d
   ```

3. Aplicar el esquema:

   ```sh
   node --env-file=.env scripts/operations-db.js
   ```

4. Para instalaciones nuevas, crear los usuarios mediante el comando interactivo, una vez por persona:

   ```sh
   node --env-file=.env scripts/operations-user.js
   ```

   La contraseña no se muestra. El secreto del autenticador se presenta una vez en la terminal para registrarlo. Crear personas distintas para capturar y aprobar; no compartir sus claves. El alta no está expuesta por HTTP.

También se pueden preparar activaciones privadas sin elegir la contraseña del usuario:

   ```sh
   node --env-file=.env scripts/operations-invite.js EMAIL NOMBRE ROL
   node --env-file=.env scripts/operations-import-masters.js
   ```

   El primer comando devuelve la ruta del archivo privado, no el secreto. No repetir el alta de los dos usuarios ya creados.

5. Iniciar Brewit (el inicio directo carga automáticamente `.env`):

   ```sh
   node server.js
   ```

6. Abrir `/operaciones`, ingresar con contraseña y TOTP, crear bodegas y artículos y comenzar con documentos **de ensayo**.

`BREWIT_REQUIRE_AUTH=1` protege además las rutas históricas `/api`, `/uploads` y `/upload`. Esas vistas completas quedan restringidas a Dirección porque aún no implementan permisos por ubicación. Un adaptador de sesión incorpora CSRF a sus solicitudes fetch del mismo origen. No habilitar acceso público como si la migración de permisos estuviese completa. La configuración local actual usa `BREWIT_REQUIRE_AUTH=0` y conserva el acceso anterior a los reportes; la API operativa exige autenticación igualmente.

La conexión PostgreSQL y la clave TOTP son necesarias para habilitar el módulo. Si faltan, `/operaciones` informa la configuración pendiente; no cae a archivos JSON como reemplazo de la base de datos.

## Flujo de documentos

1. Crear un borrador con ubicación, fecha/hora, bodega y líneas.
2. Presentar el documento.
3. Una persona distinta con el rol apropiado lo revisa y publica.
4. Consultar su efecto en Kardex, existencias, lotes o cuentas por pagar.

La fecha efectiva debe incluir zona horaria. Los documentos anteriores al último movimiento del mismo artículo/bodega se rechazan: falta implementar el recálculo controlado de operaciones retroactivas. El rechazo es deliberado y no modifica saldos parcialmente.

Las existencias negativas originadas en ventas tienen incidencias y costo pendiente. La interfaz no presenta su valorización como definitiva. Falta desarrollar la conciliación posterior y el recálculo de estas valorizaciones.

## API de preparación

Prefijo `/api/v1/operations`. Las escrituras autenticadas requieren `X-CSRF-Token`, obtenido con `/session` o `/login`. Las cookies tienen `HttpOnly` y `SameSite=Strict`.

| Método/ruta | Función |
|---|---|
| GET `/status` | Estado de configuración, siempre en preparación |
| POST `/login`, POST `/logout`, GET `/session` | Acceso y sesión |
| POST `/enrollment/start`, POST `/enrollment/finish` | Activación mediante invitación privada, contraseña y TOTP |
| POST `/imports/:id/review` | Guardar revisión o aprobar/publicar con versión esperada y motivo; Dirección/Administración |
| GET `/imports` | Registros importados pendientes de revisión; Dirección/Administración |
| GET `/baseline` | Revisión de la captura de maestros; Dirección/Administración |
| GET `/data/:resource?location=…` | Consulta de items, suppliers, warehouses, documents, balances, lots, movements, payables o issues |
| POST `/items` | Publicar versión de artículo con `item` y `version` esperada |
| POST `/warehouses`, POST `/suppliers` | Crear bodega/proveedor |
| POST `/documents` | Crear borrador; requiere `Idempotency-Key` |
| POST `/documents/:id/submit` | Presentar |
| POST `/documents/:id/post` | Aprobar/publicar por otra persona |
| POST `/documents/:id/reverse` | Revertir con motivo y comprobación de dependencias |

Las consultas devuelven decimales como cadenas. El navegador formatea cifras para lectura; los cálculos y las restricciones monetarias se ejecutan en el servidor con decimales exactos.

## Pendientes para completar el plan aprobado

| Bloque | Trabajo pendiente antes del corte |
|---|---|
| Maestros | Completar la revisión humana de la captura mediante la publicación implementada, edición completa de jerarquías/precios/formatos, reglas por bodega y publicación/verificación de carta |
| Ventas | Ingesta automática al libro propio; conservación privada de clientes; división de pagos, versiones tardías, extras, sustituciones y envases certificados. El tipo `sale` del motor es de ensayo; no está enlazado al sincronizador real |
| Documentos | Edición/versionado de borradores, rechazos, cancelación, adjuntos privados y vinculación completa entre documentos |
| Compras | Solicitudes, aprobación de compras abiertas, conciliación OC/recepción/factura por línea, costos provisionales y ajustes posteriores, notas de crédito, anticipos, importadores y devoluciones vinculadas |
| Inventario | Conteo ciego/reconteo, reservas/disponible, correcciones retroactivas, cierres, resolución de incidencias y valorizaciones pendientes |
| Lotes | Retención/liberación, eliminación física posterior a merma, alertas y trazabilidad gráfica completa proveedor/producción/destino |
| Producción | Planificación, avances parciales, sustituciones autorizadas y validación de rendimiento contra receta. El motor actual valoriza consumos reales; no certifica por sí mismo su conformidad con la receta |
| Finanzas | Migración de resultados al costo promedio, presupuestos, conciliación de pagos, exportación contable y cierre mensual |
| Reportes | Adaptar todos los módulos actuales a servicios de datos nativos; no existe todavía un modo nativo para sus reportes |
| Seguridad | Administración de usuarios/recuperación/rotación en interfaz, permisos de todas las rutas históricas, despliegue HTTPS y gestión de secretos |
| Continuidad | Respaldos cifrados automáticos externos, PITR, monitorización y ensayo que certifique RPO 15 min/RTO 4 h. Un volumen Docker no equivale a un respaldo |
| Migración | Apertura física aprobada, saldos y pendientes, dos semanas de ensayo, cierre mensual, corte simultáneo y estabilización |

Hasta completar estos puntos, no deshabilitar inventario/recetas en Toteat ni interpretar el nuevo Kardex como inventario real del negocio.

## Verificación

`npm test` ejecuta regresiones y pruebas puras. Las pruebas PostgreSQL requieren `BREWIT_TEST_DATABASE_URL` apuntando exclusivamente a una base cuyo nombre termine en `_test`; limpian las tablas operativas de esa base. Nunca utilizar la conexión de operación real.

```sh
BREWIT_TEST_DATABASE_URL=postgresql://USUARIO:CLAVE@127.0.0.1:PUERTO/brewit_test npm run test:operations
```

La suite operativa verifica conversión caja/unidad, promedio versus última compra, atomicidad ante fallo, publicación concurrente idempotente, transferencias parciales, facturas/pagos, permisos, producción/consumo, vencimientos, TOTP y revocación, reversos, inmutabilidad SQL, faltantes por lote, conteos retroactivos y formulario real en Chrome. Los datos utilizados son sintéticos.

### Resultado comprobado de esta entrega

- Suite completa con PostgreSQL y Chrome: **181 pruebas aprobadas, cero fallos y cero omitidas**.
- Suite operativa: **19 pruebas aprobadas**, incluyendo invitación de un solo uso, activación en Chrome e importación idempotente sin publicación automática.
- Ensayo manual `pg_dump`/`pg_restore` en bases sintéticas aisladas: contenido idéntico por checksum en artículos, versiones, bodegas, documentos, movimientos, saldos, lotes, auditoría y usuarios. Se verificó que el Kardex restaurado continúa rechazando eliminaciones.
- La restauración anterior prueba recuperabilidad básica, no respaldos automáticos, cifrado externo, PITR ni los objetivos de recuperación de producción.
- Se configuró PostgreSQL, se crearon las invitaciones privadas bajo `uploads` y se reinició el servidor local. La política de fuentes activa y las credenciales Toteat se conservaron. No se publicaron movimientos del negocio. `/operaciones` responde HTTP 200; la consulta de importaciones sin sesión responde 401 y los archivos privados responden 404 por HTTP.

## Revisión y publicación de maestros importados

1. Ingresar como Dirección o Administración y abrir **Maestros importados**.
2. Buscar por código/nombre/tipo, pulsar **Ver detalle** y comparar el original y sus observaciones.
3. Pulsar **Revisar y corregir**. En artículos, confirmar unidad, política, barra, conversiones, lotes y equivalencias Toteat; en bodegas, seleccionar explícitamente ubicación y tipo.
4. Elegir **Guardar revisión pendiente** para continuar después. Indicar el motivo de las correcciones o el resultado de la revisión.
5. Elegir **Aprobar y publicar en Brewit** cuando esté completo. Se publica el maestro y la aprobación en una única transacción. La receta se publica junto con el artículo; primero deben existir versiones válidas de sus ingredientes.

La receta propuesta conserva cantidades originales para revisión: el responsable debe definir su producción neta en unidad base y cantidades brutas de insumos, considerando rendimientos y porciones. No se infiere silenciosamente esa equivalencia. Las conversiones redundantes válidas de unidad base a sí misma se omiten en la propuesta; las inválidas se mantienen visibles para corregirlas o quitarlas expresamente.

Se conservan los originales y una auditoría del responsable, motivo, propuesta anterior y nueva. Las revisiones simultáneas generan un conflicto y requieren recargar. Repetir una publicación no duplica el maestro; una nueva captura tampoco sobrescribe códigos ya publicados. Los originales y las revisiones aceptadas están protegidos contra modificaciones SQL. Los artículos publicados se modifican mediante una nueva versión en Catálogo.

Los proveedores y bodegas publicados aparecen en sus vistas operativas. Las jerarquías quedan almacenadas con su aprobación y pueden consultarse en la bandeja; queda pendiente el editor integral de jerarquías y su asociación comercial. No existe aprobación masiva automática ni cambio de fuentes de los reportes. La publicación de un maestro no genera movimientos ni saldos físicos.
