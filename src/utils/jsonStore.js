const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// Small JSON file store with atomic writes. Good enough for launch; move to a DB as usage grows.
function createJsonStore(filePath, initial) {
  let data = null;

  function load() {
    if (data) return data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Never silently overwrite a corrupted store (it may hold user wallets)
        logger.fatal({ err: err.message, filePath }, 'Failed to read data store');
        throw err;
      }
      data = structuredClone(initial);
    }
    return data;
  }

  function save() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }

  return { load, save };
}

module.exports = { createJsonStore };
