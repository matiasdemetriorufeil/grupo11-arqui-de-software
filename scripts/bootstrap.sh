#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Genera un archivo .env local con credenciales de desarrollo propias.
#
# No es obligatorio: `docker compose up --build` funciona sin esto, usando los
# valores por defecto declarados en docker-compose.yml. Este script existe para
# que cada integrante tenga sus propias credenciales locales y para que el
# secreto de firma JWT sea aleatorio en lugar del valor de ejemplo.
#
#   ./scripts/bootstrap.sh
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  echo "Ya existe un archivo .env. No se sobrescribe."
  echo "Si querés regenerarlo: rm .env && ./scripts/bootstrap.sh"
  exit 0
fi

# Secreto de firma JWT aleatorio. Es el único valor que conviene no compartir.
if command -v openssl >/dev/null 2>&1; then
  secreto=$(openssl rand -hex 32)
elif command -v node >/dev/null 2>&1; then
  secreto=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
else
  echo "Hace falta openssl o node para generar el secreto." >&2
  exit 1
fi

cp .env.example .env

# Reemplazo del secreto de ejemplo por el generado.
if [[ "$(uname -s)" == "Darwin" ]]; then
  sed -i '' "s#^HELIOS_JWT_SECRET=.*#HELIOS_JWT_SECRET=${secreto}#" .env
else
  sed -i "s#^HELIOS_JWT_SECRET=.*#HELIOS_JWT_SECRET=${secreto}#" .env
fi

echo "Listo: se creó .env con un secreto JWT aleatorio."
echo ".env está en .gitignore y no se versiona."
echo
echo "Siguiente paso:  docker compose up --build"
