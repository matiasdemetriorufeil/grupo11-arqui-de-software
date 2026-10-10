// ---------------------------------------------------------------------------
// Dominio de la reserva mayorista — reglas de negocio puras.
//
// Este archivo es el centro del hexágono: no conoce HTTP, ni PostgreSQL, ni
// RabbitMQ. Recibe datos y devuelve una decisión. Por eso se puede testear sin
// levantar nada (ver test/reserva.test.js).
//
// Reglas implementadas: SPEC.md § HU-04 (Reservar un pedido mayorista).
// Decisiones: docs/adr/ADR-001-limites-de-servicios.md
// ---------------------------------------------------------------------------

/** Códigos de error del dominio, iguales a los que publica el contrato. */
export const Codigos = {
  COTIZACION_EXPIRADA: 'COTIZACION_EXPIRADA',
  LINEAS_NO_COINCIDEN: 'LINEAS_NO_COINCIDEN',
  CANTIDAD_NO_MULTIPLO_EMBALAJE: 'CANTIDAD_NO_MULTIPLO_EMBALAJE',
  MONTO_MINIMO_NO_ALCANZADO: 'MONTO_MINIMO_NO_ALCANZADO',
  CUPO_CLIENTE_EXCEDIDO: 'CUPO_CLIENTE_EXCEDIDO',
  STOCK_INSUFICIENTE: 'STOCK_INSUFICIENTE',
  SKU_DESCONTINUADO: 'SKU_DESCONTINUADO',
};

/** Unidades que una existencia tiene realmente libres para comprometer. */
export function unidadesLibres(existencia) {
  return existencia.cantidad_fisica - existencia.cantidad_reservada;
}

/** Regla 3: las cantidades mayoristas se venden por pallet completo. */
export function esMultiploDeEmbalaje(cantidad, multiplo) {
  return multiplo >= 1 && cantidad > 0 && cantidad % multiplo === 0;
}

/** Una existencia cruzó su punto de reposición y hay que reponer. */
export function requiereReposicion(existencia) {
  return unidadesLibres(existencia) <= existencia.punto_de_reposicion;
}

/**
 * Cuánto pedir al fabricante: lo necesario para volver sobre el punto de
 * reposición, redondeado hacia arriba al lote de compra y al embalaje.
 */
export function calcularCantidadDeReposicion(existencia) {
  const faltante = existencia.punto_de_reposicion - unidadesLibres(existencia);
  if (faltante <= 0) return 0;

  const lote = Math.max(existencia.lote_de_reposicion ?? 1, 1);
  const embalaje = Math.max(existencia.multiplo_de_embalaje ?? 1, 1);
  const porLote = Math.ceil(faltante / lote) * lote;
  return Math.ceil(porLote / embalaje) * embalaje;
}

/**
 * Decide si una reserva puede concretarse y, si puede, con qué plan.
 *
 * Es una función pura: no bloquea filas ni escribe nada. El caso de uso la llama
 * **después** de haber bloqueado las existencias con SELECT ... FOR UPDATE, así
 * que los datos que recibe son los definitivos dentro de la transacción.
 *
 * @param {object} args
 * @param {object} args.cotizacion      Cotización emitida por pricing-search-service.
 * @param {Array}  args.lineasPedidas   [{ sku, cantidad }] tal como llegaron en la solicitud.
 * @param {Map}    args.existenciasPorSku  sku -> fila de `existencia` ya bloqueada.
 * @param {object} args.cupo            { unidades_usadas, unidades_maximas }
 * @param {number} args.montoMinimo     Monto mínimo de orden mayorista.
 * @param {Date}   args.ahora
 * @returns {{ aprobada: boolean, errores: Array, plan?: object }}
 */
export function planificarReserva({
  cotizacion,
  lineasPedidas,
  existenciasPorSku,
  cupo,
  montoMinimo,
  ahora = new Date(),
}) {
  const errores = [];

  // --- Regla 1: la cotización tiene que estar vigente -----------------------
  // Se evalúa primero porque sin precio firme no hay nada que reservar.
  if (!cotizacion || cotizacion.estado !== 'vigente') {
    return {
      aprobada: false,
      errores: [{ codigo: Codigos.COTIZACION_EXPIRADA, detalle: 'La cotización no está vigente.' }],
    };
  }
  if (new Date(cotizacion.vigente_hasta) <= ahora) {
    return {
      aprobada: false,
      errores: [
        {
          codigo: Codigos.COTIZACION_EXPIRADA,
          detalle: `La cotización venció el ${new Date(cotizacion.vigente_hasta).toISOString()}.`,
        },
      ],
    };
  }

  // --- Regla 2: el pedido tiene que coincidir con lo cotizado --------------
  // Si no, el cliente estaría reservando a un precio que no se calculó para esa
  // combinación de líneas (las bonificaciones por volumen dependen del total).
  const cotizadasPorSku = new Map(cotizacion.lineas.map((l) => [l.sku, l]));
  if (lineasPedidas.length !== cotizacion.lineas.length) {
    errores.push({
      codigo: Codigos.LINEAS_NO_COINCIDEN,
      detalle: `La cotización tiene ${cotizacion.lineas.length} líneas y el pedido ${lineasPedidas.length}.`,
    });
  }

  const plan = { lineas: [], total: 0, moneda: cotizacion.total?.moneda ?? 'USD', reposiciones: [] };

  for (const pedida of lineasPedidas) {
    const cotizada = cotizadasPorSku.get(pedida.sku);
    if (!cotizada) {
      errores.push({
        codigo: Codigos.LINEAS_NO_COINCIDEN,
        campo: pedida.sku,
        detalle: 'El SKU no figura en la cotización.',
      });
      continue;
    }
    if (cotizada.cantidad !== pedida.cantidad) {
      errores.push({
        codigo: Codigos.LINEAS_NO_COINCIDEN,
        campo: pedida.sku,
        detalle: `Se cotizaron ${cotizada.cantidad} unidades y se piden ${pedida.cantidad}.`,
      });
      continue;
    }

    const existencia = existenciasPorSku.get(pedida.sku);
    if (!existencia) {
      errores.push({
        codigo: Codigos.SKU_DESCONTINUADO,
        campo: pedida.sku,
        detalle: 'No hay existencias registradas para este SKU.',
      });
      continue;
    }

    // --- Regla 3: múltiplo de embalaje -------------------------------------
    if (!esMultiploDeEmbalaje(pedida.cantidad, existencia.multiplo_de_embalaje)) {
      errores.push({
        codigo: Codigos.CANTIDAD_NO_MULTIPLO_EMBALAJE,
        campo: pedida.sku,
        detalle: `Debe ser múltiplo de ${existencia.multiplo_de_embalaje} (unidades por pallet).`,
      });
      continue;
    }

    // --- Regla 6: stock libre suficiente -----------------------------------
    const libres = unidadesLibres(existencia);
    if (libres < pedida.cantidad) {
      errores.push({
        codigo: Codigos.STOCK_INSUFICIENTE,
        campo: pedida.sku,
        detalle: `Se piden ${pedida.cantidad} unidades y hay ${libres} libres.`,
        cantidad_solicitada: pedida.cantidad,
        unidades_libres: libres,
      });
      continue;
    }

    const precioUnitario = Number(cotizada.precio_unitario.monto);
    const subtotal = redondearADosDecimales(precioUnitario * pedida.cantidad);
    plan.lineas.push({
      sku: pedida.sku,
      producto_id: existencia.producto_id,
      deposito_id: existencia.deposito_id,
      existencia_id: existencia.id,
      cantidad: pedida.cantidad,
      precio_unitario_congelado: precioUnitario,
      subtotal,
    });
    plan.total = redondearADosDecimales(plan.total + subtotal);

    // Efecto colateral del negocio: si esta línea deja la existencia bajo el
    // punto de reposición, hay que reponer. Se calcula acá para que el caso de
    // uso lo registre en la misma transacción.
    const trasReservar = {
      ...existencia,
      cantidad_reservada: existencia.cantidad_reservada + pedida.cantidad,
    };
    if (requiereReposicion(trasReservar)) {
      plan.reposiciones.push({
        producto_id: existencia.producto_id,
        sku: pedida.sku,
        deposito_id: existencia.deposito_id,
        cantidad: calcularCantidadDeReposicion(trasReservar),
      });
    }
  }

  // --- Regla 4: monto mínimo de orden mayorista ---------------------------
  // Se evalúa sobre el total cotizado, no sobre el plan, para que un error de
  // stock en una línea no haga parecer que el pedido además era muy chico.
  const totalCotizado = Number(cotizacion.total?.monto ?? 0);
  if (totalCotizado < montoMinimo) {
    errores.push({
      codigo: Codigos.MONTO_MINIMO_NO_ALCANZADO,
      detalle: `El monto mínimo de orden es ${montoMinimo} ${plan.moneda} y el pedido suma ${totalCotizado}.`,
    });
  }

  // --- Regla 5: cupo del cliente ------------------------------------------
  // Evita que un solo cliente acapare el stock disponible en un pico de demanda.
  const unidadesDelPedido = lineasPedidas.reduce((acc, l) => acc + l.cantidad, 0);
  if (cupo && cupo.unidades_usadas + unidadesDelPedido > cupo.unidades_maximas) {
    errores.push({
      codigo: Codigos.CUPO_CLIENTE_EXCEDIDO,
      detalle:
        `El cupo vigente es de ${cupo.unidades_maximas} unidades, ` +
        `ya usó ${cupo.unidades_usadas} y este pedido suma ${unidadesDelPedido}.`,
    });
  }

  if (errores.length > 0) return { aprobada: false, errores };
  return { aprobada: true, errores: [], plan };
}

function redondearADosDecimales(n) {
  return Math.round(n * 100) / 100;
}
