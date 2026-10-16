/**
 * Application version (SemVer). The one source of truth is package.json, bumped on main by the Release workflow
 * (scripts/release.js at the repo root). server/ deploys on its own (rootDir: server), so it reads its own
 * package.json, which always carries the same number as the root one; the git tag `v<version>` marks the release.
 */
const APP_VERSION = require('../package.json').version;

module.exports = { APP_VERSION };
