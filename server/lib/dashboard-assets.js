const fs = require('fs');
const path = require('path');

/**
 * The dashboard's static files (docs/), served by the Web Service at /t/<tenantId>/. Only an allowlist is
 * read -- the page, its stylesheet, icon, theme.js and app-*.js scripts -- and kept in memory, so nothing else under
 * docs/ (documentation, GLOSSARY.md) is ever reachable through the server, and no request path is ever joined
 * onto the filesystem.
 */
const ASSET_PATTERN = /^(index\.html|style\.css|favicon\.svg|theme\.js|app-[a-z-]+\.js)$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.js': 'text/javascript; charset=utf-8' };

/**
 * @param {string} dir the docs/ directory
 * @returns {Map<string, { body: string, type: string }>} file name -> contents; empty if dir doesn't exist
 */
function loadDashboardAssets(dir) {
    const assets = new Map();
    if (!fs.existsSync(dir)) return assets;
    for (const name of fs.readdirSync(dir)) {
        if (!ASSET_PATTERN.test(name)) continue;
        assets.set(name, { body: fs.readFileSync(path.join(dir, name), 'utf8'), type: TYPES[path.extname(name)] });
    }
    return assets;
}

// The server's own pages (ui/: settings, get started) and the dashboard files they reuse, served at /ui/<name>.
const UI_PATTERN = /^(settings\.html|start\.html|invite\.html|settings\.js|start\.js|invite\.js|settings\.css)$/;
const UI_SHARED = ['style.css', 'favicon.svg', 'app-html.js', 'theme.js'];

/**
 * @param {string} dir the server's ui/ directory
 * @param {Map<string, { body: string, type: string }>} dashboardAssets what loadDashboardAssets() read
 * @returns {Map<string, { body: string, type: string }>} file name -> contents
 */
function loadUiAssets(dir, dashboardAssets) {
    const assets = new Map();
    for (const name of UI_SHARED) if (dashboardAssets.has(name)) assets.set(name, dashboardAssets.get(name));
    if (!fs.existsSync(dir)) return assets;
    for (const name of fs.readdirSync(dir)) {
        if (UI_PATTERN.test(name)) assets.set(name, { body: fs.readFileSync(path.join(dir, name), 'utf8'), type: TYPES[path.extname(name)] });
    }
    return assets;
}

module.exports = { loadDashboardAssets, loadUiAssets, ASSET_PATTERN };
