# API Mayorista de Equipamiento Solar — Helios

Documentación de la capacidad que Helios publica para que otros sistemas coticen
y reserven equipamiento solar de nuestro stock.

Si estás integrándote con nosotros, **este documento y
[`openapi.yaml`](openapi.yaml) son todo lo que necesitás**. No hace falta
preguntarnos nada para empezar.

| | |
|---|---|
| **Versión vigente** | `1.0.0` |
| **Contrato formal** | [`openapi.yaml`](openapi.yaml) (OpenAPI 3.0.3) |
| **Mock operativo** | `http://localhost:4010` — `docker compose up` en este repo |
| **Mock vía gateway** | `http://localhost:8000/mock` |
| **Producción** | URL pública a publicar en la Entrega 2 |
| **Decisiones de diseño** | [`../adr/ADR-008-contrato-propio.md`](../adr/ADR-008-contrato-propio.md) |

---

## 1. Qué podés hacer con esta API

Cotizar y reservar paneles solares, inversores, estructuras y baterías de nuestro
stock mayorista. Una reserva **bloquea inventario real**: si reservás 108 paneles,
nadie más puede comprarlos durante los 15 minutos siguientes.

### Operaciones

| Método | Ruta | Scope | Para qué |
|---|---|---|---|
| `GET` | `/v1/proveedor/catalogo` | `catalogo:leer` | Buscar productos: paginado, filtros, orden por costo por Watt |
| `GET` | `/v1/proveedor/disponibilidad` | `catalogo:leer` | Verificar una cantidad antes de cotizar (informativo) |
| `POST` | `/v1/proveedor/cotizaciones` | `cotizaciones:escribir` | Obtener precio firme con vigencia |
| `GET` | `/v1/proveedor/cotizaciones/{id}` | `catalogo:leer` | Reconsultar una cotización |
| `POST` | `/v1/pedidos/reservar` | `pedidos:escribir` | **Reservar stock** |
| `GET` | `/v1/pedidos/{id}` | `pedidos:escribir` | Estado del pedido |
| `POST` | `/v1/pedidos/{id}/confirmar` | `pedidos:escribir` | Confirmar y disparar el cobro |
| `DELETE` | `/v1/pedidos/{id}` | `pedidos:escribir` | Cancelar y liberar el stock |

---

## 2. El flujo, de principio a fin

```
1. GET  /v1/proveedor/catalogo              → encontrás qué comprar
2. POST /v1/proveedor/cotizaciones          → obtenés cotizacion_id y precio firme (15 min)
3. POST /v1/pedidos/reservar                → bloqueás el stock (Idempotency-Key obligatorio)
4. POST /v1/pedidos/{id}/confirmar          → confirmás; disparamos el cobro
```

**No se puede reservar sin cotizar primero.** Es la única restricción del flujo
que puede sorprender, así que vale explicar por qué: la cotización fija el precio
que vas a pagar antes de que comprometas stock, y las bonificaciones por volumen
se calculan sobre el pedido completo, no línea por línea. Sin cotización no
tenemos un precio acordado que congelar.

### Máquina de estados del pedido

```
                   ┌──────────── DELETE ────────────┐
                   │                                ▼
   reservar ──> reservado ──confirmar──> pendiente_de_pago ──> confirmado
                   │                            │                  
                   │ (15 min sin confirmar)     │ (pago rechazado)
                   ▼                            ▼
               expirado                     rechazado
```

| Estado | Qué significa | ¿Tenés el stock? |
|---|---|---|
| `reservado` | Stock bloqueado, esperando tu confirmación | **Sí**, hasta `expira_en` |
| `pendiente_de_pago` | Confirmaste; esperamos al proveedor de pagos | **Sí**, lo conservamos |
| `confirmado` | Pago autorizado. Pedido firme | **Sí** |
| `rechazado` | El pago se rechazó | No, se liberó |
| `cancelado` | Lo cancelaste vos | No, se liberó |
| `expirado` | Pasaron 15 minutos sin confirmar | No, se liberó |

---

## 3. Autenticación

```http
Authorization: Bearer <JWT>
```

JWT HS256 con los claims `iss` (tu identificador de consumidor), `exp` y `scope`.
Te entregamos `client_id` y `client_secret` por canal privado; el token se emite
a partir de esas credenciales.

El token se valida en nuestro API Gateway **antes** de llegar a cualquier
servicio. Sin token o con token vencido: `401 NO_AUTENTICADO`. Con token válido
pero sin el scope necesario: `403 SCOPE_INSUFICIENTE`.

### Límite de tasa

60 solicitudes por minuto por consumidor. Al excederlo recibís `429` con
`Retry-After`. Las respuestas incluyen `RateLimit-Remaining` para que puedas
autorregularte sin llegar al límite.

---

## 4. Idempotencia — leer antes de implementar

`POST /v1/pedidos/reservar` y `POST /v1/pedidos/{id}/confirmar` **requieren** el
header `Idempotency-Key` con un UUID v4.

```http
POST /v1/pedidos/reservar
Idempotency-Key: 3d1a0d7c-8f52-4c64-9b6e-1f0a2e5c7d93
```

Reglas:

| Situación | Qué pasa |
|---|---|
| Primera llamada con esa clave | Se procesa normalmente |
| Misma clave, **mismo** cuerpo | Devolvemos la **misma** respuesta y el mismo estado HTTP, con el header `Idempotency-Replayed: true`. **No** se crea una segunda reserva |
| Misma clave, cuerpo **distinto** | `409 CLAVE_IDEMPOTENCIA_REUSADA` |
| Sin el header | `400 SOLICITUD_INVALIDA` |

Las claves se retienen **24 horas**.

**Generá una clave nueva por cada intento lógico distinto, y reusá la misma al
reintentar el mismo intento.** Es decir: si se te cortó la red y no sabés si la
reserva se creó, reintentá con la misma clave — vas a recibir la reserva original
si se había creado, o se va a crear ahora si no. Lo que **no** hay que hacer es
generar una clave nueva en cada reintento: eso puede duplicarte el pedido.

Lo hicimos obligatorio en lugar de opcional porque un reintento sin clave es un
pedido duplicado, y preferimos rechazar la llamada antes que duplicarte stock
comprometido.

---

## 5. Errores

Todos los errores usan `application/problem+json` (RFC 9457):

```json
{
  "type": "https://api.helios.example.com/problemas/stock-insuficiente",
  "title": "Stock insuficiente",
  "status": 409,
  "codigo": "STOCK_INSUFICIENTE",
  "detail": "No hay unidades libres suficientes para una o más líneas del pedido.",
  "instance": "/v1/pedidos/reservar",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "reintentable": false,
  "lineas_en_conflicto": [
    { "sku": "HEL-PAN-550-JKM", "cantidad_solicitada": 108, "unidades_libres": 72 }
  ]
}
```

**Programá contra `codigo`, no contra `title` ni `detail`.** `codigo` es estable y
no cambia de significado nunca; `title` y `detail` son texto para personas y los
podemos reescribir.

**Usá `reintentable`** para decidir si vale la pena reintentar, en lugar de
inferirlo del número de estado.

**Guardá `trace_id`** cuando algo falle: con ese valor encontramos la operación en
nuestros logs y no tenemos que preguntarte a qué hora fue.

### Tabla completa de códigos

| HTTP | `codigo` | Qué pasó | Qué hacer |
|---|---|---|---|
| 400 | `SOLICITUD_INVALIDA` | El cuerpo o los parámetros no cumplen el contrato | Corregir. Mirá `errores_de_validacion` |
| 401 | `NO_AUTENTICADO` | Token ausente, mal formado o vencido | Renovar el token |
| 403 | `SCOPE_INSUFICIENTE` | El token no tiene el scope de la operación | Pedir el scope |
| 404 | `NO_ENCONTRADO` | El recurso no existe **o no es tuyo** | Verificar el id |
| 409 | `STOCK_INSUFICIENTE` | No hay unidades libres | Mirá `lineas_en_conflicto` y recotizá con menos |
| 409 | `COTIZACION_EXPIRADA` | Pasaron los 15 minutos de vigencia | Recotizar |
| 409 | `RESERVA_EXPIRADA` | La reserva venció antes de confirmar | Volver a reservar |
| 409 | `CLAVE_IDEMPOTENCIA_REUSADA` | Misma clave con otro cuerpo | Bug tuyo: generá una clave nueva |
| 409 | `ESTADO_NO_CANCELABLE` | El pedido ya está en estado terminal | Nada: consultá el estado |
| 409 | `ESTADO_NO_CONFIRMABLE` | El pedido ya no está reservado | Nada: consultá el estado |
| 422 | `CANTIDAD_NO_MULTIPLO_EMBALAJE` | La cantidad no completa pallets | Ajustar al `multiplo_de_embalaje` del producto |
| 422 | `MONTO_MINIMO_NO_ALCANZADO` | El pedido no alcanza el mínimo mayorista | Agregar líneas |
| 422 | `CUPO_CLIENTE_EXCEDIDO` | Excede tu cupo vigente | Esperar la renovación del cupo o contactarnos |
| 422 | `LINEAS_NO_COINCIDEN` | El pedido no coincide con la cotización | Enviar exactamente las líneas cotizadas |
| 422 | `SKU_DESCONTINUADO` | El producto ya no se comercializa | Buscar un reemplazo en el catálogo |
| 429 | `LIMITE_DE_TASA_EXCEDIDO` | Más de 60 req/min | Esperar `Retry-After` |
| 503 | `SERVICIO_NO_DISPONIBLE` | Problema de nuestro lado | Reintentar con backoff exponencial |

### Reglas de la reserva, en el orden en que se validan

Útil para anticipar qué error vas a recibir:

| # | Regla | Error si falla |
|---|---|---|
| 1 | La cotización existe, es tuya y está vigente | `409 COTIZACION_EXPIRADA` |
| 2 | El pedido coincide línea por línea con la cotización | `422 LINEAS_NO_COINCIDEN` |
| 3 | Cada cantidad es múltiplo del embalaje del producto | `422 CANTIDAD_NO_MULTIPLO_EMBALAJE` |
| 4 | El monto total alcanza el mínimo mayorista | `422 MONTO_MINIMO_NO_ALCANZADO` |
| 5 | No excedés tu cupo vigente | `422 CUPO_CLIENTE_EXCEDIDO` |
| 6 | Hay stock libre suficiente | `409 STOCK_INSUFICIENTE` |

**La reserva es todo o nada:** si una sola línea falla, no se reserva ninguna.

---

## 6. Convenciones que hay que respetar

**Montos como string decimal.** `{"monto": "19872.00", "moneda": "USD"}`. Un float
JSON no representa dinero sin pérdida. Parsealo con un tipo decimal, no con
`parseFloat`.

**Cantidades múltiplo del embalaje.** Cada producto trae `multiplo_de_embalaje`
(unidades por pallet). Un panel con `multiplo_de_embalaje: 36` se vende en 36, 72,
108… nunca 100.

**El SKU es opaco.** `HEL-PAN-550-JKM` es un identificador. No parsees sus partes:
podemos cambiar el criterio de generación. Lo que sí garantizamos es que **un SKU
publicado no cambia nunca**.

**Ignorá los campos que no conozcas.** Vamos a agregar campos a las respuestas sin
cambiar la versión major. Si tu cliente falla ante un campo desconocido, se va a
romper con una actualización nuestra que no era incompatible.

**Tratá los códigos de error desconocidos según el HTTP.** Podemos agregar
códigos nuevos. Un `codigo` que no conocés con status `503` sigue siendo
reintentable.

**La disponibilidad es informativa.** `GET /v1/proveedor/disponibilidad` y el
campo `unidades_libres` del catálogo pueden estar hasta 60 s atrasados. El valor
autoritativo se verifica al reservar. No construyas lógica que asuma que
"disponibilidad dijo que había" garantiza que la reserva va a funcionar.

---

## 7. Qué hacer cuando fallamos

| Qué ves | Qué pasó de nuestro lado | Qué te recomendamos |
|---|---|---|
| `503` en catálogo o cotizaciones | Nuestro motor de búsqueda o el servicio de precios no responde | Backoff exponencial (1 s, 2 s, 4 s…). Mientras tanto, `GET /v1/proveedor/disponibilidad` sigue funcionando porque va contra otro servicio |
| `503` en reservar | No pudimos obtener el precio firme | Reintentar **con la misma `Idempotency-Key`** |
| `202` al confirmar | Nuestro proveedor de pagos no responde. **Conservamos tu stock** | Reconsultar `GET /v1/pedidos/{id}` según `Retry-After`. No vuelvas a confirmar |
| Timeout sin respuesta | No sabés si la operación se procesó | Reintentar con la **misma** `Idempotency-Key`. Si se había creado, recibís la misma reserva con `Idempotency-Replayed: true` |
| `429` | Excediste el límite de tasa | Esperar `Retry-After`. Mirá `RateLimit-Remaining` para no llegar al límite |

Te recomendamos un **timeout de 5 s** en tus llamadas a cotizar y reservar, y un
circuit breaker de tu lado. Si estamos caídos, fallar rápido es mejor para tu
sistema que acumular conexiones esperando.

---

## 8. Probar contra el mock

El mock sirve el mismo `openapi.yaml` y devuelve los ejemplos del contrato, así
que podés implementar y probar tu integración completa **antes** de que exista
nuestra implementación real.

```bash
# En la raíz de este repositorio
docker compose up -d mock-contrato
```

### Camino feliz

```bash
# Buscar en el catálogo
curl "http://localhost:4010/v1/proveedor/catalogo?tipo=panel&orden=costo_por_watt_asc" \
  -H "Authorization: Bearer cualquier-token-en-el-mock"

# Cotizar
curl -X POST "http://localhost:4010/v1/proveedor/cotizaciones" \
  -H "Authorization: Bearer cualquier-token-en-el-mock" \
  -H "Content-Type: application/json" \
  -d '{
        "destino": { "provincia": "Córdoba", "localidad": "Villa María" },
        "lineas": [ { "sku": "HEL-PAN-550-JKM", "cantidad": 108 } ]
      }'

# Reservar
curl -X POST "http://localhost:4010/v1/pedidos/reservar" \
  -H "Authorization: Bearer cualquier-token-en-el-mock" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 3d1a0d7c-8f52-4c64-9b6e-1f0a2e5c7d93" \
  -d '{
        "cotizacion_id": "7f1c9d3e-5b42-4a1f-9d0e-2c7b8a6f4e11",
        "referencia_externa": "OC-2026-000481",
        "lineas": [ { "sku": "HEL-PAN-550-JKM", "cantidad": 108 } ]
      }'
```

### Probar los caminos de error

El mock implementa el header `Prefer` de Prism, así que podés forzar cualquier
respuesta del contrato. **Esto es lo más valioso del mock**: te permite
implementar y probar tu manejo de errores sin esperar a que algo falle de verdad.

```bash
# Forzar stock insuficiente
curl -X POST "http://localhost:4010/v1/pedidos/reservar" \
  -H "Authorization: Bearer token" -H "Content-Type: application/json" \
  -H "Idempotency-Key: 3d1a0d7c-8f52-4c64-9b6e-1f0a2e5c7d93" \
  -H "Prefer: code=409" \
  -d '{"cotizacion_id":"7f1c9d3e-5b42-4a1f-9d0e-2c7b8a6f4e11","lineas":[{"sku":"HEL-PAN-550-JKM","cantidad":108}]}'

# Forzar regla de negocio incumplida (422), servicio no disponible (503), etc.
#   -H "Prefer: code=422"
#   -H "Prefer: code=503"
```

El mock **valida** las peticiones contra el contrato: si mandás un cuerpo que no
cumple el esquema o te falta la autenticación, te lo dice. Eso también es útil —
es un validador gratis de tu cliente.

### Generar un cliente

```bash
npx @openapitools/openapi-generator-cli generate \
  -i docs/contracts/openapi.yaml -g typescript-fetch -o ./cliente-helios
```

---

## 9. Versionado y compatibilidad

**SemVer con la major en la ruta.** La versión vigente es `1.0.0` y se sirve en
`/v1/**`.

### Lo que te prometemos

- Dentro de `/v1`, **sólo cambios aditivos**. Un cliente escrito hoy sigue
  funcionando.
- Un `codigo` de error **nunca** cambia de significado.
- Un SKU publicado **nunca** cambia.
- Si abrimos `/v2`, `/v1` sigue operativo **al menos 30 días**, respondiendo con
  los headers `Deprecation` y `Sunset` (RFC 8594). No apagamos una versión sin que
  aparezca antes en los headers de las respuestas que ya estás recibiendo.

### Lo que te pedimos

- Ignorar campos desconocidos en las respuestas.
- No parsear el SKU.
- Tratar códigos de error desconocidos según el status HTTP.

### Qué constituye un cambio incompatible

Quitar o renombrar un campo, volver obligatorio un campo opcional, cambiar el tipo
de un campo, o cambiar el significado de un `codigo`. Cualquiera de esas cosas
abre `/v2`.

---

## 10. Changelog

| Versión | Fecha | Cambios |
|---|---|---|
| `1.0.0` | 2026-10-09 | Primera versión publicada. Catálogo, disponibilidad, cotizaciones y ciclo de vida del pedido. Mock operativo con Prism. |

---

## 11. Contacto

Grupo **11** — Arquitectura de Software 2026, UCC.
Federico Almada, Joaquín Bonino, Demetrio Rufeil y Santino Vercesi.

Repositorio: <https://github.com/matiasdemetriorufeil/grupo11-arqui-de-software>

Si algo del contrato no está claro o te bloquea, avisanos: una ambigüedad en el
contrato es un problema nuestro, no tuyo. Cuando reportes un error, incluí el
`trace_id` de la respuesta.
