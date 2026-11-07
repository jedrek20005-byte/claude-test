# Soundboard

Single-file soundboard for playing sounds into Discord. No install, no server.

1. Install a virtual audio cable, e.g. [VB-Cable](https://vb-audio.com/Cable/) (free).
2. Open `index.html` in **Chrome or Edge**.
3. Set **Output** to `CABLE Input`. Tick **Hear it too** to also hear sounds yourself.
4. In Discord → Settings → Voice & Video, set **Input Device** to `CABLE Output`.
   (Turn off noise suppression / automatic input sensitivity if sounds get cut.)
5. Drag in audio files, click a tile or press its hotkey. `Esc` stops everything.

Sounds are stored in your browser (IndexedDB), so they persist between sessions.
Hotkeys only work while the soundboard window is focused (browsers can't capture global keys).
To talk and play sounds at once, route your mic into the cable too (Windows "Listen to this device" on the mic → CABLE Input, or use Voicemeeter).

## Voice changer

- **Mic → Discord (F2)** routes your real mic through the soundboard to the cable, so Discord hears you (and the sound tiles) via `CABLE Output`. Pick your real mic under *Your mic*.
- **Fighter pilot (F3)** toggles the pilot radio voice on/off at will: narrow-band radio EQ, light distortion, heavy compression, background static (slider) and squelch clicks when you start/stop talking. Turning it on also opens the mic.
- Other presets: Deep, Chipmunk, Robot, Megaphone, Cave echo. Pilot overrides the selected preset while it is on; turning it off returns to the preset.
- F2/F3 only work while the soundboard window is focused; click the buttons otherwise.
- Don't enable "Hear myself" without headphones (feedback).

## Desktop app (Windows / Mac / Linux)

The same soundboard also runs as a standalone desktop app (Electron), with **global hotkeys that work in any window, even in a game**:

| Hotkey | Action |
|---|---|
| `Ctrl+Alt+<tile key>` | play that sound |
| `Ctrl+Alt+F2` | mic → Discord on/off |
| `Ctrl+Alt+F3` | fighter pilot on/off |
| `Ctrl+Alt+Space` | stop all sounds |

**Run it:** install [Node.js](https://nodejs.org), then double-click `start-soundboard.bat` (first run installs dependencies), or run `npm install && npm start` in this folder.

**Build a .exe:** `npm install && npm run dist` creates a portable `Soundboard-1.0.0-portable.exe` and an installer in `dist/`. Or run the *Build soundboard app (Windows)* GitHub Action and download the `Soundboard-windows` artifact.
