#!/bin/sh
# Démarrage du conteneur : écrit la clé Google pour le relais nginx, puis lance nginx.
# Une clé Google ne contient que lettres, chiffres, « _ » et « - » : toute autre valeur
# est refusée (le relais répond alors 503 et l'application se rabat sur Nominatim).
set -e

key="${GOOGLE_MAPS_KEY:-}"
case "$key" in
  *[!A-Za-z0-9_-]*)
    echo "GOOGLE_MAPS_KEY invalide : relais Google désactivé" >&2
    key=""
    ;;
esac
[ -z "$key" ] && echo "GOOGLE_MAPS_KEY absente : relais Google désactivé" >&2

printf 'set $google_key "%s";\n' "$key" > /tmp/google-key.conf
unset GOOGLE_MAPS_KEY key

exec nginx -g 'daemon off;'
