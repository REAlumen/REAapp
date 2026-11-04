import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { ndiCandidates, libcName, loadFirst } = createRequire(import.meta.url)('../ndi-lib.js');

test('en Windows se usa la carpeta del NDI Runtime', () => {
  assert.deepEqual(ndiCandidates('win32', { NDI_RUNTIME_DIR_V6: 'C:\\NDI 6' }), ['C:\\NDI 6\\Processing.NDI.Lib.x64.dll']);
  assert.deepEqual(ndiCandidates('win32', {}), []);
  assert.equal(libcName('win32'), 'msvcrt.dll');
});

test('en Linux se busca libndi.so.6 en las rutas del sistema', () => {
  const list = ndiCandidates('linux', {});
  assert.equal(list[0], 'libndi.so.6');
  assert.ok(list.includes('/usr/local/lib/libndi.so.6'));
  assert.equal(libcName('linux'), 'libc.so.6');
});

test('se prueba cada ruta hasta que una carga', () => {
  const tried = [];
  const lib = loadFirst((file) => {
    tried.push(file);
    if (file !== '/usr/local/lib/libndi.so.6') throw new Error('no existe');
    return { file };
  }, 'linux', {});
  assert.equal(lib.file, '/usr/local/lib/libndi.so.6');
  assert.equal(tried[0], 'libndi.so.6');
});

test('sin NDI instalado se informa qué instalar en cada sistema', () => {
  assert.throws(() => loadFirst(() => { throw new Error('no'); }, 'linux', {}), /NDI SDK para Linux/);
  assert.throws(() => loadFirst(() => { throw new Error('no'); }, 'win32', {}), /NDI Tools/);
});
