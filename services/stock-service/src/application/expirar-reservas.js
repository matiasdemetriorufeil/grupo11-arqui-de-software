// ---------------------------------------------------------------------------
// Caso de uso: expirar las reservas que vencieron sin confirmar (SPEC R4.11).
//
// Lo corre un job periódico (ver src/index.js). Por cada reserva vencida, en
// UNA transacción: la marca `expirado`, libera su stock con su asiento en el
// libro mayor y deja `pedido.expirado` en el outbox. O todo, o nada.
//
// Seguro con varias instancias del job: cada reserva se toma con FOR UPDATE
// SKIP LOCKED y se revalida con la fila bloqueada, así que dos instancias
// nunca la expiran dos veces ni liberan su stock dos veces.
// ---------------------------------------------------------------------------

/**
 * @param {object} puertos
 * @param {import('./puertos.js').RepositorioDeStock} puertos.repositorio
 * @param {import('./puertos.js').PublicadorDeEventos} puertos.eventos
 * @param {{warn: Function}} [puertos.log]
 * @returns {() => Promise<{expiradas: number, salteadas: number, fallidas: number}>}
 */
export function crearExpirarReservas({ repositorio, eventos, log = { warn() {} } }) {
  return async function expirarReservas() {
    const resultado = { expiradas: 0, salteadas: 0, fallidas: 0 };

    for (const vencida of await repositorio.reservasVencidas()) {
      try {
        const expirada = await repositorio.enTransaccion(async (tx) => {
          const reserva = await tx.bloquearReservaVencida(vencida.id);
          // La tomó otra instancia, o el cliente la confirmó o canceló entre
          // la lectura y el bloqueo.
          if (!reserva) return false;

          await tx.marcarExpirada(reserva.id);
          // Las líneas vienen ordenadas por (producto_id, deposito_id): el mismo
          // orden de bloqueo que usa la reserva, para no generar deadlocks.
          for (const linea of vencida.lineas) {
            await tx.liberarStock({
              existencia_id: linea.existencia_id,
              cantidad: linea.cantidad,
              reserva_id: reserva.id,
            });
          }
          await tx.encolarEvento({
            tipo: 'pedido.expirado',
            clave_agregado: reserva.id,
            cuerpo: {
              pedido_id: reserva.id,
              consumidor: reserva.consumidor,
              lineas: vencida.lineas.map(({ sku, cantidad }) => ({ sku, cantidad })),
            },
          });
          return true;
        });

        if (expirada) resultado.expiradas += 1;
        else resultado.salteadas += 1;
      } catch (err) {
        // Una reserva que falla no frena a las demás: se reintenta en la
        // próxima pasada del job.
        resultado.fallidas += 1;
        log.warn({ err, reserva_id: vencida.id }, 'no se pudo expirar la reserva; se reintenta en la próxima pasada');
      }
    }

    if (resultado.expiradas > 0) eventos.vaciarOutboxEnSegundoPlano();
    return resultado;
  };
}
