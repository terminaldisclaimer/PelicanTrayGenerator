# PelicanExport — Fusion 360 → parts library

A Fusion 360 script. It exports every design in a Fusion cloud folder as
3MF and uploads the files to the app's parts library. They then appear
under **Parts → Library** in the app, ready to add.

## One-time setup

**1. Create an Access service token** (lets the script through Cloudflare
Access without a browser login):

- Cloudflare dashboard → Zero Trust → Access → **Service Auth** → Create
  Service Token. Name it `fusion-export`.
- Copy the **Client ID** and **Client Secret**. The secret is shown once.

**2. Allow that token on the app:**

- Zero Trust → Access → Applications → **Pelican Cutouts** → Policies → Add
  a policy.
- Action: **Service Auth**. Include: **Service Token** → `fusion-export`.
- Save. Your existing email policy stays as it is.

**3. Install the script:**

- Unzip `PelicanExport.zip` and double-click **Install (Mac).command** or
  **Install (Windows).bat**. It copies the script into Fusion's Scripts
  folder, so it shows up in Utilities → Add-Ins → Scripts and Add-Ins.
  On a Mac, if it's blocked the first time, right-click the file → Open.
- Or by hand: in Scripts and Add-Ins, click the **+** next to "My Scripts"
  and select the `PelicanExport` folder.
- To rebuild the zip from the repo: `npm run fusion:zip`.

## Use

1. Open any design in the folder you want to export.
2. Run **PelicanExport**.
3. On the first run, enter the site URL and the Client ID and Secret. They
   are saved to `~/.pelican-export.json` on your computer. Delete that file
   to re-enter them.
4. Choose whether to include sub-folders.

Designs already uploaded at the same Fusion version are skipped, so
re-running only sends what changed.

## Notes

- Limit: 25 MB per 3MF.
- File names are simplified to letters, digits, spaces and `_.()+,-`.
- Each design is opened, exported and closed without saving.
- If you get a certificate error on macOS, Fusion's Python is missing root
  certificates. Tell me and I'll add a workaround.
