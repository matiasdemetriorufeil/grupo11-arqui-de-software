// ---------------------------------------------------------------------------
// Errores que los adaptadores le informan a los casos de uso.
//
// Viven en la capa de aplicación, no en los adaptadores, para que el caso de
// uso los reconozca sin saber qué base de datos los produjo.
// ---------------------------------------------------------------------------

/**
 * Otra transacción registró la misma clave de idempotencia mientras ésta
 * corría. Pasa cuando el consumidor reintenta antes de recibir la primera
 * respuesta. La transacción perdedora ya se revirtió: no dejó nada escrito.
 */
export class ClaveIdempotenciaEnCarrera extends Error {
  constructor(clave) {
    super(`La clave de idempotencia ${clave} se registró en paralelo.`);
    this.name = 'ClaveIdempotenciaEnCarrera';
    this.clave = clave;
  }
}
