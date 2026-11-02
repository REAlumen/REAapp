// Efectos y generadores. Cada entrada define sus parámetros y una función GLSL.
// Los valores llegan en el array uniforme p[]; `time` en segundos y `beat` en pulsos.

const param = (name, min, max, def) => ({ name, min, max, def });

export const EFFECTS = {
  'Add Subtract': { params: [param('Cantidad', -1, 1, 0.2)], glsl: 'vec4 fx(vec2 v){vec4 c=texture(tex,v);c.rgb=clamp(c.rgb+p[0],0.,1.);return c;}' },
  Blow: { params: [param('Ganancia', 1, 8, 3), param('Umbral', 0, 1, 0.5)], glsl: 'vec4 fx(vec2 v){vec4 c=texture(tex,v);c.rgb+=max(c.rgb-p[1],0.)*p[0];return c;}' },
  Colorize: { params: [param('Tono', 0, 1, 0), param('Saturación', 0, 1, 1)], glsl: 'vec3 h(float t){return clamp(abs(mod(t*6.+vec3(0,4,2),6.)-3.)-1.,0.,1.);} vec4 fx(vec2 v){vec4 c=texture(tex,v);float l=dot(c.rgb,vec3(.299,.587,.114));c.rgb=mix(vec3(l),h(p[0])*l,p[1]);return c;}' },
  Flip: { params: [param('Horizontal', 0, 1, 1), param('Vertical', 0, 1, 0)], glsl: 'vec4 fx(vec2 v){if(p[0]>.5)v.x=1.-v.x;if(p[1]>.5)v.y=1.-v.y;return texture(tex,v);}' },
  'Invert RGB': { params: [param('Mezcla', 0, 1, 1)], glsl: 'vec4 fx(vec2 v){vec4 c=texture(tex,v);c.rgb=mix(c.rgb,1.-c.rgb,p[0]);return c;}' },
  Kaleidoscope: { params: [param('Segmentos', 2, 16, 6), param('Rotación', 0, 6.283, 0)], glsl: 'vec4 fx(vec2 v){vec2 q=v-.5;q.x*=res.x/res.y;float a=atan(q.y,q.x)+p[1],s=6.28318/floor(p[0]);a=mod(a,s);a=abs(a-s/2.);q=length(q)*vec2(cos(a),sin(a));q.x*=res.y/res.x;return texture(tex,q+.5);}' },
  LoRez: { params: [param('Bloques', 4, 300, 60)], glsl: 'vec4 fx(vec2 v){vec2 n=vec2(p[0],p[0]*res.y/res.x);return texture(tex,(floor(v*n)+.5)/n);}' },
  Mirror: { params: [param('Horizontal', 0, 1, 1), param('Vertical', 0, 1, 0)], glsl: 'vec4 fx(vec2 v){if(p[0]>.5&&v.x>.5)v.x=1.-v.x;if(p[1]>.5&&v.y>.5)v.y=1.-v.y;return texture(tex,v);}' },
  RadialBlur: { params: [param('Fuerza', 0, 0.5, 0.1)], glsl: 'vec4 fx(vec2 v){vec4 c=vec4(0);for(int i=0;i<16;i++){c+=texture(tex,.5+(v-.5)*(1.-p[0]*float(i)/15.));}return c/16.;}' },
  Ripples: { params: [param('Amplitud', 0, 0.1, 0.02), param('Frecuencia', 1, 80, 30), param('Velocidad', 0, 10, 3)], glsl: 'vec4 fx(vec2 v){vec2 q=v-.5;float d=length(q);return texture(tex,v+normalize(q+1e-5)*sin(d*p[1]-time*p[2])*p[0]);}' },
  'Shift Glitch': { params: [param('Cantidad', 0, 0.3, 0.05), param('Bandas', 2, 60, 20)], glsl: 'float r(float n){return fract(sin(n*91.3)*43758.5);} vec4 fx(vec2 v){float b=floor(v.y*p[1]);float t=floor(time*12.);v.x+=(r(b+t)-.5)*p[0]*step(.6,r(b*2.+t));return texture(tex,fract(v));}' },
  'Shift RGB': { params: [param('Distancia', 0, 0.1, 0.01), param('Ángulo', 0, 6.283, 0)], glsl: 'vec4 fx(vec2 v){vec2 d=p[0]*vec2(cos(p[1]),sin(p[1]));vec4 c=texture(tex,v);c.r=texture(tex,v+d).r;c.b=texture(tex,v-d).b;return c;}' },
  Slide: { params: [param('X', -1, 1, 0.25), param('Y', -1, 1, 0)], glsl: 'vec4 fx(vec2 v){return texture(tex,fract(v-p.xy));}'.replace('p.xy', 'vec2(p[0],p[1])') },
  Static: { params: [param('Cantidad', 0, 1, 0.3)], glsl: 'float r(vec2 n){return fract(sin(dot(n,vec2(12.98,78.23)))*43758.5);} vec4 fx(vec2 v){vec4 c=texture(tex,v);c.rgb=mix(c.rgb,vec3(r(v+fract(time))),p[0]);return c;}' },
  Tile: { params: [param('Columnas', 1, 16, 3), param('Filas', 1, 16, 3)], glsl: 'vec4 fx(vec2 v){return texture(tex,fract(v*vec2(floor(p[0]),floor(p[1]))));}' },
  Vignette: { params: [param('Tamaño', 0, 1.5, 0.6), param('Suavidad', 0.01, 1, 0.4)], glsl: 'vec4 fx(vec2 v){vec4 c=texture(tex,v);c.rgb*=1.-smoothstep(p[0],p[0]+p[1],length((v-.5)*2.));return c;}' },
  'Wave Warp': { params: [param('Amplitud', 0, 0.2, 0.03), param('Frecuencia', 1, 40, 8), param('Velocidad', 0, 10, 2)], glsl: 'vec4 fx(vec2 v){v.x+=sin(v.y*p[1]+time*p[2])*p[0];v.y+=cos(v.x*p[1]+time*p[2])*p[0];return texture(tex,v);}' },
};

const rgb = [param('Rojo', 0, 1, 1), param('Verde', 0, 1, 1), param('Azul', 0, 1, 1)];

export const GENERATORS = {
  'Color Sólido': { params: rgb, glsl: 'vec4 fx(vec2 v){return vec4(p[0],p[1],p[2],1);}' },
  Checkered: { params: [...rgb, param('Celdas', 2, 64, 16), param('Velocidad', 0, 4, 0.5)], glsl: 'vec4 fx(vec2 v){vec2 n=vec2(p[3]*res.x/res.y,p[3]);vec2 g=floor(v*n+vec2(beat*p[4],0.));float m=mod(g.x+g.y,2.);return vec4(vec3(p[0],p[1],p[2])*m,1);}' },
  Gradient: { params: [...rgb, param('Ángulo', 0, 6.283, 0), param('Velocidad', 0, 2, 0.25)], glsl: 'vec4 fx(vec2 v){float t=fract(dot(v-.5,vec2(cos(p[3]),sin(p[3])))+.5+beat*p[4]);t=abs(t*2.-1.);return vec4(vec3(p[0],p[1],p[2])*t,1);}' },
  Lines: { params: [...rgb, param('Cantidad', 1, 64, 12), param('Grosor', 0.01, 1, 0.3), param('Velocidad', -4, 4, 0.5)], glsl: 'vec4 fx(vec2 v){float f=fract(v.x*p[3]+beat*p[5]);return vec4(vec3(p[0],p[1],p[2])*step(f,p[4]),1);}' },
  Metaballs: { params: [...rgb, param('Bolas', 2, 12, 6), param('Velocidad', 0, 2, 0.4)], glsl: 'vec4 fx(vec2 v){vec2 q=(v-.5)*vec2(res.x/res.y,1.);float s=0.;for(int i=0;i<int(p[3]);i++){float f=float(i)+1.;vec2 c=.45*vec2(sin(time*p[4]*f*.7+f),cos(time*p[4]*f*.5+f*2.));s+=.012/max(dot(q-c,q-c),1e-4);}return vec4(vec3(p[0],p[1],p[2])*smoothstep(.8,1.2,s),1);}' },
  Rings: { params: [...rgb, param('Anillos', 1, 40, 8), param('Velocidad', -4, 4, 0.5)], glsl: 'vec4 fx(vec2 v){vec2 q=(v-.5)*vec2(res.x/res.y,1.);float f=fract(length(q)*p[3]-beat*p[4]);return vec4(vec3(p[0],p[1],p[2])*step(.5,f),1);}' },
  'Sine Wave': { params: [...rgb, param('Frecuencia', 1, 40, 6), param('Amplitud', 0, 0.5, 0.25), param('Grosor', 0.002, 0.1, 0.01)], glsl: 'vec4 fx(vec2 v){float y=.5+sin(v.x*p[3]*6.283+time*2.)*p[4];return vec4(vec3(p[0],p[1],p[2])*smoothstep(p[5],0.,abs(v.y-y)),1);}' },
  Spiral: { params: [...rgb, param('Brazos', 1, 12, 3), param('Velocidad', -4, 4, 0.5)], glsl: 'vec4 fx(vec2 v){vec2 q=(v-.5)*vec2(res.x/res.y,1.);float a=atan(q.y,q.x)*p[3]/6.283+length(q)*6.-beat*p[4];return vec4(vec3(p[0],p[1],p[2])*step(.5,fract(a)),1);}' },
  Stroboscope: { params: [...rgb, param('Por pulso', 0.25, 8, 2), param('Duración', 0.05, 0.95, 0.3)], glsl: 'vec4 fx(vec2 v){return vec4(vec3(p[0],p[1],p[2])*step(fract(beat*p[3]),p[4]),1);}' },
  Tunnelines: { params: [...rgb, param('Líneas', 2, 48, 16), param('Velocidad', -4, 4, 1)], glsl: 'vec4 fx(vec2 v){vec2 q=(v-.5)*vec2(res.x/res.y,1.);float d=max(abs(q.x),abs(q.y));float f=fract(1./max(d,.01)*.25+beat*p[4]*.25);float a=step(.5,fract(atan(q.y,q.x)/6.283*p[3]));return vec4(vec3(p[0],p[1],p[2])*step(f,.5)*(.3+.7*a)*smoothstep(0.,.2,d),1);}' },
};

export const TEXT_PARAMS = { size: 160, r: 1, g: 1, b: 1 };

export const BLEND_GLSL = `
vec3 blendFn(int m, vec3 a, vec3 b){
  if(m==1) return min(a+b,vec3(1));
  if(m==2) return a*b;
  if(m==3) return 1.-(1.-a)*(1.-b);
  if(m==4) return mix(2.*a*b,1.-2.*(1.-a)*(1.-b),step(.5,a));
  if(m==5) return abs(a-b);
  if(m==6) return max(a-b,vec3(0));
  if(m==7) return max(a,b);
  if(m==8) return min(a,b);
  if(m==9) return a+b-2.*a*b;
  if(m==10) return mix(2.*a*b,1.-2.*(1.-a)*(1.-b),step(.5,b));
  if(m==11) return mix(a*(b+.5),1.-(1.-a)*(1.5-b),step(.5,b));
  float l=dot(b,vec3(.299,.587,.114));
  if(m==12) return mix(a,b,step(.5,l));
  if(m==13) return mix(b,a,step(.5,l));
  if(m==14) return mix(a,b,l);
  if(m==15) return 1.-abs(a-b);
  if(m==16) return min(a/max(1.-b,vec3(1e-4)),vec3(1));
  if(m==17) return max(1.-(1.-a)/max(b,vec3(1e-4)),vec3(0));
  return b;
}`;
