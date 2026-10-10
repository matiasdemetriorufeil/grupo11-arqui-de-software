# catalog-service

Catálogo unificado de productos y mapeo de SKUs por fabricante.

| | |
|---|---|
| **Puerto** | 3002 |
| **Almacén** | PostgreSQL 16 (`helios_catalogo`) |
| **Patrón interno** | Capas (http → aplicación → persistencia) |
| **Expuesto por el gateway** | `/interno/catalogo/**` |

## Responsabilidad

Definir qué productos existen y unificar los códigos de los distintos
fabricantes contra un SKU canónico. Es la autoridad sobre la identidad de un
producto: cuando `import-service` llega con `JKM550N-72HL4-BDV`, este servicio
dice que eso es `HEL-PAN-550-JKM`.

No decide sobre precios ni disponibilidad.

## De qué datos es dueño

| Tabla | Qué guarda |
|---|---|
| `fabricante` | Fabricantes, con plazo de entrega y bonificación base |
| `producto` | Productos canónicos con su ficha técnica y unidad de embalaje |
| `certificacion` / `producto_certificacion` | Certificaciones (IEC, CE, UL) |
| `mapeo_sku` | Código propio de cada fabricante → SKU canónico |
| `outbox_evento` | Eventos pendientes de publicar |

## Por qué capas y no hexagonal

El modelo es relacional, estable, y sus invariantes los garantiza la base. Un
hexágono acá sería ceremonia sin beneficio — y decidirlo explícitamente también
es una decisión, registrada en
[ADR-001](../../docs/adr/ADR-001-limites-de-servicios.md).

```
src/
├── http/
│   └── rutas-catalogo.js      API interna
├── application/
│   └── skus.js                reglas de identidad (lógica pura)
└── persistence/               repositorios PostgreSQL
```

## Los invariantes los impone la base

No el código de aplicación. Esto es lo que hace que una importación con datos
sucios no pueda dejar el catálogo inconsistente:

| Invariante | Mecanismo |
|---|---|
| Un código de fabricante no apunta a dos productos | `UNIQUE (fabricante_id, codigo_fabricante)` |
| Un panel sin potencia no se puede dar de alta | `CHECK (tipo <> 'panel' OR potencia_w IS NOT NULL)` |
| El SKU cumple el formato que publica el contrato | `CHECK (sku ~ '^HEL-[A-Z]{3}-[A-Z0-9-]{3,20}$')` |
| Un producto pertenece a un fabricante que existe | clave foránea |
| El SKU es único | `UNIQUE (sku)` |

Sin la restricción de unicidad del mapeo, una importación podría crear un mapeo
ambiguo y el comparador de precios empezaría a comparar productos distintos
creyendo que son el mismo. Es un error que falla **silenciosamente**, así que la
garantía tiene que estar en el lugar donde no se puede saltear.

## Reglas de identidad

| # | Regla |
|---|---|
| R2.1 | SKU canónico con formato `HEL-{TIPO}-{POTENCIA}-{MARCA}`. Los inversores se nombran en kW (`HEL-INV-50K-SUN`), los paneles en Watts (`HEL-PAN-550-JKM`). |
| R2.2 | **El SKU es inmutable una vez publicado**: el grupo consumidor lo tiene guardado en sus propios pedidos. |
| R2.4 | Los códigos de fabricante se **normalizan** antes de comparar. |
| R2.6 | Un producto que se deja de vender se marca `descontinuado`, no se borra. |

### Normalización de códigos

`JKM550N 72HL4 BDV`, `jkm550n-72hl4-bdv`, `JKM550N--72HL4-BDV.` y
`JKM550N_72HL4/BDV` son **el mismo producto**. Sin esta normalización, cada
importación crearía duplicados y el comparador dejaría de tener sentido.

Se puede probar sin base de datos:

```bash
curl "http://localhost:3002/catalogo/mapeos/normalizar?codigo=%20%20jkm550n%2072hl4%20bdv%20"
```

Devuelve el valor normalizado y la explicación de qué se le aplicó.

### Abreviatura del fabricante

Se toman las consonantes de la primera palabra, de forma que `Jinko Solar` y
`Jinko Solar Co. Ltd.` den la misma marca. Un mismo fabricante no puede generar
dos marcas distintas según cómo esté escrita su razón social.

> Los SKUs de los datos de demostración fueron asignados manualmente y no
> necesariamente coinciden con lo que generaría la versión actual de
> `construirSku`. Eso es correcto por R2.2: un SKU publicado no se recalcula.

## Eventos

**Publica:** `catalogo.producto_catalogado`, `catalogo.mapeo_creado`

Los consumen `pricing-search-service` (alta en el índice) y `stock-service`
(creación de la existencia inicial).

## Dependencias

| Dependencia | Tipo | Si falla |
|---|---|---|
| PostgreSQL | esencial | `503`; el readiness probe lo reporta |
| RabbitMQ | asíncrona | Los eventos esperan en el outbox |

Este servicio **no llama a nadie**: es una hoja del grafo de dependencias
síncronas.

## Correr los tests

```bash
npm install && npm test        # 10 tests, sin infraestructura
```

## Estado

| Parte | Estado |
|---|---|
| Esquema con restricciones y 5 productos de demo con sus mapeos | Listo |
| Reglas de identidad de SKUs | **Implementadas y testeadas** |
| Normalización de códigos (`/catalogo/mapeos/normalizar`) | Implementada |
| CRUD de productos, fabricantes y mapeos | Entrega 2 |
| Publicación de eventos desde el outbox | Entrega 2 |
