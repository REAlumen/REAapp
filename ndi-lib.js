// Dónde está la biblioteca oficial de NDI en cada sistema. Sin dependencias para poder probarlo con node.
const path = require('path');

// Rutas que se prueban en orden: primero la carpeta que indica la instalación de NDI, después las del sistema.
function ndiCandidates(platform = process.platform, env = process.env) {
  const dirs = [env.NDI_RUNTIME_DIR_V6, env.NDI_RUNTIME_DIR_V5].filter(Boolean);
  if (platform === 'win32') return dirs.map((d) => path.win32.join(d, 'Processing.NDI.Lib.x64.dll'));
  if (platform === 'darwin') {
    return [
      ...dirs.map((d) => path.posix.join(d, 'libndi.dylib')),
      '/Library/NDI SDK for Apple/lib/macOS/libndi.dylib',
      '/usr/local/lib/libndi.dylib',
    ];
  }
  // Linux: el NDI SDK instala libndi.so.6; el cargador del sistema la encuentra por nombre si está en su ruta.
  return [
    ...dirs.map((d) => path.posix.join(d, 'libndi.so.6')),
    'libndi.so.6',
    '/usr/lib/libndi.so.6',
    '/usr/local/lib/libndi.so.6',
    '/usr/lib/x86_64-linux-gnu/libndi.so.6',
    '/usr/lib/aarch64-linux-gnu/libndi.so.6',
    'libndi.so.5',
  ];
}

// Biblioteca de C que aporta memcpy.
function libcName(platform = process.platform) {
  if (platform === 'win32') return 'msvcrt.dll';
  if (platform === 'darwin') return '/usr/lib/libSystem.B.dylib';
  return 'libc.so.6';
}

function missingMessage(platform = process.platform) {
  if (platform === 'win32') return 'NDI Runtime no instalado. Descarga NDI Tools en ndi.video/tools';
  if (platform === 'darwin') return 'NDI no instalado. Instala NDI Tools para Mac desde ndi.video/tools';
  return 'NDI no instalado. Instala el NDI SDK para Linux desde ndi.video y deja libndi.so.6 en /usr/lib o /usr/local/lib';
}

// Abre la primera ruta que funcione; si ninguna, informa sin detener la app.
function loadFirst(load, platform = process.platform, env = process.env) {
  const tried = [];
  for (const candidate of ndiCandidates(platform, env)) {
    try {
      return load(candidate);
    } catch (err) {
      tried.push(`${candidate}: ${err.message}`);
    }
  }
  const err = new Error(missingMessage(platform));
  err.tried = tried;
  throw err;
}

module.exports = { ndiCandidates, libcName, missingMessage, loadFirst };
