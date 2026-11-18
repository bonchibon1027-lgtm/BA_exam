// IndexedDB の読み書き。データは端末の中だけに保存し、外部へは送らない。
const DB = (() => {
  const NAME = 'ba-drill';
  const VERSION = 1;
  let opening = null;

  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) {
          reject(new Error('このブラウザはIndexedDBに対応していません'));
          return;
        }
        const req = indexedDB.open(NAME, VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('packs')) db.createObjectStore('packs', { keyPath: 'packId' });
          if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress', { keyPath: 'key' });
          if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
          if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('データベースを開けませんでした'));
        req.onblocked = () => reject(new Error('別のタブで古い版が開いています。タブを閉じてから再読み込みしてください'));
      });
    }
    return opening;
  }

  // 1つのトランザクションで work(t, out) を実行し、完了時に out.value を返す
  function tx(names, mode, work) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(names, mode);
      const out = { value: undefined };
      t.oncomplete = () => resolve(out.value);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('保存を中止しました'));
      try {
        work(t, out);
      } catch (e) {
        try { t.abort(); } catch (_) { /* 既に終わっている */ }
        reject(e);
      }
    }));
  }

  function getAll(store) {
    return tx([store], 'readonly', (t, out) => {
      const r = t.objectStore(store).getAll();
      r.onsuccess = () => { out.value = r.result; };
    });
  }

  function putMany(store, rows) {
    return tx([store], 'readwrite', t => {
      const os = t.objectStore(store);
      rows.forEach(row => os.put(row));
    });
  }

  function add(store, row) {
    return tx([store], 'readwrite', (t, out) => {
      const r = t.objectStore(store).add(row);
      r.onsuccess = () => { out.value = r.result; };
    });
  }

  function del(store, key) {
    return tx([store], 'readwrite', t => { t.objectStore(store).delete(key); });
  }

  // バックアップ復元用：4つのストアをまとめて入れ替える
  function replaceAll(data) {
    const names = ['packs', 'progress', 'sessions', 'settings'];
    return tx(names, 'readwrite', t => {
      names.forEach(n => {
        const os = t.objectStore(n);
        os.clear();
        (data[n] || []).forEach(row => os.put(row));
      });
    });
  }

  return { open, getAll, putMany, add, del, replaceAll };
})();
