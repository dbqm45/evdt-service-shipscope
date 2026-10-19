// The theme the dashboard's toggle saved (app-core.js), applied before the page paints: a file, not an inline
// <script>, so the Content-Security-Policy can forbid inline scripts. Shared with the server's pages (/ui/theme.js).
try {
    if (localStorage.getItem('shipscope-theme') === 'light') document.documentElement.setAttribute('data-theme', 'light');
} catch (e) { /* storage blocked: keep the default */ }
