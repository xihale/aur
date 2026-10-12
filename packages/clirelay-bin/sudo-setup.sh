#!/bin/bash
# Only remaining root step: install the built clirelay-bin package.
# Run with: sudo bash /home/xihale/Builds/clirelay-bin/sudo-setup.sh
set -euo pipefail
pacman -U --noconfirm /home/xihale/Builds/clirelay-bin/clirelay-bin-0.4.25-1-x86_64.pkg.tar.zst
