# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Precompress what nginx will serve with gzip_static. The main bundle goes
# from about 730 KB to 205 KB, which matters on a LAN-hosted tool that people
# open cold.
RUN find dist -type f \
      \( -name '*.js' -o -name '*.css' -o -name '*.html' \
      -o -name '*.svg' -o -name '*.wasm' -o -name '*.json' \) \
      -exec gzip -9 -k {} \;

# ---- runtime --------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html

# The app will not start if .wasm is served as the wrong type, and the config
# depends on gzip_static. Fail the build loudly rather than at runtime if a
# future base image drops either.
RUN grep -q 'application/wasm' /etc/nginx/mime.types \
 && nginx -V 2>&1 | grep -q http_gzip_static_module \
 && nginx -t

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost/healthz >/dev/null 2>&1 || exit 1
