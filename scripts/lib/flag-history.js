const { readJson, writeJson } = require('./json-file');

/** Appends to the flag-state-history.json audit log — one entry per actual flag/env/source flip. */
function appendFlagHistoryEntries(historyPath, entries) {
    if (!entries.length) {
        return;
    }

    const history = readJson(historyPath, []);

    history.push(...entries);

    writeJson(historyPath, history);
}

module.exports = { appendFlagHistoryEntries };