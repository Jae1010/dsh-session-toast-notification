#!/usr/bin/env node
/**
 * Bump the version in one place, then propagate it to the market index.
 *
 *   node scripts/release.mjs patch     # 1.0.0 -> 1.0.1
 *   node scripts/release.mjs minor     # 1.0.1 -> 1.1.0
 *   node scripts/release.mjs major     # 1.1.0 -> 2.0.0
 *   node scripts/release.mjs 1.2.3     # explicit version
 *
 * The version is never written by hand in two files: `package.json` is the
 * source of truth, everything else is derived here. Commit the result, then
 * push a matching tag — `.github/workflows/release.yml` publishes to npm when
 * the tag and the version agree.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = join(ROOT, 'package.json')
const INDEX = join(ROOT, 'market', 'index.json')

const bump = (version, kind) => {
  const [major, minor, patch] = version.split('.').map((part) => Number.parseInt(part, 10))
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')

const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
const current = pkg.version
const input = process.argv[2]

if (!input) {
  console.error(`usage: node scripts/release.mjs <patch|minor|major|x.y.z>\ncurrent version: ${current}`)
  process.exit(1)
}

const next = /^\d+\.\d+\.\d+/.test(input) ? input : bump(current, input)
if (next === current) {
  console.error(`version is already ${current}`)
  process.exit(1)
}
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`not a plain semver version: ${next}`)
  process.exit(1)
}

pkg.version = next
writeJson(PKG, pkg)
console.log(`package.json        ${current} -> ${next}`)

let index = null
try {
  index = JSON.parse(readFileSync(INDEX, 'utf8'))
} catch {
  console.log('market/index.json   skipped (not in this checkout)')
}

if (index) {
  const plugin = index.plugins.find((entry) => entry.name === pkg.name)
  if (!plugin) {
    console.error(`market/index.json does not list ${pkg.name}`)
    process.exit(1)
  }
  const stamp = Math.floor(Date.now() / 1000)
  const released = plugin.versions.filter((entry) => entry.version !== next)
  plugin.versions = [
    {
      version: next,
      publishTimestamp: stamp,
      source: { type: 'npm' },
      engines: { dsh: pkg.engines?.dsh },
    },
    ...released,
  ]
  writeJson(INDEX, index)
  console.log(`market/index.json   ${pkg.name}@${next} (publishTimestamp ${stamp})`)
}

const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
if (!changelog.includes(`## ${next}`)) {
  console.log(`\nnote: CHANGELOG.md has no "## ${next}" section yet — add one before tagging.`)
}

console.log(`
next steps
  1. add a "## ${next}" section to CHANGELOG.md (if the note above appeared)
  2. npm run check
  3. git add -A && git commit -m "${next}"
  4. git tag v${next} && git push --tags
     -> .github/workflows/release.yml publishes ${pkg.name}@${next} to npm
`)
