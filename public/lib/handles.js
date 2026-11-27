// 記住使用者選過的 log 資料夾／檔案（File System Access API，Chrome／Edge），存在 IndexedDB。
const DB = 'ultimate-review';
const STORE = 'handles';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
export const saveHandle = (key, h) => tx('readwrite', (s) => s.put(h, key)).catch(() => {});
export const loadHandle = (key) => tx('readonly', (s) => s.get(key)).catch(() => null);
export const clearHandle = (key) => tx('readwrite', (s) => s.delete(key)).catch(() => {});

// 已經有權限就回傳 true；needGesture 為 true 時會跳出詢問（必須在使用者點擊後呼叫）
export async function ensurePermission(handle, needGesture = false) {
  if (!handle?.queryPermission) return false;
  const opts = { mode: 'read' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (!needGesture) return false;
  return (await handle.requestPermission(opts)) === 'granted';
}

// 列出資料夾裡的 Network_*.log，新的在前
export async function listLogs(dir) {
  const out = [];
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== 'file' || !/^Network_.*\.log$/i.test(name)) continue;
    try {
      const f = await h.getFile();
      out.push({ name, handle: h, size: f.size, mtime: f.lastModified });
    } catch { /* 檔案正被移動 */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
