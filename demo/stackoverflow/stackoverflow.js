const FILENAME = 'stackoverflow.sqlite3';

Promise.resolve().then(async () => {
  try {
    const worker = new Worker('stackoverflow-worker.js', { type: 'module' });
    worker.postMessage(FILENAME);
    worker.addEventListener('message', event => {
      if (Array.isArray(event.data)) {
        log(...event.data);
      } else {
        log(event.data);
      }
    });
  } catch (e) {
    log(e.message);
    throw e;
  }
});

const TIME_FORMAT = {
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3
};

function log(text) {
  const time = new Date();
  // @ts-ignore
  const timestamp = time.toLocaleTimeString(undefined, TIME_FORMAT);
  const pre = document.createElement('pre');
  pre.textContent = `${timestamp} ${text}`;
  document.body.appendChild(pre);
}