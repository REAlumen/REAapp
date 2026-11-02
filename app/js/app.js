import { Engine } from './engine.js';
import { isKnownFormat, migrateComposition, newComposition } from './model.js';
import { OutputManager } from './output.js';
import { UI } from './ui.js';
import { AdvancedOutput } from './advanced-output.js';
import { parseAvc } from './arena-import.js';
import { NdiClient, ProgramSender } from './ndi.js';

class App {
  constructor() {
    this.comp = newComposition();
    const canvas = document.getElementById('comp');
    this.engine = new Engine(canvas, this.comp, (type, data) => this.onEngine(type, data));
    this.ndi = new NdiClient();
    this.engine.ndi = this.ndi;
    this.program = new ProgramSender(this.engine, this.ndi);
    this.engine.previewCtx = document.getElementById('preview').getContext('2d', { alpha: false, willReadFrequently: false });
    this.engine.resize();
    this.outputs = new OutputManager(canvas, this.ndi);
    this.outputs.setComposition(this.comp);
    this.outputs.onWindowClosed = () => {
      if (!this.advanced.root.hidden) this.advanced.renderPanels();
      this.ui.renderTop();
    };
    this.ui = new UI(this);
    this.advanced = new AdvancedOutput(this);
    this.ui.renderAll();
    this.advanced.refreshDisplays();
    this.ndi.onChange = () => {
      this.syncNdi();
      this.ui.renderTop();
      if (this.ui.browserTab === 'sources') this.ui.renderBrowser();
      if (this.ui.tab === 'composition') this.ui.renderProps();
    };
    this.ui.refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', () => this.ui.refreshDevices());
    window.addEventListener('keydown', (e) => this.ui.handleKey(e));
    window.addEventListener('mousedown', (e) => {
      for (const menu of document.querySelectorAll('details.menu[open], details.ao-add[open]')) {
        if (!menu.contains(e.target)) menu.open = false;
      }
    });
    window.addEventListener('beforeunload', () => this.outputs.closeAll());
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    setInterval(() => this.autosave(), 15000);
    this.restore();
  }

  onEngine(type, data) {
    if (type === 'clip') {
      this.ui.makeThumb(data);
      this.ui.renderGridSoon();
      if (this.ui.sel.clip === data.id) this.ui.renderProps();
    }
    if (type === 'connect') this.ui.renderGridSoon();
  }

  loop(now) {
    this.engine.frame(now);
    this.outputs.frame();
    this.ui.tick();
    requestAnimationFrame(this.loop);
  }

  syncNdi() {
    this.program.sync(this.comp.ndiOutput);
  }

  disableOutputs() {
    for (const screen of this.comp.screens) {
      screen.device = { type: 'virtual' };
      this.outputs.applyDevice(screen);
    }
  }

  // Abre un número gigante en cada pantalla durante 3 segundos.
  async identifyDisplays() {
    const displays = await window.native.displays();
    displays.forEach((d, i) => {
      const win = window.open('about:blank', `identify:${d.id}:fullscreen:${Date.now()}`);
      if (!win) return;
      win.document.title = `Pantalla ${i + 1}`;
      win.document.body.style.cssText = 'margin:0;background:#000;color:#00c8d7;display:flex;align-items:center;justify-content:center;height:100vh;font:bold 40vh Segoe UI,sans-serif;';
      win.document.body.textContent = String(i + 1);
      setTimeout(() => win.close(), 3000);
    });
  }

  async snapshot() {
    await window.native.savePng(this.engine.canvas.toDataURL('image/png'), `${this.comp.name}.png`);
  }

  setComposition(comp) {
    comp.ndiOutput ??= { enabled: false, name: 'REAlumen', fps: 30 };
    migrateComposition(comp);
    this.comp = comp;
    this.outputs.setComposition(comp);
    this.engine.setComposition(comp);
    this.ui.sel = {};
    this.ui.tab = 'composition';
    this.ui.thumbs.clear();
    this.ui.renderAll();
    this.syncNdi();
    this.restoreDevices();
  }

  // Al abrir, una salida a monitor secundario o NDI vuelve sola; nunca tapa la pantalla principal.
  async restoreDevices() {
    await this.ndi.ready;
    const displays = await window.native.displays();
    const comp = this.comp;
    for (const screen of comp.screens) {
      const { device } = screen;
      if (device.type === 'virtual' || device.type === 'ndi') continue;
      const d = displays.find((x) => x.id === device.displayId);
      if (!d || d.primary) screen.device = { type: 'virtual' };
      else this.outputs.applyDevice(screen);
    }
    this.ui.renderTop();
  }

  serialize() {
    return JSON.stringify(this.comp, null, 1);
  }

  autosave() { window.native.autosaveWrite(this.serialize()); }

  async restore() {
    const text = await window.native.autosaveRead();
    if (!text) return;
    try {
      const comp = JSON.parse(text);
      if (isKnownFormat(comp)) this.setComposition(comp);
    } catch (err) {
      console.warn('Autoguardado ignorado:', err.message);
    }
  }

  newFile() {
    if (window.confirm('¿Crear una composición nueva? Los cambios sin guardar se perderán.')) this.setComposition(newComposition());
  }

  async save() {
    await window.native.saveFile(this.serialize(), `${this.comp.name}.realumen`);
  }

  async open() {
    const [path] = await window.native.openFiles('composition');
    if (!path) return;
    try {
      const comp = JSON.parse(await window.native.readText(path));
      if (!isKnownFormat(comp)) throw new Error('Formato no reconocido');
      this.setComposition(comp);
    } catch (err) {
      window.alert(`No se pudo abrir: ${err.message}`);
    }
  }

  async importAvc() {
    const [path] = await window.native.openFiles('avc');
    if (!path) return;
    try {
      const { comp, stats } = parseAvc(await window.native.readText(path));
      this.setComposition(comp);
      window.alert(`Importados ${stats.clips} clips (${stats.media} con archivo, ${stats.unsupported} fuentes internas sin importar).${stats.unknownBlends ? ` ${stats.unknownBlends} capas usan una mezcla aún sin traducir y quedaron en Alpha.` : ''}${stats.unimplementedBlends.length ? ` Mezclas aún no implementadas (se ven como Alpha): ${[...new Set(stats.unimplementedBlends)].join(', ')}.` : ''}`);
    } catch (err) {
      window.alert(`No se pudo importar: ${err.message}`);
    }
  }
}

window.realumen = new App();
