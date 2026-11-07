const { app, BrowserWindow, globalShortcut, ipcMain, session, Menu } = require('electron');
const path = require('path');

let win;
const MEDIA = ['media', 'audioCapture'];

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1100, height: 760, backgroundColor: '#1e1f22', title: 'Soundboard', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,              // keep audio/voice running when minimized
      autoplayPolicy: 'no-user-gesture-required' // lets global hotkeys start sounds
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  const s = session.defaultSession;
  s.setPermissionRequestHandler((_wc, perm, cb) => cb(MEDIA.includes(perm)));
  s.setPermissionCheckHandler((_wc, perm) => MEDIA.includes(perm));
  createWindow();
});

// Renderer sends [[accelerator, action], ...]; we register them system-wide.
ipcMain.on('hotkeys', (_e, list) => {
  globalShortcut.unregisterAll();
  for (const [accel, action] of Array.isArray(list) ? list : []) {
    try { globalShortcut.register(accel, () => win && win.webContents.send('hotkey', action)); } catch {}
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
