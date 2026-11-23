"""PelicanExport — Fusion 360 add-in.

Adds a "Pelican Export" button to the Utilities tab (Add-Ins panel).

Exports every design in a Fusion cloud folder as 3MF and uploads each file to
the Pelican Cutouts parts library (https://<your-site>/api/parts/<name>).

How to use
  1. Open any design that lives in the folder you want to export.
  2. Click Utilities > Pelican Export.
  3. First run only: enter the site URL and the Cloudflare Access service-token
     ID and secret. They are saved to ~/.pelican-export.json (readable only by
     you) — never inside the script.
  4. Choose whether to include sub-folders. Designs already uploaded at the
     same Fusion version are skipped.

Each design is opened, its root component exported, and closed without saving.
"""
import json
import os
import ssl
import stat
import subprocess
import sys
import tempfile
import traceback
import urllib.error
import urllib.parse
import urllib.request

import adsk.core
import adsk.fusion

CONFIG_PATH = os.path.join(os.path.expanduser('~'), '.pelican-export.json')
MAX_BYTES = 25 * 1024 * 1024
SAFE = set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _.()+,-')


def load_config(ui):
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            cfg = json.load(f)
    changed = False
    for key, prompt, default in (
        ('site', 'Site URL', 'https://pelican.blocknets.org'),
        ('client_id', 'Cloudflare Access service token — Client ID', ''),
        ('client_secret', 'Cloudflare Access service token — Client Secret', ''),
    ):
        if not cfg.get(key):
            value, cancelled = ui.inputBox(prompt, 'PelicanExport setup', default)
            if cancelled or not value.strip():
                return None
            cfg[key] = value.strip()
            changed = True
    cfg['site'] = cfg['site'].rstrip('/')
    if not cfg['site'].startswith('https://'):
        ui.messageBox('Site URL must start with https://')
        return None
    if changed:
        with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, indent=2)
        try:
            os.chmod(CONFIG_PATH, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass
    return cfg


_SSL_CONTEXT = None
MAC_KEYCHAINS = (
    '/System/Library/Keychains/SystemRootCertificates.keychain',  # Apple's trusted roots
    '/Library/Keychains/System.keychain',  # roots installed by an administrator (e.g. a company proxy)
)


def ssl_context():
    """Fusion's bundled Python on macOS ships without root certificates, so
    load the ones macOS itself trusts from the system keychains. Certificate
    verification stays on. (On Windows the default context already uses the
    Windows certificate store.)"""
    global _SSL_CONTEXT
    if _SSL_CONTEXT:
        return _SSL_CONTEXT
    ctx = ssl.create_default_context()
    if sys.platform == 'darwin':
        for keychain in MAC_KEYCHAINS:
            try:
                pem = subprocess.run(
                    ['/usr/bin/security', 'find-certificate', '-a', '-p', keychain],
                    capture_output=True, text=True, timeout=30).stdout
                if 'BEGIN CERTIFICATE' in pem:
                    ctx.load_verify_locations(cadata=pem)
            except Exception:
                pass
        if os.path.exists('/etc/ssl/cert.pem'):
            try:
                ctx.load_verify_locations(cafile='/etc/ssl/cert.pem')
            except Exception:
                pass
    try:
        import certifi
        ctx.load_verify_locations(cafile=certifi.where())
    except Exception:
        pass
    _SSL_CONTEXT = ctx
    return ctx


def request(cfg, method, path, body=None, headers=None):
    req = urllib.request.Request(cfg['site'] + path, data=body, method=method)
    req.add_header('CF-Access-Client-Id', cfg['client_id'])
    req.add_header('CF-Access-Client-Secret', cfg['client_secret'])
    req.add_header('User-Agent', 'PelicanExport/1.0')
    for k, v in (headers or {}).items():
        req.add_header(k, v)

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        # A redirect means Access rejected the service token (login page).
        def redirect_request(self, *args, **kwargs):
            return None

    opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=ssl_context()))
    try:
        with opener.open(req, timeout=120) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except urllib.error.URLError as e:
        raise RuntimeError('Could not connect to {}: {}'.format(cfg['site'], e.reason))


def safe_name(name):
    cleaned = ''.join(c if c in SAFE else '_' for c in name).strip()[:110]
    return (cleaned or 'part') + '.3mf'


def collect(folder, recursive):
    files = [f for f in folder.dataFiles if f.fileExtension.lower() == 'f3d']
    if recursive:
        for sub in folder.dataFolders:
            files.extend(collect(sub, True))
    return files


def export_folder(app, ui):
    progress = None
    try:
        active = app.activeDocument
        if not active or not active.dataFile:
            ui.messageBox('Open a saved design from the folder you want to export, then run this script again.')
            return
        folder = active.dataFile.parentFolder

        cfg = load_config(ui)
        if not cfg:
            return

        status, body = request(cfg, 'GET', '/api/parts')
        if status != 200:
            ui.messageBox(
                'Could not reach the parts library (HTTP {}).\n\n'
                'Check the service token and that the Access application has a '
                '"Service Auth" policy for it. To re-enter credentials, delete\n{}'.format(status, CONFIG_PATH))
            return
        existing = {p['name']: str(p.get('version', '')) for p in json.loads(body.decode('utf-8'))}

        answer = ui.messageBox(
            'Export all designs in "{}" as 3MF and upload them?\n\nYes = include sub-folders\nNo = this folder only'.format(folder.name),
            'PelicanExport', adsk.core.MessageBoxButtonTypes.YesNoCancelButtonType)
        if answer == adsk.core.DialogResults.DialogCancel:
            return
        files = collect(folder, answer == adsk.core.DialogResults.DialogYes)
        if not files:
            ui.messageBox('No Fusion designs found in "{}".'.format(folder.name))
            return

        progress = ui.createProgressDialog()
        progress.cancelButtonText = 'Cancel'
        progress.isCancelButtonShown = True
        progress.show('PelicanExport', 'Starting…', 0, len(files), 0)

        uploaded, skipped, failed = [], [], []
        library_folder = ''.join(c if c in SAFE else '_' for c in folder.name).strip()[:40]
        seen = set()
        tmp = tempfile.mkdtemp(prefix='pelican-export-')
        for i, data_file in enumerate(files):
            if progress.wasCancelled:
                break
            name = safe_name(data_file.name)
            if name in seen:  # same design name in two folders
                name = safe_name('{} ({})'.format(data_file.name, data_file.parentFolder.name))
            seen.add(name)
            version = str(data_file.versionNumber)
            progress.message = '{} ({}/{})'.format(data_file.name, i + 1, len(files))
            progress.progressValue = i
            adsk.doEvents()

            if existing.get(name) == version:
                skipped.append(name)
                continue

            doc = None
            try:
                already_open = data_file.id == active.dataFile.id
                doc = active if already_open else app.documents.open(data_file, True)
                design = adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'))
                if not design:
                    raise RuntimeError('not a design document')
                path = os.path.join(tmp, name)
                mgr = design.exportManager
                options = mgr.createC3MFExportOptions(design.rootComponent, path)
                if not mgr.execute(options) or not os.path.exists(path):
                    raise RuntimeError('3MF export failed (does the design contain a solid body?)')
                with open(path, 'rb') as f:
                    payload = f.read()
                os.remove(path)
                if len(payload) > MAX_BYTES:
                    raise RuntimeError('3MF is {:.0f} MB; the library limit is 25 MB'.format(len(payload) / 1048576))
                headers = {'Content-Type': 'application/octet-stream', 'X-Part-Version': version}
                if name not in existing and library_folder:
                    # New parts are filed in a library folder named after the Fusion folder.
                    # Parts already in the library stay in whichever folder they were moved to.
                    headers['X-Part-Folder'] = urllib.parse.quote(library_folder)
                status, body = request(cfg, 'PUT', '/api/parts/' + urllib.parse.quote(name), payload, headers)
                if status != 200:
                    raise RuntimeError('upload failed (HTTP {}): {}'.format(status, body[:200].decode('utf-8', 'replace')))
                uploaded.append(name)
            except Exception as e:  # keep going with the other designs
                failed.append('{}: {}'.format(data_file.name, e))
            finally:
                if doc and doc != active:
                    try:
                        doc.close(False)
                    except Exception:
                        pass

        progress.hide()
        progress = None
        lines = ['Uploaded: {}'.format(len(uploaded)), 'Unchanged (skipped): {}'.format(len(skipped))]
        if failed:
            lines.append('Failed: {}'.format(len(failed)))
            lines.extend('  ' + f for f in failed[:15])
        ui.messageBox('\n'.join(lines), 'PelicanExport')
    except RuntimeError as e:
        if progress:
            progress.hide()
        ui.messageBox('PelicanExport: {}'.format(e))
    except Exception:
        if progress:
            progress.hide()
        ui.messageBox('PelicanExport failed:\n{}'.format(traceback.format_exc()[-1500:]))


# ---------------------------------------------------------------- add-in UI
CMD_ID = 'pelicanExportCmd'
WORKSPACE_ID = 'FusionSolidEnvironment'
TAB_ID = 'ToolsTab'  # the "Utilities" tab
PANEL_ID = 'SolidScriptsAddinsPanel'  # its "Add-Ins" panel
_handlers = []  # keep references so Fusion does not garbage-collect them


class _Execute(adsk.core.CommandEventHandler):
    def notify(self, args):
        app = adsk.core.Application.get()
        export_folder(app, app.userInterface)


class _Created(adsk.core.CommandCreatedEventHandler):
    def notify(self, args):
        handler = _Execute()
        args.command.execute.add(handler)
        _handlers.append(handler)


def _panel(ui):
    workspace = ui.workspaces.itemById(WORKSPACE_ID)
    tab = workspace.toolbarTabs.itemById(TAB_ID) if workspace else None
    panel = tab.toolbarPanels.itemById(PANEL_ID) if tab else None
    return panel or ui.allToolbarPanels.itemById(PANEL_ID)


def run(context):
    ui = None
    try:
        app = adsk.core.Application.get()
        ui = app.userInterface
        cmd = ui.commandDefinitions.itemById(CMD_ID)
        if cmd:
            cmd.deleteMe()
        resources = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'resources')
        cmd = ui.commandDefinitions.addButtonDefinition(
            CMD_ID, 'Pelican Export',
            'Export every design in this folder as 3MF and upload to the Pelican Cutouts library.',
            resources)
        created = _Created()
        cmd.commandCreated.add(created)
        _handlers.append(created)
        panel = _panel(ui)
        if not panel:
            ui.messageBox('PelicanExport: could not find the Utilities > Add-Ins panel.')
            return
        old = panel.controls.itemById(CMD_ID)
        if old:
            old.deleteMe()
        control = panel.controls.addCommand(cmd)
        control.isPromotedByDefault = True
        control.isPromoted = True
    except Exception:
        if ui:
            ui.messageBox('PelicanExport failed to start:\n{}'.format(traceback.format_exc()))


def stop(context):
    try:
        ui = adsk.core.Application.get().userInterface
        panel = _panel(ui)
        control = panel.controls.itemById(CMD_ID) if panel else None
        if control:
            control.deleteMe()
        cmd = ui.commandDefinitions.itemById(CMD_ID)
        if cmd:
            cmd.deleteMe()
    except Exception:
        pass
