'use strict'
const fs   = require('fs')
const path = require('path')

const FILE = path.join(__dirname, '..', 'settings.json')

function load() {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) }
    catch { return {} }
}

function save(data) {
    try { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)) } catch {}
}

function get(key, defaultValue) {
    const val = load()[key]
    return val !== undefined ? val : defaultValue
}

function set(key, value) {
    const data = load()
    data[key]  = value
    save(data)
}

module.exports = { get, set, load, save }
