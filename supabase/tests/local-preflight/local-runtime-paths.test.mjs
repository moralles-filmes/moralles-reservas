import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dockerCandidates } from './local-runtime-paths.mjs';

test('only fixed Docker Desktop installation suffixes are candidates, including spaces', () => {
  assert.deepEqual(dockerCandidates('win32', { LOCALAPPDATA: 'C:\\Users\\Some User\\AppData\\Local', ProgramFiles: 'C:\\Program Files', TASK_DOCKER: 'C:/untrusted.exe', PATH: 'C:/untrusted' }), [
    'C:/Users/Some User/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe',
    'C:/Program Files/Docker/Docker/resources/bin/docker.exe',
  ]);
});
test('missing, relative and network roots cannot select executables', () => {
  assert.deepEqual(dockerCandidates('win32', {}), []);
  assert.deepEqual(dockerCandidates('win32', { LOCALAPPDATA: '../outside', ProgramFiles: '\\\\host\\share' }), []);
  assert.throws(() => dockerCandidates('linux', {}), /windows_required/);
});
test('native profile installation remains available with sandbox-virtualized LOCALAPPDATA', () => {
  assert.deepEqual(dockerCandidates('win32', { LOCALAPPDATA: 'C:/Users/N/AppData/Local/Packages/sandbox/AC', USERPROFILE: 'C:/Users/N' }), [
    'C:/Users/N/AppData/Local/Packages/sandbox/AC/Programs/DockerDesktop/resources/bin/docker.exe',
    'C:/Users/N/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe',
  ]);
});
