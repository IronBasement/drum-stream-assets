import { app, BrowserWindow, BrowserWindowConstructorOptions, ipcMain } from 'electron';
import { WebSocket } from 'ws';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const defaultWindowConfig: Partial<BrowserWindowConstructorOptions> = {
  transparent: true,
  frame: false,
  webPreferences: {
    preload: join(__dirname, 'preload.mjs'),
    backgroundThrottling: false,
  },
};

function createMIDINotesWindow() {
  const win = new BrowserWindow({
    ...defaultWindowConfig,
    title: 'MIDI Notes',
    width: 1920,
    height: 1080,
  });
  // TODO: Re-enable mouse events when running sync thing
  // win.setIgnoreMouseEvents(true);
  win.loadURL(process.env.VITE_DEV_SERVER_URL! + '#MIDINotesWindow');
  // win.loadURL(process.env.VITE_DEV_SERVER_URL!);

  return win;
}

function createNowPlayingWindow() {
  const win = new BrowserWindow({
    ...defaultWindowConfig,
    title: 'Now Playing',
    width: 1920,
    height: 128,
  });
  win.setIgnoreMouseEvents(true);
  win.loadURL(process.env.VITE_DEV_SERVER_URL! + '#NowPlayingWindow');

  return win;
}

function createSyncedLyricsWindow() {
  const win = new BrowserWindow({
    ...defaultWindowConfig,
    title: 'Synced Lyrics',
    width: 640,
    height: 400,
  });
  win.setIgnoreMouseEvents(true);
  win.loadURL(process.env.VITE_DEV_SERVER_URL! + '#SyncedLyricsWindow');

  return win;
}

let prevSongChangedPayload: any;

function createWindows() {
  const windows = [
    createMIDINotesWindow(),
    createNowPlayingWindow(),
    createSyncedLyricsWindow(),
  ];
  
  // Connect to server WS to receive rebroadcast messages from remote client
  // Send all messages via IPC to individual windows
  const ws = new WebSocket('http://127.0.0.1:3000');
  ws.on('open', () => ws.send('receiver'));
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (!message) {
      console.error('Error parsing received WebSocket message:', data.toString());
      return;
    }
    if (message.type === 'song_changed') {
      const lyricsPath = join(__dirname, '../../music-stem-server/server/downloads',
        `${message.artist} - ${message.title}.lrc`);
      if (existsSync(lyricsPath)) {
        // just stuff the lyrics into the message sent to renderer process
        // 🤦‍♂️
        message.lyrics = parseLyrics(lyricsPath, message.duration);
      }
      const { type: _, ...payload } = message;
      prevSongChangedPayload = payload;
    }
    const { type, ...payload } = message;
    windows.forEach(win => win.webContents.send(type, payload));
  });
}

const parseLRCTimeToFloat = (lrcTime: string) => {
  const timeParts = lrcTime.split(':');
  const mins = parseInt(timeParts[0], 10);
  const secs = parseFloat(timeParts[1]);
  return (mins * 60) + secs;
};

const parseLyrics = (lyricsPath: string, mediaDuration: number = 0) => {
  const rawLyrics = readFileSync(lyricsPath).toString('utf8').split('\n');
  const lyrics: LyricLine[] = [
    // pad start with an empty line before the first real line happens
    // so that we don't start directly on the first line during intros
    { timestamp: 0, text: '' }
  ];
  let offset = 0;
  for (let line of rawLyrics) {
    const lengthMatch = line.match(/^\[length: (\d*\:\d*\.?\d*)\]/);
    if (lengthMatch) {
      const lrcDuration = parseLRCTimeToFloat(lengthMatch[1]);
      offset = lrcDuration - mediaDuration;
      continue;
    }

    const lineParts = line.match(/^\[(\d*\:\d*\.?\d*)\](.+)/);
    if (lineParts) {
      lyrics.push({
        timestamp: parseLRCTimeToFloat(lineParts[1]) - offset,
        text: lineParts[2].trim()
      });
    }
  }
  return lyrics;
};

ipcMain.on('initialize', (event) => prevSongChangedPayload && event.reply('song_changed', prevSongChangedPayload));
ipcMain.on('error', (event) => console.error(event));

app.on('window-all-closed', () => app.quit());
app.on('activate', () => BrowserWindow.getAllWindows().length || createWindows());
app.whenReady().then(createWindows);
