/**
 * Publish script that bumps version, publishes to marketplace, and commits the bump.
 *
 * Usage:
 *   node scripts/publish.js patch
 *   node scripts/publish.js minor
 *   node scripts/publish.js major
 *
 * Requires VSCE_PAT env var or will attempt interactive auth.
 */

const { execSync } = require('child_process');
const { readFileSync } = require('path');

const bump = process.argv[2] || 'patch';
if (!['patch', 'minor', 'major'].includes(bump)) {
    console.error(`Invalid bump type: "${bump}". Use patch, minor, or major.`);
    process.exit(1);
}

function run(cmd, opts = {}) {
    console.log(`> ${cmd}`);
    execSync(cmd, { stdio: 'inherit', ...opts });
}

// 1. Bump version in package.json (no git tag)
run(`npm version ${bump} --no-git-tag-version`);

// Read new version
const pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf8'));
const version = pkg.version;
console.log(`\nVersion bumped to ${version}\n`);

// 2. Publish (prepublish hook will compile)
const pat = process.env.VSCE_PAT || '';
const patArg = pat ? ` -p ${pat}` : '';
run(`npx @vscode/vsce publish --no-git-tag-version${patArg}`);

// 3. Commit and push the version bump
run('git add package.json package-lock.json');
run(`git commit -m "chore: bump version to ${version}"`);
run('git push');

console.log(`\nPublished v${version} and pushed version bump.`);
