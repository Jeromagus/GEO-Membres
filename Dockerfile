# GEO Membres : image de la stack geo-membres sur vm01.
# Servie sous https://app.omonville.fgl/geo-membres/ (base Vite '/geo-membres/').
# Images tirées du miroir Google de Docker Hub : les tirages anonymes de Docker Hub
# rendent HTTP 429 depuis vm01.

# --- Construction --------------------------------------------------------------
FROM mirror.gcr.io/library/node:22-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
# --ignore-scripts : better-sqlite3 (inutilisé par l'app) n'est pas compilé.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

# --- Service -------------------------------------------------------------------
# Même base que plume-rouge-outlook, épinglée par son empreinte.
FROM mirror.gcr.io/library/nginx:1.30.5-alpine-slim@sha256:32463212baf0e7d91aded2e9b843a4f2b9e017804b8c9d5bae7b51dcef64389c

# Configuration complète : pid et fichiers temporaires dans /tmp (sans root, lecture seule).
COPY nginx.conf /etc/nginx/nginx.conf
RUN rm -f /etc/nginx/conf.d/default.conf && nginx -t

# L'arborescence reproduit le préfixe d'URL : pas de StripPrefix côté Traefik.
COPY --from=build /src/dist/ /usr/share/nginx/html/geo-membres/

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/geo-membres/ || exit 1

# Les scripts d'entrée de l'image officielle réécrivent la configuration, ce que le
# système de fichiers en lecture seule interdit : nginx est lancé directement.
ENTRYPOINT []
CMD ["nginx", "-g", "daemon off;"]
