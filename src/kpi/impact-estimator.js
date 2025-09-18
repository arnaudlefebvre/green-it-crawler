import { round2, round4 } from '../utils/file-helpers.js'

// French energy mix data (2023)
const FRANCE_ENERGY_MIX = {
  // CO2 intensity: France has one of the lowest in Europe due to nuclear power
  grid_g_per_kWh: 55, // gCO2eq/kWh (RTE 2023 data)
  // Water consumption for French electricity mix
  water_L_per_kWh: 1.8, // L/kWh (lower than global average due to nuclear efficiency)
  // Data transfer energy consumption
  kWhPerGB: 0.81 // kWh/GB (SWDM model)
}

export function estimateImpactsFromTransfer(bytes, opts = {}) {
  const GB = bytes / (1024 ** 3)
  
  // Use French energy mix by default, allow override
  const kWhPerGB = opts.kWhPerGB ?? FRANCE_ENERGY_MIX.kWhPerGB
  const grid_g_per_kWh = opts.grid_g_per_kWh ?? FRANCE_ENERGY_MIX.grid_g_per_kWh
  const water_L_per_kWh = opts.water_L_per_kWh ?? FRANCE_ENERGY_MIX.water_L_per_kWh
  
  const energy_kWh = GB * kWhPerGB
  const co2_g = energy_kWh * grid_g_per_kWh
  const water_cl = energy_kWh * water_L_per_kWh * 100 // Convert L to cL
  
  return {
    dataGB: round4(GB),
    energy_kWh: round4(energy_kWh),
    co2_g: round2(co2_g),
    water_cl: round2(water_cl),
    model: 'france-mix-2023'
  }
}

// Impact scoring functions
export function scoreEnvironmentalImpact(impacts, thresholds) {
  const thr = {
    co2_g: thresholds?.co2_g ?? [0.5, 1.0, 2.0, 5.0], // gCO2eq thresholds
    energy_kWh: thresholds?.energy_kWh ?? [0.0006, 0.0012, 0.0025, 0.005], // kWh thresholds
    water_cl: thresholds?.water_cl ?? [0.01, 0.05, 0.1, 0.5], // cL thresholds
    dataGB: thresholds?.dataGB ?? [0.0005, 0.001, 0.002, 0.004] // GB thresholds
  }
  
  function normalizeLowerBetter(value, thresholds) {
    if (value <= thresholds[0]) return 100
    if (value <= thresholds[1]) return 75
    if (value <= thresholds[2]) return 50
    if (value <= thresholds[3]) return 25
    return 0
  }
  
  return {
    co2Score: normalizeLowerBetter(impacts.co2_g, thr.co2_g),
    energyScore: normalizeLowerBetter(impacts.energy_kWh, thr.energy_kWh),
    waterScore: normalizeLowerBetter(impacts.water_cl, thr.water_cl),
    dataScore: normalizeLowerBetter(impacts.dataGB, thr.dataGB)
  }
}

// Environmental impact grade
export function gradeEnvironmentalImpact(impacts, thresholds) {
  const scores = scoreEnvironmentalImpact(impacts, thresholds)
  // Weighted average: CO2 is most important, then energy, then water, then data
  const weights = { co2: 0.4, energy: 0.3, water: 0.2, data: 0.1 }
  const avgScore = (
    scores.co2Score * weights.co2 +
    scores.energyScore * weights.energy +
    scores.waterScore * weights.water +
    scores.dataScore * weights.data
  )
  
  if (avgScore >= 90) return 'A+'
  if (avgScore >= 80) return 'A'
  if (avgScore >= 70) return 'B'
  if (avgScore >= 50) return 'C'
  if (avgScore >= 35) return 'D'
  if (avgScore >= 20) return 'E'
  return 'F'
}

// Get impact status with emoji and label
export function getImpactStatus(value, thresholds, type = 'co2') {
  const score = type === 'co2' ? scoreEnvironmentalImpact({ co2_g: value }, { co2_g: thresholds }).co2Score :
                type === 'energy' ? scoreEnvironmentalImpact({ energy_kWh: value }, { energy_kWh: thresholds }).energyScore :
                type === 'water' ? scoreEnvironmentalImpact({ water_cl: value }, { water_cl: thresholds }).waterScore :
                scoreEnvironmentalImpact({ dataGB: value }, { dataGB: thresholds }).dataScore
  
  if (score >= 90) return { emoji: '🟢', label: 'Excellent', level: 'excellent' }
  if (score >= 80) return { emoji: '🟢', label: 'Très bon', level: 'very-good' }
  if (score >= 70) return { emoji: '🟡', label: 'Bon', level: 'good' }
  if (score >= 50) return { emoji: '🟠', label: 'Moyen', level: 'average' }
  if (score >= 35) return { emoji: '🟠', label: 'Médiocre', level: 'poor' }
  if (score >= 25) return { emoji: '🔴', label: 'Mauvais', level: 'bad' }
  return { emoji: '🔴', label: 'Très mauvais', level: 'very-bad' }
}