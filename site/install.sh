#!/bin/bash
# Instala o EscutaIA no macOS sem o aviso do Gatekeeper.
#   curl -fsSL https://escutaia.devontravel.com.br/install.sh | bash
#
# Por que não aparece o aviso: arquivos baixados pelo curl não recebem a marca de
# quarentena ("baixado da internet"), que é o que dispara a verificação da Apple.
# O app continua assinado (ad-hoc); este script só baixa, copia para Aplicativos e abre.
set -euo pipefail

REPO="SEU-USUARIO/escutaia"
APP="EscutaIA"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Este instalador é para macOS. Para Windows/Linux, baixe em https://escutaia.devontravel.com.br" >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *) echo "Processador não suportado: $(uname -m)" >&2; exit 1 ;;
esac

URL="https://github.com/${REPO}/releases/latest/download/${APP}-mac-${ARCH}.dmg"
TMP="$(mktemp -d)"
MNT="${TMP}/mnt"
trap 'hdiutil detach "${MNT}" -quiet >/dev/null 2>&1 || true; rm -rf "${TMP}"' EXIT

echo "⬇  Baixando o ${APP} para Mac (${ARCH})…"
curl -fL --progress-bar "${URL}" -o "${TMP}/${APP}.dmg"

echo "📦 Instalando em /Applications…"
mkdir -p "${MNT}"
hdiutil attach "${TMP}/${APP}.dmg" -nobrowse -readonly -mountpoint "${MNT}" -quiet
# Fecha uma versão antiga aberta, para poder substituir.
osascript -e "quit app \"${APP}\"" >/dev/null 2>&1 || true
sleep 1
rm -rf "/Applications/${APP}.app"
ditto "${MNT}/${APP}.app" "/Applications/${APP}.app"
xattr -dr com.apple.quarantine "/Applications/${APP}.app" 2>/dev/null || true

echo "✅ Pronto! Abrindo o ${APP}…"
open "/Applications/${APP}.app"
