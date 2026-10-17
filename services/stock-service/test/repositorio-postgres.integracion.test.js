// ---------------------------------------------------------------------------
// Tests de integración del adaptador PostgreSQL.
//
// A diferencia de reserva.test.js, éstos SÍ necesitan una base: verifican que
// las garantías que el caso de uso da por sentadas (bloqueo, atomicidad,
// idempotencia, invariantes del esquema) se cumplen de verdad en PostgreSQL.
//
//   docker compose up -d postgres-stock
//   TEST_DATABASE_URL=postgres://helios:helios_dev@localhost:5434/helios_stock \
//     npm run test:integracion
//
// Cada corrida crea una base descartable, le aplica db/init/*.sql (el mismo
// esquema y los mismos datos de demo que usa docker compose) y la borra al
// terminar. Sin TEST_DATABASE_URL los tests se saltean y `npm test` sigue
// corriendo sin infraestructura.
// ---------------------------------------------------------------------------

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { crearRepositorioPostgres } from '../src/adapters/repositorio-postgres.js';
import { crearReservarPedido } from '../src/application/reservar-pedido.js';

const URL_ADMIN = process.env.TEST_DATABASE_URL;
const DIR_INIT = new URL('../db/init/', import.meta.url);

describe('repositorio PostgreSQL', { skip: !URL_ADMIN && 'TEST_DATABASE_URL no definida' }, () => {
  const nombreBase = `helios_stock_test_${Date.now()}`;
  let admin;
  let pool;
  let repositorio;

  before(async () => {
    admin = new pg.Pool({ connectionString: URL_ADMIN, max: 1 });
    await admin.query(`create database ${nombreBase}`);

    const url = new URL(URL_ADMIN);
    url.pathname = `/${nombreBase}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 20 });

    const scripts = (await readdir(DIR_INIT)).filter((f) => f.endsWith('.sql')).sort();
    for (const script of scripts) {
      await pool.query(await readFile(new URL(script, DIR_INIT), 'utf8'));
    }

    repositorio = crearRepositorioPostgres({
      urlDeConexion: url.toString(),
      depositoAsignado: 'DEP-CBA-01',
      cupoUnidadesPorCliente: 5000,
    });
  });

  after(async () => {
    await repositorio?.cerrar();
    await pool?.end();
    await admin?.query(`drop database if exists ${nombreBase} with (force)`);
    await admin?.end();
  });

  /** Lee una existencia del depósito asignado, fuera de toda transacción. */
  async function existencia(sku) {
    const { rows } = await pool.query(
      `select e.* from stock.existencia e join stock.deposito d on d.id = e.deposito_id
        where e.sku = $1 and d.codigo = 'DEP-CBA-01'`,
      [sku],
    );
    return rows[0];
  }

  /** Arma el caso de uso real con dobles de precios y eventos. */
  function reservarPedidoCon({ cotizacion }) {
    return crearReservarPedido({
      repositorio,
      precios: {
        obtenerCotizacion: async () => cotizacion,
        mejorFabricantePorCostoPorWatt: async () => null,
      },
      eventos: { vaciarOutboxEnSegundoPlano: () => {} },
    });
  }

  function cotizacionDe(sku, cantidad, precio = 100) {
    return {
      cotizacion_id: randomUUID(),
      estado: 'vigente',
      vigente_hasta: new Date(Date.now() + 10 * 60_000).toISOString(),
      lineas: [{ sku, cantidad, precio_unitario: { monto: precio.toFixed(2), moneda: 'USD' } }],
      total: { monto: (precio * cantidad).toFixed(2), moneda: 'USD' },
    };
  }

  // --- Bloqueo de existencias ---------------------------------------------

  test('bloquea sólo las existencias del depósito asignado, en orden estable', async () => {
    const filas = await repositorio.enTransaccion((tx) =>
      tx.bloquearExistenciasPorSku(['HEL-PAN-580-TRN', 'HEL-PAN-550-JKM']),
    );

    // HEL-PAN-550-JKM también existe en DEP-BUE-01: no tiene que aparecer.
    assert.deepEqual(
      filas.map((f) => f.sku),
      ['HEL-PAN-550-JKM', 'HEL-PAN-580-TRN'],
    );
    assert.equal(typeof filas[0].id, 'number', 'los bigint llegan como number');
    assert.equal(typeof filas[0].producto_id, 'number');
  });

  test('un SKU sin existencias en el depósito no devuelve filas', async () => {
    const filas = await repositorio.enTransaccion((tx) => tx.bloquearExistenciasPorSku(['HEL-NO-EXISTE']));
    assert.deepEqual(filas, []);
  });

  // --- Lectura informativa ---------------------------------------------------

  test('existenciaPorSku lee la existencia del depósito asignado sin bloquearla', async () => {
    // Una transacción ajena bloquea la fila con FOR UPDATE y no la suelta.
    const bloqueante = await pool.connect();
    try {
      await bloqueante.query('begin');
      await bloqueante.query(`select 1 from stock.existencia where sku = 'HEL-PAN-550-JKM' for update`);

      // La lectura informativa no espera el lock: si lo esperara, este test se colgaría.
      const fila = await repositorio.existenciaPorSku('HEL-PAN-550-JKM');
      assert.deepEqual(fila, {
        sku: 'HEL-PAN-550-JKM',
        cantidad_fisica: 1840, // DEP-CBA-01; DEP-BUE-01 tiene 900 y no se suma
        cantidad_reservada: 0,
        multiplo_de_embalaje: 36,
      });
    } finally {
      await bloqueante.query('rollback');
      bloqueante.release();
    }
    assert.equal(await repositorio.existenciaPorSku('HEL-PAN-999-XXX'), null);
  });

  // --- Reserva de punta a punta contra la base -----------------------------

  test('una reserva aprobada persiste reserva, líneas, stock, libro mayor, outbox e idempotencia', async () => {
    const antes = await existencia('HEL-PAN-550-JKM');
    const clave = randomUUID();
    const cuerpo = { cotizacion_id: randomUUID(), lineas: [{ sku: 'HEL-PAN-550-JKM', cantidad: 108 }] };
    const reservar = reservarPedidoCon({ cotizacion: cotizacionDe('HEL-PAN-550-JKM', 108, 100.1) });

    const { estado, cuerpo: respuesta, repetida } = await reservar({
      consumidor: 'grupo-consumidor-a',
      claveIdempotencia: clave,
      cuerpo,
    });

    assert.equal(estado, 201);
    assert.equal(repetida, false);
    assert.equal(respuesta.total.monto, '10810.80');

    const despues = await existencia('HEL-PAN-550-JKM');
    assert.equal(despues.cantidad_reservada, antes.cantidad_reservada + 108);
    assert.equal(despues.cantidad_fisica, antes.cantidad_fisica, 'R4.13: reservar no baja el físico');

    const { rows: lineas } = await pool.query(
      'select sku, cantidad, precio_unitario_congelado from stock.reserva_linea where reserva_id = $1',
      [respuesta.pedido_id],
    );
    assert.deepEqual(lineas, [{ sku: 'HEL-PAN-550-JKM', cantidad: 108, precio_unitario_congelado: '100.10' }]);

    const { rows: asientos } = await pool.query(
      'select tipo, cantidad from stock.movimiento_stock where reserva_id = $1',
      [respuesta.pedido_id],
    );
    assert.deepEqual(asientos, [{ tipo: 'reserva', cantidad: 108 }]);

    const { rows: eventos } = await pool.query(
      `select tipo from stock.outbox_evento where clave_agregado = $1`,
      [respuesta.pedido_id],
    );
    assert.deepEqual(eventos, [{ tipo: 'pedido.reservado' }]);

    // Reintento con la misma clave y el mismo cuerpo: misma respuesta, sin efecto.
    const reintento = await reservar({ consumidor: 'grupo-consumidor-a', claveIdempotencia: clave, cuerpo });
    assert.equal(reintento.repetida, true);
    assert.deepEqual(reintento.cuerpo, JSON.parse(JSON.stringify(respuesta)));
    assert.equal((await existencia('HEL-PAN-550-JKM')).cantidad_reservada, despues.cantidad_reservada);
  });

  test('una reserva rechazada por el dominio no deja nada escrito', async () => {
    const antes = await existencia('HEL-PAN-580-TRN');
    const { rows: [{ n: reservasAntes }] } = await pool.query('select count(*)::int as n from stock.reserva');

    // 100 unidades con pallet de 31: CANTIDAD_NO_MULTIPLO_EMBALAJE.
    const reservar = reservarPedidoCon({ cotizacion: cotizacionDe('HEL-PAN-580-TRN', 100) });
    await assert.rejects(
      reservar({
        consumidor: 'grupo-consumidor-a',
        claveIdempotencia: randomUUID(),
        cuerpo: { cotizacion_id: randomUUID(), lineas: [{ sku: 'HEL-PAN-580-TRN', cantidad: 100 }] },
      }),
      { codigo: 'CANTIDAD_NO_MULTIPLO_EMBALAJE' },
    );

    assert.equal((await existencia('HEL-PAN-580-TRN')).cantidad_reservada, antes.cantidad_reservada);
    const { rows: [{ n: reservasDespues }] } = await pool.query('select count(*)::int as n from stock.reserva');
    assert.equal(reservasDespues, reservasAntes);
  });

  // --- Atomicidad e invariantes -------------------------------------------

  test('si el trabajo falla a mitad de camino, la transacción se revierte completa', async () => {
    const antes = await existencia('HEL-INV-50K-SUN');

    await assert.rejects(
      repositorio.enTransaccion(async (tx) => {
        const [fila] = await tx.bloquearExistenciasPorSku(['HEL-INV-50K-SUN']);
        await tx.comprometerStock({ existencia_id: fila.id, cantidad: 2, reserva_id: null });
        throw new Error('falla simulada después de comprometer stock');
      }),
      /falla simulada/,
    );

    const despues = await existencia('HEL-INV-50K-SUN');
    assert.equal(despues.cantidad_reservada, antes.cantidad_reservada);
    const { rows } = await pool.query(
      `select count(*)::int as n from stock.movimiento_stock where existencia_id = $1 and tipo = 'reserva'`,
      [antes.id],
    );
    assert.equal(rows[0].n, 0, 'tampoco queda el asiento del libro mayor');
  });

  test('la base impide comprometer más de lo que hay, aunque la aplicación lo intente', async () => {
    const fila = await existencia('HEL-INV-36K-HWI'); // 18 físicas

    await assert.rejects(
      repositorio.enTransaccion((tx) =>
        tx.comprometerStock({ existencia_id: fila.id, cantidad: fila.cantidad_fisica + 1, reserva_id: null }),
      ),
      { code: '23514', constraint: 'existencia_sin_sobreventa' },
    );
    assert.equal((await existencia('HEL-INV-36K-HWI')).cantidad_reservada, fila.cantidad_reservada);
  });

  test('liberar stock lo devuelve y deja un asiento negativo', async () => {
    const fila = await existencia('HEL-INV-36K-HWI');

    await repositorio.enTransaccion(async (tx) => {
      await tx.comprometerStock({ existencia_id: fila.id, cantidad: 4, reserva_id: null });
      await tx.liberarStock({ existencia_id: fila.id, cantidad: 4, reserva_id: null });
    });

    assert.equal((await existencia('HEL-INV-36K-HWI')).cantidad_reservada, fila.cantidad_reservada);
    const { rows } = await pool.query(
      `select tipo, cantidad from stock.movimiento_stock
        where existencia_id = $1 and tipo in ('reserva', 'liberacion') order by id`,
      [fila.id],
    );
    assert.deepEqual(rows, [
      { tipo: 'reserva', cantidad: 4 },
      { tipo: 'liberacion', cantidad: -4 },
    ]);
  });

  // --- Concurrencia --------------------------------------------------------

  test('N reservas concurrentes sobre la misma existencia: sólo pasan las que el stock permite', async () => {
    // HEL-PAN-540-LNG tiene 144 físicas y pallet de 36: entra UNA reserva de 108.
    const antes = await existencia('HEL-PAN-540-LNG');
    assert.equal(antes.cantidad_fisica - antes.cantidad_reservada, 144);

    const reservar = reservarPedidoCon({ cotizacion: cotizacionDe('HEL-PAN-540-LNG', 108) });
    const intentos = Array.from({ length: 6 }, (_, i) =>
      reservar({
        // Consumidores distintos: el cupo no interviene, sólo el stock.
        consumidor: `cliente-concurrente-${i}`,
        claveIdempotencia: randomUUID(),
        cuerpo: { cotizacion_id: randomUUID(), lineas: [{ sku: 'HEL-PAN-540-LNG', cantidad: 108 }] },
      }),
    );
    const resultados = await Promise.allSettled(intentos);

    const aprobadas = resultados.filter((r) => r.status === 'fulfilled');
    const rechazadas = resultados.filter((r) => r.status === 'rejected');
    assert.equal(aprobadas.length, 1);
    assert.ok(rechazadas.every((r) => r.reason.codigo === 'STOCK_INSUFICIENTE'));
    // R4.15: la segunda en adelante ve el stock ya comprometido.
    assert.equal(rechazadas[0].reason.extra.lineas_en_conflicto[0].unidades_libres, 36);

    assert.equal((await existencia('HEL-PAN-540-LNG')).cantidad_reservada, 108);

    // La reserva aprobada dejó la existencia bajo el punto de reposición:
    // R4.12 + R6.4 → una orden de reposición sin ranking de precios.
    const { rows: ordenes } = await pool.query(
      `select cantidad, origen_del_precio from stock.orden_reposicion where sku = 'HEL-PAN-540-LNG'`,
    );
    assert.deepEqual(ordenes, [{ cantidad: 720, origen_del_precio: 'sin_ranking' }]);
  });

  test('dos reservas concurrentes con la misma clave de idempotencia crean una sola', async () => {
    const antes = await existencia('HEL-PAN-580-TRN');
    const clave = randomUUID();
    const cuerpo = { cotizacion_id: randomUUID(), lineas: [{ sku: 'HEL-PAN-580-TRN', cantidad: 62 }] };
    const reservar = reservarPedidoCon({ cotizacion: cotizacionDe('HEL-PAN-580-TRN', 62) });

    const resultados = await Promise.allSettled([
      reservar({ consumidor: 'cliente-reintentador', claveIdempotencia: clave, cuerpo }),
      reservar({ consumidor: 'cliente-reintentador', claveIdempotencia: clave, cuerpo }),
    ]);

    assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 1);
    // La perdedora choca contra la PRIMARY KEY y revierte todo lo suyo.
    const fallida = resultados.find((r) => r.status === 'rejected');
    assert.equal(fallida.reason.code, '23505');
    assert.equal((await existencia('HEL-PAN-580-TRN')).cantidad_reservada, antes.cantidad_reservada + 62);
  });

  // --- Cupo, reposición y expiración ---------------------------------------

  test('el cupo suma las reservas vigentes del cliente y no cuenta las canceladas', async () => {
    const consumidor = 'cliente-cupo';
    const fila = await existencia('HEL-INV-50K-SUN');

    const insertarReserva = async (estado, cantidad) => {
      const vigente = estado === 'reservado';
      const { rows } = await pool.query(
        `insert into stock.reserva (consumidor, cotizacion_id, estado, moneda, total, expira_en, cerrado_en)
         values ($1, $2, $3, 'USD', 0, $4, $5) returning id`,
        [consumidor, randomUUID(), estado, vigente ? new Date(Date.now() + 60_000) : null, vigente ? null : new Date()],
      );
      await pool.query(
        `insert into stock.reserva_linea
           (reserva_id, producto_id, sku, deposito_id, cantidad, precio_unitario_congelado, subtotal)
         values ($1, $2, $3, $4, $5, 0, 0)`,
        [rows[0].id, fila.producto_id, fila.sku, fila.deposito_id, cantidad],
      );
    };
    await insertarReserva('reservado', 3);
    await insertarReserva('cancelado', 7);

    const cupo = await repositorio.enTransaccion((tx) => tx.obtenerCupoVigente(consumidor));
    assert.deepEqual(cupo, { unidades_usadas: 3, unidades_maximas: 5000 });
  });

  test('una segunda orden de reposición abierta para el mismo producto no se duplica ni aborta', async () => {
    const fila = await existencia('HEL-INV-36K-HWI');
    const orden = {
      producto_id: fila.producto_id,
      sku: fila.sku,
      deposito_id: fila.deposito_id,
      cantidad: 10,
      fabricante_elegido: 'Huawei',
      costo_unitario: 1500,
      costo_por_watt: 0.04,
      origen_del_precio: 'ranking_vigente',
    };

    await repositorio.enTransaccion(async (tx) => {
      await tx.registrarOrdenDeReposicion(orden);
      await tx.registrarOrdenDeReposicion({ ...orden, cantidad: 20 });
    });

    const { rows } = await pool.query(
      `select cantidad from stock.orden_reposicion where sku = $1 and estado in ('sugerida', 'emitida')`,
      [fila.sku],
    );
    assert.deepEqual(rows, [{ cantidad: 10 }]);
  });

  test('reservasVencidas devuelve las reservas vencidas con sus líneas y existencias', async () => {
    const fila = await existencia('HEL-PAN-550-JKM');
    const { rows } = await pool.query(
      `insert into stock.reserva (consumidor, cotizacion_id, moneda, total, expira_en)
       values ('cliente-moroso', $1, 'USD', 0, now() - interval '1 minute') returning id`,
      [randomUUID()],
    );
    const vencidaId = rows[0].id;
    await pool.query(
      `insert into stock.reserva_linea
         (reserva_id, producto_id, sku, deposito_id, cantidad, precio_unitario_congelado, subtotal)
       values ($1, $2, $3, $4, 36, 0, 0)`,
      [vencidaId, fila.producto_id, fila.sku, fila.deposito_id],
    );

    const vencidas = await repositorio.reservasVencidas();

    assert.deepEqual(
      vencidas.map((r) => r.id),
      [vencidaId],
      'las reservas vigentes de los otros tests no aparecen',
    );
    // `fila` viene del pool de los tests, que deja los bigint como string.
    assert.deepEqual(vencidas[0].lineas, [
      {
        existencia_id: Number(fila.id),
        producto_id: Number(fila.producto_id),
        deposito_id: Number(fila.deposito_id),
        sku: fila.sku,
        cantidad: 36,
      },
    ]);
  });

  test('buscarClaveIdempotencia ignora las claves vencidas', async () => {
    const clave = randomUUID();
    await pool.query(
      `insert into stock.clave_idempotencia
         (clave, consumidor, operacion, huella_cuerpo, estado_http, respuesta, expira_en)
       values ($1, 'x', 'POST /v1/pedidos/reservar', 'h', 201, '{}', now() - interval '1 second')`,
      [clave],
    );
    assert.equal(await repositorio.buscarClaveIdempotencia(clave), null);
  });
});
