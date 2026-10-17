// ---------------------------------------------------------------------------
// Tests del caso de uso de reserva y de las rutas de pedidos, sin base.
//
// Verifican la orquestación (qué se llama, en qué orden, qué se responde), no
// las reglas de negocio (reserva.test.js) ni la transacción real
// (repositorio-postgres.integracion.test.js).
// ---------------------------------------------------------------------------

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { crearReservarPedido } from '../src/application/reservar-pedido.js';
import { crearObtenerPedido } from '../src/application/obtener-pedido.js';
import { ClaveIdempotenciaEnCarrera } from '../src/application/errores.js';
import { routerDePedidos } from '../src/http/rutas-pedidos.js';
import { middlewareDeErrores } from '../src/problema.js';

const AHORA = new Date('2026-10-17T12:00:00Z');
const COTIZACION_ID = '7f1c9d3e-5b42-4a1f-9d0e-2c7b8a6f4e11';
const CLAVE = '3d1a0d7c-8f52-4c64-9b6e-1f0a2e5c7d93';

const COTIZACION = {
  cotizacion_id: COTIZACION_ID,
  estado: 'vigente',
  vigente_hasta: '2026-10-17T12:15:00Z',
  lineas: [{ sku: 'HEL-PAN-540-LNG', cantidad: 108, precio_unitario: { monto: '100.00', moneda: 'USD' } }],
  total: { monto: '10800.00', moneda: 'USD' },
};

const CUERPO = { cotizacion_id: COTIZACION_ID, lineas: [{ sku: 'HEL-PAN-540-LNG', cantidad: 108 }] };

/**
 * Repositorio falso que registra cada llamada en `bitacora`. La existencia
 * deja 36 libres tras reservar 108 → por debajo del punto de reposición.
 */
function repositorioFalso({ bitacora, claves = new Map(), carrera = false } = {}) {
  return {
    async buscarClaveIdempotencia(clave) {
      bitacora.push('buscarClave');
      return claves.get(clave) ?? null;
    },
    async enTransaccion(trabajo) {
      bitacora.push('BEGIN');
      const tx = {
        async bloquearExistenciasPorSku() {
          return [
            {
              id: 3, producto_id: 3, sku: 'HEL-PAN-540-LNG', deposito_id: 1, deposito: 'DEP-CBA-01',
              cantidad_fisica: 144, cantidad_reservada: 0, stock_minimo: 108,
              punto_de_reposicion: 360, lote_de_reposicion: 720, multiplo_de_embalaje: 36,
            },
          ];
        },
        async obtenerCupoVigente() {
          return { unidades_usadas: 0, unidades_maximas: 5000 };
        },
        async crearReserva(datos) {
          return { id: 'c0a80101-9f1b-4d7a-8e2c-6b5f3a1d4e88', creado_en: AHORA, ...datos };
        },
        async comprometerStock() {},
        async registrarOrdenDeReposicion(orden) {
          bitacora.push(`orden:${orden.origen_del_precio}:${orden.fabricante_elegido}`);
        },
        async encolarEvento() {},
        async registrarClaveIdempotencia(registro) {
          if (carrera) {
            // Otra transacción registró la clave primero.
            claves.set(registro.clave, { ...registro, respuesta: { pedido_id: 'el-de-la-ganadora' } });
            throw new ClaveIdempotenciaEnCarrera(registro.clave);
          }
          claves.set(registro.clave, registro);
        },
      };
      try {
        const resultado = await trabajo(tx);
        bitacora.push('COMMIT');
        return resultado;
      } catch (err) {
        bitacora.push('ROLLBACK');
        throw err;
      }
    },
  };
}

function preciosFalsos({ bitacora, cotizacion = COTIZACION, ranking = null, rankingFalla = false } = {}) {
  return {
    async obtenerCotizacion() {
      bitacora.push('cotizacion');
      return cotizacion;
    },
    async mejorFabricantePorCostoPorWatt(sku) {
      bitacora.push(`ranking:${sku}`);
      if (rankingFalla) throw new Error('pricing caído');
      return ranking;
    },
  };
}

function reservar({ repositorio, precios }) {
  return crearReservarPedido({
    repositorio,
    precios,
    eventos: { vaciarOutboxEnSegundoPlano() {} },
    reloj: () => AHORA,
  });
}

// --- Caso de uso -------------------------------------------------------------

describe('reservarPedido', () => {
  test('el ranking se pide ANTES de abrir la transacción: ninguna llamada de red con filas bloqueadas', async () => {
    const bitacora = [];
    const ranking = { fabricante: 'Longi', costo_unitario: 94.86, costo_por_watt: 0.17567, origen: 'ranking_vigente' };
    await reservar({ repositorio: repositorioFalso({ bitacora }), precios: preciosFalsos({ bitacora, ranking }) })({
      consumidor: 'grupo-consumidor',
      claveIdempotencia: CLAVE,
      cuerpo: CUERPO,
    });

    const begin = bitacora.indexOf('BEGIN');
    assert.ok(bitacora.indexOf('ranking:HEL-PAN-540-LNG') < begin, bitacora.join(' → '));
    assert.ok(bitacora.indexOf('cotizacion') < begin);
    assert.ok(!bitacora.slice(begin).some((p) => p.startsWith('ranking') || p === 'cotizacion'));
    // Y el ranking obtenido se usa en la orden de reposición.
    assert.ok(bitacora.includes('orden:ranking_vigente:Longi'));
  });

  test('si el ranking falla, la reserva se completa y la orden sale sin fabricante', async () => {
    const bitacora = [];
    const { estado } = await reservar({
      repositorio: repositorioFalso({ bitacora }),
      precios: preciosFalsos({ bitacora, rankingFalla: true }),
    })({ consumidor: 'grupo-consumidor', claveIdempotencia: CLAVE, cuerpo: CUERPO });

    assert.equal(estado, 201);
    assert.ok(bitacora.includes('orden:sin_ranking:null'));
    assert.ok(bitacora.includes('COMMIT'));
  });

  test('una cotización inexistente o ajena es COTIZACION_EXPIRADA (409), como dice el contrato', async () => {
    const bitacora = [];
    await assert.rejects(
      reservar({ repositorio: repositorioFalso({ bitacora }), precios: preciosFalsos({ bitacora, cotizacion: null }) })({
        consumidor: 'grupo-consumidor',
        claveIdempotencia: CLAVE,
        cuerpo: CUERPO,
      }),
      { codigo: 'COTIZACION_EXPIRADA', status: 409 },
    );
    assert.ok(!bitacora.includes('BEGIN'), 'ni siquiera abre la transacción');
  });

  test('si pierde la carrera de la clave de idempotencia, responde lo mismo que la ganadora', async () => {
    const bitacora = [];
    const resultado = await reservar({
      repositorio: repositorioFalso({ bitacora, carrera: true }),
      precios: preciosFalsos({ bitacora }),
    })({ consumidor: 'grupo-consumidor', claveIdempotencia: CLAVE, cuerpo: CUERPO });

    assert.equal(resultado.repetida, true);
    assert.deepEqual(resultado.cuerpo, { pedido_id: 'el-de-la-ganadora' });
    assert.ok(bitacora.includes('ROLLBACK'));
  });

  test('la respuesta informa el depósito de cada línea', async () => {
    const bitacora = [];
    const { cuerpo } = await reservar({ repositorio: repositorioFalso({ bitacora }), precios: preciosFalsos({ bitacora }) })({
      consumidor: 'grupo-consumidor',
      claveIdempotencia: CLAVE,
      cuerpo: CUERPO,
    });
    assert.equal(cuerpo.lineas[0].deposito, 'DEP-CBA-01');
  });
});

// --- Rutas -------------------------------------------------------------------

describe('rutas de pedidos', () => {
  let servidor;
  let base;
  const RESERVA_GUARDADA = {
    id: 'c0a80101-9f1b-4d7a-8e2c-6b5f3a1d4e88',
    consumidor: 'grupo-consumidor',
    cotizacion_id: COTIZACION_ID,
    referencia_externa: null,
    estado: 'reservado',
    moneda: 'USD',
    total: '10800.00',
    creado_en: AHORA,
    expira_en: new Date('2026-10-17T12:15:00Z'),
    lineas: [{ sku: 'HEL-PAN-540-LNG', cantidad: 108, deposito: 'DEP-CBA-01', precio_unitario_congelado: '100.00', subtotal: '10800.00' }],
  };

  before(async () => {
    const bitacora = [];
    const repositorio = {
      ...repositorioFalso({ bitacora }),
      async obtenerReserva(id) {
        return id === RESERVA_GUARDADA.id ? RESERVA_GUARDADA : null;
      },
    };
    const app = express();
    app.use(express.json());
    app.use(
      '/v1',
      routerDePedidos({
        consultarDisponibilidad: async () => ({}),
        reservarPedido: reservar({ repositorio, precios: preciosFalsos({ bitacora }) }),
        obtenerPedido: crearObtenerPedido({ repositorio }),
      }),
    );
    app.use(middlewareDeErrores({ error() {} }));
    servidor = app.listen(0);
    await new Promise((resolve) => servidor.once('listening', resolve));
    base = `http://127.0.0.1:${servidor.address().port}/v1/pedidos`;
  });

  after(() => new Promise((resolve) => servidor.close(resolve)));

  function postReservar(cuerpo, { clave = CLAVE, consumidor = 'grupo-consumidor' } = {}) {
    return fetch(`${base}/reservar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(clave ? { 'Idempotency-Key': clave } : {}),
        ...(consumidor ? { 'X-Consumer-Username': consumidor } : {}),
      },
      body: JSON.stringify(cuerpo),
    });
  }

  test('201 con Location e Idempotency-Replayed; el reintento responde lo mismo marcado como repetición', async () => {
    const primera = await postReservar(CUERPO);
    assert.equal(primera.status, 201);
    const pedido = await primera.json();
    assert.equal(primera.headers.get('location'), `/v1/pedidos/${pedido.pedido_id}`);
    assert.equal(primera.headers.get('idempotency-replayed'), 'false');

    const reintento = await postReservar(CUERPO);
    assert.equal(reintento.status, 201);
    assert.equal(reintento.headers.get('idempotency-replayed'), 'true');
    assert.deepEqual(await reintento.json(), pedido);
  });

  test('misma clave con otro cuerpo: 409 CLAVE_IDEMPOTENCIA_REUSADA', async () => {
    await postReservar(CUERPO);
    const res = await postReservar({ ...CUERPO, referencia_externa: 'OTRA' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).codigo, 'CLAVE_IDEMPOTENCIA_REUSADA');
  });

  test('sin Idempotency-Key: 400 nombrando el header', async () => {
    const res = await postReservar(CUERPO, { clave: null });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).errores_de_validacion[0].campo, 'Idempotency-Key');
  });

  test('sin consumidor identificado: 401', async () => {
    assert.equal((await postReservar(CUERPO, { consumidor: null })).status, 401);
  });

  for (const [descripcion, cuerpo, campo] of [
    ['sin cotizacion_id', { lineas: CUERPO.lineas }, 'cotizacion_id'],
    ['sin líneas', { cotizacion_id: COTIZACION_ID, lineas: [] }, 'lineas'],
    ['cantidad decimal', { cotizacion_id: COTIZACION_ID, lineas: [{ sku: 'HEL-PAN-540-LNG', cantidad: 1.5 }] }, 'lineas[0].cantidad'],
    ['referencia demasiado larga', { ...CUERPO, referencia_externa: 'x'.repeat(65) }, 'referencia_externa'],
  ]) {
    test(`400 ${descripcion}, nombrando el campo`, async () => {
      const res = await postReservar(cuerpo, { clave: crypto.randomUUID() });
      assert.equal(res.status, 400);
      assert.deepEqual((await res.json()).errores_de_validacion.map((e) => e.campo), [campo]);
    });
  }

  test('GET del pedido para su dueño, con la forma del contrato', async () => {
    const res = await fetch(`${base}/${RESERVA_GUARDADA.id}`, { headers: { 'X-Consumer-Username': 'grupo-consumidor' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      pedido_id: RESERVA_GUARDADA.id,
      estado: 'reservado',
      cotizacion_id: COTIZACION_ID,
      referencia_externa: null,
      lineas: [
        {
          sku: 'HEL-PAN-540-LNG',
          cantidad: 108,
          deposito: 'DEP-CBA-01',
          precio_unitario_congelado: { monto: '100.00', moneda: 'USD' },
          subtotal: { monto: '10800.00', moneda: 'USD' },
        },
      ],
      total: { monto: '10800.00', moneda: 'USD' },
      creado_en: '2026-10-17T12:00:00.000Z',
      expira_en: '2026-10-17T12:15:00.000Z',
    });
  });

  test('GET del pedido de otro consumidor, o con un id que no es UUID: 404', async () => {
    const ajeno = await fetch(`${base}/${RESERVA_GUARDADA.id}`, { headers: { 'X-Consumer-Username': 'otro' } });
    assert.equal(ajeno.status, 404);
    const malFormado = await fetch(`${base}/123`, { headers: { 'X-Consumer-Username': 'grupo-consumidor' } });
    assert.equal(malFormado.status, 404);
  });
});
