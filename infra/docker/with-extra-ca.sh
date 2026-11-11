#!/bin/sh
# Runs a command trusting an extra CA when the optional `extra_ca` BuildKit
# secret is mounted (builds behind a TLS-intercepting proxy); otherwise a no-op.
set -eu
if [ -s /run/secrets/extra_ca ]; then
  export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca
fi
exec "$@"
