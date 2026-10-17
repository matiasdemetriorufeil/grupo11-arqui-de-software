// ---------------------------------------------------------------------------
// Tests del job de expiración y del estado que ve el consumidor, sin base.
// La transacción real (SKIP LOCKED, libro mayor, concurrencia) se verifica en
// repositorio-postgres.integracion.test.js.
// ---------------------------------------------------------------------------

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { crearExpirarReservas } from '../src/application/expirar-reservas.js';
import { crearObtenerPedido } from '../src/application/obtener-pedido.js';

function vencida(id, lineas = [{ existencia_id: 1, sku: 'HEL-PAN-550-JKM', cantidad: 36 }]) {
  return { id, consumidor: 'grupo-consumidor', lineas };
}

/**
 * Repositorio falso. `tomadas` simula reservas que otra instancia del job ya
 * tiene bloqueadas (SKIP LOCKED devuelve null); `rotas`, reservas cuya
 * transacción falla.
 */
function repositorioFalso({ vencidas, tomadas = new Set(), rotas = new Set() }) {
  const efectos = [];
  return {
    efectos,
    async reservasVencidas() {
      return vencidas;
    },
    async enTransaccion(trabajo) {
      const pendientes = [];
      const tx = {
        async bloquearReservaVencida(id) {
          if (tomadas.has(id)) return null;
          return { id, consumidor: 'grupo-consumidor', version: 1 };
        },
        async marcarExpirada(id) {
          if (rotas.has(id)) throw new Error('falla simulada');
          pendientes.push(`expirada:${id}`);
        },
        async liberarStock({ existencia_id, cantidad, reserva_id }) {
          pendientes.push(`liberar:${reserva_id}:${existencia_id}:${cantidad}`);
        },
        async encolarEvento({ tipo, clave_agregado }) {
          pendientes.push(`evento:${tipo}:${clave_agregado}`);
        },
      };
      const resultado = await trabajo(tx);
      // Sólo lo confirmado deja efectos: si el trabajo lanza, no hay commit.
      efectos.push(...pendientes);
      return resultado;
    },
  };
}

const eventos = { vaciarOutboxEnSegundoPlano() {} };

describe('expirarReservas', () => {
  test('expira, libera cada línea y encola pedido.expirado, todo en la misma transacción', async () => {
    const repositorio = repositorioFalso({
      vencidas: [
        vencida('r1', [
          { existencia_id: 1, sku: 'HEL-PAN-550-JKM', cantidad: 108 },
          { existencia_id: 4, sku: 'HEL-INV-50K-SUN', cantidad: 2 },
        ]),
      ],
    });

    assert.deepEqual(await crearExpirarReservas({ repositorio, eventos })(), { expiradas: 1, salteadas: 0, fallidas: 0 });
    assert.deepEqual(repositorio.efectos, [
      'expirada:r1',
      'liberar:r1:1:108',
      'liberar:r1:4:2',
      'evento:pedido.expirado:r1',
    ]);
  });

  test('una reserva que tomó otra instancia se saltea, sin liberar nada', async () => {
    const repositorio = repositorioFalso({ vencidas: [vencida('r1'), vencida('r2')], tomadas: new Set(['r1']) });

    assert.deepEqual(await crearExpirarReservas({ repositorio, eventos })(), { expiradas: 1, salteadas: 1, fallidas: 0 });
    assert.ok(!repositorio.efectos.some((e) => e.includes(':r1')));
  });

  test('una reserva que falla no frena a las demás ni deja efectos a medias', async () => {
    const avisos = [];
    const repositorio = repositorioFalso({ vencidas: [vencida('r1'), vencida('r2')], rotas: new Set(['r1']) });

    const resultado = await crearExpirarReservas({ repositorio, eventos, log: { warn: (o) => avisos.push(o) } })();

    assert.deepEqual(resultado, { expiradas: 1, salteadas: 0, fallidas: 1 });
    assert.ok(!repositorio.efectos.some((e) => e.includes(':r1')), 'r1 no liberó stock');
    assert.ok(repositorio.efectos.includes('expirada:r2'));
    assert.equal(avisos[0].reserva_id, 'r1');
  });

  test('sin reservas vencidas no hace nada', async () => {
    const repositorio = repositorioFalso({ vencidas: [] });
    assert.deepEqual(await crearExpirarReservas({ repositorio, eventos })(), { expiradas: 0, salteadas: 0, fallidas: 0 });
  });
});

describe('estado que ve el consumidor', () => {
  const RESERVA = {
    id: 'c0a80101-9f1b-4d7a-8e2c-6b5f3a1d4e88',
    consumidor: 'grupo-consumidor',
    cotizacion_id: '7f1c9d3e-5b42-4a1f-9d0e-2c7b8a6f4e11',
    referencia_externa: null,
    estado: 'reservado',
    moneda: 'USD',
    total: '3600.00',
    creado_en: new Date('2026-10-17T12:00:00Z'),
    expira_en: new Date('2026-10-17T12:15:00Z'),
    lineas: [{ sku: 'HEL-PAN-550-JKM', cantidad: 36, deposito: 'DEP-CBA-01', precio_unitario_congelado: '100.00', subtotal: '3600.00' }],
  };
  const repositorio = { async obtenerReserva() { return RESERVA; } };

  test('antes del vencimiento: reservado, con expira_en', async () => {
    const obtener = crearObtenerPedido({ repositorio, reloj: () => new Date('2026-10-17T12:14:59Z') });
    const pedido = await obtener(RESERVA.id, 'grupo-consumidor');
    assert.equal(pedido.estado, 'reservado');
    assert.equal(pedido.expira_en, '2026-10-17T12:15:00.000Z');
  });

  test('vencida pero el job todavía no pasó: ya se informa expirado, sin expira_en', async () => {
    const obtener = crearObtenerPedido({ repositorio, reloj: () => new Date('2026-10-17T12:15:00Z') });
    const pedido = await obtener(RESERVA.id, 'grupo-consumidor');
    assert.equal(pedido.estado, 'expirado');
    assert.equal(pedido.expira_en, null);
  });

  test('un pedido pendiente_de_pago no se muestra expirado aunque pase su expira_en', async () => {
    const pendiente = { ...RESERVA, estado: 'pendiente_de_pago' };
    const obtener = crearObtenerPedido({
      repositorio: { async obtenerReserva() { return pendiente; } },
      reloj: () => new Date('2026-10-17T13:00:00Z'),
    });
    assert.equal((await obtener(RESERVA.id, 'grupo-consumidor')).estado, 'pendiente_de_pago');
  });
});
