-- ---------------------------------------------------------------------------
-- stock-service — Datos de demostración
--
-- Existencias consistentes con el catálogo de demo de catalog-service, para que
-- el flujo cotizar → reservar sea recorrible en local de punta a punta.
-- ---------------------------------------------------------------------------

set search_path = stock, public;

insert into deposito (codigo, nombre, provincia) values
  ('DEP-CBA-01', 'Centro de distribución Córdoba', 'Córdoba'),
  ('DEP-BUE-01', 'Centro de distribución Buenos Aires', 'Buenos Aires');

-- producto_id y sku replican la identidad del producto en catalog-service.
-- En régimen esta tabla se puebla por el evento ProductoCatalogadoEvent.
insert into existencia
  (producto_id, sku, deposito_id, cantidad_fisica, cantidad_reservada,
   stock_minimo, punto_de_reposicion, lote_de_reposicion, multiplo_de_embalaje)
select v.producto_id, v.sku, d.id, v.fisica, 0, v.minimo, v.reposicion, v.lote, v.embalaje
from (values
  (1, 'HEL-PAN-550-JKM', 'DEP-CBA-01', 1840,  360,  720, 1080, 36),
  (1, 'HEL-PAN-550-JKM', 'DEP-BUE-01',  900,  180,  360,  720, 36),
  (2, 'HEL-PAN-580-TRN', 'DEP-CBA-01',  620,  155,  310,  620, 31),
  (3, 'HEL-PAN-540-LNG', 'DEP-CBA-01',  144,  108,  360,  720, 36),  -- queda bajo mínimo a propósito
  (4, 'HEL-INV-50K-SUN', 'DEP-CBA-01',   24,    6,   12,   12,  1),
  (5, 'HEL-INV-36K-HWI', 'DEP-CBA-01',   18,    4,    8,   10,  1)
) as v (producto_id, sku, deposito, fisica, minimo, reposicion, lote, embalaje)
join deposito d on d.codigo = v.deposito;

-- Asiento inicial del libro mayor: el stock no aparece de la nada.
insert into movimiento_stock (existencia_id, tipo, cantidad, motivo)
select e.id, 'ingreso', e.cantidad_fisica, 'Carga inicial de datos de demostración'
from existencia e;
