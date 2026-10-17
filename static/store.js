/* =========================================================================
   store.js — 浏览器本地存储（IndexedDB）

   为什么用 IndexedDB 而不是 localStorage：
   - 合成历史要存音频 Blob，localStorage 只能放字符串且总容量 ~5MB；
   - 记录会越积越多，需要按时间翻页、按条删除；
   - 音色试听缓存也想放进来，减少重复请求。

   三个对象仓：
     records  合成记录（含音频 Blob 与完整参数）
     samples  音色复刻样本（含音频 Blob）
     cache    杂项缓存（音色试听等）
   ========================================================================= */
(function () {
  'use strict';

  const DB_NAME = 'mimo-studio';
  const DB_VERSION = 1;
  const MAX_RECORDS = 60;   // 超过就淘汰最旧的，避免把磁盘吃满

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('当前浏览器不支持 IndexedDB'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('records')) {
          const s = db.createObjectStore('records', { keyPath: 'id' });
          s.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('samples')) {
          const s = db.createObjectStore('samples', { keyPath: 'id' });
          s.createIndex('created', 'created');
        }
        if (!db.objectStoreNames.contains('cache')) {
          db.createObjectStore('cache', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('打开本地数据库失败'));
    });
    return dbPromise;
  }

  function tx(storeName, mode, fn) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(storeName, mode);
          const store = t.objectStore(storeName);
          let result;
          try {
            result = fn(store);
          } catch (e) {
            reject(e);
            return;
          }
          t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
          t.onerror = () => reject(t.error || new Error('本地数据库操作失败'));
          t.onabort = () => reject(t.error || new Error('本地数据库操作被取消'));
        })
    );
  }

  function wrap(req) {
    return { __req: req };
  }

  /** 取全部 / 按游标取前 N 条（倒序） */
  function getAll(storeName, indexName, limit) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(storeName, 'readonly');
          const src = indexName ? t.objectStore(storeName).index(indexName) : t.objectStore(storeName);
          const out = [];
          const req = src.openCursor(null, 'prev');
          req.onsuccess = () => {
            const cur = req.result;
            if (!cur) {
              resolve(out);
              return;
            }
            out.push(cur.value);
            if (limit && out.length >= limit) {
              resolve(out);
              return;
            }
            cur.continue();
          };
          req.onerror = () => reject(req.error || new Error('读取失败'));
        })
    );
  }

  /* ---------------------------------------------------------------- 记录 */

  /** 新记录入库；超过上限时淘汰最旧的（连同音频一起删） */
  async function addRecord(record) {
    await tx('records', 'readwrite', (s) => wrap(s.put(record)));
    const all = await getAll('records', 'createdAt', MAX_RECORDS + 1);
    if (all.length > MAX_RECORDS) {
      const extra = all.slice(MAX_RECORDS);
      for (const item of extra) {
        await tx('records', 'readwrite', (s) => wrap(s.delete(item.id)));
      }
    }
    return record;
  }

  function listRecords(limit) {
    return getAll('records', 'createdAt', limit || MAX_RECORDS);
  }

  function getRecord(id) {
    return tx('records', 'readonly', (s) => wrap(s.get(id)));
  }

  function deleteRecord(id) {
    return tx('records', 'readwrite', (s) => wrap(s.delete(id)));
  }

  function clearRecords() {
    return tx('records', 'readwrite', (s) => wrap(s.clear()));
  }

  function countRecords() {
    return tx('records', 'readonly', (s) => wrap(s.count()));
  }

  /* ---------------------------------------------------------------- 样本 */

  function addSample(sample) {
    return tx('samples', 'readwrite', (s) => wrap(s.put(sample)));
  }

  function listSamples() {
    return getAll('samples', 'created', 200);
  }

  function getSample(id) {
    return tx('samples', 'readonly', (s) => wrap(s.get(id)));
  }

  function deleteSample(id) {
    return tx('samples', 'readwrite', (s) => wrap(s.delete(id)));
  }

  /* ---------------------------------------------------------------- 缓存 */

  async function cacheGet(key, ttlMs) {
    const row = await tx('cache', 'readonly', (s) => wrap(s.get(key)));
    if (!row) return null;
    if (ttlMs && Date.now() - (row.at || 0) > ttlMs) return null;
    return row;
  }

  function cachePut(key, value, extra) {
    return tx('cache', 'readwrite', (s) =>
      wrap(s.put({ key, at: Date.now(), value, ...(extra || {}) }))
    );
  }

  function cacheDelete(key) {
    return tx('cache', 'readwrite', (s) => wrap(s.delete(key)));
  }

  /* ---------------------------------------------------------------- 杂项 */

  /** 估算占用，给设置面板显示用 */
  async function estimate() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        return { usage: e.usage || 0, quota: e.quota || 0 };
      }
    } catch (err) { /* 忽略 */ }
    return { usage: 0, quota: 0 };
  }

  /** Blob 存进去时带对象 URL 用 */
  function objectUrl(blob) {
    return blob ? URL.createObjectURL(blob) : '';
  }

  function revoke(url) {
    if (url && url.startsWith('blob:')) {
      try { URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ }
    }
  }

  window.MimoStore = {
    open,
    addRecord,
    listRecords,
    getRecord,
    deleteRecord,
    clearRecords,
    countRecords,
    addSample,
    listSamples,
    getSample,
    deleteSample,
    cacheGet,
    cachePut,
    cacheDelete,
    estimate,
    objectUrl,
    revoke,
    MAX_RECORDS,
  };
})();
