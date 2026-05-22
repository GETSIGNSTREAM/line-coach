#!/usr/bin/env bash
#
# setup-pi-kiosk.sh — one-shot installer for a Line Coach Pi kiosk.
#
# Run this ONCE on a freshly-imaged Raspberry Pi, after the desktop
# wizard has finished and the Pi is connected to the internet. It:
#
#   1. Installs Chromium + helpers (unclutter, xdotool)
#   2. Sets audio output to HDMI and volume to 85%
#   3. Writes the autostart file that boots Chromium into kiosk mode
#      pointed at https://wildbird.coach/?store=<STORE>&touch=1
#   4. Installs a systemd watchdog so Chromium auto-restarts if it
#      ever crashes
#   5. Reboots when you confirm at the prompt
#
# USAGE
#   curl -fsSL https://raw.githubusercontent.com/GETSIGNSTREAM/line-coach/main/scripts/setup-pi-kiosk.sh | bash -s -- <store-slug>
#
# Or after cloning the repo:
#   bash scripts/setup-pi-kiosk.sh <store-slug>
#
# VALID STORE SLUGS
#   hollywood, westwood, 3rd-la-brea, culver-city, dtla, el-segundo
#
# REQUIREMENTS
#   • Raspberry Pi OS (64-bit), full desktop version, fresh install
#   • Internet connection
#   • User 'pi' (the default account on Pi OS)
#   • Run from a normal shell (NOT as root). Script uses sudo where
#     needed and will prompt for the pi user's password once.

set -euo pipefail

# ── Args ──────────────────────────────────────────────────────────

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <store-slug>"
  echo "Valid slugs: hollywood, westwood, 3rd-la-brea, culver-city, dtla, el-segundo"
  exit 1
fi

STORE_SLUG="$1"
case "$STORE_SLUG" in
  hollywood|westwood|3rd-la-brea|culver-city|dtla|el-segundo)
    ;;
  *)
    echo "ERROR: '$STORE_SLUG' is not a recognized store slug."
    echo "Valid slugs: hollywood, westwood, 3rd-la-brea, culver-city, dtla, el-segundo"
    exit 1
    ;;
esac

# Sanity-check: don't run as root. The autostart file lives in the
# pi user's home directory; if root runs this it ends up in
# /root/.config/lxsession which the desktop session won't read.
if [[ "${EUID}" -eq 0 ]]; then
  echo "ERROR: Run as the 'pi' user, not root. The script will sudo when needed."
  exit 1
fi

DISPLAY_URL="https://wildbird.coach/?store=${STORE_SLUG}&touch=1"
USER_HOME="$HOME"

echo "════════════════════════════════════════════════════════════════"
echo " Line Coach Pi kiosk setup"
echo " Store: ${STORE_SLUG}"
echo " URL:   ${DISPLAY_URL}"
echo "════════════════════════════════════════════════════════════════"
echo ""

# ── 1. Install packages ──────────────────────────────────────────

echo "[1/5] Installing Chromium and helpers (apt update + install)…"
sudo apt update -qq
sudo apt install -y chromium-browser unclutter xdotool alsa-utils >/dev/null
echo "      ✓ Done."
echo ""

# ── 2. Audio: route to HDMI, set volume ───────────────────────────

echo "[2/5] Configuring audio output to HDMI + setting volume…"
# raspi-config nonint numbers (stable across Pi OS versions):
#   do_audio 0 = auto, 1 = headphones, 2 = HDMI
# We force HDMI because that's the canonical kiosk path. If you
# need 3.5mm later, run 'sudo raspi-config' manually.
if command -v raspi-config >/dev/null 2>&1; then
  sudo raspi-config nonint do_audio 2 >/dev/null 2>&1 || true
fi
# Set master volume to 85%. Some Pi OS builds use 'Master', others
# 'PCM' — try both, ignore failures, the Pi audio path is forgiving.
amixer set Master 85% >/dev/null 2>&1 || true
amixer set PCM 85% >/dev/null 2>&1 || true
echo "      ✓ HDMI audio enabled, volume 85%."
echo ""

# ── 3. Kiosk autostart ────────────────────────────────────────────

echo "[3/5] Writing kiosk autostart file…"
AUTOSTART_DIR="${USER_HOME}/.config/lxsession/LXDE-pi"
mkdir -p "${AUTOSTART_DIR}"
cat > "${AUTOSTART_DIR}/autostart" <<EOF
@xset s off
@xset -dpms
@xset s noblank
@unclutter -idle 0
@chromium-browser --kiosk --noerrdialogs --disable-infobars --autoplay-policy=no-user-gesture-required --disable-features=TranslateUI --check-for-update-interval=31536000 ${DISPLAY_URL}
EOF
echo "      ✓ ${AUTOSTART_DIR}/autostart"
echo ""

# ── 4. Watchdog service (auto-restart Chromium on crash) ─────────

echo "[4/5] Installing Chromium watchdog systemd service…"
sudo tee /etc/systemd/system/chromium-watchdog.service >/dev/null <<EOF
[Unit]
Description=Line Coach Chromium kiosk watchdog
After=graphical.target

[Service]
User=pi
Environment=DISPLAY=:0
ExecStart=/bin/bash -c 'while true; do pgrep -x chromium-browser > /dev/null || chromium-browser --kiosk --autoplay-policy=no-user-gesture-required "${DISPLAY_URL}" & sleep 30; done'
Restart=always

[Install]
WantedBy=graphical.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable chromium-watchdog >/dev/null 2>&1 || true
echo "      ✓ Watchdog enabled (will start on next boot)."
echo ""

# ── 5. Done — prompt to reboot ────────────────────────────────────

echo "[5/5] Setup complete."
echo ""
echo "Summary:"
echo "  • Chromium installed"
echo "  • Audio routed to HDMI, volume 85%"
echo "  • Kiosk autostart configured for ${DISPLAY_URL}"
echo "  • Watchdog service enabled"
echo ""
echo "Next: reboot the Pi. After reboot, it will boot directly into"
echo "the Line Coach display, full screen, with no further input."
echo ""

# Audio quick-test offered, not forced — some kiosks ship without
# speakers attached during setup and would fail this needlessly.
read -rp "Run a 1-second audio test now? (y/N): " AUDIO_TEST
if [[ "${AUDIO_TEST,,}" == "y" ]]; then
  echo "Playing a 1-second tone…"
  speaker-test -t sine -f 1000 -l 1 2>/dev/null || echo "      (audio test failed — verify monitor speakers are connected)"
fi
echo ""

read -rp "Reboot now? (y/N): " REBOOT_NOW
if [[ "${REBOOT_NOW,,}" == "y" ]]; then
  echo "Rebooting in 3 seconds…"
  sleep 3
  sudo reboot
else
  echo "Skipping reboot. Run 'sudo reboot' when you're ready to test the kiosk."
fi
