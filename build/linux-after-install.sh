#!/bin/bash
# Se ejecuta al instalar el .deb. Ubuntu 24.04 limita los espacios de nombres de usuario,
# así que Electron necesita su ayudante chrome-sandbox con dueño root y modo 4755.

APP_DIR='/opt/REAlumen'

if [ -f "$APP_DIR/chrome-sandbox" ]; then
  chown root:root "$APP_DIR/chrome-sandbox" || true
  chmod 4755 "$APP_DIR/chrome-sandbox" || true
fi

if type update-alternatives >/dev/null 2>&1; then
  if [ -L '/usr/bin/realumen' ] && [ -e '/usr/bin/realumen' ] && [ "$(readlink '/usr/bin/realumen')" != '/etc/alternatives/realumen' ]; then
    rm -f '/usr/bin/realumen'
  fi
  update-alternatives --install '/usr/bin/realumen' 'realumen' "$APP_DIR/realumen" 100 || ln -sf "$APP_DIR/realumen" '/usr/bin/realumen'
else
  ln -sf "$APP_DIR/realumen" '/usr/bin/realumen'
fi

if hash update-mime-database 2>/dev/null; then
  update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
  update-desktop-database /usr/share/applications || true
fi
