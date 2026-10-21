param([string]$Container = 'margin-v2-service-sql-pg')
$ErrorActionPreference = 'Stop'
$dockerExe = (Get-Command docker -ErrorAction Stop).Source
$identity = & $dockerExe inspect --format '{{.Config.Image}} {{.HostConfig.NetworkMode}} {{json .HostConfig.PortBindings}}' $Container
if ($LASTEXITCODE -ne 0 -or $identity -ne 'public.ecr.aws/supabase/postgres:17.11.0.004 none {}') {
  throw "The disposable Postgres container is not quarantined: $identity"
}
function Query([string]$Sql) {
  $result = & $dockerExe exec $Container psql -U postgres -d postgres -X -q -A -t -v ON_ERROR_STOP=1 -c $Sql
  if ($LASTEXITCODE -ne 0) { throw "Local SQL failed: $Sql" }
  return ($result | Out-String).Trim()
}
$fixture = Join-Path $PSScriptRoot '79-whatsapp-v2-two-session-fixture.sql'
Get-Content -LiteralPath $fixture -Raw | & $dockerExe exec -i $Container psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1
if ($LASTEXITCODE -ne 0) { throw 'Two-session fixture failed' }
$binding = Query "select id from public.whatsapp_template_bindings where channel_id='79000000-0000-4000-8000-000000000005'::uuid"
if ($binding -notmatch '^[0-9a-f-]{36}$') { throw "Invalid local binding id: $binding" }
$owner = '79000000-0000-4000-8000-000000000003'
$sqlA = @"
begin;
select set_config('application_name','v2-cas-a',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','$owner',true);
select public.set_whatsapp_v2_service_preference('$binding'::uuid,'confirmation',true,0,1,0);
select pg_sleep(8);
commit;
"@
$sqlB = @"
begin;
select set_config('application_name','v2-cas-b',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','$owner',true);
select public.set_whatsapp_v2_service_preference('$binding'::uuid,'confirmation',true,0,1,0);
commit;
"@
$call = {
  param($DockerExe,$Container,$Sql)
  $out = & $DockerExe exec $Container psql -U postgres -d postgres -X -q -A -t `
    -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c $Sql 2>&1
  [pscustomobject]@{ exit = $LASTEXITCODE; output = ($out | Out-String) }
}
$jobA = Start-Job -ScriptBlock $call -ArgumentList $dockerExe,$Container,$sqlA
$jobB = $null
try {
  $sleepSeen = $false
  for ($i=0; $i -lt 60; $i++) {
    if ((Query "select count(*) from pg_stat_activity where application_name='v2-cas-a' and wait_event='PgSleep'") -eq '1') {
      $sleepSeen = $true; break
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $sleepSeen) { throw 'Session A never held the opt-in transaction open' }
  $jobB = Start-Job -ScriptBlock $call -ArgumentList $dockerExe,$Container,$sqlB
  $lockSeen = $false
  for ($i=0; $i -lt 60; $i++) {
    if ((Query "select count(*) from pg_stat_activity where application_name='v2-cas-b' and wait_event_type='Lock'") -eq '1') {
      $lockSeen = $true; break
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $lockSeen) { throw 'Session B did not wait on Session A lock' }
  Wait-Job $jobA,$jobB -Timeout 20 | Out-Null
  $a = Receive-Job $jobA
  $b = Receive-Job $jobB
  if ($a.exit -ne 0 -or $a.output -notmatch '"revision"\s*:\s*1') {
    throw "Session A did not commit revision 1: $($a.output)"
  }
  if ($b.exit -eq 0 -or $b.output -notmatch 'PT409') {
    throw "Session B did not receive stale CAS PT409: $($b.output)"
  }
  $state = Query @"
select jsonb_build_object(
  'preferences',(select count(*) from app_private.whatsapp_v2_service_preferences where binding_id='$binding'::uuid and kind='confirmation' and enabled and revision=1),
  'events',(select count(*) from app_private.whatsapp_v2_service_preference_events where binding_id='$binding'::uuid and kind='confirmation'),
  'adoptions',(select count(*) from public.whatsapp_automation_adoptions where unit_id='79000000-0000-4000-8000-000000000002'::uuid),
  'permits',(select count(*) from app_private.whatsapp_v2_service_binding_permits where binding_id='$binding'::uuid)
)::text
"@ | ConvertFrom-Json
  if ($state.preferences -ne 1 -or $state.events -ne 1 -or
      $state.adoptions -ne 1 -or $state.permits -ne 0) {
    throw "Two-session state mismatch: $($state | ConvertTo-Json -Compress)"
  }
  Remove-Job $jobA,$jobB -Force
  $jobA = $null; $jobB = $null
  $admin = '79000000-0000-4000-8000-000000000004'
  $sqlPauseA = @"
begin;
select set_config('application_name','v2-pause-a',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','$admin',true);
select public.release_whatsapp_template_channel('79000000-0000-4000-8000-000000000005'::uuid,'dispatch',false,0,1);
select pg_sleep(8);
commit;
"@
  $sqlPauseB = @"
begin;
select set_config('application_name','v2-pause-b',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','$owner',true);
select public.set_whatsapp_v2_service_preference('$binding'::uuid,'waitlist_table_ready',true,0,1,0);
commit;
"@
  $jobA = Start-Job -ScriptBlock $call -ArgumentList $dockerExe,$Container,$sqlPauseA
  $sleepSeen = $false
  for ($i=0; $i -lt 60; $i++) {
    if ((Query "select count(*) from pg_stat_activity where application_name='v2-pause-a' and wait_event='PgSleep'") -eq '1') {
      $sleepSeen = $true; break
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $sleepSeen) { throw 'Admin session never held the pause transaction open' }
  $jobB = Start-Job -ScriptBlock $call -ArgumentList $dockerExe,$Container,$sqlPauseB
  $lockSeen = $false
  for ($i=0; $i -lt 60; $i++) {
    if ((Query "select count(*) from pg_stat_activity where application_name='v2-pause-b' and wait_event_type='Lock'") -eq '1') {
      $lockSeen = $true; break
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $lockSeen) { throw 'Store session did not wait on admin pause lock' }
  Wait-Job $jobA,$jobB -Timeout 20 | Out-Null
  $pauseA = Receive-Job $jobA
  $pauseB = Receive-Job $jobB
  if ($pauseA.exit -ne 0 -or $pauseA.output -notmatch '(^|\s)t(\s|$)') {
    throw "Admin pause did not commit: $($pauseA.output)"
  }
  if ($pauseB.exit -eq 0 -or $pauseB.output -notmatch 'P0A01') {
    throw "Store opt-in did not respect admin pause: $($pauseB.output)"
  }
  $pausedState = Query @"
select jsonb_build_object(
  'paused',(select not dispatch_enabled from public.whatsapp_template_bindings where id='$binding'::uuid),
  'table_ready_preferences',(select count(*) from app_private.whatsapp_v2_service_preferences where binding_id='$binding'::uuid and kind='waitlist_table_ready'),
  'table_ready_events',(select count(*) from app_private.whatsapp_v2_service_preference_events where binding_id='$binding'::uuid and kind='waitlist_table_ready')
)::text
"@ | ConvertFrom-Json
  if ($pausedState.paused -ne $true -or $pausedState.table_ready_preferences -ne 0 -or
      $pausedState.table_ready_events -ne 0) {
    throw "Admin pause state mismatch: $($pausedState | ConvertTo-Json -Compress)"
  }
  Write-Output 'GREEN79 two real PG17 sessions: CAS one win/one PT409; admin pause beats store opt-in P0A01; lock waits observed, one audit/adoption'
} finally {
  foreach ($job in @($jobA,$jobB)) {
    if ($null -ne $job) {
      if ($job.State -eq 'Running') { Stop-Job $job }
      Remove-Job $job -Force
    }
  }
}
