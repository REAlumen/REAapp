import { BLEND_MODES, clipKey, findClip, getClip, isStill, layerOpacity, newClip, newComposition, newLayer, setClip, sourceFromPath, toDb, uid } from './model.js';
import { EFFECTS, GENERATORS } from './shaders.js';
import { parseAvc } from './avc-import.js';
import {
  clearColumn, clearLayerClips, columnInfo, duplicateColumn, duplicateLayer, insertColumn, insertLayer, removeColumns, removeLayer as removeLayerOp, setCompositionSize,
} from './grid-ops.js';
import { askText, dialog, popup } from './popup.js';

const COLORS = [null, '#c0392b', '#7fb800', '#16a085', '#2980b9', '#c2188b'];
const SIZE_PRESETS = [[1920, 1080], [1280, 720], [3840, 2160], [2560, 1440], [1080, 1920], [1024, 768], [800, 600]];

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

export function slider(label, min, max, get, set, step, format) {
  const fmt = format ? (v) => format(Number(v)) : (v) => (Math.abs(max - min) > 20 ? Number(v).toFixed(0) : Number(v).toFixed(2));
  const out = h('output', {}, fmt(get()));
  const input = h('input', {
    type: 'range', min, max, step: step ?? (max - min) / 500, value: get(), 'aria-label': label,
    onInput: (e) => { set(Number(e.target.value)); out.textContent = fmt(e.target.value); },
  });
  return h('div', { class: 'param' }, h('label', { title: label }, label), input, out);
}

export const select = (options, value, onChange, label) => h('select', { 'aria-label': label, onChange: (e) => onChange(e.target.value) },
  options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t)));

const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;

export class UI {
  constructor(app) {
    this.app = app;
    this.sel = { type: 'composition' };
    this.tab = 'composition';
    this.browserTab = 'sources';
    this.thumbs = new Map();
    this.timelineRefs = null;
    this.tapTimes = [];
  }

  get comp() { return this.app.comp; }
  get engine() { return this.app.engine; }

  renderAll() {
    this.renderTop();
    this.renderGrid();
    this.renderDecks();
    this.renderProps();
    this.renderBrowser();
  }

  // ---- Barra superior ----
  renderTop() {
    const { comp, app } = this;
    const bar = document.getElementById('topbar');
    const tap = () => {
      const now = performance.now();
      this.tapTimes = this.tapTimes.filter((t) => now - t < 3000);
      this.tapTimes.push(now);
      if (this.tapTimes.length >= 2) {
        const d = (this.tapTimes.at(-1) - this.tapTimes[0]) / (this.tapTimes.length - 1);
        comp.bpm = Math.round((60000 / d) * 10) / 10;
        this.bpmInput.value = comp.bpm;
      }
    };
    this.bpmInput = h('input', { type: 'number', class: 'bpm', min: 20, max: 500, step: 0.1, value: comp.bpm, 'aria-label': 'BPM', onChange: (e) => { comp.bpm = Number(e.target.value) || 120; } });
    const scale = (f) => () => { comp.bpm = Math.min(500, Math.max(20, comp.bpm * f)); this.bpmInput.value = comp.bpm; };
    const menu = (label, items) => h('button', {
      class: 'menubtn',
      onClick: (e) => { const r = e.target.getBoundingClientRect(); popup(r.left, r.bottom + 2, items()); },
    }, label);
    bar.replaceChildren(
      h('span', { class: 'brand' }, 'REAlumen'),
      menu('Composición', () => this.compositionMenu()),
      menu('Capa', () => this.layerMenu(this.selectedLayer())),
      menu('Columna', () => this.columnMenu(this.selectedColumn())),
      this.outputMenu(),
      h('span', { class: 'sep' }),
      h('span', { id: 'beat' }),
      h('span', {}, 'BPM'), this.bpmInput,
      h('button', { onClick: tap }, 'TAP'),
      h('button', { onClick: () => { this.engine.beat = 0; } }, 'Resync'),
      h('button', { onClick: scale(0.5) }, '/2'),
      h('button', { onClick: scale(2) }, '×2'),
      h('span', { class: 'sep' }),
      h('span', {}, 'A'),
      h('div', { class: 'fader' }, h('input', { type: 'range', min: -1, max: 1, step: 0.01, value: comp.crossfader, 'aria-label': 'Crossfader', onInput: (e) => { comp.crossfader = Number(e.target.value); }, onDblclick: (e) => { comp.crossfader = 0; e.target.value = 0; } })),
      h('span', {}, 'B'),
    );
    this.beatEl = document.getElementById('beat');
  }

  // Menú Salida: pantallas detectadas, editor avanzado, NDI y herramientas.
  outputMenu() {
    const { comp, app } = this;
    const screen = comp.screens[0];
    const closeAnd = (fn) => (e) => { e.target.closest('details').open = false; fn(); this.renderTop(); };
    const isDevice = (type, id) => comp.screens.some((s) => s.device.type === type && s.device.displayId === id);
    const allVirtual = comp.screens.every((s) => s.device.type === 'virtual');
    const displays = app.advanced?.displays || [];
    const toDisplay = (type, id) => closeAnd(() => {
      screen.device = { type, displayId: id };
      app.outputs.applyDevice(screen);
    });
    const row = (label, onClick, mark = false, title = '') => h('button', { class: mark ? 'mark' : '', title, onClick }, label);
    const onAir = comp.screens.some((s) => s.device.type !== 'virtual');
    return h('details', { class: 'menu' },
      h('summary', { class: onAir ? 'on' : '' }, 'Salida'),
      h('div', { class: 'menu-list' },
        row('Desactivada', closeAnd(() => app.disableOutputs()), allVirtual, 'Ctrl+Mayús+D'),
        h('h4', {}, 'Pantalla completa'),
        ...displays.map((d) => row(d.label, toDisplay('fullscreen', d.id), isDevice('fullscreen', d.id))),
        h('h4', {}, 'En ventana'),
        ...displays.map((d) => row(d.label, toDisplay('windowed', d.id), isDevice('windowed', d.id))),
        !displays.length ? h('div', { class: 'hint' }, 'Sin pantallas detectadas.') : null,
        h('hr', {}),
        row('Avanzada…', closeAnd(() => app.advanced.show()), false, 'Ctrl+Mayús+A'),
        h('hr', {}),
        h('h4', {}, 'Compartir composición'),
        row('Transmisión de red (NDI)', closeAnd(() => {
          comp.ndiOutput.enabled = !comp.ndiOutput.enabled;
          app.syncNdi();
          this.renderProps();
        }), comp.ndiOutput.enabled),
        h('hr', {}),
        row('Identificar pantallas', closeAnd(() => app.identifyDisplays())),
        row('Preferencias de pantalla del sistema', closeAnd(() => window.native.openDisplaySettings())),
        h('hr', {}),
        row('Tarjeta de prueba', closeAnd(() => {
          const on = !comp.screens.every((s) => s.testPattern);
          for (const s of comp.screens) s.testPattern = on;
        }), comp.screens.every((s) => s.testPattern), 'Ctrl+Mayús+L'),
        row('Captura de la composición', closeAnd(() => app.snapshot()), false, 'Ctrl+Mayús+P')));
  }

  selectedLayer() {
    return this.comp.layers.find((l) => l.id === this.sel.layer) || this.comp.layers[0];
  }

  selectedColumn() {
    return Math.min(this.sel.column ?? 0, this.comp.columns - 1);
  }

  // Tras cambiar la rejilla, libera los clips borrados y corrige la selección.
  afterGridChange(removed = []) {
    const { comp, engine } = this;
    for (const clip of removed) {
      for (const layer of comp.layers) if (layer.activeClip === clip.id) engine.disconnect(layer);
      engine.forget(clip);
      this.thumbs.delete(clip.id);
      if (this.sel.clip === clip.id) this.sel.clip = null;
    }
    if (this.sel.slot) this.sel.slot = null;
    this.sel.column = this.selectedColumn();
    if (!comp.layers.some((l) => l.id === this.sel.layer)) this.sel.layer = comp.layers[0].id;
    this.renderProps();
    this.renderGrid();
    this.app.autosave();
  }

  compositionMenu() {
    const { app } = this;
    return [
      { label: 'Nueva', fn: () => app.newFile() },
      { label: 'Abrir…', fn: () => app.open() },
      { label: 'Guardar…', hint: 'Ctrl+S', fn: () => app.save() },
      { label: 'Importar .avc…', fn: () => app.importAvc() },
      '-',
      { label: 'Configuración…', fn: () => this.compositionSettings() },
    ];
  }

  compositionSettings() {
    const { comp, engine, app } = this;
    const name = h('input', { type: 'text', value: comp.name, 'aria-label': 'Nombre' });
    const description = h('textarea', { rows: 3, value: comp.description || '', 'aria-label': 'Descripción' });
    const width = h('input', { type: 'number', min: 16, max: 16384, value: comp.width, 'aria-label': 'Ancho', required: true });
    const height = h('input', { type: 'number', min: 16, max: 16384, value: comp.height, 'aria-label': 'Alto', required: true });
    const presets = select([['', 'Tamaños…'], ...SIZE_PRESETS.map(([w, hh]) => [`${w}x${hh}`, `${w} × ${hh}`])], '', (v) => {
      if (!v) return;
      [width.value, height.value] = v.split('x');
    }, 'Tamaños habituales');
    const row = (label, ...kids) => h('div', { class: 'dialog-row' }, h('label', {}, label), h('div', { class: 'dialog-field' }, kids));
    dialog('Configuración de la composición', [
      row('Nombre', name),
      row('Descripción', description),
      row('Tamaño', width, h('span', {}, '×'), height, presets),
      row('Cuadros/s', h('span', { class: 'hint' }, 'Auto: sigue al monitor')),
      row('Profundidad', h('span', { class: 'hint' }, '8 bits por canal')),
    ], {
      onApply: () => {
        const w = Math.round(Number(width.value));
        const hh = Math.round(Number(height.value));
        if (!(w >= 16 && hh >= 16 && w <= 16384 && hh <= 16384)) return false;
        comp.name = name.value.trim() || comp.name;
        comp.description = description.value;
        if (w !== comp.width || hh !== comp.height) {
          setCompositionSize(comp, w, hh);
          engine.resize();
          for (const screen of comp.screens) app.outputs.invalidate(screen);
        }
        app.autosave();
        this.renderAll();
        return true;
      },
    });
  }

  columnMenu(index) {
    const { comp } = this;
    const info = columnInfo(comp, index);
    const change = (fn) => () => this.afterGridChange(fn() || []);
    return [
      { heading: info.name || `Columna ${index + 1}` },
      { label: 'Nueva', hint: 'Ctrl+T', fn: change(() => { insertColumn(comp, comp.columns); }) },
      { label: 'Insertar antes', fn: change(() => { insertColumn(comp, index); }) },
      { label: 'Insertar después', fn: change(() => { insertColumn(comp, index + 1); }) },
      { label: 'Duplicar', fn: change(() => { duplicateColumn(comp, index); }) },
      { label: 'Renombrar', fn: () => askText('Nombre de la columna', info.name || `Columna ${index + 1}`, (v) => { info.name = v || null; this.renderGrid(); }) },
      '-',
      { label: 'Vaciar clips', fn: change(() => clearColumn(comp, index)) },
      { label: 'Quitar', disabled: comp.columns < 2, fn: change(() => removeColumns(comp, index, index + 1)) },
      { label: 'Quitar todas las anteriores', disabled: index === 0, fn: () => { const removed = removeColumns(comp, 0, index); this.sel.column = 0; this.afterGridChange(removed); } },
      { label: 'Quitar todas las siguientes', disabled: index >= comp.columns - 1, fn: change(() => removeColumns(comp, index + 1, comp.columns)) },
      '-',
      { swatches: COLORS, current: info.color ?? null, onSwatch: (color) => { info.color = color; this.renderGrid(); } },
    ];
  }

  layerMenu(layer) {
    const { comp } = this;
    const index = comp.layers.indexOf(layer);
    const change = (fn) => () => this.afterGridChange(fn() || []);
    const flag = (key, label, title) => ({
      label, title, check: !!layer[key], fn: () => { layer[key] = !layer[key]; this.renderGrid(); },
    });
    return [
      { heading: layer.name },
      { label: 'Nueva', hint: 'Ctrl+L', fn: change(() => { this.sel.layer = insertLayer(comp, comp.layers.length).id; }) },
      { label: 'Insertar encima', fn: change(() => { this.sel.layer = insertLayer(comp, index + 1).id; }) },
      { label: 'Insertar debajo', fn: change(() => { this.sel.layer = insertLayer(comp, index).id; }) },
      { label: 'Duplicar', fn: change(() => { this.sel.layer = duplicateLayer(comp, layer).id; }) },
      { label: 'Renombrar', fn: () => askText('Nombre de la capa', layer.name, (v) => { if (v) layer.name = v; this.renderGrid(); this.renderProps(); }) },
      { label: 'Copiar efectos', disabled: !layer.effects.length, fn: () => { this.effectClipboard = JSON.stringify(layer.effects); } },
      { label: 'Pegar efectos', disabled: !this.effectClipboard, fn: () => { layer.effects.push(...JSON.parse(this.effectClipboard).map((fx) => ({ ...fx, id: uid() }))); this.renderProps(); } },
      flag('folded', 'Plegar'),
      '-',
      { label: 'Vaciar clips', fn: change(() => clearLayerClips(comp, layer)) },
      { label: 'Quitar', disabled: comp.layers.length < 2, fn: change(() => { this.engine.disconnect(layer); return removeLayerOp(comp, layer); }) },
      '-',
      flag('ignoreColumn', 'Ignorar disparo de columna', 'Esta capa no cambia al disparar una columna'),
      flag('triggerFirst', 'Disparar primer clip al cargar'),
      flag('faderStart', 'Fader Start', 'Subir la opacidad desde 0 lanza el primer clip; bajarla a 0 lo expulsa'),
      flag('locked', 'Bloquear contenido', 'Impide cambiar o borrar los clips de esta capa'),
      '-',
      { swatches: COLORS, current: layer.color ?? null, onSwatch: (color) => { layer.color = color; this.renderGrid(); } },
    ];
  }

  // ---- Rejilla de clips ----
  renderGrid() {
    const { comp } = this;
    const head = h('tr', {}, h('th', {
      class: 'layerhead', title: 'Ver la composición en el Preview', style: 'cursor:pointer',
      onClick: () => { this.engine.setPreview({ kind: 'comp' }); this.select({}, 'composition'); },
    }, comp.name),
      Array.from({ length: comp.columns }, (_, c) => {
        const info = columnInfo(comp, c);
        return h('th', {
          class: `colhead ${this.sel.column === c ? 'active' : ''}`,
          style: info.color ? `box-shadow: inset 0 -3px 0 ${info.color}` : '',
          title: 'Clic: disparar columna. Clic derecho: opciones',
          onClick: () => { this.engine.triggerColumn(c); this.sel.column = c; this.renderGrid(); },
          onContextmenu: (e) => { e.preventDefault(); this.sel.column = c; popup(e.clientX, e.clientY, this.columnMenu(c)); this.renderGrid(); },
        }, info.name || `Columna ${c + 1}`);
      }));
    // La capa superior de la composición aparece arriba, como en la mezcla.
    const rows = [...comp.layers].reverse().map((layer) => h('tr', {},
      this.layerHead(layer),
      Array.from({ length: comp.columns }, (_, c) => h('td', {}, this.cell(layer, c)))));
    document.getElementById('grid').replaceChildren(h('table', {}, h('thead', {}, head), h('tbody', {}, rows)));
  }

  layerHead(layer) {
    const toggle = (key, text, title, cls = '') => h('button', {
      class: `${cls} ${layer[key] ? 'on' : ''}`, title, 'aria-pressed': String(layer[key]),
      onClick: (e) => { layer[key] = !layer[key]; e.target.classList.toggle('on', layer[key]); },
    }, text);
    const sideBtn = (s) => h('button', {
      class: layer.side === s ? 'on' : '', title: `Asignar al lado ${s} del crossfader`,
      onClick: () => { layer.side = layer.side === s ? '' : s; this.renderGrid(); },
    }, s);
    return h('td', {
      class: `layerhead ${this.sel.layer === layer.id ? 'sel' : ''}`,
      style: layer.color ? `box-shadow: inset 3px 0 0 ${layer.color}` : '',
      title: 'Clic derecho: opciones de la capa',
      onContextmenu: (e) => { e.preventDefault(); this.sel.layer = layer.id; popup(e.clientX, e.clientY, this.layerMenu(layer)); },
    },
      h('div', { class: 'row' },
        h('span', {
          class: 'name', title: `${layer.name}: seleccionar y ver en el Preview`,
          onClick: () => { this.engine.setPreview({ kind: 'layer', layer }); this.select({ layer: layer.id }, 'layer'); },
        }, layer.name),
        h('button', { title: 'Desconectar clip', onClick: () => { this.engine.disconnect(layer); this.renderGrid(); } }, 'X'),
        toggle('bypass', 'B', 'Bypass', 'warn'), toggle('solo', 'S', 'Solo'),
        sideBtn('A'), sideBtn('B')),
      layer.folded ? null : h('div', { class: 'row mix' },
        select(BLEND_MODES.map((b) => [b, b]), layer.blend, (v) => { layer.blend = v; this.renderProps(); }, `Mezcla de ${layer.name}`),
        h('div', { class: 'faders' },
          this.fader(layer, 'master', 'M', 'Master: opacidad y volumen juntos', ''),
          this.fader(layer, 'volume', 'A', 'Audio: volumen', 'audio'),
          this.fader(layer, 'opacity', 'V', 'Video: opacidad', 'video'))));
  }

  fader(layer, key, label, title, cls) {
    return h('label', { class: `fader ${cls}`, title: `${title}. Doble clic: al máximo` },
      h('input', {
        type: 'range', min: 0, max: 1, step: 0.01, value: layer[key], 'aria-label': `${title} de ${layer.name}`,
        onInput: (e) => this.setLayerFader(layer, key, Number(e.target.value)),
        onDblclick: (e) => { e.target.value = 1; this.setLayerFader(layer, key, 1); },
      }),
      h('span', {}, label));
  }

  setLayerOpacity(layer, value) {
    this.setLayerFader(layer, 'opacity', value);
  }

  setLayerFader(layer, key, value) {
    // Fader Start: al subir la imagen desde 0 lanza el primer clip; al llegar a 0 lo expulsa.
    const was = layerOpacity(layer);
    layer[key] = value;
    const now = layerOpacity(layer);
    if (layer.faderStart && key !== 'volume') {
      if (was === 0 && now > 0 && !layer.activeClip) {
        for (let c = 0; c < this.comp.columns; c++) {
          const clip = getClip(this.comp, layer.id, c);
          if (clip) { this.engine.trigger(layer, clip); break; }
        }
      } else if (now === 0 && layer.activeClip) this.engine.disconnect(layer);
    }
    this.renderGridSoon();
  }

  cell(layer, column) {
    const clip = getClip(this.comp, layer.id, column);
    const rt = clip && this.engine.runtimes.get(clip.id);
    const selected = clip && this.sel.clip === clip.id;
    const live = clip && layer.activeClip === clip.id;
    const thumb = clip && this.thumbs.get(clip.id);
    const previewing = clip && this.engine.previewTarget?.clip === clip;
    const emptySelected = !clip && this.sel.slot?.layer === layer.id && this.sel.slot.column === column;
    const el = h('div', {
      class: `cell ${clip ? 'filled' : ''} ${selected ? 'sel' : ''} ${live ? 'live' : ''} ${emptySelected ? 'empty-sel' : ''} ${layer.folded ? 'folded' : ''}`,
      title: rt?.error || clip?.name || 'Vacío: arrastra aquí un medio, fuente o efecto',
      onContextmenu: (e) => {
        e.preventDefault();
        if (!clip || layer.locked) return;
        if (live) this.engine.disconnect(layer);
        this.engine.forget(clip);
        setClip(this.comp, layer.id, column, null);
        if (this.sel.clip === clip.id) this.sel.clip = null;
        this.renderProps();
        this.renderGrid();
      },
      draggable: !!clip,
      onDragstart: (e) => { e.dataTransfer.setData('text/realumen-clip', JSON.stringify({ layerId: layer.id, column })); },
      onDragover: (e) => { e.preventDefault(); el.classList.add('drop'); },
      onDragleave: () => el.classList.remove('drop'),
      onDrop: (e) => { e.preventDefault(); el.classList.remove('drop'); if (!layer.locked) this.dropOnCell(e, layer, column); },
    },
    h('div', {
      class: 'thumb', title: clip ? `Lanzar ${clip.name}` : '',
      // Como en la app de referencia: una celda vacía expulsa el clip de la capa y queda seleccionada.
      onClick: () => { if (clip) this.triggerClip(layer, clip); else this.selectEmpty(layer, column, true); },
      onMousedown: (e) => {
        if (clip && clip.trigger === 'piano') {
          this.engine.trigger(layer, clip);
          const up = () => { this.engine.disconnect(layer); this.renderGrid(); window.removeEventListener('mouseup', up); };
          window.addEventListener('mouseup', up);
          e.preventDefault();
        }
      },
    },
    thumb && h('img', { src: thumb, alt: '' }),
    clip?.cues.length ? h('span', { class: 'cuecount' }, `◆${clip.cues.length}`) : null,
    rt?.error ? h('span', { class: 'badge' }, '⚠') : null),
    h('div', {
      class: `handle ${previewing ? 'previewing' : ''}`, title: clip ? 'Ver en el Preview sin enviarlo a la salida' : '',
      onClick: () => { if (clip) this.previewClip(clip); else this.selectEmpty(layer, column, false); },
    }, clip?.name ?? ''));
    return el;
  }

  selectEmpty(layer, column, eject) {
    if (eject) this.engine.disconnect(layer);
    this.sel.clip = null;
    this.sel.layer = layer.id;
    this.sel.column = column;
    this.sel.slot = { layer: layer.id, column };
    if (this.engine.previewTarget?.kind === 'clip') this.engine.setPreview(null);
    this.renderProps();
    this.renderGrid();
  }

  previewClip(clip) {
    this.engine.setPreview({ kind: 'clip', clip });
    this.select({ clip: clip.id });
  }

  renderPreviewBar() {
    const target = this.engine.previewTarget;
    const bar = document.getElementById('preview-bar');
    if (!target) { bar.replaceChildren(h('span', { class: 'n' }, 'Pulsa la barra de nombre de un clip')); return; }
    const name = target.kind === 'clip' ? target.clip.name : target.kind === 'layer' ? target.layer.name : 'Composición';
    const found = target.kind === 'clip' && findClip(this.comp, target.clip.id);
    const layer = found && this.comp.layers.find((l) => l.id === found.layerId);
    bar.replaceChildren(
      h('span', { class: 'n', title: name }, name),
      layer ? h('button', { onClick: () => { this.engine.trigger(layer, target.clip); this.renderGridSoon(); } }, 'Lanzar') : null,
      h('button', { onClick: () => { this.engine.setPreview(null); this.renderGrid(); this.renderPreviewBar(); } }, 'Cerrar'),
    );
  }

  triggerClip(layer, clip) {
    if (clip.trigger === 'piano') { this.select({ type: 'clip', clip: clip.id }, 'clip'); return; }
    if (clip.trigger === 'toggle' && layer.activeClip === clip.id) this.engine.disconnect(layer);
    else this.engine.trigger(layer, clip);
    this.select({ type: 'clip', clip: clip.id }, 'clip');
  }

  dropOnCell(e, layer, column) {
    const { comp } = this;
    const moved = e.dataTransfer.getData('text/realumen-clip');
    const fxName = e.dataTransfer.getData('text/realumen-effect');
    const gen = e.dataTransfer.getData('text/realumen-source');
    const liveSource = e.dataTransfer.getData('text/realumen-live');
    const existing = getClip(comp, layer.id, column);
    if (moved) {
      const from = JSON.parse(moved);
      const clip = getClip(comp, from.layerId, from.column);
      if (clip) {
        setClip(comp, from.layerId, from.column, existing);
        setClip(comp, layer.id, column, clip);
      }
    } else if (fxName && existing) {
      existing.effects.push(this.newEffect(fxName));
      this.select({ type: 'clip', clip: existing.id }, 'clip');
    } else if (liveSource) {
      this.placeClip(layer, column, this.clipFromLive(liveSource));
    } else if (gen) {
      this.placeClip(layer, column, gen === 'Texto'
        ? newClip({ type: 'text', text: 'REAlumen', size: 200, color: '#ffffff' }, 'Texto')
        : newClip({ type: 'generator', gen, values: GENERATORS[gen].params.map((q) => q.def) }, gen));
    } else {
      let col = column;
      for (const file of e.dataTransfer.files) {
        const path = window.native.pathForFile(file);
        if (!path) continue;
        const { source, name } = sourceFromPath(path);
        this.placeClip(layer, col++, newClip(source, name));
      }
    }
    this.renderGrid();
  }

  clipFromLive(json) {
    const { name, source } = JSON.parse(json);
    return newClip(source, name);
  }

  placeClip(layer, column, clip) {
    const old = getClip(this.comp, layer.id, column);
    if (old) {
      if (layer.activeClip === old.id) this.engine.disconnect(layer);
      this.engine.forget(old);
    }
    if (column >= this.comp.columns) this.comp.columns = column + 1;
    setClip(this.comp, layer.id, column, clip);
    this.engine.runtime(clip);
    this.select({ type: 'clip', clip: clip.id }, 'clip');
    return clip;
  }

  makeThumb(clip) {
    const rt = this.engine.runtimes.get(clip.id);
    if (rt?.thumb && !this.thumbs.has(clip.id)) {
      this.thumbs.set(clip.id, rt.thumb);
      return;
    }
    if (!rt?.media || this.thumbs.has(clip.id) || clip.source.type !== 'video') return;
    const v = rt.media;
    const draw = () => {
      if (!v.videoWidth) return;
      const c = document.createElement('canvas');
      c.width = 160; c.height = 90;
      c.getContext('2d').drawImage(v, 0, 0, 160, 90);
      this.thumbs.set(clip.id, c.toDataURL('image/jpeg', 0.7));
      this.renderGrid();
    };
    if (v.readyState >= 2) draw();
    else v.addEventListener('loadeddata', draw, { once: true });
  }

  renderDecks() {
    const { comp } = this;
    document.getElementById('decks').replaceChildren(
      ...comp.decks.map((d, i) => h('button', {
        class: i === comp.activeDeck ? 'on' : '',
        onClick: () => { comp.activeDeck = i; this.renderDecks(); this.renderGrid(); },
      }, d.name)),
      h('button', { title: 'Deck nuevo', onClick: () => { comp.decks.push({ id: uid(), name: `Deck ${comp.decks.length + 1}`, clips: {} }); comp.activeDeck = comp.decks.length - 1; this.renderDecks(); this.renderGrid(); } }, '+'),
    );
  }

  // ---- Panel de propiedades ----
  select(sel, tab) {
    if (sel.layer) this.sel.layer = sel.layer;
    if (sel.clip) {
      this.sel.clip = sel.clip;
      this.sel.slot = null;
      const found = findClip(this.comp, sel.clip);
      if (found) {
        this.sel.layer = found.layerId;
        this.sel.column = found.column;
      }
    }
    if (tab && tab !== 'clip') this.tab = tab;
    this.renderProps();
    this.renderGrid();
  }

  newEffect(type) {
    return { id: uid(), type, bypass: false, values: EFFECTS[type].params.map((q) => q.def) };
  }

  fxChain(list) {
    const items = list.map((fx, i) => {
      const def = EFFECTS[fx.type];
      return h('div', { class: 'fx' },
        h('div', { class: 'head' },
          h('b', {}, fx.type),
          h('button', { class: fx.bypass ? 'warn on' : '', title: 'Bypass', onClick: () => { fx.bypass = !fx.bypass; this.renderProps(); } }, 'B'),
          h('button', { disabled: i === 0, title: 'Subir', onClick: () => { list.splice(i - 1, 0, list.splice(i, 1)[0]); this.renderProps(); } }, '↑'),
          h('button', { disabled: i === list.length - 1, title: 'Bajar', onClick: () => { list.splice(i + 1, 0, list.splice(i, 1)[0]); this.renderProps(); } }, '↓'),
          h('button', { title: 'Quitar', onClick: () => { list.splice(i, 1); this.renderProps(); } }, '×')),
        def ? def.params.map((q, k) => slider(q.name, q.min, q.max, () => fx.values[k], (v) => { fx.values[k] = v; })) : h('div', { class: 'error' }, 'Efecto desconocido'));
    });
    const add = select([['', '+ Añadir efecto'], ...Object.keys(EFFECTS).map((n) => [n, n])], '', (v) => { if (v) { list.push(this.newEffect(v)); this.renderProps(); } }, 'Añadir efecto');
    return [h('h3', {}, 'Efectos'), ...items, add];
  }

  renderProps() {
    const { comp } = this;
    this.timelineRefs = null;
    const layer = this.sel.layer ? comp.layers.find((l) => l.id === this.sel.layer) : null;
    const found = this.sel.clip ? findClip(comp, this.sel.clip) : null;
    const tab = (id, label) => h('button', { class: this.tab === id ? 'on' : '', onClick: () => { this.tab = id; this.renderProps(); } }, label);
    const tabs = h('div', { class: 'tabs' }, tab('composition', 'Composición'), tab('layer', 'Capa'));
    const body = this.tab === 'composition' ? this.compositionPanel()
      : layer ? this.layerPanel(layer) : [h('div', { class: 'empty' }, 'Selecciona una capa por su nombre.')];
    document.getElementById('props').replaceChildren(tabs, ...body);
    const clipBody = found ? this.clipPanel(found.clip) : [h('div', { class: 'empty' }, 'Suelta aquí audio, video, una fuente o un efecto, o pulsa la barra de nombre de un clip para verlo y editarlo.')];
    document.getElementById('clipprops').replaceChildren(h('div', { class: 'tabs' }, h('button', { class: 'on' }, 'Clip')), ...clipBody);
    this.renderPreviewBar();
  }

  ndiPanel() {
    const { comp, app } = this;
    const cfg = comp.ndiOutput;
    const { ndi } = app;
    return [
      h('h3', {}, 'Salida NDI'),
      ndi.available ? null : h('div', { class: 'error' }, `⚠ ${ndi.error}`),
      ndi.output('program').error ? h('div', { class: 'error' }, `⚠ ${ndi.output('program').error}`) : null,
      h('div', { class: 'fieldrow' },
        h('label', {}, h('input', { type: 'checkbox', checked: cfg.enabled, disabled: !ndi.available, onChange: (e) => { cfg.enabled = e.target.checked; app.syncNdi(); this.renderTop(); } }), ' Enviar composición')),
      h('div', { class: 'fieldrow' }, h('span', {}, 'Nombre'), h('input', { type: 'text', value: cfg.name, 'aria-label': 'Nombre de la salida NDI', maxLength: 253, onChange: (e) => { cfg.name = e.target.value.trim() || 'REAlumen'; e.target.value = cfg.name; } })),
      h('div', { class: 'fieldrow' }, h('span', {}, 'Cuadros por segundo'), select([[25, '25'], [30, '30'], [50, '50'], [60, '60']], cfg.fps, (v) => { cfg.fps = Number(v); }, 'Cuadros por segundo de NDI')),
      cfg.enabled && ndi.output('program').publishedName ? h('div', { class: 'hint' }, `En la red como: ${ndi.output('program').publishedName}`) : null,
      h('div', { class: 'hint' }, 'NDI® es una marca registrada de Vizrt NDI AB.'),
    ].filter(Boolean);
  }

  compositionPanel() {
    const { comp } = this;
    return [
      h('div', { class: 'fieldrow' }, h('span', {}, 'Nombre'), h('input', { type: 'text', value: comp.name, 'aria-label': 'Nombre de la composición', onChange: (e) => { comp.name = e.target.value; this.renderGrid(); } })),
      h('div', { class: 'fieldrow' }, h('span', {}, 'Resolución'),
        h('input', { type: 'number', style: 'width:80px', value: comp.width, 'aria-label': 'Ancho', onChange: (e) => { comp.width = Math.max(16, Number(e.target.value)); this.engine.resize(); } }),
        h('span', {}, '×'),
        h('input', { type: 'number', style: 'width:80px', value: comp.height, 'aria-label': 'Alto', onChange: (e) => { comp.height = Math.max(16, Number(e.target.value)); this.engine.resize(); } })),
      slider('Master', 0, 1, () => comp.opacity, (v) => { comp.opacity = v; }),
      slider('Volumen', 0, 1, () => comp.volume, (v) => { comp.volume = v; }),
      ...this.ndiPanel(),
      ...this.fxChain(comp.effects),
    ];
  }

  layerPanel(layer) {
    const pilot = (mode, label, title) => h('button', {
      class: (layer.autopilot || 'off') === mode ? 'on' : '', title, 'aria-pressed': (layer.autopilot || 'off') === mode,
      onClick: () => { layer.autopilot = mode; this.renderProps(); },
    }, label);
    return [
      h('div', { class: 'fieldrow' }, h('span', {}, 'Nombre'), h('input', { type: 'text', value: layer.name, 'aria-label': 'Nombre de capa', onChange: (e) => { layer.name = e.target.value; this.renderGrid(); } })),
      h('h3', {}, 'Autopilot'),
      h('div', { class: 'fieldrow' },
        pilot('prev', '◀◀', 'Autopilot: reproduce los clips del layer en orden inverso'),
        pilot('off', 'OFF', 'Apaga el autopilot'),
        pilot('next', '▶▶', 'Autopilot: reproduce los clips del layer en orden'),
        pilot('random', '⤨', 'Autopilot: reproduce los clips del layer al azar')),
      h('h3', {}, 'Layer'),
      slider('Master', 0, 1, () => layer.master, (v) => this.setLayerFader(layer, 'master', v)),
      h('h3', {}, 'Audio'),
      slider('Volumen', 0, 1, () => layer.volume, (v) => this.setLayerFader(layer, 'volume', v), undefined, toDb),
      slider('Paneo', -1, 1, () => layer.pan, (v) => { layer.pan = v; }),
      h('h3', {}, 'Video'),
      slider('Opacidad', 0, 1, () => layer.opacity, (v) => this.setLayerOpacity(layer, v)),
      slider('Transición (s)', 0, 10, () => layer.transition, (v) => { layer.transition = v; }),
      h('div', { class: 'fieldrow' }, h('span', {}, 'Mezcla'), select(BLEND_MODES.map((b) => [b, b]), layer.blend, (v) => { layer.blend = v; }, 'Modo de mezcla')),
      h('div', { class: 'fieldrow' },
        h('button', { onClick: () => this.moveLayer(layer, 1) }, 'Subir capa'),
        h('button', { onClick: () => this.moveLayer(layer, -1) }, 'Bajar capa'),
        h('button', { disabled: this.comp.layers.length < 2, onClick: () => this.removeLayer(layer) }, 'Eliminar capa')),
      ...this.fxChain(layer.effects),
    ];
  }

  renderGridSoon() {
    clearTimeout(this.gridTimer);
    this.gridTimer = setTimeout(() => this.renderGrid(), 150);
  }

  moveLayer(layer, d) {
    const { layers } = this.comp;
    const i = layers.indexOf(layer);
    const j = i + d;
    if (j < 0 || j >= layers.length) return;
    layers.splice(j, 0, layers.splice(i, 1)[0]);
    this.renderGrid();
  }

  removeLayer(layer) {
    const { comp } = this;
    this.engine.disconnect(layer);
    for (const deck of comp.decks) {
      for (const key of Object.keys(deck.clips)) {
        if (key.startsWith(`${layer.id}:`)) { this.engine.forget(deck.clips[key]); delete deck.clips[key]; }
      }
    }
    comp.layers.splice(comp.layers.indexOf(layer), 1);
    this.sel = {};
    this.tab = 'composition';
    this.renderAll();
  }

  clipPanel(clip) {
    const rt = this.engine.displayRuntime(clip);
    const tr = clip.transport;
    const out = [
      h('div', { class: 'fieldrow' }, h('span', {}, 'Nombre'), h('input', { type: 'text', value: clip.name, 'aria-label': 'Nombre del clip', onChange: (e) => { clip.name = e.target.value; this.renderGrid(); } })),
    ];
    if (rt.error) out.push(h('div', { class: 'error' }, `⚠ ${rt.error}`));
    if (rt.live) {
      out.push(h('div', { class: 'hint' }, clip.source.type === 'ndi' ? `Fuente NDI: ${clip.source.name}` : `Dispositivo: ${clip.source.label}`));
      if (clip.source.type === 'ndi' && rt.connected === false) out.push(h('div', { class: 'error' }, '⚠ Sin señal: se reconectará sola cuando la fuente vuelva.'));
      out.push(...this.videoControls(clip), ...this.fxChain(clip.effects));
      return out;
    }

    const head = h('div', { class: 'head' });
    const range = h('div', { class: 'range' });
    const cueMarks = clip.cues.map((c) => h('div', { class: 'cue', style: `left:${(c.t / rt.dur) * 100}%` }, c.name));
    const timeline = h('div', {
      class: 'timeline', title: 'Clic para mover la posición',
      onMousedown: (e) => {
        const seek = (ev) => {
          const r = timeline.getBoundingClientRect();
          this.engine.seek(clip, Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)));
        };
        seek(e);
        const up = () => { window.removeEventListener('mousemove', seek); window.removeEventListener('mouseup', up); };
        window.addEventListener('mousemove', seek);
        window.addEventListener('mouseup', up);
      },
    }, range, head, ...cueMarks);
    const timeText = h('span', {}, '');
    this.timelineRefs = { clip, head, range, timeText };

    const dirBtn = (d, label, title) => h('button', {
      class: tr.dir === d ? 'on' : '', title,
      onClick: () => { tr.dir = d; rt.dir = d || 1; this.renderProps(); },
    }, label);

    out.push(
      h('h3', {}, 'Transporte'), timeline,
      h('div', { class: 'fieldrow' },
        dirBtn(-1, '◀', 'Reversa'), dirBtn(0, '❚❚', 'Pausa'), dirBtn(1, '▶', 'Adelante'),
        select([['loop', 'Bucle'], ['bounce', 'Rebote'], ['once', 'Una vez']], tr.loop, (v) => { tr.loop = v; }, 'Modo de reproducción'),
        select([['timeline', 'Timeline'], ['bpm', 'BPM Sync']], tr.mode, (v) => { tr.mode = v; this.renderProps(); }, 'Sincronía'),
        timeText),
      ...(isStill(clip.source) ? [this.durationRow(clip)] : []),
      tr.mode === 'bpm'
        ? slider('Pulsos', 1, 128, () => tr.beats, (v) => { tr.beats = v; }, 1)
        : slider('Velocidad', 0, 4, () => tr.speed, (v) => { tr.speed = v; }),
      slider('Entrada', 0, 1, () => tr.in, (v) => { tr.in = Math.min(v, tr.out - 0.001); }),
      slider('Salida', 0, 1, () => tr.out, (v) => { tr.out = Math.max(v, tr.in + 0.001); }),
      h('h3', {}, 'Cue points (teclas 1-9 saltan · Mayús+1-9 fijan)'),
      h('div', { class: 'fieldrow' },
        h('button', { onClick: () => { this.engine.addCue(clip); this.renderProps(); this.renderGrid(); } }, '+ Cue en posición actual')),
      ...clip.cues.map((cue, i) => h('div', { class: 'cuerow' },
        h('button', { title: 'Saltar a este cue', onClick: () => this.engine.jumpCue(clip, cue) }, String(i + 1)),
        h('input', { type: 'text', value: cue.name, 'aria-label': 'Nombre del cue', onChange: (e) => { cue.name = e.target.value; this.renderProps(); } }),
        h('span', { class: 'time' }, fmtTime(cue.t)),
        h('button', { title: 'Mover aquí', onClick: () => { cue.t = this.engine.displayRuntime(clip).t; this.renderProps(); } }, 'Fijar'),
        h('button', { title: 'Borrar', onClick: () => { clip.cues.splice(i, 1); this.renderProps(); this.renderGrid(); } }, '×'))),
      h('h3', {}, 'Disparo'),
      h('div', { class: 'fieldrow' },
        select([['normal', 'Normal'], ['toggle', 'Toggle'], ['piano', 'Piano']], clip.trigger, (v) => { clip.trigger = v; }, 'Estilo de disparo'),
        select([[0, 'Sin beat snap'], [0.25, '1/4 pulso'], [0.5, '1/2 pulso'], [1, '1 pulso'], [2, '2 pulsos'], [4, '1 compás'], [8, '2 compases'], [16, '4 compases']], clip.beatSnap, (v) => { clip.beatSnap = Number(v); }, 'Beat snap')),
      h('h3', {}, 'Autopilot'),
      h('div', { class: 'fieldrow' }, h('span', {}, 'Al terminar'),
        select([['layer', 'Seguir al layer'], ['none', 'No hacer nada'], ['next', 'Clip siguiente'], ['prev', 'Clip anterior'], ['random', 'Clip al azar'], ['first', 'Primer clip'], ['last', 'Último clip']],
          clip.autopilot, (v) => { clip.autopilot = v; }, 'Acción del autopilot')),
      ...(this.clipLayer(clip)?.autopilot || 'off') === 'off'
        ? [h('div', { class: 'hint' }, 'Actúa cuando el autopilot del layer está encendido.')] : [],
      ...this.videoControls(clip),
    );

    if (clip.source.type === 'generator' && GENERATORS[clip.source.gen]) {
      const s = clip.source;
      s.values = s.values || GENERATORS[s.gen].params.map((q) => q.def);
      out.push(h('h3', {}, s.gen), ...GENERATORS[s.gen].params.map((q, k) => slider(q.name, q.min, q.max, () => s.values[k], (v) => { s.values[k] = v; })));
    }
    if (clip.source.type === 'text') {
      const s = clip.source;
      out.push(h('h3', {}, 'Texto'),
        h('input', { type: 'text', value: s.text, 'aria-label': 'Texto', onInput: (e) => { s.text = e.target.value; } }),
        slider('Tamaño', 10, 600, () => s.size, (v) => { s.size = v; }),
        h('div', { class: 'fieldrow' }, h('span', {}, 'Color'), h('input', { type: 'color', value: s.color, 'aria-label': 'Color del texto', onInput: (e) => { s.color = e.target.value; } })));
    }
    out.push(...this.fxChain(clip.effects));
    return out;
  }

  clipLayer(clip) {
    const found = findClip(this.comp, clip.id);
    return found && this.comp.layers.find((l) => l.id === found.layerId);
  }

  // Cuánto tiempo queda en pantalla una imagen antes de que el autopilot cambie de clip.
  durationRow(clip) {
    const tr = clip.transport;
    const set = (v) => {
      const d = Number(v);
      if (Number.isFinite(d) && d > 0) tr.duration = Math.min(604800, Math.max(0.001, Math.round(d * 1000) / 1000));
      this.renderProps();
    };
    return h('div', { class: 'fieldrow' }, h('span', {}, 'Duración (s)'),
      h('input', { type: 'number', min: 0.001, step: 0.1, style: 'width:80px', value: tr.duration, 'aria-label': 'Duración del clip en segundos', onChange: (e) => set(e.target.value) }),
      h('button', { title: 'Restar un segundo', onClick: () => set(tr.duration - 1) }, '−'),
      h('button', { title: 'Sumar un segundo', onClick: () => set(tr.duration + 1) }, '+'),
      h('button', { title: 'Mitad de duración', onClick: () => set(tr.duration / 2) }, '/2'),
      h('button', { title: 'Doble de duración', onClick: () => set(tr.duration * 2) }, '×2'));
  }

  videoControls(clip) {
    const audio = !isStill(clip.source);
    return [
      ...(audio ? [
        h('h3', {}, 'Audio del clip'),
        slider('Volumen', 0, 1, () => clip.volume, (v) => { clip.volume = v; }, undefined, toDb),
        slider('Paneo', -1, 1, () => clip.pan ?? 0, (v) => { clip.pan = v; }),
      ] : []),
      h('h3', {}, 'Video'),
      slider('Opacidad', 0, 1, () => clip.opacity, (v) => { clip.opacity = v; }),
      slider('Posición X', -this.comp.width, this.comp.width, () => clip.x, (v) => { clip.x = v; }),
      slider('Posición Y', -this.comp.height, this.comp.height, () => clip.y, (v) => { clip.y = v; }),
      slider('Escala', 0, 5, () => clip.scale, (v) => { clip.scale = v; }),
      slider('Rotación', -3.142, 3.142, () => clip.rotation, (v) => { clip.rotation = v; }),
    ];
  }

  async refreshDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.videoDevices = devices.filter((d) => d.kind === 'videoinput');
      this.deviceError = null;
    } catch (err) {
      this.deviceError = err.message;
    }
    if (this.browserTab === 'sources') this.renderBrowser();
  }

  // ---- Navegador de fuentes, efectos y archivos ----
  renderBrowser() {
    const root = document.getElementById('browser');
    const tab = (id, label) => h('button', { class: this.browserTab === id ? 'on' : '', onClick: () => { this.browserTab = id; this.renderBrowser(); } }, label);
    const item = (name, dragType, data = name) => h('div', {
      class: 'item', draggable: true, title: 'Arrastra a una celda o doble clic para usarlo',
      onDragstart: (e) => e.dataTransfer.setData(dragType, data),
      onDblclick: () => this.applyBrowserItem(data, dragType),
    }, name);
    const liveItem = (name, source) => item(name, 'text/realumen-live', JSON.stringify({ name, source }));
    let list;
    if (this.browserTab === 'sources') {
      const { ndi } = this.app;
      const devices = this.videoDevices || [];
      list = [
        h('h3', {}, 'Cámaras y capturadoras'),
        ...devices.map((d, i) => liveItem(d.label || `Dispositivo ${i + 1}`, { type: 'capture', deviceId: d.deviceId, label: d.label })),
        !devices.length ? h('div', { class: 'hint' }, this.deviceError || 'No hay dispositivos de video conectados.') : null,
        h('h3', {}, 'NDI'),
        ...ndi.sources.map((n) => liveItem(n, { type: 'ndi', name: n })),
        !ndi.available ? h('div', { class: 'error' }, `⚠ ${ndi.error}`) : !ndi.sources.length ? h('div', { class: 'hint' }, 'Buscando fuentes NDI en la red…') : null,
        h('h3', {}, 'Generadores'),
        ...[...Object.keys(GENERATORS), 'Texto'].map((n) => item(n, 'text/realumen-source')),
      ];
    } else if (this.browserTab === 'effects') list = Object.keys(EFFECTS).map((n) => item(n, 'text/realumen-effect'));
    else {
      list = [
        h('button', { onClick: () => this.importMedia() }, 'Importar archivos a la capa seleccionada'),
        h('div', { class: 'hint' }, 'También puedes arrastrar videos, imágenes o audio desde el Explorador a cualquier celda. Compatibles: DXV (DXT1 y DXT5), H.264, VP9, AV1, WebM, MOV con H.264, PNG, JPG, WAV, MP3.'),
      ];
    }
    root.replaceChildren(
      h('div', { class: 'tabs' }, tab('sources', 'Fuentes'), tab('effects', 'Efectos'), tab('files', 'Archivos')),
      h('div', { class: 'list' }, list),
    );
  }

  targetLayerAndColumn() {
    const { comp } = this;
    if (this.sel.slot) {
      const slotLayer = comp.layers.find((l) => l.id === this.sel.slot.layer);
      if (slotLayer && !getClip(comp, slotLayer.id, this.sel.slot.column)) return { layer: slotLayer, column: this.sel.slot.column };
    }
    const found = this.sel.clip && findClip(comp, this.sel.clip);
    const layer = comp.layers.find((l) => l.id === (found?.layerId || this.sel.layer)) || comp.layers[comp.layers.length - 1];
    let column = 0;
    while (getClip(comp, layer.id, column)) column++;
    return { layer, column };
  }

  applyBrowserItem(name, dragType) {
    if (dragType === 'text/realumen-effect') {
      const found = this.sel.clip && findClip(this.comp, this.sel.clip);
      const layer = this.sel.layer && this.comp.layers.find((l) => l.id === this.sel.layer);
      const target = found ? found.clip.effects : this.tab === 'layer' && layer ? layer.effects : this.comp.effects;
      target.push(this.newEffect(name));
      this.renderProps();
      return;
    }
    const { layer, column } = this.targetLayerAndColumn();
    if (dragType === 'text/realumen-live') {
      this.placeClip(layer, column, this.clipFromLive(name));
      return;
    }
    this.placeClip(layer, column, name === 'Texto'
      ? newClip({ type: 'text', text: 'REAlumen', size: 200, color: '#ffffff' }, 'Texto')
      : newClip({ type: 'generator', gen: name, values: GENERATORS[name].params.map((q) => q.def) }, name));
  }

  async importMedia() {
    const paths = await window.native.openFiles('media', true);
    let { layer, column } = this.targetLayerAndColumn();
    for (const p of paths) {
      const { source, name } = sourceFromPath(p);
      this.placeClip(layer, column, newClip(source, name));
      while (getClip(this.comp, layer.id, column)) column++;
    }
  }

  // ---- Tick visual ----
  tick() {
    if (this.beatEl) this.beatEl.classList.toggle('on', this.engine.beat % 1 < 0.15);
    const stats = document.getElementById('stats');
    stats.textContent = `${this.comp.width}×${this.comp.height} · ${Math.round(this.engine.fps)} fps`;
    const target = this.engine.previewTarget;
    if (target?.kind === 'clip' && this.engine.previewFrames > 6 && !this.thumbs.has(target.clip.id)) {
      this.thumbs.set(target.clip.id, document.getElementById('preview').toDataURL('image/jpeg', 0.7));
      this.renderGridSoon();
    }
    const refs = this.timelineRefs;
    if (refs) {
      const { clip, head, range, timeText } = refs;
      const rt = this.engine.displayRuntime(clip);
      const d = rt.dur || 1;
      head.style.left = `${(rt.t / d) * 100}%`;
      range.style.left = `${clip.transport.in * 100}%`;
      range.style.width = `${(clip.transport.out - clip.transport.in) * 100}%`;
      timeText.textContent = `${fmtTime(rt.t)} / ${fmtTime(d)}`;
    }
  }

  handleKey(e) {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    const n = /^Digit([1-9])$/.exec(e.code);
    if (n && this.sel.clip) {
      const found = findClip(this.comp, this.sel.clip);
      if (!found) return;
      const i = Number(n[1]) - 1;
      if (e.shiftKey) {
        const rt = this.engine.runtime(found.clip);
        if (found.clip.cues[i]) found.clip.cues[i].t = rt.t;
        else this.engine.addCue(found.clip);
        this.renderProps();
        this.renderGrid();
      } else if (found.clip.cues[i]) this.engine.jumpCue(found.clip, found.clip.cues[i]);
    }
    if (e.ctrlKey && e.code === 'KeyS') { e.preventDefault(); this.app.save(); }
    if (e.ctrlKey && !e.shiftKey && e.code === 'KeyT') { e.preventDefault(); insertColumn(this.comp, this.comp.columns); this.afterGridChange(); }
    if (e.ctrlKey && !e.shiftKey && e.code === 'KeyL') { e.preventDefault(); this.sel.layer = insertLayer(this.comp, this.comp.layers.length).id; this.afterGridChange(); }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') { e.preventDefault(); this.app.disableOutputs(); this.renderTop(); }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyA') { e.preventDefault(); this.app.advanced.show(); }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyP') { e.preventDefault(); this.app.snapshot(); }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyL') {
      e.preventDefault();
      const on = !this.comp.screens.every((s) => s.testPattern);
      for (const s of this.comp.screens) s.testPattern = on;
    }
  }
}

export { parseAvc, newComposition, clipKey };
