# Auditoría de bodegas de recepción — 28-09-2026

## Conclusión
Brewit está reproduciendo las bodegas informadas por las fuentes sincronizadas. Hay discrepancias entre la API de compras, la API pública de inventario y la recepción visible en la captura aportada por el usuario. No se encontró una inversión global entre los códigos 1 y 2 en el mapeo revisado.

## Caso factura 22978, ADELE ORIGINAL, movimiento 322985
Fecha de recepción: 04-09-2026.

| Producto | Cantidad | API compras | API inventario original | Captura de recepción Toteat |
|---|---:|---|---|---|
| CCB001 Boba Perlas Frutilla | 3,40 KG | 2: Bodega Local | 2: Bodega Local | 1: Bodega Central |
| CCB006 Boba Perlas Passion Fruit | 3,40 KG | 1: Bodega Central | 2: Bodega Local | 1: Bodega Central |

La respuesta original de inventario contiene purchase=3.4 y warehouse_id=2 para ambos productos el 04-09-2026. El reporte de compras asigna por el campo products[].warehouse, mientras que el Kardex utiliza warehouse_id de inventario. No se deduce la bodega de la posición de la línea. Los maestros identifican custom_id=1 como Bodega Central Local 001 La Concepcion y custom_id=2 como Bodega Local 001 La Concepcion.

## Alcance y otros casos
- Snapshot de compras: 2026-09-28T17:20:53.804Z, versión 820a80c0-0448-4297-95a2-a9c9f6b7cb17.
- Snapshot de inventario: 2026-09-28T17:07:17.918Z, versión dc363bda-ae4d-4f7b-b043-1f68bb5d1a7e.
- Revisión de las 244 compras y 479 líneas conservadas entre 2026-05-18 y 2026-09-28: tres documentos contienen más de una bodega por línea. No implica que todos sean incorrectos.
- Comparación entre fuentes dentro de su cobertura común (2026-08-23 a 2026-09-28): 65 documentos y 120 líneas de compra. Se compararon códigos, fechas de recepción y conjuntos de bodegas. Los envases/unidades de compra no se equipararon a KG/L sin conversión verificable.
- Factura 93771, Comercial DACH SPA (OSK), 26-08-2026: SSR017 y SSR018 están asignados a bodega 2 en Compras, pero sus ingresos aparecen en bodega 1 en Inventario. Son otras dos discrepancias de ubicación confirmadas entre fuentes; no se ha verificado el documento visual de Toteat para decidir cuál es correcta.
- Facturas 326 (07-08-2026) y 0003640641 (20-08-2026): también contienen bodegas distintas por línea en Compras; anteriores a la cobertura actual de Inventario, requieren revisión independiente.
- Portal Lyon: cero compras en la cobertura común; no permite concluir que la integración esté validada para ese local.
- La comparación por bodega no certifica conciliación de todas las cantidades: existen diferencias de unidad entre compras e inventario. No se presentan esas diferencias como errores de bodega.

## Impacto y acciones
Pueden resultar afectados el reparto de compras por local, los subtotales por localidad del reporte maestro, el Kardex por bodega, las diferencias de inventario y la selección de costos/proyecciones que dependa de la ubicación. No se calculó un impacto monetario final: primero debe confirmarse la bodega real y su efecto en saldos/tomas.

No se modificaron movimientos, saldos ni asignaciones de estas compras. Corregir solo la vista de Compras dejaría el Kardex inconsistente. Debe contrastarse en Toteat el documento de recepción y el movimiento contabilizado de ambas facturas; después de corregir o aclarar la fuente, actualizar compras e inventario incluyendo las fechas afectadas. Una nueva sincronización incremental podría no releer esas fechas antiguas.

No se contactó a Toteat ni se modificó su información. La evidencia corresponde a snapshots guardados y a la captura proporcionada, no a una comprobación en vivo de la interfaz de Toteat.

## Documentos con asignación mixta (evidencia resumida)
```json
[
  {
    "document": "326",
    "date": "20260807",
    "lines": [
      {
        "code": "SSR014",
        "warehouse": 2,
        "quantity": 6,
        "unit": "UN"
      },
      {
        "code": "SSR007",
        "warehouse": 2,
        "quantity": 6,
        "unit": "L"
      },
      {
        "code": "SSR022",
        "warehouse": 1,
        "quantity": 1,
        "unit": "UN"
      },
      {
        "code": "SSR009",
        "warehouse": 2,
        "quantity": 6,
        "unit": "UN"
      },
      {
        "code": "SSR008",
        "warehouse": 2,
        "quantity": 12,
        "unit": "UN"
      },
      {
        "code": "SSR012",
        "warehouse": 2,
        "quantity": 6,
        "unit": "UN"
      },
      {
        "code": "SSR011",
        "warehouse": 2,
        "quantity": 6,
        "unit": "UN"
      },
      {
        "code": "SSR010",
        "warehouse": 2,
        "quantity": 12,
        "unit": "UN"
      },
      {
        "code": "SSR005",
        "warehouse": 2,
        "quantity": 24,
        "unit": "L"
      },
      {
        "code": "SSR006",
        "warehouse": 2,
        "quantity": 6,
        "unit": "L"
      },
      {
        "code": "SSR003",
        "warehouse": 2,
        "quantity": 6,
        "unit": "L"
      }
    ]
  },
  {
    "document": "0003640641",
    "date": "20260820",
    "lines": [
      {
        "code": "SAN007",
        "warehouse": 2,
        "quantity": 4,
        "unit": "PK"
      },
      {
        "code": "SAN006",
        "warehouse": 2,
        "quantity": 1,
        "unit": "PK"
      },
      {
        "code": "SAN005",
        "warehouse": 2,
        "quantity": 4,
        "unit": "PK"
      },
      {
        "code": "SAN014",
        "warehouse": 2,
        "quantity": 3.3,
        "unit": "KG"
      },
      {
        "code": "BOL014",
        "warehouse": 1,
        "quantity": 24,
        "unit": "UN"
      },
      {
        "code": "BOL006",
        "warehouse": 2,
        "quantity": 1,
        "unit": "CAJ"
      },
      {
        "code": "SAN008",
        "warehouse": 2,
        "quantity": 3,
        "unit": "PK"
      },
      {
        "code": "SAN002",
        "warehouse": 2,
        "quantity": 1,
        "unit": "CAJ"
      }
    ]
  },
  {
    "document": "22978",
    "date": "20260904",
    "lines": [
      {
        "code": "CCB001",
        "warehouse": 2,
        "quantity": 3.4,
        "unit": "KG"
      },
      {
        "code": "CCB006",
        "warehouse": 1,
        "quantity": 3.4,
        "unit": "KG"
      }
    ]
  }
]
```

## Verificación posterior a la corrección en Toteat — 28-09-2026, 16:18 Chile

La fuente de Compras sincronizada a las 19:01:39 UTC (16:01 Chile), versión `3e77265a-729d-4992-a4f4-297006036e1e`, ya asigna ambas líneas de la factura 22978 a `warehouse=1` (Bodega Principal).

La fuente de Inventario sincronizada posteriormente, a las 19:03:22 UTC (16:03 Chile), versión `92473707-c9f3-43e7-af46-5d53298e7c96`, conserva el ingreso de CCB001 de 3,40 KG en bodega 2. La respuesta original guardada contiene ese mismo ingreso: no lo introduce la normalización de Brewit.

Se realizó además una consulta nueva y de solo lectura a `inventorystate`, exclusivamente para el 04-09-2026, finalizada a las 19:18:33 UTC (16:18 Chile):

| Código | Bodega API | Compra KG | Saldo inicial KG | Saldo final KG |
|---|---:|---:|---:|---:|
| CCB001 | 2, Local | 3,40 | 2,50 | 5,725 |
| CCB006 | 2, Local | 3,40 | 0 | 3,40 |

Conclusión: la corrección está reflejada en Compras, pero la API de Inventario aún mantiene las entradas y saldos en la bodega local. No es solamente una versión anterior del reporte ni la falta de relectura de la fecha afectada. Con estos datos no puede determinarse si Toteat requiere reprocesamiento del Kardex o si existe un desfase/defecto en su API. Deben conciliarse recepción, movimientos y saldos del 04-09-2026 para ambos productos. No se corrigieron cantidades localmente ni se modificaron registros en Toteat.
