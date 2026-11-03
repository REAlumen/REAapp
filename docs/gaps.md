# Brechas priorizadas

Leer antes de elegir trabajo. Las cifras están en `target-app-parity.md`.

## 1. Oráculo con la app de referencia (bloquea medir la preparación)
Cada colaborador lo ejecuta con su propia copia de la app de referencia, indicada en `local/reference.json`, sobre una composición de prueba vacía llamada `PrismaOracle`; las capturas no se publican. `tools/oracle-capture.mjs` captura la salida real por NDI y `npm run selftest` con `REALUMEN_ORACLE_DIR` la compara con REAlumen.
- Mezclas: 58 de 59 identificadores traducidos en `parity/blend-ids.json`. Falta `Zoom Out`.
- Medido: la opacidad de capa funciona como crossfade (0 base, 0.5 mezcla completa, 1 capa superior) salvo en Alpha.
- Faltan por implementar y comparar los otros 41 modos, incluidos los `50 ...` y los de transición (`Push`, `Wipe`, `Zoom`, etc.).
- Siguiente: efectos, fuentes y clips con el mismo método.

## 2. Registro único de comandos
Cada acción de la interfaz pasa a ser un comando, expuesto por línea de comandos y MCP. Permite pruebas de interfaz completas.

## 3. Archivos de referencia
- `.avc`: mezcla, opacidad, transformación, efectos, cues, transporte y fuentes internas.
- `AdvancedOutput.xml`: máscaras, polígonos, soft edge y dispositivos. Hay que crear ejemplos en la app de referencia para observarlos.

## 4. Efectos y fuentes
Completar los que faltan y ajustar cada uno contra la imagen de la app de referencia, no por su nombre.

## 5. Control en vivo
MIDI, OSC, DMX, atajos, Art-Net, SMPTE y la API REST compatible.

## 6. Composición avanzada
Grupos de capas, animación de parámetros (BPM, línea de tiempo, FFT), Dashboard, deshacer y rehacer, grabación.

## 7. Salidas
Hecho desde los videos del usuario: menú Salida, pantallas detectadas, NDI por pantalla, editor flotante con Transformar y Editar puntos, menú contextual, deshacer, Cancelar y Guardar, pila con máscaras de salida, polígonos, máscaras de entrada por slice, Alt+arrastrar para copiar.
Falta: Make Circle, fuente de slice por capa, fixtures DMX, Spout, presets, Show Display Info y retardo de pantalla.
Sin comparar con la app de referencia: Is Key, Black BG, soft edge, Bézier, efecto de varias máscaras de entrada y la lista real de su campo Device.

## 7b. Rejilla y composición
Hecho: menús de Columna y Capa (nueva, insertar, duplicar, renombrar, vaciar, quitar, color, plegar, ignorar columna, primer clip, Fader Start, bloqueo, copiar efectos) y Configuración de la composición.
Falta: grupos de capas, Mask Mode, New Mixer, menús Deck, Group, Clip, Shortcuts y View, y frame rate y profundidad de color configurables.
Autopilot hecho desde el video del usuario: el layer elige anterior, apagado, siguiente o azar y cada clip elige su acción al terminar; las imágenes, generadores y textos tienen duración propia.
Sin medir: la duración inicial de una imagen (se usan 5 s; en la app de referencia se vieron 3,1 s y 16 s) y cómo la guarda el `.avc`.
Faders M, A y V en la cabecera de cada layer, y volumen en dB y paneo en el layer y en cada clip con audio, hechos desde el mismo video.
Sin medir: el rango real de volumen y paneo de la app de referencia (aquí 0 a 1 en volumen, de −∞ a 0 dB, y −1 a 1 en paneo) y si su Fader Start sigue al Master o al fader V.
Falta en los paneles, visto en el mismo video: Auto Size, tipo de alfa y modo de mezcla del clip, y Behaviour y Curve del crossfader.

## 8. Rendimiento
NDI a 60 fps entrega 17,5 cuadros nuevos/s por la copia entre procesos. 4K a 60 fps no alcanza por clip. Medir con shows reales antes de decidir si pasar el motor a código nativo.

## 9. Licencia de `dxv.js`
Deriva de FFmpeg (LGPL). Reescribir o mantener esa licencia antes de distribuir.

## Puertas de etapa
- **Alfa:** los flujos básicos funcionan en este equipo. Falta la prueba del usuario.
- **Beta:** abrir un show real de la app de referencia y operarlo de principio a fin en REAlumen.
- **Igualdad:** las comparaciones contra la app de referencia pasan y el show se opera sin diferencias apreciables.
