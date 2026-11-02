const { app, BrowserWindow, dialog, ipcMain, MessageChannelMain, protocol, screen, session, shell, powerSaveBlocker, utilityProcess } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const APP_DIR = path.join(__dirname, 'app');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
};
const MEDIA_EXT = new Set(Object.keys(MIME).filter((e) => !['.html', '.js', '.css'].includes(e)));

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true },
}]);

// Rendimiento de show: la salida no debe frenarse si la ventana principal queda tapada.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

function serveFile(filePath, request) {
  const stat = fs.statSync(filePath);
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
      status: 206,
      headers: {
        'Content-Type': type, 'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Access-Control-Allow-Origin': 'app://local',
      },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
    headers: {
      'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(stat.size),
      'Access-Control-Allow-Origin': 'app://local',
    },
  });
}

function handleProtocol(request) {
  const url = new URL(request.url);
  try {
    if (url.hostname === 'media') {
      const filePath = decodeURIComponent(url.pathname.slice(1));
      if (!MEDIA_EXT.has(path.extname(filePath).toLowerCase())) return new Response('forbidden', { status: 403 });
      return serveFile(filePath, request);
    }
    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '') || 'index.html';
    const filePath = path.join(APP_DIR, rel);
    if (!filePath.startsWith(APP_DIR)) return new Response('forbidden', { status: 403 });
    return serveFile(filePath, request);
  } catch {
    return new Response('not found', { status: 404 });
  }
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600, height: 950, backgroundColor: '#1b1c20', title: 'REAlumen', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  mainWindow.setMenu(null);

  // Las salidas son ventanas hijas del mismo proceso: la composición se copia directamente a ellas.
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    const m = /^(output|identify):(\d+):(fullscreen|windowed):/.exec(frameName || '');
    if (url !== 'about:blank' || !m) return { action: 'deny' };
    const display = screen.getAllDisplays().find((d) => String(d.id) === m[2]) || screen.getPrimaryDisplay();
    const b = display.bounds;
    return {
      action: 'allow',
      overrideBrowserWindowOptions: m[3] === 'fullscreen'
        ? { x: b.x, y: b.y, width: b.width, height: b.height, frame: false, backgroundColor: '#000', autoHideMenuBar: true }
        : { x: b.x + 80, y: b.y + 80, width: Math.min(960, b.width - 160), height: Math.min(540, b.height - 160), backgroundColor: '#000', autoHideMenuBar: true, title: 'Salida' },
    };
  });
  mainWindow.webContents.on('did-create-window', (win, { frameName }) => {
    win.setMenu(null);
    const m = /^(output|identify):\d+:(fullscreen|windowed):/.exec(frameName || '');
    if (m?.[2] === 'fullscreen') win.setFullScreen(true);
  });
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(event, () => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send('displays-changed'); });
  }
  mainWindow.on('closed', () => app.quit());
  mainWindow.webContents.once('did-finish-load', startNdiHost);
  mainWindow.loadURL('app://local/index.html');
}

function startNdiHost() {
  const child = utilityProcess.fork(path.join(__dirname, 'ndi-host.js'), [], { serviceName: 'REAlumen NDI', stdio: 'inherit' });
  const { port1, port2 } = new MessageChannelMain();
  child.postMessage({ type: 'port' }, [port1]);
  mainWindow.webContents.postMessage('ndi-port', null, [port2]);
  let quitting = false;
  child.on('exit', (code) => {
    if (!quitting && !mainWindow.isDestroyed()) mainWindow.webContents.send('ndi-exit', code);
  });
  // NDI debe cerrar sus emisores y receptores de forma ordenada para que la red lo note al momento.
  app.on('before-quit', () => {
    quitting = true;
    child.postMessage({ type: 'shutdown' });
    setTimeout(() => child.kill(), 800);
  });
}

const FILTERS = {
  media: [{ name: 'Medios', extensions: [...MEDIA_EXT].map((e) => e.slice(1)) }],
  composition: [{ name: 'Composición REAlumen', extensions: ['realumen', 'prisma'] }],
  avc: [{ name: 'Composición .avc', extensions: ['avc'] }],
  xml: [{ name: 'Configuración de salida', extensions: ['xml'] }],
};

ipcMain.handle('displays', () => screen.getAllDisplays().map((d, i) => ({
  id: d.id, label: `Pantalla ${i + 1} (${d.size.width}x${d.size.height})${d.id === screen.getPrimaryDisplay().id ? ' · principal' : ''}`,
  width: d.size.width, height: d.size.height, primary: d.id === screen.getPrimaryDisplay().id,
})));
ipcMain.handle('open-files', async (_e, kind, multi) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    filters: FILTERS[kind], properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
  });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('save-file', async (_e, text, defaultName) => {
  const r = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultName, filters: [{ name: 'Composición REAlumen', extensions: ['realumen'] }] });
  if (r.canceled) return null;
  fs.writeFileSync(r.filePath, text, 'utf8');
  return r.filePath;
});
ipcMain.handle('save-png', async (_e, dataUrl, defaultName) => {
  const r = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultName, filters: [{ name: 'Imagen PNG', extensions: ['png'] }] });
  if (r.canceled) return null;
  fs.writeFileSync(r.filePath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return r.filePath;
});
ipcMain.handle('open-display-settings', () => shell.openExternal('ms-settings:display'));
ipcMain.handle('read-text', (_e, filePath) => fs.readFileSync(filePath, 'utf8'));
ipcMain.handle('autosave-write', (_e, text) => {
  fs.writeFileSync(path.join(app.getPath('userData'), 'autosave.realumen'), text, 'utf8');
});
ipcMain.handle('autosave-read', () => {
  // El autoguardado anterior al cambio de nombre sigue en la carpeta de la app antigua.
  for (const file of [path.join(app.getPath('userData'), 'autosave.realumen'), path.join(app.getPath('appData'), 'prisma-vj', 'autosave.prisma')]) {
    try { return fs.readFileSync(file, 'utf8'); } catch { /* se prueba el siguiente */ }
  }
  return null;
});

function readLocalChecks() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'local', 'checks.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function runSelftest() {
  const out = process.env.REALUMEN_SELFTEST_DIR || path.join(app.getPath('temp'), 'realumen-selftest');
  fs.mkdirSync(out, { recursive: true });
  const wc = mainWindow.webContents;
  wc.on('console-message', (e) => { if (e.level === 'error') console.log('[renderer error]', e.message); });
  await new Promise((r) => wc.once('did-finish-load', r));
  const shot = async (name) => fs.writeFileSync(path.join(out, name), (await wc.capturePage()).toPNG());
  ipcMain.handle('selftest-shot', (_e, name) => shot(name));
  ipcMain.handle('selftest-write', (_e, name, bytes) => {
    const p = path.join(out, name);
    fs.writeFileSync(p, Buffer.from(bytes));
    return p;
  });
  const options = JSON.stringify({
    video: process.env.REALUMEN_TEST_VIDEO,
    dxvFiles: process.env.REALUMEN_TEST_DXV ? JSON.parse(process.env.REALUMEN_TEST_DXV) : [],
    oracleDir: process.env.REALUMEN_ORACLE_DIR,
    localChecks: readLocalChecks(),
  });
  const result = await wc.executeJavaScript(`import("app://local/js/selftest.js").then((m) => m.run(${options}))`);
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  app.exit(result.failed === 0 ? 0 : 1);
}

// La prueba automática no debe tocar el autoguardado real del usuario.
if (process.argv.includes('--selftest')) {
  app.setPath('userData', path.join(app.getPath('temp'), 'realumen-selftest-profile'));
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

app.whenReady().then(() => {
  protocol.handle('app', handleProtocol);
  // Cámaras y capturadoras: solo la propia app puede pedirlas.
  const isApp = (url) => (url || '').startsWith('app://local');
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(permission === 'media' && isApp(wc.getURL())));
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permission === 'media' && isApp(origin));
  powerSaveBlocker.start('prevent-display-sleep');
  createWindow();
  if (process.argv.includes('--selftest')) {
    runSelftest().catch((err) => { console.error(err); app.exit(2); });
  }
});
app.on('window-all-closed', () => app.quit());
