-- ---------------------------------------------------------------------------
-- stock-service — Inventario, reservas transaccionales y reposición
--
-- Acá vive la operación crítica del sistema: reservar stock sin sobreventa ni
-- duplicación. El esquema está diseñado alrededor de esa garantía.
--
-- Decisiones relevantes:
--   docs/adr/ADR-003-persistencia.md   (por qué PostgreSQL)
--   docs/adr/ADR-005-comunicacion.md   (eventos que publica)
--   SPEC.md, HU-04                     (reglas de la reserva)
-- ---------------------------------------------------------------------------

set client_min_messages = warning;

create schema if not exists stock;
set search_path = stock, public;

-- --- Tipos del dominio -----------------------------------------------------

create type estado_reserva as enum (
  'reservado',           -- stock bloqueado, esperando confirmación
  'pendiente_de_pago',   -- confirmada por el cliente, esperando al proveedor de pagos
  'confirmado',          -- pago autorizado
  'rechazado',           -- pago rechazado; stock liberado
  'cancelado',           -- cancelada por el cliente; stock liberado
  'expirado'             -- venció sin confirmar; stock liberado
);

create type estado_orden_reposicion as enum (
  'sugerida', 'emitida', 'recibida', 'cancelada'
);

create type tipo_movimiento as enum (
  'ingreso', 'reserva', 'liberacion', 'despacho', 'ajuste'
);

-- --- Depósitos -------------------------------------------------------------

create table deposito (
  id        bigint generated always as identity primary key,
  codigo    text not null,
  nombre    text not null,
  provincia text not null,
  activo    boolean not null default true,

  constraint deposito_codigo_unico unique (codigo)
);

-- --- Existencias -----------------------------------------------------------
-- `producto_id` y `sku` son una referencia a un agregado de OTRO servicio
-- (catalog-service). No hay FK posible entre bases: se replica el dato mínimo
-- necesario y se mantiene al día por eventos. Ver ADR-001.

create table existencia (
  id                    bigint generated always as identity primary key,
  producto_id           bigint      not null,
  sku                   text        not null,
  deposito_id           bigint      not null references deposito (id),

  cantidad_fisica       integer     not null default 0 check (cantidad_fisica >= 0),
  cantidad_reservada    integer     not null default 0 check (cantidad_reservada >= 0),

  -- Umbrales de reposición.
  stock_minimo          integer     not null default 0 check (stock_minimo >= 0),
  punto_de_reposicion   integer     not null default 0 check (punto_de_reposicion >= 0),
  lote_de_reposicion    integer     not null default 1 check (lote_de_reposicion >= 1),
  multiplo_de_embalaje  integer     not null default 1 check (multiplo_de_embalaje >= 1),

  actualizado_en        timestamptz not null default now(),

  -- Una sola fila por producto y depósito: es la fila que se bloquea al reservar.
  constraint existencia_unica unique (producto_id, deposito_id),

  -- INVARIANTE CENTRAL: nunca se puede reservar más de lo que hay.
  -- Esto es lo que hace imposible la sobreventa incluso ante un bug de aplicación.
  constraint existencia_sin_sobreventa
    check (cantidad_reservada <= cantidad_fisica)
);

create index existencia_sku_idx on existencia (sku);
create index existencia_deposito_idx on existencia (deposito_id);

-- Existencias que ya cruzaron el punto de reposición: alimenta el job que
-- genera órdenes y publica StockBajoMinimoEvent.
create index existencia_bajo_minimo_idx on existencia (producto_id)
  where cantidad_fisica - cantidad_reservada <= punto_de_reposicion;

comment on column existencia.cantidad_fisica is
  'Unidades en el depósito. No baja al reservar; baja al despachar.';
comment on column existencia.cantidad_reservada is
  'Unidades comprometidas por reservas vigentes. Libre = fisica - reservada.';

-- --- Idempotencia de las operaciones de escritura -------------------------
-- Una clave registrada es la prueba de que la operación ya se ejecutó. El
-- UNIQUE es lo que hace imposible crear dos reservas con la misma clave, incluso
-- si llegan dos pedidos idénticos en paralelo.

create table clave_idempotencia (
  clave             text        primary key,
  consumidor        text        not null,
  operacion         text        not null,
  huella_cuerpo     text        not null,   -- hash del cuerpo, para detectar reuso con otro contenido
  estado_http       integer     not null,
  respuesta         jsonb       not null,
  creado_en         timestamptz not null default now(),
  expira_en         timestamptz not null default now() + interval '24 hours'
);

create index clave_idempotencia_purga_idx on clave_idempotencia (expira_en);

-- --- Reservas --------------------------------------------------------------

create table reserva (
  id                  uuid        primary key default gen_random_uuid(),
  consumidor          text        not null,   -- claim `iss` del JWT del solicitante
  cotizacion_id       uuid        not null,
  referencia_externa  text,                   -- id del pedido en el sistema del consumidor
  estado              estado_reserva not null default 'reservado',

  moneda              text        not null check (moneda in ('USD', 'ARS')),
  total               numeric(14,2) not null check (total >= 0),

  creado_en           timestamptz not null default now(),
  expira_en           timestamptz,            -- sólo mientras mantiene stock bloqueado
  cerrado_en          timestamptz,

  -- Control de concurrencia optimista para las transiciones de estado.
  version             integer     not null default 1,

  -- Un estado terminal no puede seguir teniendo vencimiento pendiente.
  constraint reserva_vencimiento_coherente check (
    (estado in ('reservado', 'pendiente_de_pago') and expira_en is not null)
    or (estado in ('confirmado', 'rechazado', 'cancelado', 'expirado') and cerrado_en is not null)
  )
);

create index reserva_consumidor_idx on reserva (consumidor, creado_en desc);
create index reserva_cotizacion_idx on reserva (cotizacion_id);
-- Alimenta el job que expira reservas vencidas y libera stock.
create index reserva_por_expirar_idx on reserva (expira_en)
  where estado in ('reservado', 'pendiente_de_pago');

create table reserva_linea (
  id                          bigint generated always as identity primary key,
  reserva_id                  uuid    not null references reserva (id) on delete cascade,
  producto_id                 bigint  not null,
  sku                         text    not null,
  deposito_id                 bigint  not null references deposito (id),
  cantidad                    integer not null check (cantidad > 0),
  -- Precio congelado al momento de la cotización: el cliente paga lo cotizado
  -- aunque la lista del fabricante cambie después.
  precio_unitario_congelado   numeric(12,2) not null check (precio_unitario_congelado >= 0),
  subtotal                    numeric(14,2) not null check (subtotal >= 0),

  constraint reserva_linea_unica unique (reserva_id, producto_id, deposito_id)
);

create index reserva_linea_reserva_idx on reserva_linea (reserva_id);
create index reserva_linea_producto_idx on reserva_linea (producto_id, deposito_id);

-- --- Libro mayor de movimientos (append-only) -----------------------------
-- Toda variación de stock deja un asiento. Permite auditar cualquier saldo y
-- reconstruirlo, y es la evidencia de que no se perdió ni duplicó información.

create table movimiento_stock (
  id              bigint generated always as identity primary key,
  existencia_id   bigint          not null references existencia (id),
  tipo            tipo_movimiento not null,
  cantidad        integer         not null check (cantidad <> 0),
  reserva_id      uuid            references reserva (id),
  motivo          text            not null,
  ocurrido_en     timestamptz     not null default now()
);

create index movimiento_existencia_idx on movimiento_stock (existencia_id, ocurrido_en desc);
create index movimiento_reserva_idx on movimiento_stock (reserva_id)
  where reserva_id is not null;

-- --- Órdenes de reposición -------------------------------------------------
-- Se generan cuando una existencia cruza su punto de reposición. El fabricante
-- elegido es el de mejor costo por Watt según pricing-search-service.

create table orden_reposicion (
  id                      uuid        primary key default gen_random_uuid(),
  producto_id             bigint      not null,
  sku                     text        not null,
  deposito_id             bigint      not null references deposito (id),
  cantidad                integer     not null check (cantidad > 0),

  fabricante_elegido      text,
  costo_unitario          numeric(12,2) check (costo_unitario >= 0),
  costo_por_watt          numeric(8,5)  check (costo_por_watt >= 0),
  -- Si el ranking de precios no estaba disponible, se registra por qué, para no
  -- bloquear la reposición ante una falla de una dependencia (ver ADR-005).
  origen_del_precio       text        not null default 'ranking_vigente'
                            check (origen_del_precio in
                              ('ranking_vigente', 'ultimo_ranking_en_cache', 'sin_ranking')),

  estado                  estado_orden_reposicion not null default 'sugerida',
  creado_en               timestamptz not null default now(),
  actualizado_en          timestamptz not null default now()
);

create index orden_reposicion_estado_idx on orden_reposicion (estado, creado_en);

-- No se acumulan órdenes abiertas duplicadas para el mismo producto y depósito:
-- un índice único parcial lo vuelve imposible a nivel de base.
create unique index orden_reposicion_una_abierta
  on orden_reposicion (producto_id, deposito_id)
  where estado in ('sugerida', 'emitida');

-- --- Idempotencia del consumo de eventos ----------------------------------
-- RabbitMQ entrega al-menos-una-vez: este registro hace que procesar dos veces
-- el mismo mensaje no tenga efecto.

create table evento_consumido (
  id_mensaje     text        primary key,
  tipo           text        not null,
  procesado_en   timestamptz not null default now()
);

create index evento_consumido_purga_idx on evento_consumido (procesado_en);

-- --- Outbox de eventos publicados -----------------------------------------

create table outbox_evento (
  id              bigint generated always as identity primary key,
  tipo            text        not null,
  clave_agregado  text        not null,
  cuerpo          jsonb       not null,
  ocurrido_en     timestamptz not null default now(),
  publicado_en    timestamptz,
  intentos        integer     not null default 0
);

create index outbox_pendientes_idx on outbox_evento (ocurrido_en)
  where publicado_en is null;

-- --- Vista de apoyo --------------------------------------------------------

create view existencia_disponible as
select
  e.id,
  e.producto_id,
  e.sku,
  d.codigo                                    as deposito,
  e.cantidad_fisica,
  e.cantidad_reservada,
  e.cantidad_fisica - e.cantidad_reservada     as unidades_libres,
  e.punto_de_reposicion,
  (e.cantidad_fisica - e.cantidad_reservada) <= e.punto_de_reposicion as requiere_reposicion
from existencia e
join deposito d on d.id = e.deposito_id;

-- --- Mantener actualizado_en ----------------------------------------------

create or replace function tocar_actualizado_en()
returns trigger
language plpgsql
as $$
begin
  new.actualizado_en := now();
  return new;
end;
$$;

create trigger orden_reposicion_tocar
  before update on orden_reposicion
  for each row execute function tocar_actualizado_en();
