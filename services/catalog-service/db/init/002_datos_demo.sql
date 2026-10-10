-- ---------------------------------------------------------------------------
-- catalog-service — Datos de demostración
--
-- Mínimo necesario para que el flujo principal sea recorrible en local y para
-- que los ejemplos del contrato (docs/contracts/openapi.yaml) tengan respaldo
-- en datos reales. No son datos de producción.
-- ---------------------------------------------------------------------------

set search_path = catalogo, public;

insert into fabricante (nombre_canonico, pais, dias_de_entrega, bonificacion_base_pct) values
  ('Jinko Solar', 'China',  45, 3.00),
  ('Trina Solar', 'China',  50, 2.50),
  ('Longi',       'China',  40, 2.00),
  ('Sungrow',     'China',  35, 1.50),
  ('Huawei',      'China',  30, 1.00);

insert into certificacion (codigo) values
  ('IEC 61215'), ('IEC 61730'), ('IEC 62109'), ('CE'), ('UL 1703');

-- Paneles -------------------------------------------------------------------
insert into producto
  (sku, tipo, fabricante_id, modelo, potencia_w, tecnologia, eficiencia_pct,
   tension_voc_v, corriente_isc_a, garantia_anios, peso_kg, multiplo_de_embalaje)
select 'HEL-PAN-550-JKM', 'panel', f.id, 'Tiger Neo 550W Bifacial',
       550, 'topcon', 21.50, 49.50, 14.05, 25, 27.200, 36
from fabricante f where f.nombre_canonico = 'Jinko Solar';

insert into producto
  (sku, tipo, fabricante_id, modelo, potencia_w, tecnologia, eficiencia_pct,
   tension_voc_v, corriente_isc_a, garantia_anios, peso_kg, multiplo_de_embalaje)
select 'HEL-PAN-580-TRN', 'panel', f.id, 'Vertex S+ 580W',
       580, 'topcon', 22.30, 52.10, 14.60, 25, 28.500, 31
from fabricante f where f.nombre_canonico = 'Trina Solar';

insert into producto
  (sku, tipo, fabricante_id, modelo, potencia_w, tecnologia, eficiencia_pct,
   tension_voc_v, corriente_isc_a, garantia_anios, peso_kg, multiplo_de_embalaje)
select 'HEL-PAN-540-LNG', 'panel', f.id, 'Hi-MO 6 540W',
       540, 'mono_perc', 21.00, 49.20, 13.90, 25, 26.800, 36
from fabricante f where f.nombre_canonico = 'Longi';

-- Inversores ----------------------------------------------------------------
insert into producto
  (sku, tipo, fabricante_id, modelo, potencia_w, garantia_anios, peso_kg, multiplo_de_embalaje)
select 'HEL-INV-50K-SUN', 'inversor', f.id, 'SG50CX 50kW',
       50000, 10, 47.000, 1
from fabricante f where f.nombre_canonico = 'Sungrow';

insert into producto
  (sku, tipo, fabricante_id, modelo, potencia_w, garantia_anios, peso_kg, multiplo_de_embalaje)
select 'HEL-INV-36K-HWI', 'inversor', f.id, 'SUN2000-36KTL 36kW',
       36000, 10, 42.000, 1
from fabricante f where f.nombre_canonico = 'Huawei';

-- Certificaciones de los paneles --------------------------------------------
insert into producto_certificacion (producto_id, certificacion_id)
select p.id, c.id
from producto p
cross join certificacion c
where p.tipo = 'panel' and c.codigo in ('IEC 61215', 'IEC 61730', 'CE');

insert into producto_certificacion (producto_id, certificacion_id)
select p.id, c.id
from producto p
cross join certificacion c
where p.tipo = 'inversor' and c.codigo in ('IEC 62109', 'CE');

-- Mapeo de los códigos propios de cada fabricante ---------------------------
insert into mapeo_sku (fabricante_id, codigo_fabricante, producto_id, origen, confianza)
select p.fabricante_id, v.codigo, p.id, 'manual', 1.00
from (values
  ('HEL-PAN-550-JKM', 'JKM550N-72HL4-BDV'),
  ('HEL-PAN-580-TRN', 'TSM-580NEG19RC.20'),
  ('HEL-PAN-540-LNG', 'LR5-72HTH-540M'),
  ('HEL-INV-50K-SUN', 'SG50CX'),
  ('HEL-INV-36K-HWI', 'SUN2000-36KTL-M3')
) as v (sku, codigo)
join producto p on p.sku = v.sku;
