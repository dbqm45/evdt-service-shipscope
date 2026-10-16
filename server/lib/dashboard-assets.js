const fs = require('fs');
const path = require('path');

/**
 * The dashboard's static files (docs/), served by the Web Service at /t/<tenantId>/. Only an allowlist is
 * read -- the page, its stylesheet, icon and app-*.js scripts -- and kept in memory, so nothing else under
 * docs/ (data/*.json with the file-based sync's data, jira-spaces.json, components.json) is ever reachable
 * through the server, and no request path is ever joined onto the filesystem.
 */
const ASSET_PATTERN = /^(index\.html|style\.css|favicon\.svg|app-[a-z-]+\.js)$/;
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
        let body = fs.readFileSync(path.join(dir, name), 'utf8');
        // The preload hints point at data/*.json files that don't exist in SaaS mode (the data comes from
        // the API); left in, every page load would make ten 404 requests.
        if (name === 'index.html') body = body.replace(/^\s*<link rel="preload" href="(data\/[^"]+|components\.json)"[^>]*>\n/gm, '');
        assets.set(name, { body, type: TYPES[path.extname(name)] });
    }
    return assets;
}

module.exports = { loadDashboardAssets, ASSET_PATTERN };
