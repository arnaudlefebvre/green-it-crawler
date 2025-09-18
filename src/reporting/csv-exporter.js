import fs from 'fs'
import { toCsvRow } from '../utils/config-loader.js'

export function appendToHistory(historyPath, result) {
  fs.appendFileSync(historyPath, JSON.stringify(result) + '\n')
}

export function appendToCsv(csvPath, result) {
  const headers = Object.keys(result)
  if (!fs.existsSync(csvPath) || fs.readFileSync(csvPath, 'utf8').trim() === '') {
    fs.writeFileSync(csvPath, headers.join(',') + '\n')
  }
  fs.appendFileSync(csvPath, toCsvRow(result, headers) + '\n')
}