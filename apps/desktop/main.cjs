const { app, BrowserWindow, Menu, shell, session } = require('electron');
const path = require('node:path');

// 默认加载线上工作台；本地联调用 WORKBUDDY_URL 覆盖。
const APP_URL = process.env.WORKBUDDY_URL || 'https://app.worksylar.com';
const APP_ORIGIN = (() => {
  try {
    return new URL(APP_URL).origin;
  } catch {
    return 'https://app.worksylar.com';
  }
})();

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0b0f0d',
    title: 'WorkSylar',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      // 远程页面按普通浏览器处理：不给 Node 能力，开启上下文隔离。
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.loadURL(APP_URL);

  // 站外链接交给系统浏览器，避免在客户端里打开不可信页面。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${APP_ORIGIN}/`) || url.startsWith('http://localhost:')) {
      return { action: 'allow' };
    }
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(APP_ORIGIN) || url.startsWith('http://localhost:')) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // 默认拒绝摄像头/麦克风等权限，后续按业务需要再放开。
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false);
    });

    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === 'darwin'
          ? [{ role: 'appMenu' }]
          : []),
        {
          label: '文件',
          submenu: [{ role: 'quit', label: '退出' }],
        },
        {
          label: '编辑',
          submenu: [
            { role: 'undo', label: '撤销' },
            { role: 'redo', label: '重做' },
            { type: 'separator' },
            { role: 'cut', label: '剪切' },
            { role: 'copy', label: '复制' },
            { role: 'paste', label: '粘贴' },
            { role: 'selectAll', label: '全选' },
          ],
        },
        {
          label: '视图',
          submenu: [
            { role: 'reload', label: '刷新' },
            { role: 'toggleDevTools', label: '开发者工具' },
            { type: 'separator' },
            { role: 'resetZoom', label: '实际大小' },
            { role: 'zoomIn', label: '放大' },
            { role: 'zoomOut', label: '缩小' },
            { type: 'separator' },
            { role: 'togglefullscreen', label: '全屏' },
          ],
        },
        {
          label: '帮助',
          submenu: [
            {
              label: '访问官网',
              click: () => void shell.openExternal('https://worksylar.com'),
            },
            {
              label: `版本 ${app.getVersion()}`,
              enabled: false,
            },
          ],
        },
      ]),
    );

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
