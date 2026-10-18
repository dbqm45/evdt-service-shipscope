#!/usr/bin/env node
// Checks that scripts/, server/, docs/app-*.js and adapters/ stay on their own side of the module boundary
// described in CLAUDE.md (file-based sync vs. SaaS backend vs. classic-<script> frontend).
//   node scripts/check-module-boundaries.js
const path = require('path');
const { findBoundaryViolations } = require('./lib/module-boundaries');

const violations = findBoundaryViolations(path.join(__dirname, '..'));

if (violations.length) {
    console.error('✗ Module boundary violations:');
    for (const v of violations) console.error(`  - ${v.file}:${v.line}: ${v.text}`);
    process.exit(1);
}
console.log('✓ No module boundary violations (scripts/ ↔ server/ ↔ docs/app-*.js, adapters/)');
