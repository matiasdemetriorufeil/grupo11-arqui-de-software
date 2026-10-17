// ---------------------------------------------------------------------------
// Adaptador de salida: RepositorioDeStock sobre PostgreSQL.
//
// Implementa los puertos `RepositorioDeStock` y `TransaccionDeStock` declarados
// en src/application/puertos.js. Es el único archivo del servicio que sabe SQL.
//
// Decisiones (ver src/adapters/README.md y docs/adr/ADR-003-persistencia.md):
//
//   - Driver `pg` con UN pool por proceso.
//   - Aislamiento READ COMMITTED. No hace falta más: la exclusión mutua la da
//     SELECT ... FOR UPDATE sobre las existencias, y la invariante final la
//     garantiza el CHECK (cantidad_reservada <= cantidad_fisica).
//   - Las filas se bloquean SIEMPRE ordenadas por (producto_id, deposito_id).
//     Dos pedidos con las mismas líneas en distinto orden no pueden quedar
//     esperándose mutuamente.
//   - Toda variación de stock deja un asiento en `movimiento_stock` en la misma
//     sentencia de la transacción. El asiento guarda el delta con signo sobre
//     `cantidad_reservada`: +N al reservar, -N al liberar.
// ---------------------------------------------------------------------------

import pg from 'pg';

import { ErrorDeDominio } from '../problema.js';
import { ClaveIdempotenciaEnCarrera } from '../application/errores.js';

/** Estados en los que una reserva sigue ocupando stock y cupo. */
const ESTADOS_VIGENTES = ['reservado', 'pendiente_de_pago'];

/** Estados que NO cuentan para el cupo: la reserva no llegó a concretarse. */
const ESTADOS_SIN_EFECTO = ['rechazado', 'cancelado', 'expirado'];

// `bigint` (OID 20) llega del driver como string para no perder precisión.
// Los ids de este esquema no se acercan a 2^53, así que se convierten a number:
// el dominio compara y suma ids y cantidades sin tener que pensar en tipos.
const tipos = {
  getTypeParser(oid, formato) {
    if (oid === pg.types.builtins.INT8) return (v) => (v === null ? null : Number(v));
    return pg.types.getTypeParser(oid, formato);
  },
};

/**
 * @param {object} [opciones]
 * @param {string} [opciones.urlDeConexion]     Por defecto DATABASE_URL.
 * @param {string} [opciones.depositoAsignado]  Código del depósito contra el que
 *   se reserva. SPEC § 5, supuesto 6: la asignación de depósito es simple.
 * @param {number} [opciones.cupoUnidadesPorCliente]  R4.5: máximo de unidades
 *   que un cliente puede tener comprometidas dentro de la ventana.
 * @param {number} [opciones.ventanaCupoHoras]
 * @param {pg.Pool} [opciones.pool]  Para inyectar un pool ya creado (tests).
 * @returns {import('../application/puertos.js').RepositorioDeStock & { cerrar: () => Promise<void> }}
 */
export function crearRepositorioPostgres({
  urlDeConexion = process.env.DATABASE_URL,
  depositoAsignado = process.env.DEPOSITO_ASIGNADO ?? 'DEP-CBA-01',
  cupoUnidadesPorCliente = Number(process.env.CUPO_UNIDADES_POR_CLIENTE ?? 5000),
  ventanaCupoHoras = Number(process.env.VENTANA_CUPO_HORAS ?? 24),
  pool = new pg.Pool({
    connectionString: urlDeConexion,
    max: 10,
    // Sin este límite, con la base caída cada pedido esperaría indefinidamente
    // una conexión. Mejor un 503 rápido que el consumidor puede reintentar.
    connectionTimeoutMillis: 2000,
    types: tipos,
  }),
} = {}) {
  const contexto = { depositoAsignado, cupoUnidadesPorCliente, ventanaCupoHoras };

  // Un pool inactivo puede perder conexiones (reinicio de la base). Sin este
  // handler, el 'error' emitido tiraría abajo el proceso.
  pool.on('error', () => {});

  return {
    async enTransaccion(trabajo) {
      const cliente = await pool.connect().catch(traducirErrorDeConexion);
      try {
        await cliente.query('begin isolation level read committed');
        const resultado = await trabajo(transaccionSobre(cliente, contexto));
        await cliente.query('commit');
        return resultado;
      } catch (err) {
        await cliente.query('rollback').catch(() => {});
        throw err;
      } finally {
        cliente.release();
      }
    },

    async existenciaPorSku(sku) {
      const { rows } = await pool
        .query(
          `select e.sku, e.cantidad_fisica, e.cantidad_reservada, e.multiplo_de_embalaje
             from stock.existencia e
             join stock.deposito d on d.id = e.deposito_id
            where e.sku = $1 and d.codigo = $2 and d.activo`,
          [sku, depositoAsignado],
        )
        .catch(traducirErrorDeConexion);
      return rows[0] ?? null;
    },

    async obtenerReserva(id) {
      const { rows } = await pool
        .query(
          `select r.id, r.consumidor, r.cotizacion_id, r.referencia_externa, r.estado,
                  r.moneda, r.total, r.creado_en, r.expira_en,
                  json_agg(json_build_object(
                    'sku',                       l.sku,
                    'cantidad',                  l.cantidad,
                    'deposito',                  d.codigo,
                    'precio_unitario_congelado', l.precio_unitario_congelado,
                    'subtotal',                  l.subtotal
                  ) order by l.id) as lineas
             from stock.reserva r
             join stock.reserva_linea l on l.reserva_id = r.id
             join stock.deposito d on d.id = l.deposito_id
            where r.id = $1
            group by r.id`,
          [id],
        )
        .catch(traducirErrorDeConexion);
      return rows[0] ?? null;
    },

    async buscarClaveIdempotencia(clave) {
      // Una clave vencida es como si no existiera: el consumidor puede reusarla.
      const { rows } = await pool.query(
        `select clave, consumidor, operacion, huella_cuerpo, estado_http, respuesta, creado_en
           from stock.clave_idempotencia
          where clave = $1 and expira_en > now()`,
        [clave],
      );
      return rows[0] ?? null;
    },

    async reservasVencidas() {
      // Incluye las líneas con su existencia: el job de expiración las necesita
      // para liberar exactamente lo que se comprometió.
      const { rows } = await pool.query(
        `select r.id, r.consumidor, r.estado, r.expira_en, r.version,
                coalesce(
                  json_agg(json_build_object(
                    'existencia_id', e.id,
                    'producto_id',   l.producto_id,
                    'deposito_id',   l.deposito_id,
                    'sku',           l.sku,
                    'cantidad',      l.cantidad
                  ) order by l.producto_id, l.deposito_id)
                  filter (where l.id is not null),
                  '[]'
                ) as lineas
           from stock.reserva r
           left join stock.reserva_linea l on l.reserva_id = r.id
           left join stock.existencia e
                  on e.producto_id = l.producto_id and e.deposito_id = l.deposito_id
          where r.estado = any($1::stock.estado_reserva[])
            and r.expira_en <= now()
          group by r.id
          order by r.expira_en`,
        [ESTADOS_VIGENTES],
      );
      return rows;
    },

    /** Cierra el pool. Lo usa el apagado ordenado del proceso y los tests. */
    async cerrar() {
      await pool.end();
    },
  };
}

/**
 * Operaciones que corren sobre un cliente con la transacción ya abierta.
 * @returns {import('../application/puertos.js').TransaccionDeStock}
 */
function transaccionSobre(cliente, { depositoAsignado, cupoUnidadesPorCliente, ventanaCupoHoras }) {
  return {
    async bloquearExistenciasPorSku(skus) {
      if (skus.length === 0) return [];
      // FOR UPDATE OF e: se bloquea la existencia, no el depósito del join.
      const { rows } = await cliente.query(
        `select e.id, e.producto_id, e.sku, e.deposito_id, d.codigo as deposito,
                e.cantidad_fisica, e.cantidad_reservada,
                e.stock_minimo, e.punto_de_reposicion,
                e.lote_de_reposicion, e.multiplo_de_embalaje
           from stock.existencia e
           join stock.deposito d on d.id = e.deposito_id
          where e.sku = any($1::text[])
            and d.codigo = $2
            and d.activo
          order by e.producto_id, e.deposito_id
            for update of e`,
        [skus, depositoAsignado],
      );
      return rows;
    },

    async obtenerCupoVigente(consumidor) {
      // Serializa las reservas de un mismo cliente. Sin esto, dos pedidos
      // simultáneos del mismo cliente sobre SKUs distintos no comparten ningún
      // lock de existencia y los dos podrían pasar la validación de cupo.
      // El lock se toma después de las existencias, siempre en ese orden.
      await cliente.query('select pg_advisory_xact_lock(hashtext($1))', [`cupo:${consumidor}`]);

      const { rows } = await cliente.query(
        `select coalesce(sum(l.cantidad), 0)::integer as unidades_usadas
           from stock.reserva r
           join stock.reserva_linea l on l.reserva_id = r.id
          where r.consumidor = $1
            and r.estado <> all($2::stock.estado_reserva[])
            and r.creado_en > now() - make_interval(hours => $3)`,
        [consumidor, ESTADOS_SIN_EFECTO, ventanaCupoHoras],
      );
      return { unidades_usadas: rows[0].unidades_usadas, unidades_maximas: cupoUnidadesPorCliente };
    },

    async crearReserva({ consumidor, cotizacion_id, referencia_externa, moneda, total, expira_en, lineas }) {
      const { rows } = await cliente.query(
        `insert into stock.reserva
           (consumidor, cotizacion_id, referencia_externa, moneda, total, expira_en)
         values ($1, $2, $3, $4, $5, $6)
         returning id, consumidor, cotizacion_id, referencia_externa, estado,
                   moneda, total, creado_en, expira_en, version`,
        [consumidor, cotizacion_id, referencia_externa, moneda, total, expira_en],
      );
      const reserva = rows[0];

      // Una sola sentencia para todas las líneas.
      await cliente.query(
        `insert into stock.reserva_linea
           (reserva_id, producto_id, sku, deposito_id, cantidad, precio_unitario_congelado, subtotal)
         select $1, l.producto_id, l.sku, l.deposito_id, l.cantidad,
                l.precio_unitario_congelado, l.subtotal
           from jsonb_to_recordset($2::jsonb) as l (
                  producto_id bigint, sku text, deposito_id bigint, cantidad integer,
                  precio_unitario_congelado numeric, subtotal numeric)`,
        [reserva.id, JSON.stringify(lineas)],
      );

      return reserva;
    },

    async comprometerStock({ existencia_id, cantidad, reserva_id }) {
      await moverReservado(cliente, {
        existencia_id,
        delta: cantidad,
        tipo: 'reserva',
        reserva_id,
        motivo: 'Reserva de pedido mayorista',
      });
    },

    async liberarStock({ existencia_id, cantidad, reserva_id }) {
      await moverReservado(cliente, {
        existencia_id,
        delta: -cantidad,
        tipo: 'liberacion',
        reserva_id,
        motivo: 'Liberación de reserva',
      });
    },

    async registrarOrdenDeReposicion({
      producto_id,
      sku,
      deposito_id,
      cantidad,
      fabricante_elegido,
      costo_unitario,
      costo_por_watt,
      origen_del_precio,
    }) {
      // R6.5: si ya hay una orden abierta para el producto y depósito, no se
      // duplica y la reserva sigue. El índice único parcial es la garantía real;
      // el ON CONFLICT evita que esa garantía aborte la transacción.
      await cliente.query(
        `insert into stock.orden_reposicion
           (producto_id, sku, deposito_id, cantidad,
            fabricante_elegido, costo_unitario, costo_por_watt, origen_del_precio)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (producto_id, deposito_id) where estado in ('sugerida', 'emitida')
         do nothing`,
        [
          producto_id,
          sku,
          deposito_id,
          cantidad,
          fabricante_elegido,
          costo_unitario,
          costo_por_watt,
          origen_del_precio,
        ],
      );
    },

    async encolarEvento({ tipo, clave_agregado, cuerpo }) {
      await cliente.query(
        `insert into stock.outbox_evento (tipo, clave_agregado, cuerpo) values ($1, $2, $3)`,
        [tipo, clave_agregado, JSON.stringify(cuerpo)],
      );
    },

    async registrarClaveIdempotencia({ clave, consumidor, operacion, huella_cuerpo, estado_http, respuesta }) {
      // Sin ON CONFLICT a propósito: si otra transacción registró la misma clave
      // en paralelo, la PRIMARY KEY hace fallar ésta y el rollback deshace la
      // reserva duplicada entera. El caso de uso decide qué responder.
      try {
        await cliente.query(
          `insert into stock.clave_idempotencia
             (clave, consumidor, operacion, huella_cuerpo, estado_http, respuesta)
           values ($1, $2, $3, $4, $5, $6)`,
          [clave, consumidor, operacion, huella_cuerpo, estado_http, JSON.stringify(respuesta)],
        );
      } catch (err) {
        if (err.code === '23505' && err.constraint === 'clave_idempotencia_pkey') {
          throw new ClaveIdempotenciaEnCarrera(clave);
        }
        throw err;
      }
    },
  };
}

/**
 * Cambia `cantidad_reservada` y deja el asiento en el libro mayor en una sola
 * sentencia. Si el cambio violara una invariante (sobreventa o reservado
 * negativo) el CHECK de la tabla hace fallar la sentencia y con ella la
 * transacción.
 */
async function moverReservado(cliente, { existencia_id, delta, tipo, reserva_id, motivo }) {
  const { rowCount } = await cliente.query(
    `with actualizada as (
       update stock.existencia
          set cantidad_reservada = cantidad_reservada + $2,
              actualizado_en = now()
        where id = $1
       returning id
     )
     insert into stock.movimiento_stock (existencia_id, tipo, cantidad, reserva_id, motivo)
     select id, $3::stock.tipo_movimiento, $2, $4, $5 from actualizada`,
    [existencia_id, delta, tipo, reserva_id, motivo],
  );
  if (rowCount === 0) throw new Error(`La existencia ${existencia_id} no existe.`);
}

// Errores que significan "la base no está disponible", no "la consulta está mal":
// red, timeout de conexión y las clases SQLSTATE 08 (conexión) y 57P (apagado).
const CODIGOS_DE_CONEXION = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT']);

function esErrorDeConexion(err) {
  if (CODIGOS_DE_CONEXION.has(err?.code)) return true;
  if (typeof err?.code === 'string' && (err.code.startsWith('08') || err.code.startsWith('57P'))) return true;
  return /timeout exceeded when trying to connect|Connection terminated/i.test(err?.message ?? '');
}

/**
 * Convierte una falla de conexión en un 503 reintentable. Cualquier otro error
 * se propaga tal cual: un bug de SQL tiene que verse como 500, no esconderse
 * detrás de "servicio no disponible".
 */
function traducirErrorDeConexion(err) {
  if (esErrorDeConexion(err)) {
    throw new ErrorDeDominio('SERVICIO_NO_DISPONIBLE', 'La base de inventario no está disponible.');
  }
  throw err;
}
