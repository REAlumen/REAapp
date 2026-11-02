// Editor de salidas: pantallas, slices y máscaras, con selección de entrada y transformación de salida.
import { newMask, newPolygon, newScreen, newSlice, rect, uid } from './model.js';
import {
  AREAS, bringToTop, editablePoints, fitArea, groupBounds, matchInputShape, mirror, moveInStack, outlinePoints, placeInStack, reshapeMask, rotate, rotationOf,
  scaleBounds, setCenter, setPointMode, setSubdivisions, stackItems, stagePoints, swapInputOutput, translate,
} from './slice-ops.js';
import { pointInPolygon } from './warp.js';
import { parseAdvancedOutput } from './arena-import.js';
import { h, select } from './ui.js';

const HANDLE = 9;
const ROTATE_RING = 16;
const UNDO_LIMIT = 100;
const SNAP_PIXELS = 8;

const round = (v) => Math.round(v * 100) / 100;
const SHAPES = [['heart', '♥', 'Corazón'], ['rect', '▭', 'Rectángulo'], ['ellipse', '◯', 'Círculo'], ['triangle', '△', 'Triángulo'], ['hexagon', '⬡', 'Hexágono']];

function stepper(label, get, set, { step = 1, min, max } = {}) {
  const clamp = (v) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const input = h('input', {
    type: 'number', step: 'any', value: round(get()), 'aria-label': label,
    onChange: (e) => { const v = Number(e.target.value); if (Number.isFinite(v)) set(clamp(v)); },
  });
  const nudge = (d) => () => { const v = clamp(round(get() + d * step)); set(v); input.value = v; };
  return h('div', { class: 'aofield' },
    h('label', { title: label }, label), input,
    h('button', { 'aria-label': `Bajar ${label}`, onClick: nudge(-1) }, '−'),
    h('button', { 'aria-label': `Subir ${label}`, onClick: nudge(1) }, '+'));
}

export class AdvancedOutput {
  constructor(app) {
    this.app = app;
    this.root = document.getElementById('advanced');
    this.stageMode = 'output';
    this.editMode = 'transform';
    this.screenId = null;
    this.selection = [];
    this.displays = [];
    this.view = { zoom: 0, panX: 0, panY: 0 };
    this.handTool = false;
    this.snap = true;
    this.showGrid = false;
    this.undoStack = [];
    this.redoStack = [];
    this.clipboard = [];
    this.drawing = null;
    window.addEventListener('message', (e) => {
      if (e.data === 'displays-changed') this.refreshDisplays();
    });
    window.addEventListener('keydown', (e) => { if (!this.root.hidden) this.onKey(e); });
  }

  get comp() { return this.app.comp; }

  get screen() {
    return this.comp.screens.find((s) => s.id === this.screenId) || this.comp.screens[0] || null;
  }

  get items() { return this.selection; }

  async refreshDisplays() {
    this.displays = await window.native.displays();
    if (!this.root.hidden) this.renderPanels();
    this.app.ui?.renderTop();
  }

  async show() {
    await this.refreshDisplays();
    this.root.hidden = false;
    this.app.outputs.previewActive = true;
    this.openSnapshot = JSON.stringify(this.comp.screens);
    this.undoStack = [];
    this.redoStack = [];
    this.selection = [];
    this.fitNext = true;
    this.render();
    this.startLoop();
  }

  // Guardar y cerrar conserva los cambios; Cancelar vuelve a como estaba al abrir.
  close(save) {
    if (!save && this.openSnapshot) this.restore(this.openSnapshot);
    this.root.hidden = true;
    this.app.outputs.previewActive = false;
    cancelAnimationFrame(this.raf);
    for (const screen of this.comp.screens) this.app.outputs.applyDevice(screen);
    this.app.autosave();
    this.app.ui.renderTop();
  }

  hide() { this.close(true); }

  invalidate() {
    for (const screen of this.comp.screens) this.app.outputs.invalidate(screen);
  }

  // ---- Deshacer ----
  pushUndo() {
    this.undoStack.push(JSON.stringify(this.comp.screens));
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.updateUndoButtons();
  }

  restore(json) {
    const ids = this.selection.map((i) => i.id);
    const before = new Map(this.comp.screens.map((s) => [s.id, s]));
    this.comp.screens = JSON.parse(json);
    const after = new Set(this.comp.screens.map((s) => s.id));
    for (const [id, screen] of before) if (!after.has(id)) this.app.outputs.removeScreen(screen);
    for (const screen of this.comp.screens) this.app.outputs.applyDevice(screen);
    const all = this.comp.screens.flatMap((s) => [...s.slices, ...s.masks, ...s.slices.flatMap((x) => x.inputMasks || [])]);
    this.selection = ids.map((id) => all.find((i) => i.id === id)).filter(Boolean);
    this.invalidate();
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.comp.screens));
    this.restore(this.undoStack.pop());
    this.render();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.comp.screens));
    this.restore(this.redoStack.pop());
    this.render();
  }

  updateUndoButtons() {
    if (this.undoBtn) this.undoBtn.disabled = !this.undoStack.length;
    if (this.redoBtn) this.redoBtn.disabled = !this.redoStack.length;
  }

  edit(fn) {
    this.pushUndo();
    fn();
    this.invalidate();
    this.renderPanels();
  }

  // ---- Interfaz ----
  render() {
    const { screen } = this;
    if (screen) this.screenId = screen.id;
    // Un solo lienzo durante toda la sesión: recrearlo perdería su tamaño y haría saltar el encuadre.
    if (!this.stage) {
      this.stage = h('canvas', { 'aria-label': 'Editor visual de la salida' });
      this.bindStage();
    }
    this.leftPanel = h('div', { class: 'ao-side' });
    this.rightPanel = h('div', { class: 'ao-right' });
    this.toolbarSlot = h('span', { class: 'ao-modes' });
    this.zoomLabel = h('span', { class: 'ao-zoom' }, '');
    this.undoBtn = h('button', { title: 'Deshacer (Ctrl+Z)', onClick: () => this.undo() }, '↶');
    this.redoBtn = h('button', { title: 'Rehacer (Ctrl+Y)', onClick: () => this.redo() }, '↷');
    const tab = (id, label) => h('button', { class: `ao-tab ${this.stageMode === id ? 'on' : ''}`, onClick: () => { this.stageMode = id; this.selection = this.selection.filter((i) => !i.stage || i.stage === id); this.fitNext = true; this.render(); } }, label);
    this.contextMenu = h('div', { class: 'ao-menu', hidden: true });
    this.root.replaceChildren(
      h('div', {
        class: 'ao-title',
        title: 'Arrastra para mover la ventana; puedes seguir lanzando clips detrás',
        onMousedown: (e) => this.dragWindow(e),
      }, h('span', {}, 'Salida avanzada'), h('span', { class: 'ao-comp' }, `Composición ${this.comp.width}×${this.comp.height}`)),
      h('div', { class: 'ao-body' },
        this.leftPanel,
        h('div', { class: 'ao-center' },
          h('div', { class: 'ao-tabs' }, tab('input', 'Selección de entrada'), tab('output', 'Transformación de salida')),
          h('div', { class: 'ao-tools' },
            this.zoomLabel,
            h('button', { title: 'Ajustar a la vista', onClick: () => { this.fitNext = true; } }, 'Ajustar'),
            this.undoBtn, this.redoBtn,
            h('button', { class: this.handTool ? 'on' : '', title: 'Mano: arrastra para mover la vista', onClick: (e) => { this.handTool = !this.handTool; e.target.classList.toggle('on', this.handTool); } }, '✋'),
            h('button', { class: this.snap ? 'on' : '', title: 'Imán: ajustar a bordes', onClick: (e) => { this.snap = !this.snap; e.target.classList.toggle('on', this.snap); } }, 'Imán'),
            h('button', { class: this.showGrid ? 'on' : '', title: 'Mostrar rejilla', onClick: (e) => { this.showGrid = !this.showGrid; e.target.classList.toggle('on', this.showGrid); } }, 'Rejilla'),
            h('span', { class: 'sep' }),
            this.toolbarSlot),
          h('div', { class: 'ao-stage' }, this.stage),
          h('div', { class: 'ao-actions' },
            h('button', { onClick: () => this.importArena() }, 'Importar AdvancedOutput.xml'),
            h('span', { class: 'sep' }),
            h('button', { onClick: () => this.close(false) }, 'Cancelar'),
            h('button', { class: 'on', onClick: () => this.close(true) }, 'Guardar y cerrar'))),
        this.rightPanel),
      this.contextMenu,
    );
    this.renderPanels();
    this.updateUndoButtons();
  }

  renderPanels() {
    if (!this.leftPanel) return;
    this.leftPanel.replaceChildren(...this.treePanel());
    this.rightPanel.replaceChildren(...this.propsPanel());
    this.toolbarSlot.replaceChildren(...this.modeButtons());
    this.updateUndoButtons();
  }

  modeButtons() {
    if (!this.selection.length) return [];
    const btn = (id, label) => h('button', { class: this.editMode === id ? 'on' : '', title: 'T alterna entre los dos modos', onClick: () => { this.editMode = id; this.renderPanels(); } }, label);
    return [btn('points', '+ Editar puntos'), btn('transform', 'Transformar')];
  }

  dragWindow(e) {
    const r = this.root.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    const move = (ev) => {
      this.root.style.left = `${Math.max(-r.width + 80, Math.min(window.innerWidth - 80, start.left + ev.clientX - start.x))}px`;
      this.root.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, start.top + ev.clientY - start.y))}px`;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  closeAdd(e) {
    const details = e.target.closest('details');
    if (details) details.open = false;
  }

  // Lista a la que pertenece un objeto: slices, máscaras de salida o máscaras de entrada de un slice.
  ownerList(item) {
    const { screen } = this;
    if (!item.points) return screen.slices;
    if (screen.masks.includes(item)) return screen.masks;
    return screen.slices.find((s) => s.inputMasks?.includes(item))?.inputMasks || screen.masks;
  }

  removeItems(items) {
    for (const item of items) {
      const list = this.ownerList(item);
      const i = list.indexOf(item);
      if (i >= 0) list.splice(i, 1);
    }
    this.selection = [];
  }

  cloneItems(items) {
    return items.map((item) => {
      const copy = { ...JSON.parse(JSON.stringify(item)), id: uid(), name: `${item.name} copia` };
      for (const m of copy.inputMasks || []) m.id = uid();
      this.ownerList(item).push(copy);
      if (item.stage !== 'input') bringToTop(this.screen, copy);
      return copy;
    });
  }

  stageMasks() {
    const { screen } = this;
    if (!screen) return [];
    return this.stageMode === 'input' ? screen.slices.flatMap((s) => s.inputMasks || []) : screen.masks;
  }

  // Los slices usan toda la composición al crearse: la entrada se recorta después con los tiradores.
  addSlice() {
    const { screen } = this;
    this.edit(() => {
      const s = newSlice(screen.slices.length + 1, screen.width, screen.height);
      s.input = rect(0, 0, this.comp.width, this.comp.height);
      screen.slices.push(s);
      bringToTop(screen, s);
      this.selection = [s];
    });
  }

  addPolygon(points) {
    const { screen, comp } = this;
    this.edit(() => {
      const count = screen.slices.filter((s) => s.warpMode === 'polygon').length + 1;
      const s = newPolygon(count, 'triangle', screen.width, screen.height, comp.width, comp.height, points);
      screen.slices.push(s);
      bringToTop(screen, s);
      this.selection = [s];
    });
  }

  addOutputMask(kind) {
    const { screen } = this;
    this.edit(() => {
      const m = newMask('output', kind, screen.width, screen.height, screen.masks.length + 1);
      screen.masks.push(m);
      bringToTop(screen, m);
      this.selection = [m];
    });
  }

  addInputMask(slice, kind) {
    const { comp } = this;
    this.edit(() => {
      slice.inputMasks ??= [];
      const m = newMask('input', kind, comp.width, comp.height, slice.inputMasks.length + 1);
      slice.inputMasks.push(m);
      this.selection = [m];
    });
  }

  startDrawing(what, slice) {
    this.drawing = { what, slice, points: [] };
    this.renderPanels();
  }

  shapeButtons(onShape, onDraw) {
    return h('div', { class: 'ao-shape-row' },
      SHAPES.map(([kind, icon, label]) => h('button', { title: label, 'aria-label': label, onClick: () => onShape(kind) }, icon)),
      onDraw ? h('button', { title: 'Dibujar: clic para añadir puntos, doble clic para cerrar', 'aria-label': 'Dibujar', onClick: onDraw }, '✎') : null);
  }

  addMenu() {
    const { screen } = this;
    const act = (fn) => (e) => { this.closeAdd(e); fn(); };
    return h('details', { class: 'ao-add' },
      h('summary', { 'aria-label': 'Añadir' }, '+'),
      h('div', { class: 'ao-add-list' },
        h('button', {
          onClick: act(() => this.edit(() => {
            const s = newScreen(this.comp.screens.length + 1, this.comp.width, this.comp.height);
            this.comp.screens.push(s);
            this.screenId = s.id;
            this.selection = [];
            this.fitNext = true;
          })),
        }, 'Pantalla'),
        h('button', { disabled: !screen, onClick: act(() => this.addSlice()) }, 'Slice'),
        h('div', { class: 'ao-add-row' }, h('span', {}, 'Polígono'),
          h('button', { title: 'Triángulo', 'aria-label': 'Polígono triángulo', onClick: act(() => this.addPolygon()) }, '△'),
          h('button', { title: 'Dibujar polígono', 'aria-label': 'Dibujar polígono', onClick: act(() => this.startDrawing('polygon')) }, '✎')),
        h('div', { class: 'ao-add-row' }, h('span', {}, 'Máscara de salida'),
          this.shapeButtons((kind) => { this.stageMode = 'output'; this.addOutputMask(kind); document.querySelector('.ao-add')?.removeAttribute('open'); }, () => this.startDrawing('mask')))));
  }

  treeItem(item, label, depth, onDelete, { draggable = false, locked = false } = {}) {
    const selected = this.selection.includes(item);
    const row = h('div', {
      class: `ao-item depth${depth} ${selected ? 'sel' : ''} ${locked ? 'locked' : ''}`,
      draggable,
      onClick: (e) => { if (!locked) this.selectItem(item, e.ctrlKey || e.metaKey); },
      onDragstart: (e) => { e.dataTransfer.setData('text/plain', ''); this.draggedItem = item; },
      onDragover: (e) => { if (this.draggedItem && this.draggedItem !== item) { e.preventDefault(); row.classList.add('dragover'); } },
      onDragleave: () => row.classList.remove('dragover'),
      onDrop: (e) => {
        e.preventDefault();
        row.classList.remove('dragover');
        const moved = this.draggedItem;
        this.draggedItem = null;
        if (moved && moved !== item) this.edit(() => placeInStack(this.screen, moved, item));
      },
    },
    h('input', {
      type: 'checkbox', checked: item.enabled !== false, 'aria-label': `Activar ${label}`,
      onClick: (e) => e.stopPropagation(),
      onChange: (e) => this.edit(() => { item.enabled = e.target.checked; }),
    }),
    h('span', { class: 'n', title: label }, label),
    selected ? h('button', { title: 'Eliminar', onClick: (e) => { e.stopPropagation(); onDelete(); } }, '×') : null);
    return row;
  }

  selectItem(item, add) {
    if (add) {
      this.selection = this.selection.includes(item) ? this.selection.filter((i) => i !== item) : [...this.selection, item];
    } else this.selection = [item];
    this.renderPanels();
  }

  deviceLabel(screen) {
    const d = screen.device;
    if (d.type === 'ndi') return `NDI (${screen.width}×${screen.height})`;
    if (d.type === 'virtual') return `Salida virtual (${screen.width}×${screen.height})`;
    const display = this.displays.find((x) => x.id === d.displayId);
    return `${d.type === 'fullscreen' ? 'Completa' : 'Ventana'}: ${display?.label || 'pantalla desconectada'}`;
  }

  treePanel() {
    const out = [this.addMenu()];
    if (this.drawing) out.push(h('div', { class: 'hint' }, 'Dibujando: clic para añadir puntos, doble clic para cerrar, Esc para cancelar.'));
    for (const screen of this.comp.screens) {
      const active = screen.id === this.screenId;
      out.push(h('div', {
        class: `ao-item ao-screen ${active && !this.selection.length ? 'sel' : ''}`,
        onClick: () => { this.screenId = screen.id; this.selection = []; this.fitNext = true; this.renderPanels(); },
      },
      h('input', {
        type: 'checkbox', checked: screen.enabled !== false, 'aria-label': `Activar ${screen.name}`,
        onClick: (e) => e.stopPropagation(),
        onChange: (e) => this.edit(() => { screen.enabled = e.target.checked; }),
      }),
      h('span', { class: 'n' }, h('b', {}, screen.name), h('small', {}, this.deviceLabel(screen))),
      this.comp.screens.length > 1 ? h('button', {
        title: 'Eliminar pantalla',
        onClick: (e) => {
          e.stopPropagation();
          this.edit(() => {
            this.app.outputs.removeScreen(screen);
            this.comp.screens.splice(this.comp.screens.indexOf(screen), 1);
            this.selection = [];
            this.screenId = this.comp.screens[0].id;
          });
        },
      }, '×') : null));
      if (!active) continue;
      // La lista muestra arriba lo que se dibuja encima. Arrastrar una fila cambia el orden, como en Arena.
      for (const item of [...stackItems(screen)].reverse()) {
        const isMask = !!item.points;
        out.push(this.treeItem(item, item.name, 1, () => this.edit(() => this.removeItems([item])), {
          draggable: this.stageMode === 'output',
          // En la selección de entrada, una máscara de salida no se edita.
          locked: isMask && this.stageMode === 'input',
        }));
        if (isMask || this.stageMode !== 'input') continue;
        for (const m of [...(item.inputMasks || [])].reverse()) {
          out.push(this.treeItem(m, m.name, 2, () => this.edit(() => this.removeItems([m]))));
        }
      }
    }
    return out;
  }

  deviceOptions() {
    const opts = [['virtual', 'Salida virtual']];
    for (const d of this.displays) opts.push([`fullscreen:${d.id}`, `Pantalla completa: ${d.label}`]);
    for (const d of this.displays) opts.push([`windowed:${d.id}`, `En ventana: ${d.label}`]);
    opts.push(['ndi', this.app.ndi.available ? 'Transmisión de red (NDI)' : 'NDI no disponible']);
    return opts;
  }

  deviceValue(screen) {
    const d = screen.device;
    if (d.type === 'fullscreen' || d.type === 'windowed') return `${d.type}:${d.displayId}`;
    return d.type;
  }

  setDevice(screen, value) {
    this.edit(() => {
      if (value === 'virtual') screen.device = { type: 'virtual' };
      else if (value === 'ndi') screen.device = { type: 'ndi', name: screen.name, fps: 30 };
      else {
        const [type, id] = value.split(':');
        const displayId = Number(id);
        screen.device = { type, displayId };
        const d = this.displays.find((x) => x.id === displayId);
        if (d && type === 'fullscreen') this.resizeScreen(screen, d.width, d.height);
      }
      this.app.outputs.applyDevice(screen);
    });
  }

  // Cambiar el tamaño de la pantalla conserva la forma relativa de sus slices.
  resizeScreen(screen, width, height) {
    const from = { left: 0, top: 0, width: screen.width, height: screen.height };
    const to = { left: 0, top: 0, width, height };
    scaleBounds(screen.slices, 'output', from, to);
    scaleBounds(screen.masks.filter((m) => m.stage === 'output'), 'output', from, to);
    screen.width = width;
    screen.height = height;
    this.fitNext = true;
  }

  colorFields(item) {
    const live = (key) => (v) => { item[key] = v; };
    return [
      stepper('Brillo', () => item.brightness, live('brightness'), { step: 0.01, min: -1, max: 1 }),
      stepper('Contraste', () => item.contrast, live('contrast'), { step: 0.01, min: -1, max: 1 }),
      stepper('Rojo', () => item.r, live('r'), { step: 0.01, min: -1, max: 1 }),
      stepper('Verde', () => item.g, live('g'), { step: 0.01, min: -1, max: 1 }),
      stepper('Azul', () => item.b, live('b'), { step: 0.01, min: -1, max: 1 }),
    ];
  }

  guideRow() {
    return [
      h('h3', {}, this.stageMode === 'input' ? 'Guía de entrada' : 'Guía de salida'),
      h('div', { class: 'fieldrow' },
        h('button', { onClick: () => this.loadGuide() }, 'Cargar…'),
        this.guide?.[this.stageMode] ? h('button', { onClick: () => { this.guide[this.stageMode] = null; this.renderPanels(); } }, 'Quitar') : null),
    ];
  }

  async loadGuide() {
    const [path] = await window.native.openFiles('media');
    if (!path) return;
    const img = new Image();
    img.onload = () => {
      this.guide = this.guide || {};
      this.guide[this.stageMode] = img;
      this.renderPanels();
    };
    img.src = `app://media/${encodeURIComponent(path)}`;
    img.crossOrigin = 'anonymous';
  }

  screenPanel(screen) {
    const out = [h('div', { class: 'ao-head' }, screen.name)];
    out.push(
      h('div', { class: 'aofield wide' }, h('label', {}, 'Nombre'), h('input', { type: 'text', value: screen.name, 'aria-label': 'Nombre de pantalla', onChange: (e) => this.edit(() => { screen.name = e.target.value; }) })),
      h('div', { class: 'aofield wide' }, h('label', {}, 'Dispositivo'), select(this.deviceOptions(), this.deviceValue(screen), (v) => this.setDevice(screen, v), 'Dispositivo de salida')),
    );
    if (screen.device.type === 'ndi') {
      const status = this.app.ndi.output(screen.id);
      out.push(
        h('div', { class: 'aofield wide' }, h('label', {}, 'Nombre NDI'), h('input', { type: 'text', maxLength: 240, value: screen.device.name || screen.name, 'aria-label': 'Nombre NDI', onChange: (e) => this.edit(() => { screen.device.name = e.target.value.trim() || screen.name; }) })),
        h('div', { class: 'aofield wide' }, h('label', {}, 'Cuadros/s'), select([[25, '25'], [30, '30'], [50, '50'], [60, '60']], screen.device.fps || 30, (v) => this.edit(() => { screen.device.fps = Number(v); }), 'Cuadros por segundo NDI')),
        h('div', { class: 'hint' }, this.app.ndi.available ? `En la red como: ${status.publishedName || 'iniciando…'}` : `⚠ ${this.app.ndi.error}`),
      );
      if (status.error) out.push(h('div', { class: 'error' }, `⚠ ${status.error}`));
    }
    out.push(
      stepper('Ancho', () => screen.width, (v) => this.edit(() => this.resizeScreen(screen, Math.max(16, Math.round(v)), screen.height)), { min: 16 }),
      stepper('Alto', () => screen.height, (v) => this.edit(() => this.resizeScreen(screen, screen.width, Math.max(16, Math.round(v)))), { min: 16 }),
      stepper('Opacidad', () => screen.opacity, (v) => { screen.opacity = v; }, { step: 0.01, min: 0, max: 1 }),
      ...this.colorFields(screen),
      h('div', { class: 'fieldrow' }, h('label', {}, h('input', { type: 'checkbox', checked: screen.testPattern, onChange: (e) => { screen.testPattern = e.target.checked; } }), ' Patrón de prueba')),
      ...this.guideRow(),
    );
    return out;
  }

  geometryFields(items) {
    const stage = this.stageMode;
    const b = () => groupBounds(items, stage);
    const change = (fn) => this.edit(fn);
    const resize = (update) => change(() => { const from = b(); scaleBounds(items, stage, from, { ...from, ...update(from) }); });
    return [
      stepper('X', () => b().x, (v) => change(() => setCenter(items, stage, 'x', v))),
      stepper('Y', () => b().y, (v) => change(() => setCenter(items, stage, 'y', v))),
      stepper('Izquierda', () => b().left, (v) => change(() => translate(items, stage, v - b().left, 0))),
      stepper('Arriba', () => b().top, (v) => change(() => translate(items, stage, 0, v - b().top))),
      stepper('Ancho', () => b().width, (v) => resize(() => ({ width: Math.max(1, v) })), { min: 1 }),
      stepper('Alto', () => b().height, (v) => resize(() => ({ height: Math.max(1, v) })), { min: 1 }),
      stepper('Rotación', () => rotationOf(items[0], stage), (v) => change(() => {
        const g = b();
        rotate(items, stage, g.x, g.y, ((v - rotationOf(items[0], stage)) * Math.PI) / 180);
      })),
    ];
  }

  slicePanel(items) {
    const slices = items.filter((i) => !i.points);
    const first = items[0];
    const multiple = items.length > 1;
    const out = [h('div', { class: 'ao-head' }, multiple ? 'Varios seleccionados' : first.name)];
    out.push(h('div', { class: 'aofield wide' }, h('label', {}, 'Nombre'), h('input', { type: 'text', value: first.name, 'aria-label': 'Nombre', onChange: (e) => this.edit(() => { first.name = e.target.value; }) })));
    if (first.points) return [...out, ...this.maskFields(first)];
    if (this.editMode === 'transform') out.push(...this.geometryFields(items));
    if (this.stageMode === 'input') {
      if (!multiple) {
        out.push(
          h('h3', {}, 'Máscara de entrada'),
          h('div', { class: 'hint' }, 'Recorta la parte de la composición que usa este slice.'),
          this.shapeButtons((kind) => this.addInputMask(first, kind), () => this.startDrawing('inputMask', first)),
        );
      }
      return out;
    }
    const flip = (key, label) => h('button', {
      class: slices.every((s) => s[key]) ? 'on' : '', title: label,
      onClick: () => this.edit(() => { const v = !slices.every((s) => s[key]); for (const s of slices) s[key] = v; }),
    }, label);
    const check = (key, label) => h('div', { class: 'fieldrow' }, h('label', {}, h('input', {
      type: 'checkbox', checked: slices.every((s) => s[key]),
      onChange: (e) => this.edit(() => { for (const s of slices) s[key] = e.target.checked; }),
    }), ` ${label}`));
    out.push(
      h('div', { class: 'fieldrow' }, h('span', {}, 'Invertir'), flip('flipX', 'Horizontal'), flip('flipY', 'Vertical')),
      check('isKey', 'Is Key'), check('blackBg', 'Black BG'),
      ...this.colorFields(first),
      h('div', { class: 'fieldrow' }, h('label', {}, h('input', { type: 'checkbox', checked: first.edge?.enabled !== false, onChange: (e) => this.edit(() => { first.edge.enabled = e.target.checked; }) }), ' Soft Edge')),
    );
    if (first.warpMode === 'polygon') {
      out.pop();
      return out;
    }
    if (first.edge?.enabled !== false) {
      const edge =(key, label) => stepper(label, () => first.edge[key], (v) => { first.edge[key] = v; }, { step: 0.01, min: 0, max: 0.5 });
      out.push(edge('left', 'Izquierda'), edge('right', 'Derecha'), edge('top', 'Arriba'), edge('bottom', 'Abajo'), stepper('Gamma', () => first.edge.gamma, (v) => { first.edge.gamma = v; }, { step: 0.1, min: 0.5, max: 3 }));
    }
    if (!multiple && this.editMode === 'points' && this.stageMode === 'output') {
      out.push(
        h('h3', {}, 'Deformación'),
        h('div', { class: 'aofield wide' }, h('label', {}, 'Puntos'), select([['linear', 'Lineal'], ['bezier', 'Bézier']], first.warpMode === 'bezier' ? 'bezier' : 'linear', (v) => this.edit(() => setPointMode(first, v)), 'Modo de puntos')),
        stepper('Subdiv. X', () => first.subdivX || 0, (v) => this.edit(() => setSubdivisions(first, v, first.subdivY || 0)), { min: 0, max: 32 }),
        stepper('Subdiv. Y', () => first.subdivY || 0, (v) => this.edit(() => setSubdivisions(first, first.subdivX || 0, v)), { min: 0, max: 32 }),
      );
    }
    return out;
  }

  maskFields(m) {
    const output = m.stage !== 'input';
    return [
      ...this.geometryFields([m]),
      h('div', { class: 'fieldrow' }, h('label', {}, h('input', { type: 'checkbox', checked: m.invert, onChange: (e) => this.edit(() => { m.invert = e.target.checked; }) }), ' Invertir')),
      stepper('Suavizado', () => m.feather, (v) => { m.feather = v; this.invalidate(); }, { min: 0, max: 200 }),
      h('h3', {}, output ? 'Máscara de salida' : 'Máscara de entrada'),
      this.shapeButtons((kind) => this.edit(() => reshapeMask(m, kind))),
      h('div', { class: 'hint' }, output ? 'Tapa en negro lo que tiene debajo en la lista; invertida, deja ver solo su interior. Arrastra filas para cambiar el orden.' : 'Oculta esta zona de la composición en el slice.'),
      h('div', { class: 'hint' }, 'En Editar puntos: doble clic en un borde añade un punto; Alt+clic lo borra.'),
    ];
  }

  propsPanel() {
    if (!this.screen) return [];
    if (this.selection.length) return this.slicePanel(this.selection);
    return this.screenPanel(this.screen);
  }

  async importArena() {
    const [path] = await window.native.openFiles('xml');
    if (!path) return;
    try {
      const text = await window.native.readText(path);
      this.pushUndo();
      this.applyArena(text);
    } catch (err) {
      window.alert(`No se pudo importar: ${err.message}`);
    }
  }

  applyArena(text) {
    const { screens } = parseAdvancedOutput(text);
    for (const s of this.comp.screens) this.app.outputs.removeScreen(s);
    this.comp.screens = screens;
    this.screenId = screens[0]?.id ?? null;
    this.selection = [];
    this.fitNext = true;
    if (!this.root.hidden) this.render();
    return screens;
  }

  // ---- Lienzo ----
  stageSize() {
    if (this.stageMode === 'input' || !this.screen) return [this.comp.width, this.comp.height];
    return [this.screen.width, this.screen.height];
  }

  fitView() {
    const [w, hh] = this.stageSize();
    const c = this.stage;
    const zoom = Math.min((c.width - 60) / w, (c.height - 60) / hh);
    this.view = { zoom, panX: (c.width - w * zoom) / 2, panY: (c.height - hh * zoom) / 2 };
    this.fitNext = false;
  }

  toScreenX(x) { return x * this.view.zoom + this.view.panX; }

  toScreenY(y) { return y * this.view.zoom + this.view.panY; }

  toStage(e) {
    const r = this.stage.getBoundingClientRect();
    const px = (e.clientX - r.left) * (this.stage.width / r.width);
    const py = (e.clientY - r.top) * (this.stage.height / r.height);
    return { x: (px - this.view.panX) / this.view.zoom, y: (py - this.view.panY) / this.view.zoom, px, py };
  }

  stageItems() {
    const { screen } = this;
    if (!screen) return [];
    const items = this.stageMode === 'input' ? [...screen.slices, ...this.stageMasks()] : stackItems(screen);
    return items.filter((i) => i.enabled !== false || this.selection.includes(i));
  }

  transformHandles() {
    if (!this.selection.length) return null;
    const b = groupBounds(this.selection, this.stageMode);
    const { left: l, top: t, width: w, height: hh } = b;
    return {
      bounds: b,
      scale: [
        { id: 'nw', x: l, y: t }, { id: 'n', x: l + w / 2, y: t }, { id: 'ne', x: l + w, y: t }, { id: 'e', x: l + w, y: t + hh / 2 },
        { id: 'se', x: l + w, y: t + hh }, { id: 's', x: l + w / 2, y: t + hh }, { id: 'sw', x: l, y: t + hh }, { id: 'w', x: l, y: t + hh / 2 },
      ],
    };
  }

  hitTest(p) {
    const near = (q, radius) => Math.hypot(this.toScreenX(q.x) - p.px, this.toScreenY(q.y) - p.py) <= radius;
    if (this.editMode === 'transform') {
      const handles = this.transformHandles();
      if (handles) {
        const scale = handles.scale.find((q) => near(q, HANDLE));
        if (scale) return { type: 'scale', handle: scale.id };
        const ring = handles.scale.filter((q) => q.id.length === 2).find((q) => near(q, ROTATE_RING));
        if (ring) return { type: 'rotate' };
      }
    } else {
      for (const item of this.selection) {
        const pts = editablePoints(item, this.stageMode);
        const index = pts.findIndex((q) => near(q, HANDLE));
        if (index >= 0) return { type: 'point', item, index, pts };
      }
    }
    const items = this.stageItems();
    const selectedHit = this.selection.find((i) => this.inside(i, p));
    if (selectedHit) return { type: 'move', item: selectedHit };
    for (const item of [...items].reverse()) if (this.inside(item, p)) return { type: 'move', item };
    return null;
  }

  inside(item, p) {
    if (item.kind === 'ellipse') {
      const [a, b] = item.points;
      const rx = Math.abs(b.x - a.x) / 2 || 1;
      const ry = Math.abs(b.y - a.y) / 2 || 1;
      return ((p.x - (a.x + b.x) / 2) / rx) ** 2 + ((p.y - (a.y + b.y) / 2) / ry) ** 2 <= 1;
    }
    return pointInPolygon(outlinePoints(item, this.stageMode), p.x, p.y);
  }

  // Ajusta un desplazamiento a los bordes del escenario y de otros objetos.
  snapDelta(bounds, dx, dy, exclude) {
    if (!this.snap) return { dx, dy };
    const limit = SNAP_PIXELS / this.view.zoom;
    const [w, hh] = this.stageSize();
    const xs = [0, w / 2, w];
    const ys = [0, hh / 2, hh];
    for (const item of this.stageItems()) {
      if (exclude.includes(item)) continue;
      const b = groupBounds([item], this.stageMode);
      xs.push(b.left, b.left + b.width);
      ys.push(b.top, b.top + b.height);
    }
    const best = (edges, targets) => {
      let snap = null;
      for (const e of edges) for (const t of targets) if (Math.abs(t - e) <= limit && (snap === null || Math.abs(t - e) < Math.abs(snap))) snap = t - e;
      return snap ?? 0;
    };
    const left = bounds.left + dx;
    const top = bounds.top + dy;
    return {
      dx: dx + best([left, left + bounds.width], xs),
      dy: dy + best([top, top + bounds.height], ys),
    };
  }

  beginDrag(e, onMove) {
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.renderPanels();
    };
    const move = (ev) => { onMove(ev); this.invalidate(); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  bindStage() {
    const { stage } = this;
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = this.toStage(e);
      const zoom = Math.min(16, Math.max(0.02, this.view.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      this.view = { zoom, panX: p.px - p.x * zoom, panY: p.py - p.y * zoom };
    }, { passive: false });
    stage.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const hit = this.hitTest(this.toStage(e));
      if (hit?.item && !this.selection.includes(hit.item)) this.selection = [hit.item];
      this.renderPanels();
      this.openContextMenu(e.clientX, e.clientY);
    });
    stage.addEventListener('mousedown', (e) => {
      this.contextMenu.hidden = true;
      if (e.button === 2) return;
      const p = this.toStage(e);
      if (this.drawing) {
        this.drawing.points.push({ x: p.x, y: p.y });
        return;
      }
      if (this.handTool || e.button === 1) {
        const start = { x: e.clientX, y: e.clientY, panX: this.view.panX, panY: this.view.panY };
        const r = stage.getBoundingClientRect();
        const k = stage.width / r.width;
        this.beginDrag(e, (ev) => {
          this.view.panX = start.panX + (ev.clientX - start.x) * k;
          this.view.panY = start.panY + (ev.clientY - start.y) * k;
        });
        return;
      }
      const hit = this.hitTest(p);
      if (!hit) {
        if (!(e.ctrlKey || e.metaKey) && this.selection.length) { this.selection = []; this.renderPanels(); }
        return;
      }
      if (hit.type === 'move' && !this.selection.includes(hit.item)) {
        this.selectItem(hit.item, e.ctrlKey || e.metaKey);
      } else if (hit.type === 'move' && (e.ctrlKey || e.metaKey)) {
        this.selectItem(hit.item, true);
        return;
      }
      if (hit.type === 'point' && e.altKey && hit.item.kind === 'polygon' && hit.pts.length > 3) {
        this.edit(() => hit.pts.splice(hit.index, 1));
        return;
      }
      if (this.editMode === 'points' && hit.type === 'move') return;
      this.pushUndo();
      // Alt al arrastrar deja una copia: así se construyen las divisiones de una pantalla.
      if (e.altKey && hit.type === 'move') {
        this.selection = this.cloneItems(this.selection);
        this.invalidate();
        this.renderPanels();
      }
      this.startInteraction(hit, p, e);
    });
    stage.addEventListener('dblclick', (e) => {
      if (this.drawing) {
        this.finishDrawing();
        return;
      }
      const item = this.selection[0];
      if (item?.kind === 'polygon' && this.editMode === 'points') this.edit(() => this.insertVertex(item, this.toStage(e)));
    });
  }

  startInteraction(hit, p, e) {
    const items = this.selection;
    if (!items.length) return;
    const stageName = this.stageMode;
    const snapshot = items.map((item) => stagePoints(item, stageName).map((q) => ({ x: q.x, y: q.y })));
    const restore = () => items.forEach((item, i) => {
      stagePoints(item, stageName).forEach((q, k) => { q.x = snapshot[i][k].x; q.y = snapshot[i][k].y; });
    });
    const start = groupBounds(items, stageName);
    if (hit.type === 'point') {
      const original = { x: hit.pts[hit.index].x, y: hit.pts[hit.index].y };
      this.beginDrag(e, (ev) => {
        const q = this.toStage(ev);
        hit.pts[hit.index].x = original.x + q.x - p.x;
        hit.pts[hit.index].y = original.y + q.y - p.y;
      });
    } else if (hit.type === 'move') {
      this.beginDrag(e, (ev) => {
        const q = this.toStage(ev);
        restore();
        let dx = q.x - p.x;
        let dy = q.y - p.y;
        // Mayús limita el movimiento a un eje.
        if (ev.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const d = this.snapDelta(start, dx, dy, items);
        translate(items, stageName, d.dx, d.dy);
      });
    } else if (hit.type === 'rotate') {
      const a0 = Math.atan2(p.y - start.y, p.x - start.x);
      this.beginDrag(e, (ev) => {
        const q = this.toStage(ev);
        restore();
        let a = Math.atan2(q.y - start.y, q.x - start.x) - a0;
        if (ev.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
        rotate(items, stageName, start.x, start.y, a);
      });
    } else if (hit.type === 'scale') {
      const id = hit.handle;
      this.beginDrag(e, (ev) => {
        const q = this.toStage(ev);
        restore();
        let { left, top, width, height } = start;
        const right = left + width;
        const bottom = top + height;
        if (id.includes('w')) { left = Math.min(q.x, right - 1); width = right - left; }
        if (id.includes('e')) { width = Math.max(1, q.x - left); }
        if (id.includes('n')) { top = Math.min(q.y, bottom - 1); height = bottom - top; }
        if (id.includes('s')) { height = Math.max(1, q.y - top); }
        if (ev.shiftKey && id.length === 2 && start.height > 0) {
          const ratio = start.width / start.height;
          if (width / height > ratio) height = width / ratio; else width = height * ratio;
          if (id.includes('w')) left = right - width;
          if (id.includes('n')) top = bottom - height;
        }
        scaleBounds(items, stageName, start, { left, top, width, height });
      });
    }
  }

  finishDrawing() {
    const { what, slice } = this.drawing;
    const pts = this.drawing.points.slice(0, -1);
    this.drawing = null;
    if (pts.length < 3) {
      this.renderPanels();
      return;
    }
    if (what === 'polygon') {
      this.addPolygon(pts);
    } else {
      this.edit(() => {
        const [w, hh] = this.stageSize();
        const list = what === 'inputMask' ? slice.inputMasks : this.screen.masks;
        const m = newMask(what === 'inputMask' ? 'input' : 'output', 'rect', w, hh, list.length + 1);
        m.points = pts;
        m.shape = 'draw';
        list.push(m);
        if (what !== 'inputMask') bringToTop(this.screen, m);
        this.selection = [m];
      });
    }
    this.editMode = 'points';
    this.renderPanels();
  }

  insertVertex(m, p) {
    let best = 0;
    let bestD = Infinity;
    m.points.forEach((a, i) => {
      const b = m.points[(i + 1) % m.points.length];
      const l = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l));
      const d = Math.hypot(p.x - a.x - t * (b.x - a.x), p.y - a.y - t * (b.y - a.y));
      if (d < bestD) { bestD = d; best = i; }
    });
    m.points.splice(best + 1, 0, { x: p.x, y: p.y });
  }

  // ---- Menú contextual ----
  openContextMenu(x, y) {
    const items = this.selection;
    const stageName = this.stageMode;
    const [w, hh] = this.stageSize();
    const has = items.length > 0;
    const slices = items.filter((i) => !i.points);
    const reorder = (delta) => this.edit(() => {
      for (const item of items) if (this.screen.slices.includes(item) || this.screen.masks.includes(item)) moveInStack(this.screen, item, delta);
    });
    const paste = () => this.edit(() => {
      this.selection = this.clipboard.map((json) => {
        const copy = { ...JSON.parse(json), id: uid() };
        copy.name = `${copy.name} copia`;
        for (const m of copy.inputMasks || []) m.id = uid();
        (copy.points ? this.screen.masks : this.screen.slices).push(copy);
        bringToTop(this.screen, copy);
        return copy;
      });
    });
    const copy = () => { this.clipboard = items.filter((i) => i.stage !== 'input').map((i) => JSON.stringify(i)); };
    const remove = () => this.removeItems(items);
    const area = (name) => () => this.edit(() => fitArea(items, stageName, AREAS[name](w, hh)));
    const groups = [
      [['Centrar X', () => this.edit(() => setCenter(items, stageName, 'x', w / 2)), has],
        ['Centrar Y', () => this.edit(() => setCenter(items, stageName, 'y', hh / 2)), has],
        ['Espejo X', () => this.edit(() => mirror(items, stageName, 'x', w)), has],
        ['Espejo Y', () => this.edit(() => mirror(items, stageName, 'y', hh)), has]],
      [['Mitad izquierda', area('left'), has], ['Mitad superior', area('top'), has], ['Mitad derecha', area('right'), has], ['Mitad inferior', area('bottom'), has], ['Área completa', area('whole'), has]],
      [['Igualar a la forma de entrada', () => this.edit(() => slices.forEach(matchInputShape)), slices.length > 0],
        ['Intercambiar entrada y salida', () => this.edit(() => slices.forEach(swapInputOutput)), slices.length > 0]],
      [['Traer adelante', () => reorder(1), has], ['Enviar atrás', () => reorder(-1), has]],
      [['Duplicar', () => this.edit(() => { this.selection = this.cloneItems(items); }), has],
      ['Copiar', copy, has],
      ['Cortar', () => { copy(); this.edit(remove); }, has],
      ['Pegar', paste, this.clipboard.length > 0]],
    ];
    const rows = groups.flatMap((group, g) => [
      g ? h('hr', {}) : null,
      ...group.map(([label, fn, enabled]) => h('button', { disabled: !enabled, onClick: () => { this.contextMenu.hidden = true; fn(); } }, label)),
    ]).filter(Boolean);
    this.contextMenu.replaceChildren(...rows);
    this.contextMenu.hidden = false;
    const my = Math.min(y, window.innerHeight - 420);
    this.contextMenu.style.left = `${x}px`;
    this.contextMenu.style.top = `${Math.max(4, my)}px`;
  }

  onKey(e) {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (e.ctrlKey && e.code === 'KeyZ') { e.preventDefault(); this.undo(); return; }
    if (e.ctrlKey && e.code === 'KeyY') { e.preventDefault(); this.redo(); return; }
    if (e.code === 'Escape') {
      if (this.drawing) { this.drawing = null; this.renderPanels(); } else this.contextMenu.hidden = true;
      return;
    }
    if (e.code === 'KeyT' && this.selection.length) {
      this.editMode = this.editMode === 'transform' ? 'points' : 'transform';
      this.renderPanels();
      return;
    }
    if ((e.code === 'Delete' || e.code === 'Backspace') && this.selection.length) {
      this.edit(() => this.removeItems(this.selection));
      return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.code];
    if (arrows && this.selection.length) {
      e.preventDefault();
      const k = e.shiftKey ? 10 : 1;
      this.edit(() => translate(this.selection, this.stageMode, arrows[0] * k, arrows[1] * k));
    }
  }

  startLoop() {
    const loop = () => {
      if (this.root.hidden) return;
      try {
        this.drawStage();
      } catch (err) {
        console.error(err);
      }
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  drawStage() {
    const { stage, screen } = this;
    if (!screen || !stage) return;
    const parent = stage.parentElement;
    const cw = Math.max(16, parent.clientWidth);
    const ch = Math.max(16, parent.clientHeight);
    if (stage.width !== cw || stage.height !== ch) {
      // Si el panel cambia de tamaño se conserva el encuadre; no debe saltar al seleccionar.
      this.view.panX += (cw - stage.width) / 2;
      this.view.panY += (ch - stage.height) / 2;
      stage.width = cw;
      stage.height = ch;
    }
    if (this.fitNext) this.fitView();
    this.zoomLabel.textContent = `${Math.round(this.view.zoom * 100)} %`;
    const ctx = stage.getContext('2d');
    const [w, hh] = this.stageSize();
    const { zoom, panX, panY } = this.view;
    const sx = (x) => x * zoom + panX;
    const sy = (y) => y * zoom + panY;
    ctx.fillStyle = '#2b2d33';
    ctx.fillRect(0, 0, cw, ch);
    const source = this.stageMode === 'input' ? this.app.engine.canvas : this.app.outputs.renderers.get(screen.id)?.canvas;
    ctx.fillStyle = '#000';
    ctx.fillRect(panX, panY, w * zoom, hh * zoom);
    if (source) ctx.drawImage(source, panX, panY, w * zoom, hh * zoom);
    const guide = this.guide?.[this.stageMode];
    if (guide) {
      ctx.globalAlpha = 0.5;
      ctx.drawImage(guide, panX, panY, w * zoom, hh * zoom);
      ctx.globalAlpha = 1;
    }
    if (this.showGrid) {
      ctx.strokeStyle = 'rgba(255,255,255,.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 100) { ctx.moveTo(sx(x), panY); ctx.lineTo(sx(x), sy(hh)); }
      for (let y = 0; y <= hh; y += 100) { ctx.moveTo(panX, sy(y)); ctx.lineTo(sx(w), sy(y)); }
      ctx.stroke();
    }
    const path = (pts, closed = true) => {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y))));
      if (closed) ctx.closePath();
    };
    const square = (p, color, size = HANDLE) => {
      ctx.fillStyle = '#17181c';
      ctx.fillRect(sx(p.x) - size / 2, sy(p.y) - size / 2, size, size);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx(p.x) - size / 2, sy(p.y) - size / 2, size, size);
    };
    const ACCENT = '#00c8d7';
    const MASK = '#ffb020';
    for (const s of screen.slices) {
      if (s.enabled === false && !this.selection.includes(s)) continue;
      const selected = this.selection.includes(s);
      const outline = outlinePoints(s, this.stageMode);
      ctx.setLineDash(this.stageMode === 'input' ? [5, 3] : []);
      ctx.strokeStyle = selected ? ACCENT : 'rgba(0,200,215,.55)';
      ctx.lineWidth = selected ? 2 : 1;
      if (this.stageMode === 'output' && s.warpMode === 'grid' && s.grid) {
        const { nx, ny, points } = s.grid;
        for (let j = 0; j < ny; j++) { path(Array.from({ length: nx }, (_, i) => points[j * nx + i]), false); ctx.stroke(); }
        for (let i = 0; i < nx; i++) { path(Array.from({ length: ny }, (_, j) => points[j * nx + i]), false); ctx.stroke(); }
      } else if (this.stageMode === 'output' && s.warpMode === 'bezier') {
        for (let j = 0; j < 4; j++) { path([0, 1, 2, 3].map((i) => s.bezier[j * 4 + i]), false); ctx.stroke(); }
        for (let i = 0; i < 4; i++) { path([0, 1, 2, 3].map((j) => s.bezier[j * 4 + i]), false); ctx.stroke(); }
      } else {
        path(outline);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      if (selected) {
        const b = groupBounds([s], this.stageMode);
        ctx.fillStyle = ACCENT;
        ctx.font = '13px Segoe UI';
        ctx.textAlign = 'center';
        ctx.fillText(s.name, sx(b.x), sy(b.y));
        ctx.textAlign = 'start';
      }
    }
    for (const m of this.stageMasks()) {
      const selected = this.selection.includes(m);
      ctx.strokeStyle = selected ? MASK : 'rgba(255,176,32,.6)';
      ctx.lineWidth = selected ? 2 : 1.5;
      if (m.kind === 'ellipse') {
        const [a, b] = m.points;
        ctx.beginPath();
        ctx.ellipse(sx((a.x + b.x) / 2), sy((a.y + b.y) / 2), (Math.abs(b.x - a.x) / 2) * zoom, (Math.abs(b.y - a.y) / 2) * zoom, 0, 0, Math.PI * 2);
      } else path(m.points);
      ctx.stroke();
    }
    if (this.selection.length) {
      if (this.editMode === 'transform') {
        const handles = this.transformHandles();
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1;
        const b = handles.bounds;
        ctx.strokeRect(sx(b.left), sy(b.top), b.width * zoom, b.height * zoom);
        for (const q of handles.scale) {
          if (q.id.length === 2) {
            ctx.beginPath();
            ctx.arc(sx(q.x), sy(q.y), ROTATE_RING, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(0,200,215,.7)';
            ctx.stroke();
          }
          square(q, ACCENT);
        }
      } else {
        for (const item of this.selection) {
          for (const q of editablePoints(item, this.stageMode)) square(q, item.points ? MASK : ACCENT, 11);
        }
      }
    }
    if (this.drawing?.points.length) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      path(this.drawing.points, false);
      ctx.stroke();
      for (const q of this.drawing.points) square(q, '#fff');
    }
  }
}

export { uid };
