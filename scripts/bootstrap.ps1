# ---------------------------------------------------------------------------
# Genera un archivo .env local con credenciales de desarrollo propias.
#
# No es obligatorio: `docker compose up --build` funciona sin esto, usando los
# valores por defecto declarados en docker-compose.yml. Este script existe para
# que cada integrante tenga sus propias credenciales locales y para que el
# secreto de firma JWT sea aleatorio en lugar del valor de ejemplo.
#
#   .\scripts\bootstrap.ps1
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

if (Test-Path '.env') {
  Write-Output 'Ya existe un archivo .env. No se sobrescribe.'
  Write-Output 'Si querés regenerarlo: Remove-Item .env ; .\scripts\bootstrap.ps1'
  exit 0
}

# Secreto de firma JWT aleatorio. Es el único valor que conviene no compartir.
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$secreto = -join ($bytes | ForEach-Object { $_.ToString('x2') })

$contenido = Get-Content '.env.example' -Encoding utf8
$contenido = $contenido -replace '^HELIOS_JWT_SECRET=.*', "HELIOS_JWT_SECRET=$secreto"
$contenido | Set-Content '.env' -Encoding utf8

Write-Output 'Listo: se creó .env con un secreto JWT aleatorio.'
Write-Output '.env está en .gitignore y no se versiona.'
Write-Output ''
Write-Output 'Siguiente paso:  docker compose up --build'
