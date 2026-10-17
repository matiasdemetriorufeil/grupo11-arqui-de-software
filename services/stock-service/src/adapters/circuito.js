// ---------------------------------------------------------------------------
// Circuit breaker para llamadas salientes.
//
// Política fijada en docs/adr/ADR-005-comunicacion.md: abre a las 5 fallas
// consecutivas, pasa a half-open a los 30 s y cierra con un éxito. Mientras está
// abierto se falla rápido en lugar de agotar el timeout en cada llamada: con la
// dependencia caída, esperar 2 s por pedido sólo suma latencia y conexiones
// ocupadas sin cambiar el resultado.
//
// Es una pieza de infraestructura, no de dominio: la usan los adaptadores HTTP
// (precios, y más adelante el proveedor de pagos), uno por dependencia.
// ---------------------------------------------------------------------------

export const EstadosDelCircuito = Object.freeze({
  CERRADO: 'cerrado',
  ABIERTO: 'abierto',
  SEMIABIERTO: 'semiabierto',
});

/** Se lanza cuando el circuito rechaza la llamada sin intentarla. */
export class CircuitoAbierto extends Error {
  constructor(nombre) {
    super(`Circuito ${nombre} abierto: la llamada no se intenta.`);
    this.name = 'CircuitoAbierto';
  }
}

/**
 * @param {object} opciones
 * @param {string} opciones.nombre             Dependencia protegida, para logs.
 * @param {number} [opciones.umbralDeFallas]   Fallas consecutivas que lo abren.
 * @param {number} [opciones.esperaMs]         Tiempo abierto antes del half-open.
 * @param {() => number} [opciones.ahora]      Reloj en ms, inyectable en tests.
 * @param {(estado: string) => void} [opciones.alCambiar]  Notificación de cambio de estado.
 */
export function crearCircuito({
  nombre,
  umbralDeFallas = 5,
  esperaMs = 30_000,
  ahora = Date.now,
  alCambiar = () => {},
}) {
  let estado = EstadosDelCircuito.CERRADO;
  let fallasConsecutivas = 0;
  let abiertoDesde = 0;
  let pruebaEnCurso = false;

  function pasarA(nuevo) {
    if (nuevo === estado) return;
    estado = nuevo;
    alCambiar(nuevo);
  }

  return {
    get estado() {
      return estado;
    },

    /**
     * Ejecuta `llamada` si el circuito lo permite. `esFalla(err)` decide si un
     * error cuenta para abrir el circuito: un 404 o un 422 son respuestas
     * válidas de una dependencia sana y no deben abrirlo.
     */
    async ejecutar(llamada, esFalla = () => true) {
      if (estado === EstadosDelCircuito.ABIERTO) {
        if (ahora() - abiertoDesde < esperaMs) throw new CircuitoAbierto(nombre);
        pasarA(EstadosDelCircuito.SEMIABIERTO);
      }
      // En half-open pasa UNA sola llamada de prueba; las demás siguen fallando
      // rápido hasta saber si la dependencia volvió.
      if (estado === EstadosDelCircuito.SEMIABIERTO) {
        if (pruebaEnCurso) throw new CircuitoAbierto(nombre);
        pruebaEnCurso = true;
      }

      try {
        const resultado = await llamada();
        fallasConsecutivas = 0;
        pasarA(EstadosDelCircuito.CERRADO);
        return resultado;
      } catch (err) {
        if (esFalla(err)) {
          fallasConsecutivas += 1;
          if (estado === EstadosDelCircuito.SEMIABIERTO || fallasConsecutivas >= umbralDeFallas) {
            abiertoDesde = ahora();
            pasarA(EstadosDelCircuito.ABIERTO);
          }
        } else if (estado === EstadosDelCircuito.SEMIABIERTO) {
          // Respondió, aunque fuera con un error de negocio: la dependencia está viva.
          fallasConsecutivas = 0;
          pasarA(EstadosDelCircuito.CERRADO);
        }
        throw err;
      } finally {
        if (estado !== EstadosDelCircuito.SEMIABIERTO) pruebaEnCurso = false;
      }
    },
  };
}
