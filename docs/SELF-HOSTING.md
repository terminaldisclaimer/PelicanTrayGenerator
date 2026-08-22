# Self-hosting on Unraid

The app is a static site, so hosting it is just serving files. The container is
nginx plus the built assets: no database, no volumes, no state to back up.
Projects live as `.json` files wherever the browser saves them.

Resting footprint is a few MB of RAM and effectively no CPU - all the geometry
work happens in the browser of whoever opens it.

---

## Pick a route

| | How it updates | Registry needed | Best when |
|---|---|---|---|
| **A. GHCR image + auto-update** | Push to the default branch, GitHub builds, Unraid pulls | Yes | You want it hands-off (recommended) |
| **B. Compose Manager** | `docker compose pull && up -d`, or automated | Yes | You already run Compose on Unraid |
| **C. Build on the server** | `git pull` + rebuild, on a cron | No | You would rather not use a registry |

---

## A. GHCR image, auto-updated (recommended)

**1. Let GitHub build the image.**
`.github/workflows/docker.yml` runs on every push to the default branch and on
`v*` tags. It runs the typecheck and tests first, then pushes to
`ghcr.io/terminaldisclaimer/pelicantraygenerator`, tagged `latest`, `sha-<short>`
and semver for tags. Nothing to configure - it authenticates with the built-in
`GITHUB_TOKEN`.

**2. Decide how Unraid authenticates.**

This repository is private, so the package GitHub publishes is private too, and
Unraid cannot pull it anonymously. Two ways round that:

- **Make the package public** (the repository stays private). On GitHub go to
  the repo -> **Packages** -> `pelicantraygenerator` -> **Package settings** ->
  **Change visibility** -> Public. The image holds only the compiled front end,
  which has no secrets and no server code in it. This is the low-friction
  option: Unraid then needs no credentials at all.
- **Or keep it private** and give Unraid a credential. Create a classic PAT with
  only `read:packages`, then on the Unraid console:

  ```bash
  docker login ghcr.io -u <your-github-username> -p <the-token>
  ```

  Unraid persists this in `/root/.docker/config.json`, which does **not**
  survive a reboot on its own - add the same command to the **User Scripts**
  plugin with the "At First Array Start Only" schedule so it is re-applied.

**3. Add the container.**
Copy `unraid/pelican-tray-generator.xml` to
`/boot/config/plugins/dockerMan/templates-user/my-PelicanTrayGenerator.xml`,
then **Docker -> Add Container** and choose *PelicanTrayGenerator* from the
template dropdown. It maps host port `8420` to the container's port 80; change
it there if 8420 is taken.

Or skip the template and fill in **Add Container** by hand:

| Field | Value |
|---|---|
| Repository | `ghcr.io/terminaldisclaimer/pelicantraygenerator:latest` |
| Network Type | Bridge |
| Port | Host `8420` -> Container `80`, TCP |
| WebUI | `http://[IP]:[PORT:80]/` |

**4. Turn on updates.** Either:

- **CA Auto Update Applications** (Apps -> Install, then Settings -> Auto Update
  Applications). Enable it for this container and pick a schedule. This is the
  native Unraid way and is enough if a daily update window suits you.
- **Watchtower**, for something closer to continuous. The compose file already
  carries the opt-in label, so run Watchtower with `--label-enable` and it will
  only touch containers that asked for it:

  ```
  Repository: containrrr/watchtower
  Post Arguments: --label-enable --cleanup --interval 300
  Volume: /var/run/docker.sock -> /var/run/docker.sock
  ```

  If the package is private, Watchtower needs the same credentials - mount
  `/root/.docker/config.json` to `/config.json` read-only.

End state: push to the default branch, and a few minutes later the container on
Unraid is running the new build.

---

## B. Compose Manager

Install **Docker Compose Manager** from Community Applications, add a stack, and
point it at `docker-compose.yml` from this repo. Then:

```bash
docker compose pull && docker compose up -d
```

To automate, put that in a **User Scripts** entry on a cron schedule.

---

## C. Build on the Unraid box, no registry

Nothing but Docker is needed on the server - the build happens inside the image,
so there is no Node install to maintain.

```bash
cd /mnt/user/appdata
git clone https://github.com/terminaldisclaimer/PelicanTrayGenerator.git
cd PelicanTrayGenerator
docker compose -f docker-compose.build.yml up -d --build
```

For a private repo, clone over SSH with a deploy key rather than embedding a
token in the URL. Then automate with a **User Scripts** entry on a daily cron:

```bash
#!/bin/bash
cd /mnt/user/appdata/PelicanTrayGenerator || exit 1
git pull --ff-only || exit 1
docker compose -f docker-compose.build.yml up -d --build
docker image prune -f
```

A rebuild takes a couple of minutes, most of it `npm ci`. Docker layer caching
means an unchanged `package-lock.json` skips that entirely.

---

## What the container serves

`docker/nginx.conf` is deliberately small, but three things in it matter:

- **`application/wasm`.** The geometry kernel is a WASM module and will not
  start if it is served as the wrong type. The Dockerfile asserts this at build
  time rather than letting it fail in someone's browser.
- **Precompressed assets.** The build gzips everything and nginx serves the
  `.gz` siblings via `gzip_static`, taking the main bundle from about 730 KB to
  205 KB.
- **Caching split.** `/assets/*` is content-hashed by the build and cached for a
  year; `index.html` is `no-cache`, so an updated container actually reaches a
  browser that already has the old page.

### A note on the Content-Security-Policy

The CSP locks everything to `'self'`, which is the protection that matters here:
a compromised dependency has nowhere to send your part outlines. It does include
`'unsafe-eval'`, which is not a preference - the geometry kernel's Emscripten
loader evaluates a string at startup, and the app fails to start without it.
This was verified by driving the real app through these exact headers, not
assumed.

## Reverse proxy

Behind SWAG, Nginx Proxy Manager or Traefik, proxy to `pelican-tray-generator:80`
and let the proxy own TLS. Two things to watch:

- Do not let the proxy re-add its own `Content-Security-Policy`; two policies
  intersect, and a second one without `'unsafe-eval'` will stop the app loading.
- If the proxy strips `Content-Encoding`, disable `gzip_static` interference by
  letting the proxy handle compression instead - the app works either way, it is
  only a transfer-size question.

The app has no authentication of its own. If you expose it beyond your LAN, put
it behind whatever your proxy offers (Authelia, Cloudflare Access, basic auth).
