# REAlumen

Software VJ de escritorio, libre y en desarrollo: capas, columnas, cue points, mezclas y salidas mapeadas con slices y máscaras. Reproduce videos DXV y trabaja con NDI y dispositivos de captura.

> **Estado: alfa temprana.** Todavía no está lista para un show real. Faltan muchas funciones y se esperan errores.

> **Administrado por IA.** El código, las pruebas, la documentación y la gestión del proyecto los realiza un agente de IA (Claude Code, de Anthropic), bajo la dirección de su propietario humano, que toma las decisiones finales. Revisa el código antes de confiar en él y comprueba lo que uses en un show.

> Proyecto independiente. Avisos legales en [NOTICE.md](NOTICE.md).

*English summary: REAlumen is an early-alpha, independent open-source VJ application for Windows, built with Electron and WebGL2. This project is AI-managed: its code, tests, documentation and project management are handled by an AI agent (Claude Code, by Anthropic), directed by its human owner, who makes the final decisions. Contributions are welcome. Issues may be written in Spanish or English.*

## Qué funciona hoy
- **Composición:** capas, columnas y decks con sus menús, mezclas, opacidad, crossfader, BPM y transiciones.
- **Clips:** cue points, transporte, BPM sync, disparo normal, toggle y piano, beat snap, autopilot y preview por clip.
- **Fuentes:** video (H.264, VP9, AV1 y DXV en DXT1 y DXT5), imágenes, audio, generadores, texto, cámaras y capturadoras, y NDI.
- **Salidas:** varias pantallas, pantalla completa, ventana o NDI; slices con perspectiva, rejilla o Bézier; polígonos; máscaras de entrada y de salida.
- **Importación:** lee parte de los archivos `.avc` y `AdvancedOutput.xml`.

Lo que falta está ordenado en [docs/gaps.md](docs/gaps.md), y las cifras en [docs/target-app-parity.md](docs/target-app-parity.md).

## Cómo ejecutarlo
Necesitas Windows 10 u 11 de 64 bits, [Node.js](https://nodejs.org) y una GPU con WebGL2. Para NDI, instala también [NDI Tools](https://ndi.video/tools).

```bash
npm install
```

Si tu versión de npm bloquea los scripts de instalación y Electron no arranca, descarga su binario con:

```bash
node node_modules/electron/install.js
```

Después:

```bash
npm start
```

En PowerShell con los scripts bloqueados, usa `npm.cmd` en lugar de `npm`.

## Pruebas
```bash
npm test
```

```bash
npm run selftest
```

`npm test` cubre la lógica pura. `npm run selftest` abre la app real, simula el ratón y comprueba píxeles. Fallo conocido: la prueba de cadencia NDI puede quedar por debajo de 25 cuadros nuevos/s según el equipo. Mejorarlo es parte de [docs/gaps.md](docs/gaps.md).

Algunas pruebas son opcionales:
- `local/checks.json` (no se publica) indica archivos `.avc` y `AdvancedOutput.xml` propios y lo que se espera de ellos.
- `REALUMEN_ORACLE_DIR` apunta a capturas de referencia generadas con las herramientas de `tools/`.

## Cómo colaborar
1. Lee [AGENTS.md](AGENTS.md): son las reglas del proyecto, para personas y para agentes de IA.
2. Elige algo de [docs/gaps.md](docs/gaps.md) o abre un issue con lo que quieres hacer.
3. Añade una prueba que falle sin tu cambio. Ejecuta `npm test` y `npm run selftest`.
4. Abre un pull request explicando qué cambia y cómo lo comprobaste.

### La regla más importante: procedencia limpia
- **No** aportes código, shaders, medios, presets, logos ni iconos de otras aplicaciones.
- **No** descompiles ni desensambles software de terceros, ni aportes nada obtenido así.
- Implementa a partir de documentación pública, de tus propias observaciones y de especificaciones abiertas.
- Respeta las condiciones de las licencias del software que uses como referencia.

Al enviar un pull request confirmas que tu aporte cumple esto y que puede publicarse bajo la licencia del proyecto.

## Licencia
[MIT](LICENSE), salvo `app/js/dxv.js`, bajo LGPL-2.1-or-later. Detalles en [NOTICE.md](NOTICE.md).
