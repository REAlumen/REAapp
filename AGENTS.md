# Reglas de trabajo de REAlumen

Método adaptado de ArtCraft (github.com/storytold): implementación independiente, medida contra la app de referencia.
La referencia es Resolume Arena 7.21, usada con una licencia propia. REAlumen no tiene relación con Resolume.

## Procedencia
1. **Sin interiores de Arena.** No descompilar ni leer su código o sus shaders. Nada de Ghidra sobre sus binarios.
2. **Sí se permite observar.** Documentación y ayuda instaladas, API pública (`rest/docs/swagger.yaml`), archivos que el usuario crea con Arena, y el comportamiento de la app en ejecución. REA se usa solo para observar conducta.
3. **Sin activos ajenos.** Ni logos, iconos, medios, presets ni nombre de Resolume. Los iconos se dibujan en código.
4. **Licencias.** Dependencias permisivas. FFmpeg solo como oráculo de prueba, nunca como parte del producto.
   Excepción pendiente: `app/js/dxv.js` deriva de código LGPL de FFmpeg; hay que reescribirlo desde observación o mantenerlo bajo LGPL.

## Arquitectura
5. **Todo es un comando.** Cada acción de la interfaz debe pasar por un único registro de comandos, disponible también por línea de comandos y MCP, para que una prueba o un agente manejen la app igual que una persona.
6. **Capas sin mezclar.** El motor y el modelo no dependen de la interfaz.

## Verificación
7. **Oráculos antes que opiniones.** Formatos contra archivos reales creados por Arena; imagen contra la salida real de Arena; comportamiento contra su API.
8. **Ninguna cifra sin fuente.** `docs/target-app-parity.md` se genera con `node tools/parity.mjs`. La amplitud indica que algo existe, no que se comporte igual: la preparación real se mide por separado con oráculos y flujos completos.
9. **Lista priorizada.** El trabajo sale de `docs/gaps.md`, leído antes de empezar.
10. **Etapas con puerta.** Una etapa solo se alcanza al pasar sus flujos de trabajo reales de principio a fin.
11. **Nunca caer en un show.** La entrada del usuario y los archivos son hostiles: un error se informa y no detiene la salida. Cada fallo corregido deja una prueba que fallaba antes.
