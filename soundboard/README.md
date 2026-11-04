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
