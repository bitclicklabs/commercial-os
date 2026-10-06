<#
.SYNOPSIS
Sincroniza apps/twenty-app con la instancia local de Twenty desde Windows.

.DESCRIPTION
Evita dos fallos de la CLI de Twenty en Windows:

  1. `yarn twenty apply` falla con "Resource path must not contain backslashes".
  2. La subida de archivos usa la SERVER_URL del servidor (http://localhost:3020),
     que dentro de un contenedor no resuelve.

El script ejecuta `yarn twenty apply` (o `plan`) en un contenedor efimero node:24
conectado a la red pxos-net. Dentro del contenedor, socat reenvia
127.0.0.1:3020 a pxos-twenty:3000, de modo que http://localhost:3020 resuelve
igual que en el host. El contenedor trabaja sobre una COPIA temporal de
apps/twenty-app (sin node_modules, .twenty ni .yarn); el codigo original no se
modifica.

La API key se lee de TWENTY_API_KEY en deployments/.env (o de la variable de
entorno del mismo nombre, que tiene prioridad). Nunca se escribe en disco ni se
pasa como argumento en la linea de comandos de docker.

El script no borra nada fuera del directorio temporal que crea. No ejecuta
`docker compose`; solo `docker run --rm` sobre un contenedor efimero.

.PARAMETER Action
`apply` (por defecto) aplica la App. `plan` solo previsualiza los cambios.

.PARAMETER Force
Solo con `apply`: anade --force. Usalo unicamente tras revisar los cambios
destructivos con `-Action plan`.

.PARAMETER EnvFile
Ruta del archivo .env con TWENTY_API_KEY. Por defecto, deployments/.env.

.PARAMETER Network
Red Docker del stack. Por defecto, pxos-net.

.PARAMETER TwentyContainer
Contenedor de Twenty al que reenvia socat. Por defecto, pxos-twenty.

.PARAMETER Image
Imagen del contenedor efimero. Por defecto, node:24.

.PARAMETER RemoteName
Nombre del remote que se crea dentro del contenedor. Por defecto, pxos-tunnel.

.PARAMETER KeepTemp
Conserva el directorio temporal (para depurar). Por defecto se elimina.

.EXAMPLE
.\scripts\sync-twenty-app.ps1

.EXAMPLE
.\scripts\sync-twenty-app.ps1 -Action plan

.EXAMPLE
.\scripts\sync-twenty-app.ps1 -Force
#>
[CmdletBinding()]
param(
    [ValidateSet('apply', 'plan')]
    [string]$Action = 'apply',

    [switch]$Force,

    [string]$EnvFile,

    [string]$Network = 'pxos-net',

    [string]$TwentyContainer = 'pxos-twenty',

    [string]$Image = 'node:24',

    [string]$RemoteName = 'pxos-tunnel',

    [switch]$KeepTemp
)

# 'Continue' a proposito: en Windows PowerShell 5.1 los comandos nativos que
# escriben en stderr no deben convertirse en excepciones. Se comprueba
# $LASTEXITCODE a mano tras cada llamada a docker/robocopy.
$ErrorActionPreference = 'Continue'

function Stop-Script {
    param([string]$Message)
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

# --- Rutas -------------------------------------------------------------------

$repoRoot = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $repoRoot 'apps\twenty-app'
if (-not $EnvFile) {
    $EnvFile = Join-Path $repoRoot 'deployments\.env'
}

if (-not (Test-Path -LiteralPath (Join-Path $appDir 'package.json'))) {
    Stop-Script "No encuentro apps\twenty-app\package.json en $repoRoot. Ejecuta el script desde un checkout del repositorio."
}

# --- API key -----------------------------------------------------------------

$apiKey = $env:TWENTY_API_KEY
$keyFromEnvironment = [bool]$apiKey
if (-not $apiKey) {
    if (-not (Test-Path -LiteralPath $EnvFile)) {
        Stop-Script "No existe $EnvFile. Crealo desde deployments\.env.example y anade TWENTY_API_KEY."
    }
    foreach ($line in (Get-Content -LiteralPath $EnvFile -Encoding UTF8)) {
        if ($line -match '^\s*TWENTY_API_KEY\s*=\s*(.*)$') {
            $apiKey = $Matches[1].Trim().Trim('"').Trim("'")
        }
    }
}
if (-not $apiKey) {
    Stop-Script "TWENTY_API_KEY esta vacia o no existe en $EnvFile. Crea la API key en Settings > APIs & Webhooks y anadela al archivo."
}

# --- Comprobaciones de Docker (solo lectura) ---------------------------------

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Stop-Script 'No encuentro el comando docker. Inicia Docker Desktop.'
}

$netFound = & docker network ls --filter "name=^$Network$" --format '{{.Name}}'
if ($LASTEXITCODE -ne 0) {
    Stop-Script 'No puedo hablar con el daemon de Docker. Inicia Docker Desktop.'
}
if (-not $netFound) {
    Stop-Script "No existe la red $Network. Levanta el stack con 'docker compose up -d' en deployments\."
}

$twentyRunning = & docker ps --filter "name=^$TwentyContainer$" --filter 'status=running' --format '{{.Names}}'
if (-not $twentyRunning) {
    Stop-Script "El contenedor $TwentyContainer no esta en ejecucion. Levanta el stack con 'docker compose up -d' en deployments\."
}

# --- Copia temporal de la App ------------------------------------------------

$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
$work = Join-Path $tempRoot ('pxos-twenty-sync-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$appCopy = Join-Path $work 'app'
New-Item -ItemType Directory -Path $appCopy -Force | Out-Null

$exitCode = 1
try {
    Write-Host "Copiando apps\twenty-app a $appCopy (sin node_modules, .twenty ni .yarn)..."
    & robocopy $appDir $appCopy /E /XD node_modules .twenty .yarn /NFL /NDL /NJH /NJS /NP | Out-Null
    # robocopy devuelve 0-7 si la copia fue correcta, 8 o mas si hubo errores.
    if ($LASTEXITCODE -ge 8) {
        Stop-Script "robocopy fallo con codigo $LASTEXITCODE."
    }

    # Script que se ejecuta dentro del contenedor. Se escribe con finales de
    # linea LF y sin BOM: bash falla con CRLF.
    $applyArgs = $Action
    if ($Force -and $Action -eq 'apply') {
        $applyArgs = 'apply --force'
    }
    $inner = @"
set -eu

echo '[contenedor] Instalando socat...'
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends socat >/dev/null

echo '[contenedor] Reenviando 127.0.0.1:3020 -> ${TwentyContainer}:3000'
socat TCP-LISTEN:3020,bind=127.0.0.1,fork,reuseaddr TCP:${TwentyContainer}:3000 &
SOCAT_PID=`$!
sleep 1

echo '[contenedor] Activando corepack e instalando dependencias...'
corepack enable
yarn install

echo '[contenedor] Registrando el remote ${RemoteName}...'
yarn twenty remote:add --url http://localhost:3020 --api-key "`$TWENTY_API_KEY" --as ${RemoteName}
yarn twenty remote:use ${RemoteName}

echo '[contenedor] Ejecutando: yarn twenty ${applyArgs}'
STATUS=0
yarn twenty ${applyArgs} || STATUS=`$?

kill "`$SOCAT_PID" 2>/dev/null || true
exit "`$STATUS"
"@
    $inner = $inner -replace "`r`n", "`n"
    $scriptPath = Join-Path $work 'run.sh'
    [System.IO.File]::WriteAllText($scriptPath, $inner, (New-Object System.Text.UTF8Encoding($false)))

    Write-Host "Ejecutando 'yarn twenty $applyArgs' en un contenedor $Image sobre la red $Network..."
    # La API key viaja por variable de entorno (-e NOMBRE sin valor): no aparece
    # en la linea de comandos de docker.
    $env:TWENTY_API_KEY = $apiKey
    & docker run --rm `
        --network $Network `
        --mount "type=bind,source=$work,target=/work" `
        -w /work/app `
        -e TWENTY_API_KEY `
        $Image `
        bash /work/run.sh
    $exitCode = $LASTEXITCODE
}
finally {
    # Quita la clave del entorno de esta sesion solo si la leimos del .env.
    if (-not $keyFromEnvironment) {
        Remove-Item Env:\TWENTY_API_KEY -ErrorAction SilentlyContinue
    }

    if ($KeepTemp) {
        Write-Host "Directorio temporal conservado: $work"
    }
    else {
        # Borra solo el directorio temporal creado arriba. `rd /s /q` soporta
        # mejor que Remove-Item las rutas largas de node_modules.
        $leaf = Split-Path -Leaf $work
        $parent = [System.IO.Path]::GetFullPath((Split-Path -Parent $work))
        if ($leaf -like 'pxos-twenty-sync-*' -and $parent -eq $tempRoot -and (Test-Path -LiteralPath $work)) {
            & cmd.exe /c "rd /s /q `"$work`""
        }
    }
}

if ($exitCode -ne 0) {
    Stop-Script "yarn twenty $Action termino con codigo $exitCode."
}

Write-Host "Listo: yarn twenty $Action completado." -ForegroundColor Green
Write-Host 'Comprueba el resultado en http://localhost:3020/settings/applications#developer'
exit 0
