// ---------------------------------------------------------------------------
// Tests de integración de cotizaciones contra Elasticsearch y Redis reales.
//
//   docker compose up -d elasticsearch redis
//   TEST_ELASTICSEARCH_URL=http://localhost:9200 TEST_REDIS_URL=redis://localhost:6379 \
//     npm run test:integracion
//
// Usa un alias de índice descartable. Las cotizaciones de prueba se guardan con
// una retención corta y se borran al terminar.
// ---------------------------------------------------------------------------

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { crearClienteElasticsearch } from '../src/elasticsearch.js';
import { crearClienteRedis } from '../src/redis.js';
import { asegurarIndice } from '../src/projection/mapeo-indice.js';
import { cargarDatosDemo } from '../src/projection/datos-demo.js';
import { crearRepositorioDeCotizaciones } from '../src/query/repositorio-cotizaciones.js';
import { crearCotizaciones } from '../src/query/cotizaciones.js';

const URL_ES = process.env.TEST_ELASTICSEARCH_URL;
const URL_REDIS = process.env.TEST_REDIS_URL;
const FALTA = !URL_ES ? 'TEST_ELASTICSEARCH_URL no definida' : !URL_REDIS ? 'TEST_REDIS_URL no definida' : false;

describe('cotizaciones contra Elasticsearch y Redis', { skip: FALTA }, () => {
  const alias = `helios-productos-test-cot-${Date.now()}`;
  const emitidas = [];
  let es;
  let redis;
  let cotizaciones;

  before(async () => {
    es = crearClienteElasticsearch({ url: URL_ES });
    redis = crearClienteRedis({ url: URL_REDIS });
    await new Promise((resolve) => (redis.isReady ? resolve() : redis.once('ready', resolve)));

    await asegurarIndice(es, { alias });
    await cargarDatosDemo(es, { alias });
    cotizaciones = crearCotizaciones({
      es,
      alias,
      repositorio: crearRepositorioDeCotizaciones({ redis, segundosDeRetencion: 120 }),
    });
  });

  after(async () => {
    for (const id of emitidas) await redis?.del(`cotizacion:${id}`).catch(() => {});
    await redis?.quit().catch(() => {});
    await es?.indices.delete({ index: `${alias}-v1` }).catch(() => {});
    await es?.close();
  });

  test('cotiza contra el índice real, la guarda en Redis y la devuelve a su dueño', async () => {
    const cotizacion = await cotizaciones.cotizar(
      {
        destino: { provincia: 'Córdoba', localidad: 'Villa María' },
        lineas: [
          { sku: 'HEL-PAN-550-JKM', cantidad: 108 },
          { sku: 'HEL-INV-50K-SUN', cantidad: 2, fabricante_preferido: 'Sungrow' },
        ],
      },
      'grupo-consumidor',
    );
    emitidas.push(cotizacion.cotizacion_id);

    assert.equal(cotizacion.total.monto, '17251.88');
    assert.deepEqual(await cotizaciones.obtener(cotizacion.cotizacion_id, 'grupo-consumidor'), cotizacion);
    await assert.rejects(cotizaciones.obtener(cotizacion.cotizacion_id, 'otro-grupo'), { codigo: 'NO_ENCONTRADO' });
  });

  test('la clave en Redis tiene retención: no queda para siempre', async () => {
    const cotizacion = await cotizaciones.cotizar(
      { destino: { provincia: 'Salta', localidad: 'Salta' }, lineas: [{ sku: 'HEL-PAN-540-LNG', cantidad: 36 }] },
      'grupo-consumidor',
    );
    emitidas.push(cotizacion.cotizacion_id);

    const ttl = await redis.ttl(`cotizacion:${cotizacion.cotizacion_id}`);
    assert.ok(ttl > 0 && ttl <= 120, `TTL inesperado: ${ttl}`);
  });

  test('un SKU que no está en el índice se rechaza con 422', async () => {
    await assert.rejects(
      cotizaciones.cotizar(
        { destino: { provincia: 'Córdoba', localidad: 'x' }, lineas: [{ sku: 'HEL-PAN-999-XXX', cantidad: 1 }] },
        'grupo-consumidor',
      ),
      { codigo: 'SKU_DESCONTINUADO', status: 422 },
    );
  });

  test('con Redis inalcanzable, cotizar responde 503 en lugar de colgarse', async () => {
    const caido = crearClienteRedis({ url: 'redis://127.0.0.1:1' });
    const sinRedis = crearCotizaciones({ es, alias, repositorio: crearRepositorioDeCotizaciones({ redis: caido }) });
    const inicio = Date.now();
    try {
      await assert.rejects(
        sinRedis.cotizar(
          { destino: { provincia: 'Córdoba', localidad: 'x' }, lineas: [{ sku: 'HEL-PAN-550-JKM', cantidad: 36 }] },
          'grupo-consumidor',
        ),
        { codigo: 'SERVICIO_NO_DISPONIBLE', status: 503 },
      );
      assert.ok(Date.now() - inicio < 1000, 'falla rápido, sin esperar a que Redis vuelva');
    } finally {
      await caido.disconnect().catch(() => {});
    }
  });
});
