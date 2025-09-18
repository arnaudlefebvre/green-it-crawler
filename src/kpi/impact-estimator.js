import { round2, round4 } from '../utils/file-helpers.js'

export function estimateImpactsFromTransfer(bytes, opts = {}) {
  const GB = bytes / (1024 ** 3)
  const kWhPerGB = (opts.kWhPerGB ?? 0.81)
  const grid_g_per_kWh = (opts.grid_g_per_kWh ?? 442)
  const water_L_per_kWh = (opts.water_L_per_kWh ?? 1.9)
  const energy_kWh = GB * kWhPerGB
  const co2_g = energy_kWh * grid_g_per_kWh
  const water_cl = energy_kWh * water_L_per_kWh * 100
  return {
    dataGB: round4(GB),
    energy_kWh: round4(energy_kWh),
    co2_g: round2(co2_g),
    water_cl: round2(water_cl),
    model: 'swdm'
  }
}