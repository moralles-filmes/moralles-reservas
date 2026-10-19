param([string]$Container = 'margin-template-auto-sql-pg')
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$migrations = Join-Path $repo 'supabase\migrations'
$scratch = Join-Path $env:TEMP 'margin-template-auto-73-bridges'
New-Item -ItemType Directory -Path $scratch -Force | Out-Null

$identity = docker inspect --format '{{.Config.Image}} {{.HostConfig.NetworkMode}} {{json .HostConfig.PortBindings}}' $Container
if ($LASTEXITCODE -ne 0 -or $identity -ne 'public.ecr.aws/supabase/postgres:17.11.0.004 none {}') {
  throw "The disposable Postgres container is not quarantined: $identity"
}

$extract = Join-Path $PSScriptRoot '66-extract-bridge.mjs'
node $extract (Join-Path $PSScriptRoot '41-automation-resource-confirm-testsetup.mjs') "if (process.argv.length === 3 && process.argv[2] === '--source-check')" schema (Join-Path $scratch 'bridge41.sql')
if ($LASTEXITCODE -ne 0) { throw 'bridge41 extraction failed' }
node $extract (Join-Path $PSScriptRoot '48-waitlist-voucher-testsetup.mjs') "if(process.argv.length===3&&process.argv[2]==='--source-check')" schema (Join-Path $scratch 'bridge48.sql')
if ($LASTEXITCODE -ne 0) { throw 'bridge48 extraction failed' }
node $extract (Join-Path $PSScriptRoot '38-automation-acceptance-testsetup.mjs') 'for (let pass = 1; pass <= 2; pass++)' transaction (Join-Path $scratch 'setup38.sql') "if (process.argv.length === 3 && process.argv[2] === '--source-check')" 'const literal'
if ($LASTEXITCODE -ne 0) { throw 'setup38 extraction failed' }

function Apply-Sql([string]$path) {
  Write-Output ('APPLY ' + [IO.Path]::GetFileName($path))
  Get-Content -LiteralPath $path -Raw | docker exec -i $Container psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1
  if ($LASTEXITCODE -ne 0) { throw "SQL failed: $path" }
}
function Apply-Migration([string]$prefix) {
  $file = Get-ChildItem -LiteralPath $migrations -Filter ($prefix + '*.sql') | Select-Object -First 1
  if (-not $file) { throw "Missing migration: $prefix" }
  Apply-Sql $file.FullName
}
function Apply-Bridge([string]$path) {
  $sql = "begin; set local lock_timeout='5s'; set local statement_timeout='20s';`n" + (Get-Content -LiteralPath $path -Raw) + "`ncommit;"
  foreach ($pass in 1..2) {
    $sql | docker exec -i $Container psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1
    if ($LASTEXITCODE -ne 0) { throw "Bridge failed: $path" }
  }
}

Apply-Sql (Join-Path $PSScriptRoot '25-template-bootstrap.sql')
foreach ($prefix in @('20261003225857','20261004002728','20261004014032','20261004025039','20261004165825','20261004184738','20261005145913')) {
  Apply-Migration $prefix
}
Apply-Bridge (Join-Path $scratch 'bridge41.sql')
Apply-Migration '20261005170415'
Apply-Sql (Join-Path $PSScriptRoot '44-outbox-automation-bootstrap.sql')
Apply-Migration '20261006003631'
Apply-Bridge (Join-Path $scratch 'bridge48.sql')
Apply-Migration '20261009003452'
Apply-Migration '20261009135808'
foreach ($pass in 1..2) { Apply-Sql (Join-Path $scratch 'setup38.sql') }
docker exec $Container psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -c "select cron.unschedule(jobid) from cron.job where jobname in('whatsapp-automation-worker','whatsapp-template-workers')" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cron quarantine failed' }
Apply-Sql (Join-Path $PSScriptRoot '52-automation-receipts-bootstrap.sql')
Apply-Sql (Join-Path $PSScriptRoot '56-template-management-bootstrap.sql')
foreach ($prefix in @('20261009153435','20261009180617','20261009220823','20261017120000','20261017200000')) {
  Apply-Migration $prefix
}
$legacyUpdatedAt = @'
create or replace function public.update_updated_at()
returns trigger language plpgsql set search_path=public as $$
begin
  new.updated_at=now();
  return new;
end $$;
revoke all on function public.update_updated_at() from public,anon,authenticated,service_role;
'@
$legacyUpdatedAt | docker exec -i $Container psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1
if ($LASTEXITCODE -ne 0) { throw 'Local legacy updated-at helper failed' }
Apply-Migration '20261014120000'
# The minimal 25 fixture predates the general status writer columns/checks.
# Restore only its local prerequisites before installing the historical RPC
# used by the new row-locked template heartbeat writer.
$healthBridge = @'
alter table public.whatsapp_channels
  add column if not exists display_phone text,
  add column if not exists connected_at timestamptz,
  add column if not exists last_error text;
alter table public.whatsapp_channel_lifecycle_events
  drop constraint if exists whatsapp_channel_lifecycle_events_provider_check;
alter table public.whatsapp_channel_lifecycle_events
  add constraint whatsapp_channel_lifecycle_events_provider_check
  check (provider in ('zapi','uazapi','waha','official','datafy'));
'@
$healthBridge | docker exec -i $Container psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1
if ($LASTEXITCODE -ne 0) { throw 'Local status-writer bridge failed' }
Apply-Migration '20260901225539'
Apply-Migration '20261017203000'
Write-Output 'BOOTSTRAP-THROUGH-73-READY'
