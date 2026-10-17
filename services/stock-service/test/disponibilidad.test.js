// ---------------------------------------------------------------------------
// Tests de GET /v1/proveedor/disponibilidad.
//
// Corren sin base de datos: el caso de uso recibe un repositorio falso, y la
// ruta se ejercita con un servidor Express real sobre un puerto efímero. La
// lectura contra PostgreSQL se cubre en repositorio-postgres.integracion.test.js.
// ---------------------------------------------------------------------------

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { crearConsultarDisponibilidad } from '../src/application/consultar-disponibilidad.js';
import { crearRepositorioPostgres } from '../src/adapters/repositorio-postgres.js';
import { routerDePedidos } from '../src/http/rutas-pedidos.js';
import { middlewareDeErrores } from '../src/problema.js';

const AHORA = new Date('2026-10-16T14:00:00Z');

const EXISTENCIAS = {
  'HEL-PAN-550-JKM': {
    sku: 'HEL-PAN-550-JKM',
    cantidad_fisica: 1840,
    cantidad_reservada: 400,
    multiplo_de_embalaje: 36,
  },
};

const repositorioFalso = { existenciaPorSku: async (sku) => EXISTENCIAS[sku] ?? null };

// --- Caso de uso -------------------------------------------------------------

describe('consultarDisponibilidad', () => {
  const consultar = crearConsultarDisponibilidad({ repositorio: repositorioFalso, reloj: () => AHORA });

  test('informa las unidades libres (físicas menos reservadas), no las físicas', async () => {
    assert.deepEqual(await consultar({ sku: 'HEL-PAN-550-JKM', cantidad: 120 }), {
      sku: 'HEL-PAN-550-JKM',
      cantidad_solicitada: 120,
      hay_disponible: true,
      unidades_libres: 1440,
      multiplo_de_embalaje: 36,
      consultado_en: '2026-10-16T14:00:00.000Z',
    });
  });

  test('pedir exactamente las libres está disponible; una más, no', async () => {
    assert.equal((await consultar({ sku: 'HEL-PAN-550-JKM', cantidad: 1440 })).hay_disponible, true);
    assert.equal((await consultar({ sku: 'HEL-PAN-550-JKM', cantidad: 1441 })).hay_disponible, false);
  });

  test('un SKU sin existencias es NO_ENCONTRADO', async () => {
    await assert.rejects(consultar({ sku: 'HEL-PAN-999-XXX', cantidad: 1 }), { codigo: 'NO_ENCONTRADO' });
  });
});

// --- Ruta HTTP -------------------------------------------------------------

describe('GET /v1/proveedor/disponibilidad', () => {
  let servidor;
  let base;

  before(async () => {
    const app = express();
    app.use(
      '/v1',
      routerDePedidos({
        consultarDisponibilidad: crearConsultarDisponibilidad({ repositorio: repositorioFalso, reloj: () => AHORA }),
      }),
    );
    app.use(middlewareDeErrores({ error() {} }));
    servidor = app.listen(0);
    await new Promise((resolve) => servidor.once('listening', resolve));
    base = `http://127.0.0.1:${servidor.address().port}/v1/proveedor/disponibilidad`;
  });

  after(() => new Promise((resolve) => servidor.close(resolve)));

  test('200 con el cuerpo del contrato', async () => {
    const res = await fetch(`${base}?sku=HEL-PAN-550-JKM&cantidad=120`);
    assert.equal(res.status, 200);
    const cuerpo = await res.json();
    assert.equal(cuerpo.unidades_libres, 1440);
    assert.equal(cuerpo.cantidad_solicitada, 120, 'la cantidad llega como número, no como string');
  });

  test('404 problem+json si el SKU no tiene existencias', async () => {
    const res = await fetch(`${base}?sku=HEL-PAN-999-XXX&cantidad=1`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /application\/problem\+json/);
    assert.equal((await res.json()).codigo, 'NO_ENCONTRADO');
  });

  test('400 nombrando los parámetros faltantes', async () => {
    const res = await fetch(base);
    assert.equal(res.status, 400);
    const campos = (await res.json()).errores_de_validacion.map((e) => e.campo);
    assert.deepEqual(campos, ['sku', 'cantidad']);
  });

  for (const [descripcion, consulta, campoInvalido] of [
    ['SKU fuera del formato canónico', 'sku=JKM550N&cantidad=10', 'sku'],
    ['cantidad cero', 'sku=HEL-PAN-550-JKM&cantidad=0', 'cantidad'],
    ['cantidad negativa', 'sku=HEL-PAN-550-JKM&cantidad=-36', 'cantidad'],
    ['cantidad decimal', 'sku=HEL-PAN-550-JKM&cantidad=1.5', 'cantidad'],
    ['cantidad no numérica', 'sku=HEL-PAN-550-JKM&cantidad=muchas', 'cantidad'],
  ]) {
    test(`400 con ${descripcion}`, async () => {
      const res = await fetch(`${base}?${consulta}`);
      assert.equal(res.status, 400);
      const campos = (await res.json()).errores_de_validacion.map((e) => e.campo);
      assert.deepEqual(campos, [campoInvalido]);
    });
  }
});

// --- Base caída --------------------------------------------------------------

test('con la base inalcanzable, el adaptador responde SERVICIO_NO_DISPONIBLE (503), no un 500', async () => {
  // Puerto 1: nada escucha ahí, la conexión se rechaza de inmediato.
  const repositorio = crearRepositorioPostgres({ urlDeConexion: 'postgres://nadie:nada@127.0.0.1:1/nada' });
  try {
    await assert.rejects(repositorio.existenciaPorSku('HEL-PAN-550-JKM'), {
      codigo: 'SERVICIO_NO_DISPONIBLE',
      status: 503,
    });
    await assert.rejects(
      repositorio.enTransaccion(async () => {}),
      { codigo: 'SERVICIO_NO_DISPONIBLE' },
    );
  } finally {
    await repositorio.cerrar();
  }
});
