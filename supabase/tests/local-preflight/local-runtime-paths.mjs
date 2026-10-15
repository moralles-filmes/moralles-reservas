// Resolve installed Docker Desktop only; never search PATH or accept executable overrides.
import { statSync } from 'node:fs';
import { win32, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function dockerCandidates(platform, environment) {
  if (platform !== 'win32') throw new Error('local_runtime_windows_required');
  return [
    [environment.LOCALAPPDATA, 'Programs/DockerDesktop/resources/bin/docker.exe'],
    // Windows app sandbox may virtualize LOCALAPPDATA; USERPROFILE retains the native install root.
    [environment.USERPROFILE, 'AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe'],
    [environment.ProgramFiles, 'Docker/Docker/resources/bin/docker.exe'],
  ].flatMap(([base, suffix]) => typeof base === 'string' && /^[a-z]:[\\/]/i.test(base)
    ? [win32.join(base, suffix).replaceAll('\\', '/')]
    : []);
}

export function resolveLocalDocker() {
  for (const candidate of dockerCandidates(process.platform, process.env)) {
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* Try the next installed location. */ }
  }
  throw new Error('local_runtime_docker_desktop_not_installed');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--docker') throw new Error('local_runtime_arguments_refused');
  console.log(resolveLocalDocker());
}
