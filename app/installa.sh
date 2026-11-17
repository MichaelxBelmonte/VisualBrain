#!/bin/zsh
# Builds a distributable standalone app. Installation is a drag into Applications.
set -e
cd "$(dirname "$0")/.."
npm run package:mac -- "$@"
echo "Pacchetto pronto in release/. Chiudi le sessioni prima di sostituire l'app installata."
