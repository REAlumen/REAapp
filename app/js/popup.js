// Menús emergentes y diálogos propios. Electron no ofrece window.prompt.
function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') node.className = v;
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
  return node;
}

let openMenu = null;

export function closePopup() {
  openMenu?.remove();
  openMenu = null;
}

window.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closePopup();
}, true);

// items: { label, fn, disabled, check, hint, swatches, onSwatch, current, heading } o '-'.
export function popup(x, y, items) {
  closePopup();
  const rows = items.filter(Boolean).map((item) => {
    if (item === '-') return el('hr', {});
    if (item.heading) return el('h4', {}, item.heading);
    if (item.swatches) {
      return el('div', { class: 'swatches' }, item.swatches.map((color) => el('button', {
        class: item.current === color ? 'on' : '', title: color || 'Sin color', 'aria-label': color || 'Sin color',
        style: color ? `background:${color}` : '',
        onClick: () => { closePopup(); item.onSwatch(color); },
      }, color ? '' : '✓')));
    }
    return el('button', {
      class: item.check ? 'mark' : '', disabled: !!item.disabled, title: item.title || '',
      onClick: () => { closePopup(); item.fn?.(); },
    }, el('span', {}, item.label), item.hint ? el('small', {}, item.hint) : null);
  });
  openMenu = el('div', { class: 'popup' }, rows);
  document.body.append(openMenu);
  const r = openMenu.getBoundingClientRect();
  openMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  openMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  return openMenu;
}

// Diálogo modal con formulario: `build` devuelve los campos y `apply` los aplica.
export function dialog(title, fields, { okLabel = 'Aplicar', onApply }) {
  const close = () => { overlay.remove(); };
  const form = el('form', {
    class: 'dialog', onSubmit: (e) => {
      e.preventDefault();
      if (onApply() !== false) close();
    },
  },
  el('h3', {}, title), fields,
  el('div', { class: 'dialog-actions' },
    el('button', { type: 'button', onClick: close }, 'Cancelar'),
    el('button', { type: 'submit', class: 'on' }, okLabel)));
  const overlay = el('div', { class: 'overlay', onKeydown: (e) => { if (e.key === 'Escape') close(); } }, form);
  document.body.append(overlay);
  form.querySelector('input, textarea, select')?.focus();
  form.querySelector('input')?.select?.();
  return overlay;
}

export function askText(title, value, onDone) {
  const input = el('input', { type: 'text', value, 'aria-label': title });
  return dialog(title, [input], {
    okLabel: 'Aceptar',
    onApply: () => { onDone(input.value.trim()); },
  });
}
