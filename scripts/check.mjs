#!/usr/bin/env node
/**
 * Repository checks that run anywhere: plain Node, no DSH, no Windows.
 *
 * The behavioural harnesses live in `_test/` on the authoring machine, because
 * they drive the real plugin through the real DSH runtime and a real Windows
 * toast. What is left for CI is everything that can be decided from the files
 * alone: manifest integrity, syntax, locale completeness, ASCII-only PowerShell
 * scripts (Windows PowerShell 5.1 reads ANSI unless there is a BOM), and the
 * market index matching the package version.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
let checks = 0

function check(name, run) {
  checks += 1
  try {
    const detail = run()
    console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`FAIL ${name} — ${error.message}`)
  }
}

function need(condition, message) {
  if (!condition) throw new Error(message)
}

function readJson(path) {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8'))
}

function readText(path) {
  return readFileSync(join(ROOT, path), 'utf8')
}

function exists(path) {
  try {
    statSync(join(ROOT, path))
    return true
  } catch {
    return false
  }
}

const pkg = readJson('package.json')

check('package.json is valid and named', () => {
  need(typeof pkg.name === 'string' && pkg.name.length > 0, 'missing name')
  need(/^\d+\.\d+\.\d+/.test(pkg.version), `bad version: ${pkg.version}`)
  need(pkg.type === 'module', 'must stay an ES module')
  return `${pkg.name}@${pkg.version}`
})

check('DSH manifest points at real files', () => {
  need(pkg.dsh?.bundle?.patch, 'dsh.bundle.patch is missing')
  need(exists(pkg.dsh.bundle.patch), `${pkg.dsh.bundle.patch} does not exist`)
  need(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform must be web')
  const inject = pkg.dsh.client.inject || []
  need(inject.length > 0, 'dsh.client.inject is empty')
  for (const file of ['index.js', 'client.js', 'icon.svg', 'LICENSE']) {
    need(exists(file), `${file} is missing`)
  }
  return `${Object.keys(pkg.dsh.compatibility?.dshReleases || {}).join(', ') || 'no compatibility map'}`
})

check('cordis patch matches the package name', () => {
  const patch = readText(pkg.dsh.bundle.patch)
  need(patch.includes(`name: ${pkg.name}`), `cordis.patch.yml does not mention ${pkg.name}`)
  need(/insert:/.test(patch), 'cordis.patch.yml has no insert')
  return 'insert found'
})

check('entry points parse', () => {
  for (const file of ['index.js', 'client.js', 'scripts/check.mjs', 'scripts/release.mjs']) {
    const result = spawnSync(process.execPath, ['--check', join(ROOT, file)], { encoding: 'utf8' })
    need(result.status === 0, `${file}: ${(result.stderr || '').trim().split('\n')[0]}`)
  }
  return 'index.js, client.js, scripts'
})

check('locale files are complete', () => {
  const dir = join(ROOT, 'locale')
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
  need(files.length >= 2, 'expected at least zh.json and en.json')
  for (const file of files) {
    const meta = JSON.parse(readFileSync(join(dir, file), 'utf8')).meta
    need(meta && meta.title && meta.description, `${file} is missing meta.title or meta.description`)
  }
  return files.join(', ')
})

check('PowerShell scripts are ASCII only', () => {
  // Windows PowerShell 5.1 falls back to the ANSI code page unless the file
  // carries a BOM, and a mis-read script fails with unrelated syntax errors.
  for (const file of ['toast.ps1', 'jump.ps1']) {
    const bytes = readFileSync(join(ROOT, file))
    const text = bytes.toString('latin1')
    need(!/[^\x00-\x7f]/.test(text), `${file} contains non-ASCII bytes`)
  }
  const launcher = readText('launch.vbs')
  need(launcher.includes('WScript.Arguments'), 'launch.vbs does not read its argument')
  return 'toast.ps1, jump.ps1, launch.vbs'
})

check('bundled sounds are present', () => {
  const dir = join(ROOT, 'sounds')
  const files = readdirSync(dir).filter((name) => name.endsWith('.mp3'))
  need(files.length >= 8, `expected 8 bundled sounds, found ${files.length}`)
  const index = readText('index.js')
  for (const file of files) {
    need(index.includes(file), `index.js does not reference ${file}`)
  }
  return `${files.length} files`
})

check('market idx matches the package version', () => {
  if (!exists('market/index.json')) return 'no market/index.json in this repo'
  const index = readJson('market/index.json')
  const plugin = index.plugins.find((entry) => entry.name === pkg.name)
  need(plugin, `market index does not list ${pkg.name}`)
  const version = plugin.versions[0]
  need(version.version === pkg.version, `index says ${version.version}, package says ${pkg.version}`)
  need(version.source.type === 'npm', 'index entry must publish through npm')

  if (exists('market/index-git.json')) {
    const gitIndex = readJson('market/index-git.json')
    const gitPlugin = gitIndex.plugins.find((entry) => entry.name === pkg.name)
    need(gitPlugin, `market/index-git.json does not list ${pkg.name}`)
    const gitVersion = gitPlugin.versions[0]
    need(gitVersion.version === pkg.version, `git index says ${gitVersion.version}, package says ${pkg.version}`)
    need(gitVersion.source.type === 'git', 'git index entry must install from git')
    need(
      typeof gitVersion.source.commit === 'string' && /^[0-9a-f]{40}$/.test(gitVersion.source.commit),
      'git index needs a full 40-char commit',
    )
  }

  return `${plugin.name}@${version.version}`
})

check('files list covers everything the plugin loads at runtime', () => {
  const files = pkg.files || []
  for (const needed of ['index.js', 'client.js', 'toast.ps1', 'jump.ps1', 'launch.vbs', 'cordis.patch.yml', 'icon.svg']) {
    need(files.includes(needed), `package.json files[] is missing ${needed}`)
  }
  need(files.some((entry) => entry.startsWith('locale/')), 'files[] is missing locale')
  need(files.some((entry) => entry.startsWith('sounds/')), 'files[] is missing sounds')
  return `${files.length} entries`
})

console.log(`\n${checks - failures.length}/${checks} checks passed`)
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
