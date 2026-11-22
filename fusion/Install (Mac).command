#!/bin/bash
# Copies the PelicanExport script into Fusion 360's Scripts folder.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)/PelicanExport"
DEST="$HOME/Library/Application Support/Autodesk/Autodesk Fusion 360/API/Scripts"
if [ ! -d "$HOME/Library/Application Support/Autodesk/Autodesk Fusion 360" ]; then
  echo "Fusion 360 does not appear to be installed for this user (folder not found)."
  read -n 1 -s -r -p "Press any key to close."; exit 1
fi
mkdir -p "$DEST"
rm -rf "$DEST/PelicanExport"
cp -R "$SRC" "$DEST/"
echo "Installed to: $DEST/PelicanExport"
echo "In Fusion: Utilities > Add-Ins > Scripts and Add-Ins > PelicanExport > Run."
echo "(Restart Fusion if it was already open.)"
read -n 1 -s -r -p "Press any key to close."
