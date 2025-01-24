import SQLiteESMFactory from '../../dist/wa-sqlite-async.mjs';
import { OPFSAdaptiveVFS as MyVFS } from '../../src/examples/OPFSAdaptiveVFS.js';
import * as SQLite from '../../src/sqlite-api.js';

const STATEMENT = `SELECT * FROM "notes" WHERE "graphId" == ? AND "id" = ?`;
const PARAMETERS = ["rhashimoto1","01122024"];
const COUNT = 1_000_000;

const filenameReady = new Promise(resolve => {
  addEventListener('message', function handler(event) {
    resolve(event.data);
    removeEventListener('message', handler);
  }, { once: true });
});

postMessage('Hello from the worker!');
Promise.resolve().then(async () => {
  try {
    const filename = await filenameReady;
    postMessage(`Copy ${filename} to OPFS.`);
    const dirHandle = await navigator.storage.getDirectory();
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    const accessHandle = await fileHandle.createSyncAccessHandle();
    accessHandle.truncate(0);
    accessHandle.write(await fetch(filename).then(response => response.arrayBuffer()));
    accessHandle.close();

    postMessage('Open database.');
    const module = await SQLiteESMFactory();
    const sqlite3 = SQLite.Factory(module);

    const vfs = await MyVFS.create('hello', module);
    // @ts-ignore
    sqlite3.vfs_register(vfs, true);
    const db = await sqlite3.open_v2(await filenameReady);

    postMessage('Prepare statement.');
    const prepared = await (async () => {
      for await (const stmt of sqlite3.statements(db, STATEMENT, { unscoped: true }))
        return stmt;
    })();

    postMessage(`Execute ${COUNT} queries.`);
    for (let i = 0; i < COUNT; ++i) {
      PARAMETERS.forEach((param, index) => {
        sqlite3.bind(prepared, index + 1, param);
      });

      while (await sqlite3.step(prepared) === SQLite.SQLITE_ROW) {
        const row = sqlite3.row(prepared);
        if (i === 0) console.log(row);
      }

      sqlite3.reset(prepared);
      if ((i + 1) % 1000 === 0) postMessage(`${i + 1} queries`);
    }
    if (COUNT % 1000 !== 0) postMessage(`${COUNT} queries`);

    postMessage('Done!');
  } catch (e) {
    postMessage(e.message);
    throw e;
  }
});
