#!/bin/bash
# FAST DEPLOY — code is compiled on the developer's machine and bind-mounted in (docker-compose.prebuilt.yml).
# Nothing is compiled here: this box has ONE cpu core shared with other projects, where `tsc` took 10+ minutes
# against 6.5 seconds on a laptop.
#
# `up -d` alone is NOT enough. With a bind mount the files change but compose sees an unchanged config and does
# nothing, leaving Node running the code it loaded at startup — a deploy that reports success and changes
# nothing. So: `up -d` to apply any config/image change, then an explicit `restart` to make the processes
# actually pick up the new dist.
#
# The ONE case that still needs a real image build is a package.json change (node_modules live in the image).
set -e
cd /opt/bera-bot/app
C="docker compose -p bera-bot -f docker-compose.yml -f docker-compose.vps.yml -f docker-compose.prebuilt.yml"
$C up -d brain observer kg-observer || { echo DEPLOY_FAIL_UP; exit 1; }
$C restart brain observer kg-observer || { echo DEPLOY_FAIL_RESTART; exit 1; }
echo "DEPLOY_OK $(date -u +%H:%M:%S)"
