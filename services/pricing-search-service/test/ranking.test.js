// ---------------------------------------------------------------------------
// Tests del proyector, de la consulta de ranking y de GET /interno/ranking/:sku.
//
// Sin infraestructura: Elasticsearch se reemplaza por un doble que devuelve
// documentos o lanza los mismos errores que el cliente oficial. Contra un
// Elasticsearch real: ranking.integracion.test.js.
// ---------------------------------------------------------------------------

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { errors } from '@elastic/elasticsearch';

import { documentoDeProducto } from '../src/projection/proyector.js';
import { crearConsultaDeRanking } from '../src/query/ranking.js';
import { routerInterno } from '../src/http/rutas-internas.js';
import { middlewareDeErrores } from '../src/problema.js';

const FICHA_PANEL = {
  sku: 'HEL-PAN-550-JKM',
  tipo: 'panel',
  modelo: 'Tiger Neo 550W Bifacial',
  potencia_w: 550,
  tecnologia_celda: 'topcon',
  certificaciones: ['CE'],
  multiplo_de_embalaje: 36,
};

function oferta(overrides = {}) {
  return {
    fabricante: 'Jinko Solar',
    moneda: 'USD',
    precio_lista: 85,
    bonificacion_base_pct: 3,
    unidades_libres: 1840,
    dias_de_entrega: 45,
    ...overrides,
  };
}

// --- Proyector -------------------------------------------------------------

describe('documentoDeProducto', () => {
  test('calcula el costo de referencia: lista − bonificación base + IVA, sin flete', () => {
    const doc = documentoDeProducto({ ficha: FICHA_PANEL, ofertas: [oferta()] });
    // 85 × (1 − 0,03) × 1,21 = 99,7645 → 99,76
    assert.equal(doc.ofertas[0].costo_unitario_final, 99.76);
    assert.equal(doc.ofertas[0].costo_por_watt, 0.18138);
    assert.equal(doc.mejor_costo_por_watt, 0.18138);
  });

  test('el mejor costo por Watt ignora a quien no tiene stock, aunque sea más barato', () => {
    const doc = documentoDeProducto({
      ficha: FICHA_PANEL,
      ofertas: [
        oferta({ fabricante: 'Barato Sin Stock', precio_lista: 50, unidades_libres: 0 }),
        oferta(),
      ],
    });
    assert.equal(doc.mejor_costo_por_watt, 0.18138);
    assert.equal(doc.unidades_libres_total, 1840);
  });

  test('sin ofertas con stock no hay mejor costo por Watt', () => {
    const doc = documentoDeProducto({ ficha: FICHA_PANEL, ofertas: [oferta({ unidades_libres: 0 })] });
    assert.equal(doc.mejor_costo_por_watt, null);
  });

  test('un producto sin potencia no tiene costo por Watt', () => {
    const doc = documentoDeProducto({
      ficha: { ...FICHA_PANEL, sku: 'HEL-EST-001-XXX', tipo: 'estructura', potencia_w: null },
      ofertas: [oferta()],
    });
    assert.equal(doc.ofertas[0].costo_por_watt, null);
    assert.equal(doc.mejor_costo_por_watt, null);
  });

  test('registra cuándo se proyectó', () => {
    const ahora = new Date('2026-10-17T12:00:00Z');
    assert.equal(documentoDeProducto({ ficha: FICHA_PANEL, ofertas: [], ahora }).proyectado_en, ahora.toISOString());
  });
});

// --- Consulta de ranking ------------------------------------------------------

/** Doble de Elasticsearch: `get` devuelve el documento indicado o lanza. */
function esFalso(documentos, { falla } = {}) {
  return {
    async get({ id }) {
      if (falla) throw falla;
      if (!documentos[id]) {
        throw new errors.ResponseError({ statusCode: 404, body: { found: false }, headers: {}, warnings: null, meta: {} });
      }
      return { _source: documentos[id] };
    },
  };
}

const DOCUMENTO = documentoDeProducto({
  ficha: FICHA_PANEL,
  ofertas: [
    oferta({ fabricante: 'Jinko Solar', precio_lista: 85 }),
    oferta({ fabricante: 'Distribuidor B', precio_lista: 83 }),
    oferta({ fabricante: 'Distribuidor C', precio_lista: 70, unidades_libres: 0 }),
  ],
});

describe('consulta de ranking', () => {
  test('elige el mejor costo por Watt entre las ofertas con stock', async () => {
    const mejorFabricante = crearConsultaDeRanking({ es: esFalso({ 'HEL-PAN-550-JKM': DOCUMENTO }) });

    assert.deepEqual(await mejorFabricante('HEL-PAN-550-JKM'), {
      sku: 'HEL-PAN-550-JKM',
      fabricante: 'Distribuidor B', // C es más barato pero no tiene stock
      costo_unitario_final: 97.42, // 83 × 0,97 × 1,21 = 97,4171
      costo_por_watt: 0.17713,
      motivo: 'mejor_costo_por_watt',
    });
  });

  test('producto no indexado: null', async () => {
    const mejorFabricante = crearConsultaDeRanking({ es: esFalso({}) });
    assert.equal(await mejorFabricante('HEL-PAN-999-XXX'), null);
  });

  test('nadie lo vende con stock: null', async () => {
    const sinStock = documentoDeProducto({ ficha: FICHA_PANEL, ofertas: [oferta({ unidades_libres: 0 })] });
    const mejorFabricante = crearConsultaDeRanking({ es: esFalso({ 'HEL-PAN-550-JKM': sinStock }) });
    assert.equal(await mejorFabricante('HEL-PAN-550-JKM'), null);
  });

  test('Elasticsearch caído: SERVICIO_NO_DISPONIBLE', async () => {
    const mejorFabricante = crearConsultaDeRanking({
      es: esFalso({}, { falla: new errors.ConnectionError('connect ECONNREFUSED') }),
    });
    await assert.rejects(mejorFabricante('HEL-PAN-550-JKM'), { codigo: 'SERVICIO_NO_DISPONIBLE', status: 503 });
  });

  test('un error que no es de disponibilidad se propaga tal cual (termina en 500)', async () => {
    const mejorFabricante = crearConsultaDeRanking({ es: esFalso({}, { falla: new TypeError('bug') }) });
    await assert.rejects(mejorFabricante('HEL-PAN-550-JKM'), TypeError);
  });
});

// --- Ruta HTTP ---------------------------------------------------------------

describe('GET /interno/ranking/:sku', () => {
  let servidor;
  let base;
  let falla = null;

  before(async () => {
    const app = express();
    const mejorFabricante = crearConsultaDeRanking({
      es: {
        get: (args) => esFalso({ 'HEL-PAN-550-JKM': DOCUMENTO }, { falla }).get(args),
      },
    });
    app.use(routerInterno({ mejorFabricante }));
    app.use(middlewareDeErrores({ error() {} }));
    servidor = app.listen(0);
    await new Promise((resolve) => servidor.once('listening', resolve));
    base = `http://127.0.0.1:${servidor.address().port}/interno/ranking`;
  });

  after(() => new Promise((resolve) => servidor.close(resolve)));

  test('200 con el formato que espera stock-service', async () => {
    const res = await fetch(`${base}/HEL-PAN-550-JKM`);
    assert.equal(res.status, 200);
    const cuerpo = await res.json();
    for (const campo of ['sku', 'fabricante', 'costo_unitario_final', 'costo_por_watt']) {
      assert.ok(campo in cuerpo, `falta ${campo}`);
    }
  });

  test('404 problem+json si nadie lo vende con stock', async () => {
    const res = await fetch(`${base}/HEL-PAN-999-XXX`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).codigo, 'NO_ENCONTRADO');
  });

  test('400 con un SKU fuera del formato canónico', async () => {
    const res = await fetch(`${base}/jkm550`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).errores_de_validacion[0].campo, 'sku');
  });

  test('503 con Retry-After si el índice no está disponible', async () => {
    falla = new errors.ConnectionError('connect ECONNREFUSED');
    try {
      const res = await fetch(`${base}/HEL-PAN-550-JKM`);
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('retry-after'), '5');
    } finally {
      falla = null;
    }
  });
});
