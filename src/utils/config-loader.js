import fs from 'fs'
import * as yaml from 'yaml'

export function loadConfig(configPath) {
  const cfgText = fs.readFileSync(configPath, 'utf8')
  return yaml.parse(cfgText) || {}
}

export function toCsvRow(obj, headers) {
  return headers.map(h => JSON.stringify(obj[h] ?? '')).join(',')
}