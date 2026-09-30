const fs = require('fs');

/** Appends to the flag-state-history.json audit log — one entry per actual flag/env/source flip. */
function appendFlagHistoryEntries(historyPath, entries) {
    if (!entries.length) {
        return;
    }

    const history = fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath, 'utf8')) : [];

    history.push(...entries);

    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2) + '\n');
}

module.exports = { appendFlagHistoryEntries };