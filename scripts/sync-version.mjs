// 将 package.json 的版本号同步到 Cargo.toml / Cargo.lock / tauri.conf.json
// 由 `pnpm version` 的 version 生命周期钩子自动调用
import { readFileSync, writeFileSync } from 'node:fs'

const version = JSON.parse(readFileSync('package.json', 'utf8')).version

// Cargo.toml
let cargo = readFileSync('src-tauri/Cargo.toml', 'utf8')
cargo = cargo.replace(/^version = ".*"$/m, `version = "${version}"`)
writeFileSync('src-tauri/Cargo.toml', cargo)

// Cargo.lock（dbflow 自身条目）
let lock = readFileSync('src-tauri/Cargo.lock', 'utf8')
lock = lock.replace(/(name = "dbflow"\nversion = ")[^"]*(")/, `$1${version}$2`)
writeFileSync('src-tauri/Cargo.lock', lock)

// tauri.conf.json
let conf = readFileSync('src-tauri/tauri.conf.json', 'utf8')
conf = conf.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`)
writeFileSync('src-tauri/tauri.conf.json', conf)

console.log(`✓ 版本号已同步到 Cargo.toml / Cargo.lock / tauri.conf.json: ${version}`)
