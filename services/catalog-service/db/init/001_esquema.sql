-- ---------------------------------------------------------------------------
-- catalog-service — Catálogo unificado de equipamiento solar
--
-- Dueño exclusivo de estos datos. Ningún otro servicio accede a esta base:
-- el resto consume la API HTTP del servicio o los eventos que publica.
--
-- Decisiones relevantes: docs/adr/ADR-003-persistencia.md
-- ---------------------------------------------------------------------------

set client_min_messages = warning;

create schema if not exists catalogo;
set search_path = catalogo, public;

-- --- Tipos del dominio -----------------------------------------------------

create type tipo_producto as enum ('panel', 'inversor', 'estructura', 'bateria');

create type tecnologia_celda as enum (
  'mono_perc', 'topcon', 'hjt', 'policristalino', 'bifacial'
);

create type estado_producto as enum ('activo', 'descontinuado', 'en_revision');

-- --- Fabricantes -----------------------------------------------------------

create table fabricante (
  id                        bigint generated always as identity primary key,
  nombre_canonico           text        not null,
  pais                      text        not null,
  -- Condiciones comerciales que entran en el cálculo del costo unitario final.
  dias_de_entrega           integer     not null default 30 check (dias_de_entrega >= 0),
  bonificacion_base_pct     numeric(5,2) not null default 0
    check (bonificacion_base_pct >= 0 and bonificacion_base_pct <= 100),
  activo                    boolean     not null default true,
  creado_en                 timestamptz not null default now(),
  actualizado_en            timestamptz not null default now(),

  constraint fabricante_nombre_unico unique (nombre_canonico)
);

comment on table fabricante is
  'Fabricante/proveedor del que importamos listas de precios.';

-- --- Productos canónicos ---------------------------------------------------

create table producto (
  id                      bigint generated always as identity primary key,
  -- SKU canónico de Helios: es el identificador que ve el mundo exterior.
  sku                     text              not null,
  tipo                    tipo_producto     not null,
  fabricante_id           bigint            not null references fabricante (id),
  modelo                  text              not null,

  -- Ficha técnica. Nullable según tipo: un inversor no tiene tecnología de celda.
  potencia_w              integer           check (potencia_w > 0),
  tecnologia              tecnologia_celda,
  eficiencia_pct          numeric(4,2)      check (eficiencia_pct > 0 and eficiencia_pct <= 100),
  tension_voc_v           numeric(6,2)      check (tension_voc_v > 0),
  corriente_isc_a         numeric(6,2)      check (corriente_isc_a > 0),
  garantia_anios          integer           check (garantia_anios >= 0),
  peso_kg                 numeric(7,3)      check (peso_kg > 0),

  -- Unidad de embalaje mayorista: toda compra debe ser múltiplo de este valor.
  multiplo_de_embalaje    integer           not null default 1
                            check (multiplo_de_embalaje >= 1),

  estado                  estado_producto   not null default 'activo',
  creado_en               timestamptz       not null default now(),
  actualizado_en          timestamptz       not null default now(),

  constraint producto_sku_unico unique (sku),
  constraint producto_sku_formato check (sku ~ '^HEL-[A-Z]{3}-[A-Z0-9-]{3,20}$'),
  -- Un panel sin potencia no se puede rankear por costo por Watt.
  constraint panel_requiere_potencia
    check (tipo <> 'panel' or potencia_w is not null)
);

comment on column producto.multiplo_de_embalaje is
  'Unidades por pallet. stock-service rechaza cantidades que no sean múltiplo de este valor.';

-- Índice sobre la FK (Postgres no lo crea solo) y sobre los filtros de búsqueda.
create index producto_fabricante_idx on producto (fabricante_id);
create index producto_tipo_potencia_idx on producto (tipo, potencia_w)
  where estado = 'activo';

-- --- Certificaciones (relación n:m) ---------------------------------------

create table certificacion (
  id      bigint generated always as identity primary key,
  codigo  text not null,
  constraint certificacion_codigo_unico unique (codigo)
);

create table producto_certificacion (
  producto_id       bigint not null references producto (id) on delete cascade,
  certificacion_id  bigint not null references certificacion (id),
  vence_en          date,
  primary key (producto_id, certificacion_id)
);

create index producto_certificacion_cert_idx
  on producto_certificacion (certificacion_id);

-- --- Mapeo de SKUs: el corazón de la unificación de catálogo --------------
-- Cada fabricante nombra el mismo producto a su manera. import-service llega con
-- el código del fabricante; acá se resuelve a qué producto canónico corresponde.

create table mapeo_sku (
  id                  bigint generated always as identity primary key,
  fabricante_id       bigint not null references fabricante (id),
  codigo_fabricante   text   not null,
  producto_id         bigint not null references producto (id) on delete cascade,
  -- Cómo se estableció el mapeo: importa para auditar los automáticos.
  origen              text   not null default 'manual'
                        check (origen in ('manual', 'automatico', 'heuristico')),
  confianza           numeric(3,2) check (confianza >= 0 and confianza <= 1),
  creado_en           timestamptz not null default now(),

  -- Un mismo código de un mismo fabricante no puede apuntar a dos productos.
  constraint mapeo_sku_unico unique (fabricante_id, codigo_fabricante)
);

create index mapeo_sku_producto_idx on mapeo_sku (producto_id);

comment on table mapeo_sku is
  'Traduce el código propio de cada fabricante al SKU canónico de Helios.';

-- --- Bitácora de eventos publicados (patrón outbox) -----------------------
-- Garantiza que un cambio de catálogo y la publicación de su evento ocurran en
-- la misma transacción. Un worker lee las filas no publicadas y las envía a
-- RabbitMQ; si falla, reintenta sin perder el evento.

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

create trigger fabricante_tocar
  before update on fabricante
  for each row execute function tocar_actualizado_en();

create trigger producto_tocar
  before update on producto
  for each row execute function tocar_actualizado_en();
