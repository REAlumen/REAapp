// Prueba end-to-end dentro de la app real. Se ejecuta con `npm run selftest`.
import { newClip, newMask, setClip, sourceFromPath, rect } from './model.js';
import { parseAdvancedOutput, parseAvc } from './avc-import.js';
import { rasterizeMasks } from './output.js';
import { bezierFromCorners } from './warp.js';
import { groupBounds, moveInStack, reshapeMask } from './slice-ops.js';
import { removeLayer as removeLayerOp, setCompositionSize } from './grid-ops.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run(options = {}) {
  const app = window.realumen;
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: String(detail) });
  const attempt = async (name, fn) => {
    try { await fn(); } catch (err) { check(name, false, err.stack || err.message); }
  };
  app.setComposition((await import('./model.js')).newComposition());
  const { comp, engine } = app;
  const [l1, l2, l3] = comp.layers;
  const gen = (name, values) => newClip({ type: 'generator', gen: name, values }, name);

  await attempt('generador', async () => {
    const red = gen('Color Sólido', [1, 0, 0]);
    setClip(comp, l1.id, 0, red);
    engine.trigger(l1, red);
    await sleep(150);
    const px = engine.readPixel(960, 540);
    check('un generador pinta la composición', px[0] > 240 && px[1] < 10, px);
  });

  await attempt('autopilot', async () => {
    const a = gen('Color Sólido', [0, 1, 0]);
    const b = gen('Color Sólido', [0, 0, 1]);
    a.transport.duration = 0.3;
    b.transport.duration = 0.3;
    setClip(comp, l3.id, 6, a);
    setClip(comp, l3.id, 7, b);
    engine.trigger(l3, a);
    await sleep(600);
    check('sin autopilot en el layer, la imagen se queda', l3.activeClip === a.id, l3.activeClip);
    l3.autopilot = 'next';
    engine.trigger(l3, a);
    await sleep(450);
    check('el autopilot del layer pasa al clip siguiente al cumplirse la duración', l3.activeClip === b.id, l3.activeClip);
    b.autopilot = 'none';
    await sleep(600);
    check('la acción "No hacer nada" del clip detiene el autopilot', l3.activeClip === b.id, l3.activeClip);
    const text = (nodes) => nodes.map((n) => n.textContent).join(' ');
    check('el panel del layer muestra los botones del autopilot', /◀◀.*OFF.*▶▶.*⤨/.test(text(app.ui.layerPanel(l3))), text(app.ui.layerPanel(l3)).slice(0, 120));
    const clipText = text(app.ui.clipPanel(b));
    check('el panel de un clip de imagen muestra duración y acción del autopilot', clipText.includes('Duración') && clipText.includes('Seguir al layer'), clipText.slice(0, 160));
    b.autopilot = 'layer';
    b.transport.duration = 'dañado';
    await sleep(200);
    check('una duración dañada no detiene la reproducción', engine.runtime(b).dur > 0 && !engine.runtime(b).error, engine.runtime(b).dur);
    l3.autopilot = 'off';
    engine.disconnect(l3);
    setClip(comp, l3.id, 6, null);
    setClip(comp, l3.id, 7, null);
  });

  await attempt('mezcla', async () => {
    const blue = gen('Color Sólido', [0, 0, 1]);
    setClip(comp, l2.id, 0, blue);
    l2.blend = 'Add';
    engine.trigger(l2, blue);
    await sleep(150);
    const px = engine.readPixel(960, 540);
    check('la mezcla Add suma dos capas', px[0] > 240 && px[2] > 240, px);
    l2.opacity = 0.25;
    await sleep(100);
    const half = engine.readPixel(960, 540);
    check('la opacidad de capa reduce su aporte', half[2] > 100 && half[2] < 160, half);
    l2.opacity = 0.5;
    l2.bypass = true;
    await sleep(100);
    const off = engine.readPixel(960, 540);
    check('bypass oculta la capa', off[2] < 10, off);
    l2.bypass = false;
    l2.master = 0;
    await sleep(100);
    const noMaster = engine.readPixel(960, 540);
    check('el Master del layer en 0 oculta la capa', noMaster[2] < 10, noMaster);
    l2.master = 1;
    app.ui.renderGrid();
    const head = [...document.querySelectorAll('.layerhead')].find((el) => el.textContent.includes(l2.name));
    const xf = document.querySelector('#topbar input[type=range]');
    check('el crossfader A/B sigue horizontal', xf && xf.getBoundingClientRect().width > xf.getBoundingClientRect().height * 2, xf && `${xf.getBoundingClientRect().width}x${xf.getBoundingClientRect().height}`);
    check('la cabecera del layer tiene los faders M, A y V', head && head.querySelectorAll('.fader input[type=range]').length === 3 && /M\s*A\s*V/.test(head.querySelector('.faders').textContent), head?.querySelector('.faders')?.textContent);
  });

  await attempt('crossfader', async () => {
    l2.side = 'B';
    comp.crossfader = -1;
    await sleep(100);
    const a = engine.readPixel(960, 540);
    check('el crossfader en A apaga el lado B', a[2] < 10, a);
    comp.crossfader = 0;
    l2.side = '';
  });

  await attempt('efecto', async () => {
    const clip = comp.decks[0].clips[`${l1.id}:0`];
    clip.effects.push({ id: 'fx1', type: 'Invert RGB', bypass: false, values: [1] });
    l2.bypass = true;
    await sleep(100);
    const px = engine.readPixel(960, 540);
    check('Invert RGB convierte rojo en cian', px[0] < 10 && px[1] > 240 && px[2] > 240, px);
    clip.effects.length = 0;
    l2.bypass = false;
  });

  await attempt('video y cues', async () => {
    if (!options.video) return; // Opcional: REALUMEN_TEST_VIDEO indica un video propio.
    l3.solo = true;
    const { source, name } = sourceFromPath(options.video);
    const clip = newClip(source, name);
    setClip(comp, l3.id, 0, clip);
    engine.trigger(l3, clip);
    await sleep(2500);
    const rt = engine.runtimes.get(clip.id);
    check('un video local se carga sin error', rt.ready && !rt.error, rt.error);
    const sample = () => {
      let sum = 0;
      for (let y = 60; y < 1080; y += 120) for (let x = 60; x < 1920; x += 120) sum += engine.readPixel(x, y).slice(0, 3).reduce((a, b) => a + b, 0);
      return sum;
    };
    const a = sample();
    await sleep(500);
    const b = sample();
    check('el video llega a la textura', a > 0, a);
    check('los fotogramas del video cambian', a !== b, `${a} -> ${b}`);
    await window.native.selftestShot('00-video.png');
    const before = rt.t;
    await sleep(200);
    check('el transporte avanza', rt.t !== before, `${before} -> ${rt.t}`);
    engine.addCue(clip);
    clip.cues[0].t = 0.1;
    engine.jumpCue(clip, clip.cues[0]);
    check('saltar a un cue mueve la posición', Math.abs(rt.t - 0.1) < 0.05, rt.t);
    clip.transport.dir = 0;
    engine.seek(clip, 0.5);
    const paused = rt.t;
    await sleep(150);
    check('la pausa detiene el transporte', rt.t === paused, `${paused} -> ${rt.t}`);
    engine.disconnect(l3);
    l3.solo = false;
  });

  await attempt('DXV', async () => {
    for (const [label, path] of options.dxvFiles || []) {
      l3.solo = true;
      const clip = newClip(sourceFromPath(path).source, label);
      setClip(comp, l3.id, 0, clip);
      engine.trigger(l3, clip);
      await sleep(1000);
      const rt = engine.runtimes.get(clip.id);
      check(`DXV ${label}: abre sin error`, rt.ready && !rt.error && rt.worker, `${rt.error} ${rt.w}x${rt.h} dur=${rt.dur}`);
      const sample = () => {
        let sum = 0;
        for (let y = 60; y < 1080; y += 120) for (let x = 60; x < 1920; x += 120) sum += engine.readPixel(x, y).slice(0, 3).reduce((a, b) => a + b, 0);
        return sum;
      };
      const a = sample();
      const f0 = rt.frame;
      await sleep(1000);
      const b = sample();
      const fps0 = engine.fps;
      check(`DXV ${label}: la imagen llega y cambia`, (a > 0 || b > 0) && a !== b && rt.frame !== f0, `${a} -> ${b}, cuadro ${f0} -> ${rt.frame}, ${rt.decodeMs?.toFixed(1)} ms/cuadro, ${fps0.toFixed(0)} fps`);
      // El audio se carga aparte y puede tardar más que la imagen.
      for (let i = 0; i < 30 && rt.hasAudio && !rt.voice && !rt.audioError; i++) await sleep(100);
      if (rt.audioBuffer || rt.audioError) check(`DXV ${label}: audio`, rt.audioBuffer && !rt.audioError && rt.voice, `${rt.audioError || ''} ${rt.audioBuffer?.duration?.toFixed(2)}s ${rt.audioBuffer?.sampleRate}Hz`);
      if (rt.voice) {
        clip.pan = 0.5;
        l3.pan = 0.25;
        clip.volume = 0.5;
        await sleep(100);
        const v = rt.voice;
        check(`DXV ${label}: el volumen y el paneo del clip llegan al audio`, Math.abs(v.panner.pan.value - 0.75) < 0.01 && Math.abs(v.gain.gain.value - 0.5) < 0.01, `pan ${v.panner.pan.value} vol ${v.gain.gain.value}`);
        l3.pan = 0;
      }
      check(`DXV ${label}: miniatura`, !!rt.thumb);
      await window.native.selftestShot(`dxv-${label}.png`);
      engine.disconnect(l3);
      setClip(comp, l3.id, 0, null);
      engine.forget(clip);
      l3.solo = false;
    }
  });

  const previewPixel = () => [...engine.previewCtx.getImageData(320, 180, 1, 1).data];

  await attempt('preview', async () => {
    const onAir = comp.decks[0].clips[`${l1.id}:0`];
    engine.trigger(l1, onAir);
    l2.bypass = true;
    const green = gen('Color Sólido', [0, 1, 0]);
    setClip(comp, l3.id, 5, green);
    const handle = () => [...document.querySelectorAll('.cell .handle')].find((n) => n.textContent === 'Color Sólido' && n.closest('tr') === document.querySelector('#grid tbody tr'));
    app.ui.renderGrid();
    handle().click();
    await sleep(200);
    check('la barra del clip lo muestra en el Preview', previewPixel()[1] > 240 && previewPixel()[0] < 10, previewPixel());
    check('previsualizar no conecta el clip', l3.activeClip !== green.id, l3.activeClip);
    const air = engine.readPixel(960, 540);
    check('previsualizar no cambia la salida', air[0] > 240 && air[1] < 10, air);
    check('el clip previsualizado queda seleccionado', app.ui.sel.clip === green.id, app.ui.sel.clip);
    await window.native.selftestShot('03-preview.png');
    engine.setPreview({ kind: 'layer', layer: l1 });
    await sleep(100);
    check('el nombre de capa muestra la capa en el Preview', previewPixel()[0] > 240, previewPixel());
    engine.setPreview(null);
    setClip(comp, l3.id, 5, null);
    engine.forget(green);
    l2.bypass = false;
  });

  await attempt('captura', async () => {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    check('se listan dispositivos de video', devices.length > 0, devices.map((d) => d.label).join(', '));
    await app.ui.refreshDevices();
    const clip = newClip({ type: 'capture', deviceId: devices[0].deviceId, label: devices[0].label }, devices[0].label);
    setClip(comp, l3.id, 6, clip);
    l3.solo = true;
    engine.trigger(l3, clip);
    await sleep(1500);
    const rt = engine.runtimes.get(clip.id);
    check('el dispositivo se abre sin error', rt.active && rt.media && !rt.error, `${rt.error} ${rt.media?.videoWidth}x${rt.media?.videoHeight}`);
    const px = () => {
      let sum = 0;
      for (let y = 60; y < 1080; y += 120) for (let x = 60; x < 1920; x += 120) sum += engine.readPixel(x, y).slice(0, 3).reduce((a, b) => a + b, 0);
      return sum;
    };
    const a = px();
    await sleep(400);
    check('la imagen del dispositivo llega y cambia', a > 0 && a !== px(), a);
    engine.disconnect(l3);
    l3.solo = false;
    await sleep(2300);
    check('al dejar de usarlo se libera el dispositivo', !rt.active && !rt.stream, rt.active);
    setClip(comp, l3.id, 6, null);
    engine.forget(clip);
  });

  await attempt('NDI', async () => {
    await app.ndi.ready;
    check('el NDI Runtime carga por la API oficial', app.ndi.available, app.ndi.version || app.ndi.error);
    if (!app.ndi.available) return;
    const name = `REAlumen Prueba ${Date.now() % 100000}`;
    const onAir = comp.decks[0].clips[`${l1.id}:0`];
    engine.trigger(l1, onAir);
    l2.bypass = true;
    comp.ndiOutput = { enabled: true, name, fps: 30 };
    app.syncNdi();
    const sentAt = app.ndi.output('program').sentFrames;
    const t0 = performance.now();
    await sleep(3500);
    const rate = (app.ndi.output('program').sentFrames - sentAt) / ((performance.now() - t0) / 1000);
    check('la salida NDI mantiene la cadencia declarada', Math.abs(app.ndi.output('program').wireFps - 30) <= 3, `en la red ${app.ndi.output('program').wireFps} cuadros/s; render entrega ${rate.toFixed(1)}/s; app a ${engine.fps.toFixed(0)} fps`);
    check('la app sigue fluida enviando NDI', engine.fps > 45, engine.fps.toFixed(0));
    check('el render entrega cuadros nuevos a la cadencia de NDI', rate > 25, `${rate.toFixed(1)}/s`);
    check('NDI informa el nombre publicado', app.ndi.output('program').publishedName?.includes(name), app.ndi.output('program').publishedName);
    let found = null;
    for (let i = 0; i < 30 && !found; i++) {
      found = app.ndi.sources.find((n) => n.includes(name));
      if (!found) await sleep(500);
    }
    check('la salida aparece como fuente NDI en la red', !!found, app.ndi.sources.join(' | '));
    if (!found) return;
    const input = newClip({ type: 'ndi', name: found }, found);
    setClip(comp, l3.id, 7, input);
    app.ui.previewClip(input);
    let rt = engine.runtimes.get(input.id);
    for (let i = 0; i < 40 && !(rt?.frames > 3); i++) { await sleep(250); rt = engine.runtimes.get(input.id); }
    check('la entrada NDI recibe cuadros', rt?.frames > 3 && !rt.error, `${rt?.frames} cuadros ${rt?.w}x${rt?.h} ${rt?.error}`);
    const f0 = rt?.frames || 0;
    await sleep(2000);
    check('la entrada NDI recibe a ritmo', ((rt?.frames || 0) - f0) / 2 > 20, `${((rt?.frames || 0) - f0) / 2} cuadros/s`);
    check('la fuente informa conexión', rt?.connected === true, rt?.connected);
    check('el tally refleja preview', rt?.tally === 'false:true', rt?.tally);
    await sleep(300);
    const before = previewPixel();
    check('la imagen enviada vuelve por NDI (rojo)', before[0] > 230 && before[2] < 25, before);
    const blue = gen('Color Sólido', [0, 0, 1]);
    setClip(comp, l1.id, 8, blue);
    engine.trigger(l1, blue);
    await sleep(800);
    const after = previewPixel();
    check('un cambio en la salida llega por NDI (azul)', after[2] > 230 && after[0] < 25, after);
    await window.native.selftestShot('04-ndi.png');
    // Medición a 60 fps, solo informativa: depende de la potencia del equipo.
    comp.ndiOutput.fps = 60;
    const s60 = app.ndi.output('program').sentFrames;
    const t60 = performance.now();
    await sleep(3000);
    check('Medición NDI a 60 fps', true, `en la red ${app.ndi.output('program').wireFps}/s; cuadros nuevos ${((app.ndi.output('program').sentFrames - s60) / ((performance.now() - t60) / 1000)).toFixed(1)}/s; app a ${engine.fps.toFixed(0)} fps`);
    comp.ndiOutput.enabled = false;
    app.syncNdi();
    engine.setPreview(null);
    engine.forget(input);
    setClip(comp, l3.id, 7, null);
    setClip(comp, l1.id, 8, null);
    engine.trigger(l1, onAir);
    l2.bypass = false;
  });

  await attempt('oráculo de mezcla', async () => {
    if (!options.oracleDir) return;
    const lut = JSON.parse(await window.native.readText(`${options.oracleDir}/blend-lut.json`));
    const baseClip = newClip({ type: 'image', path: `${options.oracleDir}/ideal-base.png` }, 'base');
    const overClip = newClip({ type: 'image', path: `${options.oracleDir}/ideal-over.png` }, 'over');
    // Curva medida de la captura NDI de la app de referencia: valor ideal i/(grid-1) frente a valor recibido.
    const curve = lut.base.slice(0, lut.grid).map((p) => p[0]);
    const throughNdi = (v) => {
      const pos = (v / 255) * (curve.length - 1);
      const k = Math.min(curve.length - 2, Math.floor(pos));
      return curve[k] + (curve[k + 1] - curve[k]) * (pos - k);
    };
    setClip(comp, l1.id, 3, baseClip);
    setClip(comp, l2.id, 3, overClip);
    const saved = [l1.blend, l2.blend, l2.bypass, l2.opacity];
    l1.blend = 'Alpha'; l1.opacity = 1; l2.bypass = false; l3.bypass = true; l3.solo = false;
    engine.trigger(l1, baseClip);
    engine.trigger(l2, overClip);
    await sleep(600);
    const results = {};
    const { BLEND_MODES } = await import('./model.js');
    const compare = async (label, mode, opacity, table) => {
      l2.blend = mode;
      l2.opacity = opacity;
      await sleep(80);
      let sum = 0;
      let max = 0;
      const n = lut.grid;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const x = Math.min(1919, Math.round((i / (n - 1)) * 1919));
          const y = Math.min(1079, Math.round((j / (n - 1)) * 1079));
          const px = engine.readPixel(x, y);
          const ref = table[j * n + i];
          for (let c = 0; c < 3; c++) {
            const d = Math.abs(throughNdi(px[c]) - ref[c]);
            sum += d;
            if (d > max) max = Math.round(d);
          }
        }
      }
      const mean = sum / (n * n * 3);
      results[label] = { mean: Number(mean.toFixed(2)), max };
      check(`Mezcla igual que la app de referencia: ${label}`, mean <= 3, `error medio ${mean.toFixed(2)}, máximo ${max} (niveles 0-255)`);
    };
    for (const mode of BLEND_MODES) if (lut.modes[mode]) await compare(mode, mode, lut.opacity, lut.modes[mode]);
    for (const [key, table] of Object.entries(lut.phases)) {
      const [mode, opacity] = key.split('@');
      await compare(key, mode, Number(opacity), table);
    }
    await window.native.selftestWrite('blend-compare.json', new TextEncoder().encode(JSON.stringify(results, null, 1)));
    [l1.blend, l2.blend, l2.bypass, l2.opacity] = saved;
    l3.bypass = false;
    engine.disconnect(l2);
    setClip(comp, l1.id, 3, null);
    setClip(comp, l2.id, 3, null);
    engine.forget(baseClip);
    engine.forget(overClip);
  });

  await attempt('beat snap', async () => {
    const clip = gen('Color Sólido', [0, 1, 0]);
    clip.beatSnap = 4;
    setClip(comp, l3.id, 1, clip);
    engine.beat = 0.1;
    engine.trigger(l3, clip);
    check('beat snap retrasa el disparo', l3.activeClip === null, l3.activeClip);
    engine.beat = 3.99;
    await sleep(100);
    check('beat snap dispara en el siguiente compás', l3.activeClip === clip.id, l3.activeClip);
    engine.disconnect(l3);
  });

  await attempt('máscaras', async () => {
    const c = document.createElement('canvas');
    const m1 = newMask('output', 'polygon', 100, 100, 1);
    m1.points = rect(0, 0, 50, 100);
    const m2 = newMask('output', 'ellipse', 100, 100, 2);
    m2.points = [{ x: 60, y: 60 }, { x: 100, y: 100 }];
    rasterizeMasks(c, [m1, m2], 100, 100);
    const px = (x, y) => c.getContext('2d').getImageData(x, y, 1, 1).data[0];
    check('varias máscaras tapan sus zonas', px(10, 50) < 5 && px(80, 80) < 5 && px(80, 20) > 250, [px(10, 50), px(80, 80), px(80, 20)]);
    m1.invert = true;
    rasterizeMasks(c, [m1], 100, 100);
    check('una máscara invertida tapa el exterior', px(10, 50) > 250 && px(80, 50) < 5, [px(10, 50), px(80, 50)]);
  });

  await attempt('salida', async () => {
    const screen = comp.screens[0];
    l1.bypass = false; l2.bypass = true;
    const [red] = [comp.decks[0].clips[`${l1.id}:0`]];
    engine.trigger(l1, red);
    await sleep(100);
    screen.width = 1920; screen.height = 1080;
    screen.slices[0].input = rect(0, 0, 1920, 1080);
    screen.slices[0].corners = rect(0, 0, 960, 540);
    const mask = newMask('output', 'polygon', 1920, 1080, 1);
    mask.points = rect(0, 0, 200, 200);
    screen.masks = [mask];
    app.outputs.invalidate(screen);
    app.outputs.previewActive = true;
    await sleep(200);
    const r = app.outputs.renderer(screen);
    const { gl } = r;
    const read = (x, y) => {
      const o = new Uint8Array(4);
      gl.readPixels(x, 1080 - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, o);
      return [...o];
    };
    const inside = read(480, 270);
    const outside = read(1500, 800);
    const masked = read(100, 100);
    check('el slice dibuja la composición en su zona', inside[0] > 240, inside);
    check('fuera del slice queda negro', outside[0] < 5, outside);
    check('la máscara de salida tapa el slice', masked[0] < 5, masked);

    const displays = await window.native.displays();
    check('se detectan las pantallas del equipo', displays.length > 0, displays.map((d) => d.label).join(' | '));
    screen.device = { type: 'windowed', displayId: displays[displays.length - 1].id };
    app.outputs.applyDevice(screen);
    const win = app.outputs.windows.get(screen.id);
    check('se abre la ventana de salida', win && !win.win.closed);
    await sleep(400);
    const ctxPx = win.ctx.getImageData(480, 270, 1, 1).data;
    check('la ventana de salida recibe la imagen', ctxPx[0] > 240, [...ctxPx]);
    win.win.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    check('Esc desactiva la salida en la ventana', !app.outputs.windows.has(screen.id) && screen.device.type === 'virtual', screen.device.type);

    if (app.ndi.available) {
      screen.name = `Pantalla NDI ${Date.now() % 100000}`;
      screen.device = { type: 'ndi', name: screen.name, fps: 30 };
      app.outputs.applyDevice(screen);
      await sleep(2500);
      const status = app.ndi.output(screen.id);
      check('una pantalla puede salir por NDI', status.publishedName?.includes(screen.name) && status.wireFps > 25, `${status.publishedName} ${status.wireFps} cuadros/s`);
      let found = null;
      for (let i = 0; i < 24 && !found; i++) {
        found = app.ndi.sources.find((n) => n.includes(screen.name));
        if (!found) await sleep(500);
      }
      check('la pantalla NDI aparece en la red', !!found, found);
      if (found) {
        const input = newClip({ type: 'ndi', name: found }, found);
        setClip(comp, l3.id, 7, input);
        app.ui.previewClip(input);
        let rt = engine.runtimes.get(input.id);
        for (let i = 0; i < 40 && !(rt?.frames > 3); i++) { await sleep(250); rt = engine.runtimes.get(input.id); }
        await sleep(300);
        // Con el slice en el cuarto superior izquierdo: abajo a la derecha debe llegar negro y sin invertir.
        const ctx = engine.previewCtx;
        const w = ctx.canvas.width;
        const hh = ctx.canvas.height;
        const inSlice = [...ctx.getImageData(Math.round(w * 0.3), Math.round(hh * 0.3), 1, 1).data];
        const outOfSlice = [...ctx.getImageData(Math.round(w * 0.75), Math.round(hh * 0.75), 1, 1).data];
        check('la imagen por NDI de pantalla llega derecha', inSlice[0] > 200 && outOfSlice[0] < 25, `${inSlice} / ${outOfSlice}`);
        engine.setPreview(null);
        engine.forget(input);
        setClip(comp, l3.id, 7, null);
      }
      screen.device = { type: 'virtual' };
      app.outputs.applyDevice(screen);
    }
    app.outputs.previewActive = false;
    screen.masks = [];
    screen.slices[0].corners = rect(0, 0, 1920, 1080);
    screen.slices[0].bezier = bezierFromCorners(screen.slices[0].corners);
    app.outputs.invalidate(screen);
  });

  await attempt('celda vacía', async () => {
    const onAir = comp.decks[0].clips[`${l1.id}:0`];
    engine.trigger(l1, onAir);
    app.ui.renderGrid();
    await sleep(100);
    check('la capa tiene clip al aire', l1.activeClip === onAir.id, l1.activeClip);
    const row = [...document.querySelectorAll('#grid tbody tr')].at(-1);
    const emptyThumb = row.querySelectorAll('td .cell')[4].querySelector('.thumb');
    emptyThumb.click();
    await sleep(100);
    check('pulsar una celda vacía expulsa el clip de la capa', l1.activeClip === null, l1.activeClip);
    check('la celda vacía queda seleccionada', app.ui.sel.slot?.column === 4 && app.ui.sel.slot?.layer === l1.id, JSON.stringify(app.ui.sel.slot));
    check('la celda vacía se resalta', !!document.querySelector('#grid .cell.empty-sel'));
    check('el panel Clip queda vacío', document.querySelector('#clipprops .empty') !== null);
    await window.native.selftestShot('09-celda-vacia.png');
    const px = engine.readPixel(960, 540);
    check('la salida deja de mostrar ese clip', px[0] < 10 || l2.activeClip, px);
    app.ui.applyBrowserItem('Rings', 'text/realumen-source');
    await sleep(100);
    const placed = comp.decks[0].clips[`${l1.id}:4`];
    check('una fuente se coloca en la celda vacía elegida', !!placed, Object.keys(comp.decks[0].clips).join(','));
    engine.forget(placed);
    setClip(comp, l1.id, 4, null);
    app.ui.sel = {};
    engine.trigger(l1, onAir);
    app.ui.renderAll();
  });

  await attempt('columnas, capas y composición', async () => {
    const { ui } = app;
    const menuClick = (label) => {
      const button = [...document.querySelectorAll('.popup button')].find((b) => b.textContent.startsWith(label));
      if (!button) throw new Error(`Falta en el menú: ${label}`);
      button.click();
    };
    const openColumn = (i) => {
      const th = document.querySelectorAll('#grid th.colhead')[i];
      const r = th.getBoundingClientRect();
      th.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left, clientY: r.bottom }));
    };
    const columnsAtStart = comp.columns;
    const marker = gen('Lines', [1, 1, 1, 4, 0.5, 0]);
    setClip(comp, l3.id, 1, marker);
    ui.renderGrid();

    openColumn(1);
    await sleep(30);
    const labels = [...document.querySelectorAll('.popup button')].map((b) => b.textContent);
    check('el clic derecho abre el menú de columna', labels.some((l) => l.startsWith('Insertar antes')) && labels.some((l) => l.startsWith('Quitar todas las siguientes')), labels.join('|'));
    await window.native.selftestShot('11-menu-columna.png');
    menuClick('Insertar antes');
    await sleep(30);
    check('insertar antes corre los clips', comp.columns === columnsAtStart + 1 && comp.decks[0].clips[`${l3.id}:2`] === marker, comp.columns);
    openColumn(2);
    menuClick('Duplicar');
    check('duplicar columna copia el clip', comp.decks[0].clips[`${l3.id}:3`]?.name === 'Lines', comp.columns);
    openColumn(3);
    menuClick('Renombrar');
    await sleep(30);
    const renameInput = document.querySelector('.dialog input');
    renameInput.value = 'Coro';
    document.querySelector('.dialog button[type=submit]').click();
    await sleep(30);
    check('renombrar columna se ve en la cabecera', document.querySelectorAll('#grid th.colhead')[3].textContent === 'Coro', document.querySelectorAll('#grid th.colhead')[3].textContent);
    openColumn(3);
    menuClick('Quitar');
    openColumn(1);
    menuClick('Quitar');
    check('quitar columnas deja la rejilla como estaba', comp.columns === columnsAtStart && comp.decks[0].clips[`${l3.id}:1`] === marker, comp.columns);

    const layersAtStart = comp.layers.length;
    const head = [...document.querySelectorAll('#grid tbody td.layerhead')].at(-1);
    const hr = head.getBoundingClientRect();
    head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: hr.left + 20, clientY: hr.top + 10 }));
    await sleep(30);
    const layerLabels = [...document.querySelectorAll('.popup button')].map((b) => b.textContent);
    check('el clic derecho abre el menú de capa', layerLabels.some((l) => l.startsWith('Insertar encima')) && layerLabels.some((l) => l.startsWith('Bloquear contenido')), layerLabels.join('|'));
    await window.native.selftestShot('12-menu-capa.png');
    menuClick('Insertar encima');
    check('insertar capa encima', comp.layers.length === layersAtStart + 1 && comp.layers[1].id === ui.sel.layer, comp.layers.map((l) => l.name).join(','));
    const added = comp.layers[1];
    check('el selector de mezcla está en la cabecera de capa', !!document.querySelector('#grid tbody td.layerhead select'));
    ui.afterGridChange(removeLayerOp(comp, added));
    check('quitar la capa la elimina', comp.layers.length === layersAtStart);

    l1.ignoreColumn = true;
    const beforeTrigger = l1.activeClip;
    engine.triggerColumn(1);
    check('ignorar disparo de columna protege la capa', l1.activeClip === beforeTrigger, l1.activeClip);
    l1.ignoreColumn = false;
    engine.disconnect(l3);
    engine.trigger(l1, comp.decks[0].clips[`${l1.id}:0`]);

    ui.compositionSettings();
    await sleep(30);
    await window.native.selftestShot('13-configuracion.png');
    const form = document.querySelector('.dialog');
    const [nameField] = form.querySelectorAll('input[type=text]');
    const [w, hh] = form.querySelectorAll('input[type=number]');
    nameField.value = 'Prueba Configurada';
    w.value = 1280;
    hh.value = 720;
    form.querySelector('button[type=submit]').click();
    await sleep(120);
    check('la configuración cambia nombre y tamaño', comp.name === 'Prueba Configurada' && comp.width === 1280 && engine.canvas.width === 1280 && engine.canvas.height === 720, `${comp.name} ${engine.canvas.width}x${engine.canvas.height}`);
    const after = engine.readPixel(640, 360);
    check('el motor sigue renderizando tras cambiar el tamaño', after[0] > 200, after);
    setCompositionSize(comp, 1920, 1080);
    engine.resize();
    for (const s of comp.screens) app.outputs.invalidate(s);
    ui.renderAll();
    setClip(comp, l3.id, 1, null);
    engine.forget(marker);
    ui.renderGrid();
  });

  await attempt('editor de salidas con ratón', async () => {
    const ao = app.advanced;
    await ao.show();
    await sleep(300);
    const screen = ao.screen;
    const mouse = (type, x, y, opts = {}) => {
      const r = ao.stage.getBoundingClientRect();
      const init = {
        bubbles: true, button: 0, ...opts,
        clientX: r.left + ao.toScreenX(x) * (r.width / ao.stage.width),
        clientY: r.top + ao.toScreenY(y) * (r.height / ao.stage.height),
      };
      (type === 'mousedown' || type === 'contextmenu' || type === 'dblclick' ? ao.stage : window).dispatchEvent(new MouseEvent(type, init));
    };
    const drag = (x0, y0, x1, y1, opts) => {
      mouse('mousedown', x0, y0, opts);
      mouse('mousemove', (x0 + x1) / 2, (y0 + y1) / 2, opts);
      mouse('mousemove', x1, y1, opts);
      mouse('mouseup', x1, y1, opts);
    };
    ao.snap = false;
    const slice = screen.slices[0];
    mouse('mousedown', 960, 540);
    mouse('mouseup', 960, 540);
    check('un clic selecciona el slice', ao.selection[0] === slice, ao.selection.length);
    const panel = ao.rightPanel.textContent;
    check('el panel muestra los campos del slice', panel.includes('Rotación') && panel.includes('Is Key') && panel.includes('Soft Edge'), panel.slice(0, 80));
    await window.native.selftestShot('05-slice.png');

    // El ratón trabaja en píxeles enteros: la tolerancia es de un píxel de pantalla en cada eje.
    const tol = 2 / ao.view.zoom;
    drag(960, 540, 1060, 590);
    check('arrastrar mueve el slice', Math.abs(slice.corners[0].x - 100) < tol && Math.abs(slice.corners[0].y - 50) < tol, JSON.stringify(slice.corners[0]));
    ao.undo();
    const undone = ao.screen.slices[0];
    check('deshacer devuelve la posición', Math.abs(undone.corners[0].x) < 1, JSON.stringify(undone.corners[0]));
    ao.redo();
    check('rehacer vuelve a aplicarla', Math.abs(ao.screen.slices[0].corners[0].x - 100) < tol);
    const zoomBefore = ao.view.panY;
    await sleep(60);
    check('seleccionar no reencuadra el lienzo', ao.view.panY === zoomBefore, `${zoomBefore} -> ${ao.view.panY}`);
    ao.undo();

    const s = ao.screen.slices[0];
    ao.selection = [s];
    drag(1920, 1080, 960, 540);
    check('el tirador de esquina escala', Math.abs(s.corners[2].x - 960) < tol && Math.abs(s.corners[2].y - 540) < tol, JSON.stringify(s.corners[2]));
    const corner = { ...s.corners[2] };
    ao.selection = [s];
    ao.editMode = 'points';
    ao.renderPanels();
    await sleep(60);
    drag(corner.x, corner.y, 900, 600);
    check('Editar puntos mueve solo una esquina', Math.abs(s.corners[2].x - 900) < tol && Math.abs(s.corners[0].x) < tol, JSON.stringify(s.corners[2]));
    ao.editMode = 'transform';

    mouse('contextmenu', 200, 200);
    await sleep(50);
    const entry = [...ao.contextMenu.querySelectorAll('button')].find((b) => b.textContent === 'Mitad izquierda');
    check('el clic derecho abre el menú del slice', !ao.contextMenu.hidden && !!entry);
    await window.native.selftestShot('06-menu.png');
    entry.click();
    const left = groupBounds([ao.screen.slices[0]], 'output');
    check('Mitad izquierda ajusta el slice', Math.abs(left.left) < 1 && Math.abs(left.width - 960) < 1 && Math.abs(left.height - 1080) < 1, JSON.stringify(left));

    const addMenuText = ao.leftPanel.querySelector('.ao-add').textContent;
    check('no hay atajo de columnas: se diseña con slices', !addMenuText.includes('columnas'), addMenuText);
    check('el menú + ofrece polígono y máscara', addMenuText.includes('Polígono') && addMenuText.includes('Máscara de salida'), addMenuText);

    // Alt al arrastrar deja una copia del slice: así se construyen las divisiones.
    ao.selection = [ao.screen.slices[0]];
    ao.renderPanels();
    const before = groupBounds(ao.selection, 'output');
    drag(before.x, before.y, before.x + 960, before.y, { altKey: true });
    check('Alt+arrastrar duplica el slice', ao.screen.slices.length === 2 && Math.abs(groupBounds([ao.screen.slices[1]], 'output').left - 960) < tol, ao.screen.slices.length);
    await sleep(100);
    await window.native.selftestShot('07-slices.png');

    // Pila: una máscara solo tapa lo que tiene debajo.
    ao.addSlice();
    const whole = ao.screen.slices.at(-1);
    check('un slice nuevo ocupa toda la pantalla', Math.abs(whole.corners[2].x - 1920) < 1, JSON.stringify(whole.corners[2]));
    ao.addOutputMask('rect');
    const mask = ao.selection[0];
    mask.points = rect(600, 300, 700, 500);
    ao.invalidate();
    ao.addPolygon([{ x: 800, y: 400 }, { x: 1100, y: 400 }, { x: 1100, y: 700 }, { x: 800, y: 700 }]);
    const poly = ao.selection[0];
    check('el polígono es un slice más', poly.warpMode === 'polygon' && poly.corners.length === 4 && poly.input.length === 4);
    await sleep(150);
    const renderer = app.outputs.renderer(ao.screen);
    const read = (x, y) => {
      const o = new Uint8Array(4);
      renderer.gl.readPixels(x, 1080 - 1 - y, 1, 1, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, o);
      return o[0];
    };
    check('la máscara tapa lo que tiene debajo', read(700, 350) < 5, read(700, 350));
    check('el polígono encima de la máscara se ve', read(950, 550) > 200, read(950, 550));
    check('fuera de la máscara se sigue viendo', read(100, 100) > 200, read(100, 100));
    await window.native.selftestShot('10-mascara-poligono.png');
    moveInStack(ao.screen, mask, 1);
    ao.invalidate();
    await sleep(100);
    check('subir la máscara en la pila tapa también el polígono', read(950, 550) < 5, read(950, 550));
    moveInStack(ao.screen, mask, -1);
    mask.invert = true;
    ao.invalidate();
    await sleep(100);
    check('la máscara invertida deja ver solo su interior', read(700, 350) > 200 && read(100, 100) < 5, `${read(700, 350)} / ${read(100, 100)}`);
    mask.invert = false;
    reshapeMask(mask, 'ellipse');
    check('cambiar la forma conserva el recuadro', mask.kind === 'ellipse' && Math.abs(groupBounds([mask], 'output').width - 700) < 1, JSON.stringify(groupBounds([mask], 'output')));
    ao.removeItems([mask, poly]);

    // Máscara de entrada: pertenece a cada slice.
    ao.stageMode = 'input';
    ao.selection = [whole];
    ao.render();
    await sleep(100);
    check('la entrada ofrece máscara de slice', ao.rightPanel.textContent.includes('Máscara de entrada'), ao.rightPanel.textContent.slice(0, 80));
    ao.addInputMask(whole, 'rect');
    const inputMask = ao.selection[0];
    inputMask.points = rect(0, 0, 400, 400);
    ao.invalidate();
    await sleep(120);
    await window.native.selftestShot('08-entrada.png');
    ao.stageMode = 'output';
    ao.selection = [];
    ao.render();
    await sleep(120);
    for (const other of ao.screen.slices) if (other !== whole) other.enabled = false;
    ao.invalidate();
    await sleep(120);
    check('la máscara de entrada oculta esa zona del slice', read(100, 100) < 5 && read(1500, 800) > 200, `${read(100, 100)} / ${read(1500, 800)}`);
    check('la máscara de entrada queda en el slice', whole.inputMasks.length === 1 && ao.screen.masks.length === 0);

    // El editor no bloquea la rejilla: se pueden lanzar clips detrás.
    const panelRect = ao.root.getBoundingClientRect();
    const firstCol = document.querySelector('#grid th.colhead').getBoundingClientRect();
    check('el editor flotante deja ver la rejilla', panelRect.width < window.innerWidth && (panelRect.left > 0 || panelRect.top > 0), `${panelRect.left},${panelRect.top} ${panelRect.width}x${panelRect.height}`);
    const titleBar = ao.root.querySelector('.ao-title');
    const tb = titleBar.getBoundingClientRect();
    titleBar.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: tb.left + 40, clientY: tb.top + 5 }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: tb.left + 140, clientY: tb.top + 55 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const moved = ao.root.getBoundingClientRect();
    check('el editor se mueve por la barra de título', Math.abs(moved.left - panelRect.left - 100) < 2 && Math.abs(moved.top - panelRect.top - 50) < 2, `${moved.left},${moved.top}`);
    check('la rejilla sigue accesible', firstCol.width > 0);
    ao.root.style.left = '';
    ao.root.style.top = '';

    ao.close(false);
    check('Cancelar deshace todos los cambios', comp.screens[0].slices.length === 1 && Math.abs(comp.screens[0].slices[0].corners[2].x - 1920) < 1, comp.screens[0].slices.length);
    check('el editor se cierra', ao.root.hidden);
  });

  // Comprobaciones contra archivos creados con la app de referencia: solo si se indican en local/checks.json (no se publica).
  await attempt('importación de referencia', async () => {
    const local = options.localChecks;
    if (!local) return;
    if (local.advancedOutput) {
      const { screens } = parseAdvancedOutput(await window.native.readText(local.advancedOutput.path));
      const s = screens[0];
      const e = local.advancedOutput;
      check(`AdvancedOutput real: ${e.slices} slices`, s.slices.length === e.slices, s.slices.length);
      const corner = s.slices[e.sliceIndex].corners[0];
      const input = s.slices[e.sliceIndex].input[0];
      check('AdvancedOutput real: geometría de un slice', Math.abs(corner.x - e.outputX) < 0.01 && Math.abs(input.x - e.inputX) < 0.01, JSON.stringify(corner));
    }
    for (const e of local.compositions || []) {
      const { comp: imported, stats } = parseAvc(await window.native.readText(e.path));
      const label = e.label || 'Composición real';
      check(`${label}: capas y columnas`, imported.layers.length === e.layers && imported.columns === e.columns, `${imported.layers.length}/${imported.columns}`);
      if (e.decks) check(`${label}: decks`, imported.decks.length === e.decks, imported.decks.length);
      check(`${label}: clips`, stats.clips === (e.clips ?? stats.clips), JSON.stringify(stats));
      check(`${label}: BPM leído`, imported.bpm > 0, imported.bpm);
      if (e.blends) {
        const blends = imported.layers.map((l) => l.blend).join(',');
        check(`${label}: mezclas iguales a la API de la app de referencia`, blends === e.blends, blends);
      }
      if (e.layerName) check(`${label}: nombre de capa`, imported.layers[1].name === e.layerName, imported.layers[1].name);
      if (e.opacities) {
        const ok = e.opacities.every((v, i) => v === null || Math.abs(imported.layers[i].opacity - v) < 0.001);
        check(`${label}: opacidades de capa`, ok, imported.layers.map((l) => l.opacity.toFixed(3)).join(','));
      }
    }
  });

  await attempt('capturas', async () => {
    const lines = gen('Rings', [0, 0.8, 1, 8, 0.5]);
    setClip(comp, l3.id, 2, lines);
    l3.blend = 'Add';
    engine.trigger(l3, lines);
    l2.bypass = false;
    app.ui.select({ type: 'clip', clip: lines.id }, 'clip');
    await sleep(400);
    await window.native.selftestShot('01-principal.png');
  });

  const failed = checks.filter((c) => !c.ok).length;
  return { total: checks.length, failed, checks };
}
