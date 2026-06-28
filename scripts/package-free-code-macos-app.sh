#!/usr/bin/env bash
# Build FreeCodeMac (SwiftPM release) and assemble a minimal .app bundle for
# local install (e.g. copy to /Applications). Optional: .pkg via pkgbuild (unsigned).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAC_DIR="$ROOT/apps/free-code-macos"
DIST_DIR="$MAC_DIR/dist"
BUILD_DIR="$MAC_DIR/.build-package"
APP_NAME="FreeCodeMac.app"
PKG_NAME="FreeCodeMac.pkg"
BUNDLE_ID="dev.free.FreeCodeMac"
MAKE_PKG=false

usage() {
	sed -n '1,55p' <<'EOF'
Usage: package-free-code-macos-app.sh [options]

  Builds apps/free-code-macos in release mode and writes:
    apps/free-code-macos/dist/FreeCodeMac.app

  Optional app icon: place either
    apps/free-code-macos/packaging/AppIcon.icns
  or a master square PNG at
    apps/free-code-macos/packaging/AppIcon.png
  (ideally 1024x1024). The script copies or builds AppIcon.icns into the bundle
  and sets CFBundleIconFile in Info.plist.

Options:
  --pkg     Also write apps/free-code-macos/dist/FreeCodeMac.pkg (installs app to /Applications).
  -h, --help

Examples:
  ./scripts/package-free-code-macos-app.sh
  ./scripts/package-free-code-macos-app.sh --pkg
  cp -R apps/free-code-macos/dist/FreeCodeMac.app ~/Applications/
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--pkg) MAKE_PKG=true ;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			echo "Unknown option: $1" >&2
			usage >&2
			exit 1
			;;
	esac
	shift
done

VERSION="$(
	node -e "process.stdout.write(require(process.argv[1]).version)" "$ROOT/package.json" 2>/dev/null || echo "0.0.0"
)"

echo "==> swift build -c release universal ($MAC_DIR)"
(cd "$MAC_DIR" && swift build --scratch-path "$BUILD_DIR" -c release --arch arm64 --arch x86_64)

BIN_DIR="$(cd "$MAC_DIR" && swift build --scratch-path "$BUILD_DIR" -c release --arch arm64 --arch x86_64 --show-bin-path)"
EXE="$BIN_DIR/FreeCodeMac"
if [[ ! -x "$EXE" ]]; then
	echo "error: missing executable: $EXE" >&2
	exit 1
fi

APP_DIR="$DIST_DIR/$APP_NAME"
MACOS_DIR="$APP_DIR/Contents/MacOS"
RESOURCES_DIR="$APP_DIR/Contents/Resources"
PACKAGING_DIR="$MAC_DIR/packaging"
ICON_PLIST_FRAGMENT=""

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"

echo "==> copy executable + resource bundles"
cp "$EXE" "$MACOS_DIR/"

# NSBundle.module searches Contents/Resources/ (Bundle.main.resourceURL), NOT Contents/MacOS/.
# Copy .bundle resource bundles to Contents/Resources/ so the app finds them at runtime.
# Universal builds sometimes place .bundle files in the arch-specific dir rather than the
# combined output dir — search both locations so resources are never missed.
mkdir -p "$RESOURCES_DIR"
BUNDLE_SEARCH_DIRS=("$BIN_DIR")
for ARCH_DIR in "$BUILD_DIR/arm64-apple-macosx/release" "$BUILD_DIR/x86_64-apple-macosx/release"; do
	[[ -d "$ARCH_DIR" ]] && BUNDLE_SEARCH_DIRS+=("$ARCH_DIR")
done

shopt -s nullglob
BUNDLES_COPIED=0
for SEARCH_DIR in "${BUNDLE_SEARCH_DIRS[@]}"; do
	for b in "$SEARCH_DIR"/*.bundle; do
		BNAME="$(basename "$b")"
		if [[ ! -e "$RESOURCES_DIR/$BNAME" ]]; then
			echo "    $BNAME -> Contents/Resources/"
			cp -R "$b" "$RESOURCES_DIR/"
			BUNDLES_COPIED=$((BUNDLES_COPIED + 1))
		fi
	done
done
shopt -u nullglob

if [[ $BUNDLES_COPIED -eq 0 ]]; then
	echo "warning: no .bundle resources found — app may crash on launch" >&2
fi

ICNS_SRC="$PACKAGING_DIR/AppIcon.icns"
PNG_SRC="$PACKAGING_DIR/AppIcon.png"
if [[ -f "$ICNS_SRC" ]]; then
	mkdir -p "$RESOURCES_DIR"
	cp "$ICNS_SRC" "$RESOURCES_DIR/AppIcon.icns"
	ICON_PLIST_FRAGMENT="$(printf '\t<key>CFBundleIconFile</key>\n\t<string>AppIcon</string>\n')"
	echo "==> app icon: $ICNS_SRC -> Contents/Resources/AppIcon.icns"
elif [[ -f "$PNG_SRC" ]]; then
	mkdir -p "$RESOURCES_DIR"
	ICONSET_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/freecodemac-icon.XXXXXX")"
	ICONSET="$ICONSET_ROOT/AppIcon.iconset"
	mkdir "$ICONSET"
	sips -z 16 16 "$PNG_SRC" --out "$ICONSET/icon_16x16.png" >/dev/null
	sips -z 32 32 "$PNG_SRC" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
	sips -z 32 32 "$PNG_SRC" --out "$ICONSET/icon_32x32.png" >/dev/null
	sips -z 64 64 "$PNG_SRC" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
	sips -z 128 128 "$PNG_SRC" --out "$ICONSET/icon_128x128.png" >/dev/null
	sips -z 256 256 "$PNG_SRC" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
	sips -z 256 256 "$PNG_SRC" --out "$ICONSET/icon_256x256.png" >/dev/null
	sips -z 512 512 "$PNG_SRC" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
	sips -z 512 512 "$PNG_SRC" --out "$ICONSET/icon_512x512.png" >/dev/null
	sips -z 1024 1024 "$PNG_SRC" --out "$ICONSET/icon_512x512@2x.png" >/dev/null
	if ! iconutil -c icns "$ICONSET" -o "$RESOURCES_DIR/AppIcon.icns"; then
		rm -rf "$ICONSET_ROOT"
		echo "error: iconutil failed (use a square PNG for $PNG_SRC)" >&2
		exit 1
	fi
	rm -rf "$ICONSET_ROOT"
	ICON_PLIST_FRAGMENT="$(printf '\t<key>CFBundleIconFile</key>\n\t<string>AppIcon</string>\n')"
	echo "==> app icon: built AppIcon.icns from $PNG_SRC"
fi

PLIST="$APP_DIR/Contents/Info.plist"
echo "==> write Info.plist ($VERSION)"
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleExecutable</key>
	<string>FreeCodeMac</string>
	<key>CFBundleIdentifier</key>
	<string>$BUNDLE_ID</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>FreeCodeMac</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$VERSION</string>
	<key>CFBundleVersion</key>
	<string>$VERSION</string>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
${ICON_PLIST_FRAGMENT}</dict>
</plist>
EOF

echo "==> done: $APP_DIR"

if [[ "$MAKE_PKG" == true ]]; then
	PKG_OUT="$DIST_DIR/$PKG_NAME"
	STAGE="$(mktemp -d "${TMPDIR:-/tmp}/freecodemac-pkg.XXXXXX")"
	trap "rm -rf \"$STAGE\"" EXIT
	mkdir -p "$STAGE"
	cp -R "$APP_DIR" "$STAGE/"
	echo "==> pkgbuild -> $PKG_OUT"
	pkgbuild \
		--root "$STAGE" \
		--identifier "$BUNDLE_ID.pkg" \
		--version "$VERSION" \
		--install-location "/Applications" \
		"$PKG_OUT"
	echo "==> install with: sudo installer -pkg \"$PKG_OUT\" -target /"
fi
