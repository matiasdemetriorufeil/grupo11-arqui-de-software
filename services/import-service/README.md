# import-service

Ingesta y normalización de listas de precios de fabricantes con formatos
heterogéneos.

| | |
|---|---|
| **Puerto** | 3001 |
| **Almacén** | MongoDB 7 (`helios_importaciones`) |
| **Patrón interno** | Pipeline por etapas |
| **Expuesto por el gateway** | `/interno/importaciones/**` |

## Responsabilidad

Convertir las planillas que mandan los fabricantes —cada una con sus columnas,
su separador decimal y sus códigos— en filas canónicas listas para el catálogo.

## El problema concreto

Dos fabricantes, dos planillas que dicen lo mismo de forma incompatible:

| Jinko Solar | Trina Solar |
|---|---|
| `Model No.` | `CODIGO` |
| `Pmax (W)` → `550W` | `POTENCIA` → `580 Wp` |
| `FOB Price USD/pc` → `$ 85.00` | `PRECIO UNIT.` → `1.110,20` |
| `Pcs/Pallet` | `BULTO` |
| encabezado en la fila 1 | encabezado en la fila 3 |
| separador decimal `.` | separador decimal `,` |

Y el mes que viene cambian las columnas sin avisar.

## De qué datos es dueño

| Colección | Qué guarda | Validación |
|---|---|---|
| `lote_importacion` | Un archivo recibido, con su estado en el pipeline | `$jsonSchema` estricto |
| `fila_cruda` | La fila **tal como vino**, sin interpretar | **ninguna, a propósito** |
| `fila_normalizada` | El resultado canónico | `$jsonSchema` estricto |
| `perfil_mapeo` | Reglas versionadas por fabricante | `$jsonSchema` estricto |
| `evento_consumido` | Idempotencia del consumo (TTL 7 días) | — |

`fila_cruda` no tiene validador **a propósito**: ahí entra lo que el fabricante
haya mandado, con sus celdas vacías y sus columnas raras. Es la evidencia de qué
recibimos, y lo que permite reprocesar un lote viejo con un perfil nuevo.

El "schema-on-read" se aplica a los datos de terceros; donde el esquema es
nuestro, se valida. Ver [ADR-003](../../docs/adr/ADR-003-persistencia.md).

## El pipeline

```
ingesta ──> parseo ──> normalización ──> validación ──> publicación
   │           │             │                │              │
 lote      fila_cruda   fila_normalizada   decisión    evento + catálogo
 recibido   guardada     canónica          del lote
```

Cada etapa tiene una entrada y una salida, puede fallar por sus propias razones,
y el estado del lote dice en qué etapa está. Por eso un lote interrumpido se
reanuda desde donde se cortó en lugar de volver a empezar.

```
src/
├── pipeline/
│   └── normalizador.js    etapa de normalización (lógica pura)
├── persistence/           colecciones de MongoDB
└── http/
    └── rutas-importaciones.js
```

## Reglas de negocio

| # | Regla |
|---|---|
| R1.3 | **El formato decimal lo declara el perfil, no se adivina.** `1.234` vale 1,234 con separador `.` y 1234 con separador `,`. |
| R1.4 | Una fila sin código de fabricante o sin precio interpretable se marca con error, **nombrando la columna del fabricante** donde falló. |
| R1.5 | Un lote con **más del 10 % de filas con error se rechaza completo**. |
| R1.6 | El mismo archivo no se importa dos veces: índice único sobre `archivo.huella_sha256`. |

> **Por qué R1.5:** aplicar media lista deja el comparador en un estado peor que
> no haber importado nada, porque los productos que entraron compiten contra
> precios viejos de los que no entraron.

### Una nota sobre las transformaciones

Las transformaciones declarables en un perfil (`quitar_simbolo_moneda`,
`trim_mayusculas`, `colapsar_espacios`) son **sólo de limpieza de texto**. A
propósito no hay transformaciones que reinterpreten el formato numérico ni las
unidades: eso lo resuelven `aDecimal` (con el `separador_decimal` del perfil) y
`aPotenciaW`, que son la única fuente de verdad para esas dos cosas.

El motivo es concreto, y lo descubrimos con un test: una transformación
`coma_a_punto` aplicada antes de `aDecimal` con separador `,` hacía que
`1.110,20` terminara valiendo **111020**. Dos componentes interpretando el mismo
formato es un error esperando a ocurrir, y un precio mal interpretado por un
factor de 1000 cotiza mal todo el catálogo.

## Probar la normalización sin subir un archivo

Implementado ya en la Entrega 1, porque es la forma de ajustar el perfil de un
fabricante nuevo:

```bash
curl -X POST "http://localhost:3001/importaciones/probar-normalizacion" \
  -H "Content-Type: application/json" \
  -d '{
    "perfil": {
      "separador_decimal": ",",
      "moneda_por_defecto": "USD",
      "columnas": { "codigo_fabricante": "CODIGO", "precio_lista": "PRECIO UNIT." }
    },
    "filas": [ { "CODIGO": "TSM-580", "PRECIO UNIT.": "1.110,20" } ]
  }'
```

Devuelve la fila normalizada, los errores por fila y la decisión sobre el lote.

## Eventos

**Publica:** `precios.lista_actualizada` cuando un lote se aplica.

## Dependencias

| Dependencia | Tipo | Si falla |
|---|---|---|
| MongoDB | esencial | `503`; el readiness probe lo reporta |
| `catalog-service` | síncrona | El lote queda en `normalizado` y se reanuda |
| RabbitMQ | asíncrona | El evento espera en el outbox |

## Correr los tests

```bash
npm install && npm test        # 20 tests, sin infraestructura
```

Los casos salen de planillas reales: formatos de número distintos, unidades
mezcladas y columnas con nombres propios de cada marca.

## Estado

| Parte | Estado |
|---|---|
| Colecciones con validadores e índices, más dos perfiles de demo | Listo |
| Etapa de normalización | **Implementada y testeada** |
| Decisión de aplicar o rechazar el lote | **Implementada y testeada** |
| Prueba en seco (`/probar-normalizacion`) | Implementada |
| Ingesta de archivos, parseo de XLSX, aplicación al catálogo | Entrega 2 |
