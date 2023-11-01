import * as VFS from "../../src/VFS.js";
import { IDBBatchAtomicVFS } from "../../src/examples/IDBBatchAtomicVFS.js";

const SEARCH_PARAMS = new URLSearchParams(location.search);
const IDB_NAME = SEARCH_PARAMS.get('idb') ?? 'sqlite-vfs';
const DB_NAME = SEARCH_PARAMS.get('db') ?? 'sqlite.db';

const DBFILE_MAGIC = 'SQLite format 3\x00';

// Use a service worker for downloading. This is currently the only
// cross-browser way to stream to a local file.
navigator.serviceWorker.register('service-worker.js', { type: 'module' });
(async function() {
  // Enable the export button when the service worker is responding.
  while (true) {
    let delay = 25;
    const response = await fetch('./export?check=true');
    if (response.ok) {
      // @ts-ignore
      document.getElementById('file-export').disabled = false;
      return;
    }
    await new Promise(resolve => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 5000);
  }
})();

document.getElementById('file-export').addEventListener('click', async () => {
  // Fetch from the special URL handled by the service worker. All
  // the magic happens there.
  const url = new URL('./export', location.href);
  url.searchParams.set('idb', IDB_NAME);
  url.searchParams.set('db', DB_NAME);
  window.open(url);
});

document.getElementById('file-import').addEventListener('change', async event => {
  let vfs;
  try {
    log(`Importing to IndexedDB ${IDB_NAME}, path ${DB_NAME}`);
    vfs = new IDBBatchAtomicVFS(IDB_NAME);
    // @ts-ignore
    await importDatabase(vfs, DB_NAME, event.target.files[0].stream());
    log('Import complete');

    // Use a Worker to verify the database with SQLite.
    log('Verifying database integrity');
    const url = new URL('./verifier.js', location.href);
    url.searchParams.set('idb', IDB_NAME);
    url.searchParams.set('db', DB_NAME);
    const worker = new Worker(url, { type: 'module' });
    await new Promise(resolve => {
      worker.addEventListener('message', ({data}) => {
        resolve();
        for (const row of data) {
          log(`integrity result: ${row}`);
        }
        worker.terminate();
      });
    });
    log('Verification complete');
  } catch (e) {
    log(e.toString());
    throw e;
  } finally {
    vfs?.close();
  }
});

/**
 * @param {VFS.Base} vfs 
 * @param {string} path 
 * @param {ReadableStream} stream 
 */
async function importDatabase(vfs, path, stream) {
  // This generator converts arbitrary sized chunks from the stream
  // into SQLite pages.
  async function* pagify() {
    /** @type {Uint8Array[]} */ const chunks = [];
    const reader = stream.getReader();

    // Read at least the file header fields we need.
    log('Reading file header...');
    while (chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) < 32) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Unexpected end of file');
      chunks.push(value);
    }

    // Consolidate the header into a single DataView.
    let copyOffset = 0;
    const header = new DataView(new ArrayBuffer(32));
    for (const chunk of chunks) {
      const src = chunk.subarray(0, header.byteLength - copyOffset);
      const dst = new Uint8Array(header.buffer, copyOffset);
      dst.set(src);
      copyOffset += src.byteLength;
    }

    if (new TextDecoder().decode(header.buffer.slice(0, 16)) !== DBFILE_MAGIC) {
      throw new Error('Not a SQLite database file');
    }

    // Extract page fields.
    const pageSize = (field => field === 1 ? 65536 : field)(header.getUint16(16));
    const pageCount = header.getUint32(28);
    log(`${pageCount} pages, ${pageSize} bytes each, ${pageCount * pageSize} bytes total`);

    // Yield each page in sequence.
    log('Copying pages...');
    for (let i = 0; i < pageCount; ++i) {
      // Read enough chunks to produce the next page.
      while (chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) < pageSize) {
        const { done, value } = await reader.read();
        if (done) throw new Error('Unexpected end of file');
        chunks.push(value);
      }

      // Assemble the page into a single Uint8Array.
      // TODO: Optimize case where first chunk has >= pageSize bytes.
      let copyOffset = 0;
      const page = new Uint8Array(pageSize);
      while (copyOffset < pageSize) {
        // Copy bytes into the page.
        const src = chunks[0].subarray(0, pageSize - copyOffset);
        const dst = new Uint8Array(page.buffer, copyOffset);
        dst.set(src);
        copyOffset += src.byteLength;

        if (src.byteLength === chunks[0].byteLength) {
          // All the bytes in the chunk were consumed.
          chunks.shift();
        } else {
          chunks[0] = chunks[0].subarray(src.byteLength);
        }
      }

      yield page;
    }

    const { done } = await reader.read();
    if (!done) throw new Error('Unexpected data after last page');
  };

  const onFinally = [];
  try {
    log(`Deleting ${path}...`);
    await vfs.xDelete(path, 1);

    // Create the file.
    log(`Creating ${path}...`);
    const fileId = 1234;
    const flags = VFS.SQLITE_OPEN_MAIN_DB | VFS.SQLITE_OPEN_CREATE | VFS.SQLITE_OPEN_READWRITE;
    await check(vfs.xOpen(path, fileId, flags, new DataView(new ArrayBuffer(4))));
    onFinally.push(() => vfs.xClose(fileId));

    // Open a "transaction".
    await check(vfs.xLock(fileId, VFS.SQLITE_LOCK_SHARED));
    onFinally.push(() => vfs.xUnlock(fileId, VFS.SQLITE_LOCK_NONE));
    await check(vfs.xLock(fileId, VFS.SQLITE_LOCK_RESERVED));
    onFinally.push(() => vfs.xUnlock(fileId, VFS.SQLITE_LOCK_SHARED));
    await check(vfs.xLock(fileId, VFS.SQLITE_LOCK_EXCLUSIVE));

    const ignored = new DataView(new ArrayBuffer(4));
    await vfs.xFileControl(fileId, VFS.SQLITE_FCNTL_BEGIN_ATOMIC_WRITE, ignored);

    // Write pages.
    let iOffset = 0;
    for await (const page of pagify()) {
      await check(vfs.xWrite(fileId, page, iOffset));
      iOffset += page.byteLength;
    }

    await vfs.xFileControl(fileId, VFS.SQLITE_FCNTL_COMMIT_ATOMIC_WRITE, ignored);
    await vfs.xFileControl(fileId, VFS.SQLITE_FCNTL_SYNC, ignored);
    await vfs.xSync(fileId, VFS.SQLITE_SYNC_NORMAL);
  } finally {
    while (onFinally.length) {
      await onFinally.pop()();
    }
  }
}

function log(...args) {
  const timestamp = new Date().toLocaleTimeString(undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  });
  
  const element = document.createElement('pre');
  element.textContent = `${timestamp} ${args.join(' ')}`;
  document.body.append(element);
}

async function check(code) {
  if (await code !== VFS.SQLITE_OK) {
    throw new Error(`Error code: ${code}`);
  }
}