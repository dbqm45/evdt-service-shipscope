// The theme the dashboard's toggle saved (docs/app-core.js), applied before the page paints.
try {
    if (localStorage.getItem('shipscope-theme') === 'light') document.documentElement.setAttribute('data-theme', 'light');
} catch (e) { /* storage blocked: keep the default */ }
