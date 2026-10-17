// ---------------------------------------------------------------------------
// Tests del cliente HTTP de pricing-search-service y del circuit breaker.
//
// Sin infraestructura: un servidor HTTP local hace de pricing-search-service y
// cada test le dice cómo comportarse (responder, fallar, tardar). El circuito
// usa un reloj controlado para no esperar 30 s reales.
// Política verificada: docs/adr/ADR-005-comunicacion.md, flujos 1 y 4.
// ---------------------------------------------------------------------------

import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { crearServicioDePreciosHttp } from '../src/adapters/precios-http.js';
import { CircuitoAbierto, EstadosDelCircuito, crearCircuito } from '../src/adapters/circuito.js';

const COTIZACION = {
  cotizacion_id: '7f1c9d3e-5b42-4a1f-9d0e-2c7b8a6f4e11',
  estado: 'vigente',
  vigente_hasta: '2026-10-16T14:45:00Z',
  lineas: [{ sku: 'HEL-PAN-550-JKM', cantidad: 108, precio_unitario: { monto: '100.10', moneda: 'USD' } }],
  total: { monto: '10810.80', moneda: 'USD' },
};

const RANKING = {
  sku: 'HEL-PAN-550-JKM',
  fabricante: 'Jinko Solar',
  costo_unitario_final: 100.1,
  costo_por_watt: 0.182,
};

// --- Servidor falso --------------------------------------------------------

/** Cola de respuestas: cada pedido consume la siguiente; la última se repite. */
let guion = [];
let pedidos = [];

function responder(...pasos) {
  guion = pasos;
}

const servidor = http.createServer((req, res) => {
  pedidos.push({ url: req.url, cabeceras: req.headers });
  const paso = guion.length > 1 ? guion.shift() : guion[0];
  const enviar = () => {
    res.writeHead(paso.estado, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(paso.cuerpo ?? {}));
  };
  if (paso.demoraMs) setTimeout(enviar, paso.demoraMs);
  else enviar();
});

let urlBase;

before(async () => {
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  urlBase = `http://127.0.0.1:${servidor.address().port}`;
});

after(() => {
  servidor.closeAllConnections();
  return new Promise((resolve) => servidor.close(resolve));
});

beforeEach(() => {
  guion = [];
  pedidos = [];
});

/** Reloj manual para el circuito. */
function relojManual() {
  let ms = 0;
  return { ahora: () => ms, avanzar: (delta) => (ms += delta) };
}

function cliente({ reloj = relojManual(), timeoutMs = 200 } = {}) {
  const circuito = crearCircuito({ nombre: 'precios-test', ahora: reloj.ahora });
  return { precios: crearServicioDePreciosHttp({ urlBase, timeoutMs, circuito }), circuito, reloj };
}

// --- Flujo 1: cotización (esencial) ----------------------------------------

describe('obtenerCotizacion (flujo esencial)', () => {
  test('devuelve la cotización y propaga consumidor y correlación', async () => {
    responder({ estado: 200, cuerpo: COTIZACION });
    const { precios } = cliente();

    const cotizacion = await precios.obtenerCotizacion(COTIZACION.cotizacion_id, {
      consumidor: 'grupo-consumidor',
      correlationId: 'corr-123',
    });

    assert.deepEqual(cotizacion, COTIZACION);
    assert.equal(pedidos.length, 1);
    assert.equal(pedidos[0].url, `/v1/proveedor/cotizaciones/${COTIZACION.cotizacion_id}`);
    assert.equal(pedidos[0].cabeceras['x-consumer-username'], 'grupo-consumidor');
    assert.equal(pedidos[0].cabeceras['x-correlation-id'], 'corr-123');
  });

  test('404 es "no existe para este consumidor": null y sin reintento', async () => {
    responder({ estado: 404 });
    const { precios } = cliente();

    assert.equal(await precios.obtenerCotizacion('otra', { consumidor: 'x' }), null);
    assert.equal(pedidos.length, 1);
  });

  test('un 5xx aislado se reintenta una vez y la llamada se recupera', async () => {
    responder({ estado: 502 }, { estado: 200, cuerpo: COTIZACION });
    const { precios } = cliente();

    assert.deepEqual(await precios.obtenerCotizacion('c', { consumidor: 'x' }), COTIZACION);
    assert.equal(pedidos.length, 2);
  });

  test('dos 5xx seguidos: SERVICIO_NO_DISPONIBLE (503), con un solo reintento', async () => {
    responder({ estado: 500 });
    const { precios } = cliente();

    await assert.rejects(precios.obtenerCotizacion('c', { consumidor: 'x' }), {
      codigo: 'SERVICIO_NO_DISPONIBLE',
      status: 503,
    });
    assert.equal(pedidos.length, 2, 'intento + 1 reintento, no más');
  });

  test('un timeout cuenta como falla transitoria y se reintenta', async () => {
    responder({ estado: 200, cuerpo: COTIZACION, demoraMs: 300 });
    const { precios } = cliente({ timeoutMs: 50 });

    await assert.rejects(precios.obtenerCotizacion('c', { consumidor: 'x' }), {
      codigo: 'SERVICIO_NO_DISPONIBLE',
    });
    assert.equal(pedidos.length, 2);
  });

  test('un 4xx no se reintenta: reintentar no vuelve válido el pedido', async () => {
    responder({ estado: 422 });
    const { precios } = cliente();

    await assert.rejects(precios.obtenerCotizacion('c', { consumidor: 'x' }), { name: 'RespuestaInesperada' });
    assert.equal(pedidos.length, 1);
  });

  test('501 (pricing todavía sin implementar): 503 sin reintento y sin abrir el circuito', async () => {
    responder({ estado: 501 });
    const { precios, circuito } = cliente();

    for (let i = 0; i < 6; i++) {
      await assert.rejects(precios.obtenerCotizacion('c', { consumidor: 'x' }), {
        codigo: 'SERVICIO_NO_DISPONIBLE',
      });
    }
    assert.equal(pedidos.length, 6, 'un pedido por llamada, sin reintentos');
    assert.equal(circuito.estado, EstadosDelCircuito.CERRADO);
  });

  test('con pricing inalcanzable (conexión rechazada): 503', async () => {
    // Puerto 1: nada escucha ahí.
    const precios = crearServicioDePreciosHttp({ urlBase: 'http://127.0.0.1:1', timeoutMs: 200 });
    await assert.rejects(precios.obtenerCotizacion('c', { consumidor: 'x' }), {
      codigo: 'SERVICIO_NO_DISPONIBLE',
    });
  });
});

// --- Circuit breaker integrado ---------------------------------------------

describe('circuit breaker sobre pricing-search-service', () => {
  test('tras 5 llamadas fallidas se abre y falla rápido sin llamar', async () => {
    responder({ estado: 503 });
    const { precios, circuito } = cliente();

    for (let i = 0; i < 5; i++) {
      await assert.rejects(precios.obtenerCotizacion('c', { consumidor: 'x' }));
    }
    assert.equal(circuito.estado, EstadosDelCircuito.ABIERTO);
    assert.equal(pedidos.length, 10, '5 llamadas × (intento + reintento)');

    await assert.rejects(precios.obtenerCotizacion('c', { consumidor: 'x' }), {
      codigo: 'SERVICIO_NO_DISPONIBLE',
    });
    assert.equal(pedidos.length, 10, 'con el circuito abierto no sale ningún pedido');
  });

  test('a los 30 s deja pasar una prueba; si responde bien, se cierra', async () => {
    responder({ estado: 503 });
    const { precios, circuito, reloj } = cliente();
    for (let i = 0; i < 5; i++) await assert.rejects(precios.obtenerCotizacion('c', { consumidor: 'x' }));

    reloj.avanzar(29_999);
    await assert.rejects(precios.obtenerCotizacion('c', { consumidor: 'x' }));
    assert.equal(circuito.estado, EstadosDelCircuito.ABIERTO, 'antes de los 30 s sigue abierto');

    reloj.avanzar(1);
    responder({ estado: 200, cuerpo: COTIZACION });
    assert.deepEqual(await precios.obtenerCotizacion('c', { consumidor: 'x' }), COTIZACION);
    assert.equal(circuito.estado, EstadosDelCircuito.CERRADO);
  });

  test('si la prueba del half-open falla, vuelve a abrirse por otros 30 s', async () => {
    responder({ estado: 503 });
    const { precios, circuito, reloj } = cliente();
    for (let i = 0; i < 5; i++) await assert.rejects(precios.obtenerCotizacion('c', { consumidor: 'x' }));

    reloj.avanzar(30_000);
    const antes = pedidos.length;
    await assert.rejects(precios.obtenerCotizacion('c', { consumidor: 'x' }));
    assert.equal(pedidos.length, antes + 2, 'la prueba se intenta (con su reintento)');
    assert.equal(circuito.estado, EstadosDelCircuito.ABIERTO);

    await assert.rejects(precios.obtenerCotizacion('c', { consumidor: 'x' }));
    assert.equal(pedidos.length, antes + 2, 'y vuelve a fallar rápido');
  });

  test('los 404 y 4xx no abren el circuito: la dependencia está sana', async () => {
    responder({ estado: 404 });
    const { precios, circuito } = cliente();
    for (let i = 0; i < 10; i++) await precios.obtenerCotizacion('c', { consumidor: 'x' });
    assert.equal(circuito.estado, EstadosDelCircuito.CERRADO);
  });
});

describe('circuito (unidad)', () => {
  test('en half-open pasa UNA sola llamada de prueba; las concurrentes fallan rápido', async () => {
    const reloj = relojManual();
    const circuito = crearCircuito({ nombre: 't', umbralDeFallas: 1, ahora: reloj.ahora });
    await assert.rejects(circuito.ejecutar(async () => { throw new Error('caída'); }));
    reloj.avanzar(30_000);

    let liberar;
    const prueba = circuito.ejecutar(() => new Promise((resolve) => (liberar = resolve)));
    await assert.rejects(circuito.ejecutar(async () => 'no debería correr'), CircuitoAbierto);

    liberar('ok');
    assert.equal(await prueba, 'ok');
    assert.equal(circuito.estado, EstadosDelCircuito.CERRADO);
  });

  test('un éxito reinicia la cuenta de fallas consecutivas', async () => {
    const circuito = crearCircuito({ nombre: 't', umbralDeFallas: 3 });
    const fallar = () => circuito.ejecutar(async () => { throw new Error('x'); }).catch(() => {});
    await fallar();
    await fallar();
    await circuito.ejecutar(async () => 'ok');
    await fallar();
    await fallar();
    assert.equal(circuito.estado, EstadosDelCircuito.CERRADO, '2 + 2 no son 3 consecutivas');
  });

  test('notifica cada cambio de estado', async () => {
    const reloj = relojManual();
    const estados = [];
    const circuito = crearCircuito({
      nombre: 't',
      umbralDeFallas: 1,
      ahora: reloj.ahora,
      alCambiar: (e) => estados.push(e),
    });
    await assert.rejects(circuito.ejecutar(async () => { throw new Error('x'); }));
    reloj.avanzar(30_000);
    await circuito.ejecutar(async () => 'ok');
    assert.deepEqual(estados, ['abierto', 'semiabierto', 'cerrado']);
  });
});

// --- Flujo 4: ranking (conveniencia) ---------------------------------------

describe('mejorFabricantePorCostoPorWatt (flujo de conveniencia)', () => {
  test('traduce el ranking al formato del puerto, con origen ranking_vigente', async () => {
    responder({ estado: 200, cuerpo: RANKING });
    const { precios } = cliente();

    assert.deepEqual(await precios.mejorFabricantePorCostoPorWatt('HEL-PAN-550-JKM', { correlationId: 'c-9' }), {
      fabricante: 'Jinko Solar',
      costo_unitario: 100.1,
      costo_por_watt: 0.182,
      origen: 'ranking_vigente',
    });
    assert.equal(pedidos[0].url, '/interno/ranking/HEL-PAN-550-JKM');
    assert.equal(pedidos[0].cabeceras['x-correlation-id'], 'c-9');
  });

  test('si pricing falla, devuelve el último ranking conocido marcado como tal', async () => {
    const { precios } = cliente();
    responder({ estado: 200, cuerpo: RANKING });
    await precios.mejorFabricantePorCostoPorWatt('HEL-PAN-550-JKM');

    responder({ estado: 503 });
    const degradado = await precios.mejorFabricantePorCostoPorWatt('HEL-PAN-550-JKM');
    assert.equal(degradado.origen, 'ultimo_ranking_en_cache');
    assert.equal(degradado.fabricante, 'Jinko Solar');
  });

  test('sin ranking previo y con pricing caído: null, nunca una excepción', async () => {
    responder({ estado: 503 });
    const { precios } = cliente();
    assert.equal(await precios.mejorFabricantePorCostoPorWatt('HEL-PAN-580-TRN'), null);
  });

  test('con el circuito abierto tampoco lanza', async () => {
    responder({ estado: 503 });
    const { precios, circuito } = cliente();
    for (let i = 0; i < 5; i++) await assert.rejects(precios.obtenerCotizacion('c', { consumidor: 'x' }));
    assert.equal(circuito.estado, EstadosDelCircuito.ABIERTO);

    assert.equal(await precios.mejorFabricantePorCostoPorWatt('HEL-PAN-580-TRN'), null);
  });

  test('404 (nadie lo vende con stock): null, sin reintento', async () => {
    responder({ estado: 404 });
    const { precios } = cliente();
    assert.equal(await precios.mejorFabricantePorCostoPorWatt('HEL-PAN-580-TRN'), null);
    assert.equal(pedidos.length, 1);
  });
});
