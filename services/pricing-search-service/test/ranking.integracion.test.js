// ---------------------------------------------------------------------------
// Tests de integración contra un Elasticsearch real.
//
//   docker compose up -d elasticsearch
//   TEST_ELASTICSEARCH_URL=http://localhost:9200 npm run test:integracion
//
// Cada corrida usa un alias propio y descartable, así que no toca el índice
// que usa el servicio. Sin TEST_ELASTICSEARCH_URL se saltean.
// ---------------------------------------------------------------------------

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { crearClienteElasticsearch } from '../src/elasticsearch.js';
import { asegurarIndice } from '../src/projection/mapeo-indice.js';
import { PRODUCTOS_DEMO, cargarDatosDemo } from '../src/projection/datos-demo.js';
import { crearConsultaDeRanking } from '../src/query/ranking.js';

const URL_ES = process.env.TEST_ELASTICSEARCH_URL;

describe('índice de productos en Elasticsearch', { skip: !URL_ES && 'TEST_ELASTICSEARCH_URL no definida' }, () => {
  const alias = `helios-productos-test-${Date.now()}`;
  let es;

  before(() => {
    es = crearClienteElasticsearch({ url: URL_ES });
  });

  after(async () => {
    // Nombre exacto: Elasticsearch 8 no permite borrar índices con comodines.
    await es?.indices.delete({ index: `${alias}-v1` }).catch(() => {});
    await es?.close();
  });

  test('asegurarIndice crea el índice con su alias una sola vez, aun en paralelo', async () => {
    // Las dos instancias del servicio arrancan a la vez.
    const resultados = await Promise.all([asegurarIndice(es, { alias }), asegurarIndice(es, { alias })]);
    assert.deepEqual(resultados.sort(), [false, true]);
    assert.equal(await asegurarIndice(es, { alias }), false);
    assert.ok(await es.indices.existsAlias({ name: alias }));
  });

  test('el mapping es estricto: un campo no declarado se rechaza', async () => {
    await assert.rejects(
      es.index({ index: alias, id: 'HEL-PAN-000-XXX', document: { sku: 'HEL-PAN-000-XXX', campo_inventado: 1 } }),
      (err) => err.meta?.body?.error?.type === 'strict_dynamic_mapping_exception',
    );
  });

  test('la carga de demo es idempotente y no pisa lo que ya está indexado', async () => {
    assert.deepEqual(await cargarDatosDemo(es, { alias }), { creados: PRODUCTOS_DEMO.length, existentes: 0 });

    // Simula un documento ya actualizado por la proyección.
    await es.update({ index: alias, id: 'HEL-PAN-550-JKM', doc: { version: 7 }, refresh: 'wait_for' });

    assert.deepEqual(await cargarDatosDemo(es, { alias }), { creados: 0, existentes: PRODUCTOS_DEMO.length });
    const { _source } = await es.get({ index: alias, id: 'HEL-PAN-550-JKM' });
    assert.equal(_source.version, 7, 'la segunda carga no lo sobrescribió');
  });

  test('el ranking responde contra el índice real', async () => {
    const mejorFabricante = crearConsultaDeRanking({ es, alias });

    assert.deepEqual(await mejorFabricante('HEL-PAN-550-JKM'), {
      sku: 'HEL-PAN-550-JKM',
      fabricante: 'Jinko Solar',
      costo_unitario_final: 99.76,
      costo_por_watt: 0.18138,
      motivo: 'unico_con_stock',
    });
    assert.equal(await mejorFabricante('HEL-PAN-999-XXX'), null);
  });

  test('se puede ordenar el catálogo por mejor costo por Watt', async () => {
    const { hits } = await es.search({
      index: alias,
      query: { term: { tipo: 'panel' } },
      sort: [{ mejor_costo_por_watt: 'asc' }],
    });
    assert.deepEqual(
      hits.hits.map((h) => h._id),
      // 0,17567 < 0,18138 < 0,18714 USD/W
      ['HEL-PAN-540-LNG', 'HEL-PAN-550-JKM', 'HEL-PAN-580-TRN'],
    );
  });
});
