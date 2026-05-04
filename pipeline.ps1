# pipeline.ps1
# Waits for enrich_cards -> runs enrich_yandex per file -> merges hot leads
# Launch: powershell -ExecutionPolicy Bypass -File pipeline.ps1

$ErrorActionPreference = "Continue"
$nodeScripts = Join-Path $PSScriptRoot "node_scripts"

Write-Host ""
Write-Host "=== PIPELINE START ===" -ForegroundColor Cyan
Write-Host (Get-Date -Format "yyyy-MM-dd HH:mm:ss")

# --- Step 1: Wait for all enrich_cards.cjs processes to finish ---
Write-Host ""
Write-Host "[1/3] Waiting for enrich_cards.cjs to finish..." -ForegroundColor Yellow

while ($true) {
    $procs = Get-Process -Name "node" -ErrorAction SilentlyContinue |
        Where-Object {
            try {
                $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
                $cmdLine -and $cmdLine -match "enrich_cards"
            } catch { $false }
        }

    if (-not $procs -or @($procs).Count -eq 0) {
        Write-Host "  All enrich_cards.cjs processes finished." -ForegroundColor Green
        break
    }

    $count = @($procs).Count
    $ts = Get-Date -Format "HH:mm:ss"
    Write-Host "  $ts - $count enrich_cards process(es) running. Next check in 60s..."
    Start-Sleep -Seconds 60
}

# --- Step 2: Run enrich_yandex.cjs for each file ---
Write-Host ""
Write-Host "[2/3] Running enrich_yandex.cjs..." -ForegroundColor Yellow

$yandexJobs = @(
    @{ file = "..\novosibirsk_salons.json";    city = "novosibirsk" },
    @{ file = "..\barnaul_salons_full.json";   city = "barnaul" },
    @{ file = "..\barnaul_barbershops.json";   city = "barnaul" }
)

foreach ($job in $yandexJobs) {
    $basename = Split-Path $job.file -Leaf
    Write-Host ""
    Write-Host "  --- $basename ($($job.city)) ---" -ForegroundColor Cyan
    Write-Host "  Started: $(Get-Date -Format 'HH:mm:ss')"

    $fullPath = Join-Path $nodeScripts $job.file
    if (-not (Test-Path $fullPath)) {
        Write-Host "  SKIP: file not found" -ForegroundColor Red
        continue
    }

    Push-Location $nodeScripts
    node enrich_yandex.cjs --file $job.file --city $job.city --threshold 50
    $ec = $LASTEXITCODE
    Pop-Location

    if ($ec -ne 0) {
        Write-Host "  WARNING: enrich_yandex exited with code $ec" -ForegroundColor Red
    } else {
        Write-Host "  Done: $(Get-Date -Format 'HH:mm:ss')" -ForegroundColor Green
    }
}

# --- Step 3: Merge hot leads ---
Write-Host ""
Write-Host "[3/3] Merging hot leads..." -ForegroundColor Yellow

Push-Location $nodeScripts
node merge_hot_leads.cjs
$ec = $LASTEXITCODE
Pop-Location

if ($ec -ne 0) {
    Write-Host "  WARNING: merge exited with code $ec" -ForegroundColor Red
} else {
    Write-Host "  Merge complete." -ForegroundColor Green
}

Write-Host ""
Write-Host "=== PIPELINE DONE ===" -ForegroundColor Cyan
Write-Host (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
Write-Host "Output: hot_leads_all.json"
Write-Host ""

# Sleep after pipeline completes
Write-Host "Going to sleep in 10 seconds..." -ForegroundColor Yellow
Start-Sleep -Seconds 10
rundll32.exe powrprof.dll,SetSuspendState 0,1,0
