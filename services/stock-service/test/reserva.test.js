// ---------------------------------------------------------------------------
// Tests unitarios de las reglas de negocio de la reserva.
//
//   npm test            (desde services/stock-service)
//   docker compose run --rm --entrypoint sh stock-service -c "npm test"
//
// No necesitan base de datos ni broker: el dominio es puro. Esto es la razón
// práctica de haber elegido arquitectura hexagonal para este servicio.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Codigos,
  calcularCantidadDeReposicion,
  esMultiploDeEmbalaje,
  planificarReserva,
  requiereReposicion,
  unidadesLibres,
} from '../src/domain/reserva.js';

const AHORA = new Date('2026-10-09T14:30:00Z');

function cotizacionValida(overrides = {}) {
  return {
    cotizacion_id: '7f1c9d3e-5b42-4a1f-9d0e-2c7b8a6f4e11',
    estado: 'vigente',
    vigente_hasta: '2026-10-09T14:45:00Z',
    lineas: [
      { sku: 'HEL-PAN-550-JKM', cantidad: 108, precio_unitario: { monto: '100.10', moneda: 'USD' } },
    ],
    total: { monto: '10810.80', moneda: 'USD' },
    ...overrides,
  };
}

function existencia(overrides = {}) {
  return {
    id: 1,
    producto_id: 1,
    sku: 'HEL-PAN-550-JKM',
    deposito_id: 1,
    cantidad_fisica: 1840,
    cantidad_reservada: 0,
    stock_minimo: 360,
    punto_de_reposicion: 720,
    lote_de_reposicion: 1080,
    multiplo_de_embalaje: 36,
    ...overrides,
  };
}

const sinCupo = { unidades_usadas: 0, unidades_maximas: 100000 };

// --- Cálculos básicos ------------------------------------------------------

test('unidadesLibres descuenta lo reservado del stock físico', () => {
  assert.equal(unidadesLibres(existencia({ cantidad_fisica: 100, cantidad_reservada: 30 })), 70);
});

test('esMultiploDeEmbalaje acepta sólo pallets completos', () => {
  assert.equal(esMultiploDeEmbalaje(108, 36), true);
  assert.equal(esMultiploDeEmbalaje(110, 36), false);
  assert.equal(esMultiploDeEmbalaje(0, 36), false, 'una cantidad nula no es una compra válida');
});

// --- Camino feliz ----------------------------------------------------------

test('aprueba una reserva que cumple todas las reglas y congela el precio cotizado', () => {
  const resultado = planificarReserva({
    cotizacion: cotizacionValida(),
    lineasPedidas: [{ sku: 'HEL-PAN-550-JKM', cantidad: 108 }],
    existenciasPorSku: new Map([['HEL-PAN-550-JKM', existencia()]]),
    cupo: sinCupo,
    montoMinimo: 5000,
    ahora: AHORA,
  });

  assert.equal(resultado.aprobada, true);
  assert.deepEqual(resultado.errores, []);
  assert.equal(resultado.plan.lineas.length, 1);
  assert.equal(resultado.plan.lineas[0].precio_unitario_congelado, 100.1);
  assert.equal(resultado.plan.total, 10810.8);
  assert.deepEqual(resultado.plan.reposiciones, [], 'queda stock de sobra, no hay que reponer');
});

// --- Regla 1: vigencia de la cotización -----------------------------------

test('rechaza si la cotización ya venció', () => {
  const resultado = planificarReserva({
    cotizacion: cotizacionValida({ vigente_hasta: '2026-10-09T14:29:59Z' }),
    lineasPedidas: [{ sku: 'HEL-PAN-550-JKM', cantidad: 108 }],
    existenciasPorSku: new Map([['HEL-PAN-550-JKM', existencia()]]),
    cupo: sinCupo,
    montoMinimo: 5000,
    ahora: AHORA,
  });

  assert.equal(resultado.aprobada, false);
  assert.equal(resultado.errores[0].codigo, Codigos.COTIZACION_EXPIRADA);
});

// --- Regla 2: el pedido coincide con lo cotizado --------------------------

test('rechaza si se piden más unidades de las cotizadas', () => {
  const resultado = planificarReserva({
    cotizacion: cotizacionValida(),
    lineasPedidas: [{ sku: 'HEL-PAN-550-JKM', cantidad: 144 }],
    existenciasPorSku: new Map([['HEL-PAN-550-JKM', existencia()]]),
    cupo: sinCupo,
    montoMinimo: 5000,
    ahora: AHORA,
  });

  assert.equal(resultado.aprobada, false);
  assert.equal(resultado.errores[0].codigo, Codigos.LINEAS_NO_COINCIDEN);
});

// --- Regla 3: múltiplo de embalaje ----------------------------------------

test('rechaza una cantidad que no completa pallets', () => {
  const resultado = planificarReserva({
    cotizacion: cotizacionValida({
      lineas: [
        { sku: 'HEL-PAN-550-JKM', cantidad: 100, precio_unitario: { monto: '100.10', moneda: 'USD' } },
      ],
      total: { monto: '10010.00', moneda: 'USD' },
    }),
    lineasPedidas: [{ sku: 'HEL-PAN-550-JKM', cantidad: 100 }],
    existenciasPorSku: new Map([['HEL-PAN-550-JKM', existencia()]]),
    cupo: sinCupo,
    montoMinimo: 5000,
    ahora: AHORA,
  });

  assert.equal(resultado.aprobada, false);
  assert.equal(resultado.errores[0].codigo, Codigos.CANTIDAD_NO_MULTIPLO_EMBALAJE);
});

// --- Regla 4: monto mínimo -------------------------------------------------

test('rechaza un pedido por debajo del monto mínimo mayorista', () => {
  const resultado = planificarReserva({
    cotizacion: cotizacionValida({
      lineas: [
        { sku: 'HEL-PAN-550-JKM', cantidad: 36, precio_unitario: { monto: '100.10', moneda: 'USD' } },
      ],
      total: { monto: '3603.60', moneda: 'USD' },
    }),
    lineasPedidas: [{ sku: 'HEL-PAN-550-JKM', cantidad: 36 }],
    existenciasPorSku: new Map([['HEL-PAN-550-JKM', existencia()]]),
    cupo: sinCupo,
    montoMinimo: 5000,
    ahora: AHORA,
  });

  assert.equal(resultado.aprobada, false);
  assert.equal(resultado.errores[0].codigo, Codigos.MONTO_MINIMO_NO_ALCANZADO);
});

// --- Regla 5: cupo del cliente --------------------------------------------

test('rechaza cuando el pedido excede el cupo vigente del cliente', () => {
  const resultado = planificarReserva({
    cotizacion: cotizacionValida(),
    lineasPedidas: [{ sku: 'HEL-PAN-550-JKM', cantidad: 108 }],
    existenciasPorSku: new Map([['HEL-PAN-550-JKM', existencia()]]),
    cupo: { unidades_usadas: 950, unidades_maximas: 1000 },
    montoMinimo: 5000,
    ahora: AHORA,
  });

  assert.equal(resultado.aprobada, false);
  assert.equal(resultado.errores[0].codigo, Codigos.CUPO_CLIENTE_EXCEDIDO);
});

// --- Regla 6: sin sobreventa ----------------------------------------------

test('rechaza e informa las unidades libres cuando no alcanza el stock', () => {
  const resultado = planificarReserva({
    cotizacion: cotizacionValida(),
    lineasPedidas: [{ sku: 'HEL-PAN-550-JKM', cantidad: 108 }],
    existenciasPorSku: new Map([
      ['HEL-PAN-550-JKM', existencia({ cantidad_fisica: 144, cantidad_reservada: 72 })],
    ]),
    cupo: sinCupo,
    montoMinimo: 5000,
    ahora: AHORA,
  });

  assert.equal(resultado.aprobada, false);
  const error = resultado.errores[0];
  assert.equal(error.codigo, Codigos.STOCK_INSUFICIENTE);
  assert.equal(error.unidades_libres, 72, 'el consumidor necesita saber cuánto hay');
});

test('es todo o nada: una línea sin stock invalida el pedido completo', () => {
  const cotizacion = cotizacionValida({
    lineas: [
      { sku: 'HEL-PAN-550-JKM', cantidad: 108, precio_unitario: { monto: '100.10', moneda: 'USD' } },
      { sku: 'HEL-INV-50K-SUN', cantidad: 2, precio_unitario: { monto: '3180.00', moneda: 'USD' } },
    ],
    total: { monto: '17170.80', moneda: 'USD' },
  });

  const resultado = planificarReserva({
    cotizacion,
    lineasPedidas: [
      { sku: 'HEL-PAN-550-JKM', cantidad: 108 },
      { sku: 'HEL-INV-50K-SUN', cantidad: 2 },
    ],
    existenciasPorSku: new Map([
      ['HEL-PAN-550-JKM', existencia()],
      [
        'HEL-INV-50K-SUN',
        existencia({
          id: 5,
          producto_id: 4,
          sku: 'HEL-INV-50K-SUN',
          cantidad_fisica: 1,
          cantidad_reservada: 0,
          multiplo_de_embalaje: 1,
          punto_de_reposicion: 12,
        }),
      ],
    ]),
    cupo: sinCupo,
    montoMinimo: 5000,
    ahora: AHORA,
  });

  assert.equal(resultado.aprobada, false);
  assert.equal(resultado.plan, undefined, 'no se devuelve plan parcial');
});

// --- Consecuencia de negocio: reposición automática ------------------------

test('detecta que la reserva deja la existencia bajo el punto de reposición', () => {
  const resultado = planificarReserva({
    cotizacion: cotizacionValida(),
    lineasPedidas: [{ sku: 'HEL-PAN-550-JKM', cantidad: 108 }],
    existenciasPorSku: new Map([
      ['HEL-PAN-550-JKM', existencia({ cantidad_fisica: 792, cantidad_reservada: 0 })],
    ]),
    cupo: sinCupo,
    montoMinimo: 5000,
    ahora: AHORA,
  });

  assert.equal(resultado.aprobada, true);
  assert.equal(resultado.plan.reposiciones.length, 1);
  assert.equal(resultado.plan.reposiciones[0].sku, 'HEL-PAN-550-JKM');
  assert.ok(resultado.plan.reposiciones[0].cantidad > 0);
});

test('requiereReposicion compara contra el stock libre, no contra el físico', () => {
  assert.equal(
    requiereReposicion(existencia({ cantidad_fisica: 1000, cantidad_reservada: 400 })),
    true,
    '600 libres contra un punto de reposición de 720',
  );
  assert.equal(requiereReposicion(existencia()), false);
});

test('la cantidad a reponer se redondea al lote y al embalaje', () => {
  const cantidad = calcularCantidadDeReposicion(
    existencia({ cantidad_fisica: 720, cantidad_reservada: 108, lote_de_reposicion: 360 }),
  );
  // Faltan 108 unidades para volver a 720 -> un lote de 360, ya múltiplo de 36.
  assert.equal(cantidad, 360);
});

test('no se repone si la existencia está sobre su punto de reposición', () => {
  assert.equal(calcularCantidadDeReposicion(existencia()), 0);
});
