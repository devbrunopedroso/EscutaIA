#!/bin/sh
# Build da página na Vercel: aponta os links de download para as Releases do GitHub.
# Ordem: ESCUTAIA_REPO (variável definida no painel da Vercel) > repositório de onde a
# Vercel fez o deploy (VERCEL_GIT_REPO_OWNER/SLUG, automático com deploy pelo GitHub).
set -e
REPO="${ESCUTAIA_REPO:-}"
if [ -z "$REPO" ] && [ -n "$VERCEL_GIT_REPO_OWNER" ] && [ -n "$VERCEL_GIT_REPO_SLUG" ]; then
  REPO="$VERCEL_GIT_REPO_OWNER/$VERCEL_GIT_REPO_SLUG"
fi
rm -rf public && mkdir public
cp index.html icon.png install.sh public/
if [ -n "$REPO" ]; then
  for f in public/index.html public/install.sh; do sed -i.bak "s#SEU-USUARIO/escutaia#$REPO#" "$f" && rm -f "$f.bak"; done
  echo "links de download → github.com/$REPO/releases"
else
  echo "aviso: defina ESCUTAIA_REPO (ex.: seu-usuario/escutaia) nas variáveis do projeto na Vercel"
fi
# Link da Chrome Web Store, quando a extensão for publicada (opcional).
if [ -n "$CHROME_STORE_URL" ]; then
  sed -i.bak "s#const CHROME_STORE_URL = \"\";#const CHROME_STORE_URL = \"$CHROME_STORE_URL\";#" public/index.html && rm -f public/index.html.bak
fi
