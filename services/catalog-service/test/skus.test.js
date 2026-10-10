// ---------------------------------------------------------------------------
// Tests de las reglas de identidad del catálogo unificado.
//
//   npm test   (desde services/catalog-service)
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  abreviarFabricante,
  construirSku,
  esSkuCanonico,
  normalizarCodigoDeFabricante,
} from '../src/application/skus.js';

// --- Normalización de códigos de fabricante -------------------------------

test('el mismo código escrito de distintas formas normaliza igual', () => {
  const esperado = 'JKM550N-72HL4-BDV';
  for (const variante of [
    'JKM550N-72HL4-BDV',
    '  jkm550n-72hl4-bdv  ',
    'JKM550N 72HL4 BDV',
    'JKM550N_72HL4/BDV',
    'JKM550N--72HL4---BDV',
    'JKM550N-72HL4-BDV.',
  ]) {
    assert.equal(normalizarCodigoDeFabricante(variante), esperado, `falló con: "${variante}"`);
  }
});

test('códigos realmente distintos no se confunden', () => {
  assert.notEqual(
    normalizarCodigoDeFabricante('JKM550N-72HL4-BDV'),
    normalizarCodigoDeFabricante('JKM545N-72HL4-BDV'),
  );
});

test('una entrada que no es texto no rompe el pipeline de importación', () => {
  assert.equal(normalizarCodigoDeFabricante(null), '');
  assert.equal(normalizarCodigoDeFabricante(undefined), '');
  assert.equal(normalizarCodigoDeFabricante(42), '');
});

// --- Formato del SKU canónico ---------------------------------------------

test('reconoce los SKUs canónicos de Helios', () => {
  assert.equal(esSkuCanonico('HEL-PAN-550-JKM'), true);
  assert.equal(esSkuCanonico('HEL-INV-50K-SUN'), true);
});

test('rechaza lo que no cumple el formato del contrato', () => {
  assert.equal(esSkuCanonico('hel-pan-550-jkm'), false, 'el formato es en mayúsculas');
  assert.equal(esSkuCanonico('PAN-550-JKM'), false, 'falta el prefijo HEL');
  assert.equal(esSkuCanonico('HEL-PANEL-550-JKM'), false, 'el tipo son tres letras');
  assert.equal(esSkuCanonico(''), false);
  assert.equal(esSkuCanonico(undefined), false);
});

// --- Construcción del SKU --------------------------------------------------

test('los paneles se nombran por su potencia en Watts', () => {
  const sku = construirSku({ tipo: 'panel', potenciaW: 550, fabricante: 'Jinko Solar' });
  assert.equal(sku, 'HEL-PAN-550-JNK');
  assert.equal(esSkuCanonico(sku), true);
});

test('los inversores se nombran en kW', () => {
  const sku = construirSku({ tipo: 'inversor', potenciaW: 50000, fabricante: 'Sungrow' });
  assert.equal(sku, 'HEL-INV-50K-SNG');
  assert.equal(esSkuCanonico(sku), true);
});

test('la abreviatura del fabricante ignora la razón social', () => {
  assert.equal(
    abreviarFabricante('Jinko Solar'),
    abreviarFabricante('Jinko Solar Co. Ltd.'),
    'el mismo fabricante no puede generar dos marcas distintas',
  );
});

test('un fabricante corto o lleno de vocales igual da tres caracteres', () => {
  assert.equal(abreviarFabricante('Aiko').length, 3);
  assert.equal(abreviarFabricante('Ja').length, 3);
});

test('rechaza datos con los que no se puede construir un SKU', () => {
  assert.throws(() => construirSku({ tipo: 'modulo', potenciaW: 550, fabricante: 'X' }), TypeError);
  assert.throws(() => construirSku({ tipo: 'panel', potenciaW: 0, fabricante: 'X' }), TypeError);
  assert.throws(() => construirSku({ tipo: 'panel', potenciaW: 550, fabricante: '' }), TypeError);
});
