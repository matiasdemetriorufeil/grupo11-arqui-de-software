// ---------------------------------------------------------------------------
// Tests unitarios del comparador de precios.
//
//   npm test   (desde services/pricing-search-service)
//
// Cubren la parte del sistema que decide cuánto cuesta algo y a qué fabricante
// se le compra: si esto se equivoca, se cotiza mal y se repone al proveedor
// equivocado.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bonificacionPorVolumen,
  calcularCostoPorWatt,
  calcularCostoUnitarioFinal,
  claveDeCache,
  elegirFabricante,
  rankearOfertas,
} from '../src/query/precios.js';

// --- Costo unitario final --------------------------------------------------

test('aplica bonificación, flete prorrateado e impuestos en ese orden', () => {
  const costo = calcularCostoUnitarioFinal({
    precioLista: 100,
    bonificacionPct: 10,
    fleteTotal: 360,
    unidadesDelEnvio: 36,
    impuestosPct: 21,
  });
  // 100 - 10% = 90 ; flete 360/36 = 10 ; (90 + 10) * 1.21 = 121.00
  assert.equal(costo, 121);
});

test('sin bonificación ni flete, el costo es el precio de lista con impuestos', () => {
  assert.equal(
    calcularCostoUnitarioFinal({ precioLista: 100, unidadesDelEnvio: 1, impuestosPct: 21 }),
    121,
  );
});

test('permite operaciones exentas de impuestos', () => {
  assert.equal(
    calcularCostoUnitarioFinal({ precioLista: 100, unidadesDelEnvio: 1, impuestosPct: 0 }),
    100,
  );
});

test('rechaza entradas que no tienen sentido en el dominio', () => {
  assert.throws(() => calcularCostoUnitarioFinal({ precioLista: -1 }), TypeError);
  assert.throws(
    () => calcularCostoUnitarioFinal({ precioLista: 100, unidadesDelEnvio: 0 }),
    TypeError,
  );
});

// --- Bonificación por volumen ----------------------------------------------

test('la bonificación por volumen es escalonada', () => {
  assert.equal(bonificacionPorVolumen(36), 0);
  assert.equal(bonificacionPorVolumen(108), 1.5);
  assert.equal(bonificacionPorVolumen(216), 3);
  assert.equal(bonificacionPorVolumen(540), 4.5);
  assert.equal(bonificacionPorVolumen(1080), 6);
});

// --- Costo por Watt --------------------------------------------------------

test('el costo por Watt vuelve comparables paneles de distinta potencia', () => {
  const panel550 = calcularCostoPorWatt(100, 550);
  const panel580 = calcularCostoPorWatt(110, 580);
  assert.equal(panel550, 0.18182);
  assert.equal(panel580, 0.18966);
  assert.ok(panel550 < panel580, 'el de 550 W es más barato por Watt pese a costar menos en total');
});

test('un producto sin potencia nominal no se compara por Watt', () => {
  assert.equal(calcularCostoPorWatt(100, null), null);
  assert.equal(calcularCostoPorWatt(100, 0), null);
});

// --- Ranking ---------------------------------------------------------------

const OFERTAS = [
  { fabricante: 'Trina Solar', costo_por_watt: 0.19, costo_unitario: 110, unidades_libres: 620, dias_de_entrega: 50 },
  { fabricante: 'Jinko Solar', costo_por_watt: 0.182, costo_unitario: 100, unidades_libres: 1840, dias_de_entrega: 45 },
  { fabricante: 'Longi', costo_por_watt: 0.175, costo_unitario: 95, unidades_libres: 0, dias_de_entrega: 40 },
];

test('el ranking excluye a los fabricantes sin stock', () => {
  const rankeadas = rankearOfertas(OFERTAS);
  assert.equal(rankeadas.length, 2);
  assert.ok(
    !rankeadas.some((o) => o.fabricante === 'Longi'),
    'Longi es el más barato pero no puede entregar',
  );
  assert.equal(rankeadas[0].fabricante, 'Jinko Solar');
});

test('los empates se resuelven de forma determinista', () => {
  const empatadas = [
    { fabricante: 'Zeta', costo_por_watt: 0.18, costo_unitario: 99, unidades_libres: 10, dias_de_entrega: 30 },
    { fabricante: 'Alfa', costo_por_watt: 0.18, costo_unitario: 99, unidades_libres: 10, dias_de_entrega: 30 },
  ];
  assert.equal(rankearOfertas(empatadas)[0].fabricante, 'Alfa');
  assert.equal(rankearOfertas([...empatadas].reverse())[0].fabricante, 'Alfa');
});

test('a igual costo por Watt gana el plazo de entrega más corto', () => {
  const ofertas = [
    { fabricante: 'Lenta', costo_por_watt: 0.18, costo_unitario: 99, unidades_libres: 10, dias_de_entrega: 60 },
    { fabricante: 'Rapida', costo_por_watt: 0.18, costo_unitario: 99, unidades_libres: 10, dias_de_entrega: 20 },
  ];
  assert.equal(rankearOfertas(ofertas)[0].fabricante, 'Rapida');
});

// --- Elección de fabricante ------------------------------------------------

test('por defecto elige el mejor costo por Watt', () => {
  const elegido = elegirFabricante(OFERTAS);
  assert.equal(elegido.oferta.fabricante, 'Jinko Solar');
  assert.equal(elegido.motivo, 'mejor_costo_por_watt');
});

test('respeta el fabricante preferido del cliente', () => {
  const elegido = elegirFabricante(OFERTAS, 'Trina Solar');
  assert.equal(elegido.oferta.fabricante, 'Trina Solar');
  assert.equal(elegido.motivo, 'fabricante_preferido');
});

test('si el fabricante preferido no tiene stock, cae al ranking', () => {
  const elegido = elegirFabricante(OFERTAS, 'Longi');
  assert.equal(elegido.oferta.fabricante, 'Jinko Solar');
  assert.equal(elegido.motivo, 'mejor_costo_por_watt');
});

test('devuelve null cuando ningún fabricante tiene stock', () => {
  assert.equal(elegirFabricante([{ ...OFERTAS[2] }]), null);
});

test('marca el caso de un único fabricante con stock', () => {
  const elegido = elegirFabricante([OFERTAS[1], OFERTAS[2]]);
  assert.equal(elegido.motivo, 'unico_con_stock');
});

// --- Clave de caché --------------------------------------------------------

test('dos consultas equivalentes comparten entrada de caché', () => {
  const a = claveDeCache({ q: 'Panel 550', orden: 'costo_por_watt_asc', pagina: 1 });
  const b = claveDeCache({ pagina: 1, orden: 'costo_por_watt_asc', q: 'panel 550 ' });
  assert.equal(a, b, 'el orden de los parámetros y el casing no deben partir la caché');
});

test('los parámetros vacíos no cambian la clave', () => {
  assert.equal(
    claveDeCache({ q: 'panel', fabricante: '' }),
    claveDeCache({ q: 'panel', fabricante: undefined }),
  );
});

test('consultas distintas no colisionan', () => {
  assert.notEqual(claveDeCache({ q: 'panel' }), claveDeCache({ q: 'inversor' }));
});
