# BLE Reverse Engineering — CMF Watch Pro 2

Workspace for WatchAI v1 (see [PRD.md](PRD.md)).

## Status

- **PRD committed.** No code yet.
- **Toolchain blocker:** No JDK/Gradle/Android SDK on this Mac (temurin install needs sudo; ask user to run `brew install --cask temurin` manually, plus Android Studio or `brew install --cask android-commandlinetools` + sdkmanager).
- Phone-over-USB (no emulator) is the deployment plan once toolchain exists.

## M0 — Connectivity Test (hardware required)

1. Phone: enable Developer Options + USB debugging; connect to Mac; verify with `adb devices`.
2. Install nRF Connect (mobile) or Wireshark + HCI snoop log (Developer options → Bluetooth HCI snoop log) to capture CMF app ↔ watch traffic.
3. Pair CMF Watch Pro 2, run capture, identify GATT service/characteristic for quick-reply writes.
4. Log findings in `notes/m0-findings.md` — never guess; record only observed UUIDs/packet formats.
