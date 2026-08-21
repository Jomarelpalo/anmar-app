export const COMPETITION_RULE_PRESETS = Object.freeze({
  premini: Object.freeze({ label: 'Preminibasket', periodLabel: 'periodos', periodCount: 6, periodMinutes: 8, courtMinutes: 60 }),
  mini: Object.freeze({ label: 'Minibasket', periodLabel: 'periodos', periodCount: 6, periodMinutes: 8, courtMinutes: 60 }),
  infantil: Object.freeze({ label: 'Infantil', periodLabel: 'cuartos', periodCount: 4, periodMinutes: 10, courtMinutes: 90 }),
  cadete: Object.freeze({ label: 'Cadete', periodLabel: 'cuartos', periodCount: 4, periodMinutes: 10, courtMinutes: 90 }),
  junior: Object.freeze({ label: 'Júnior', periodLabel: 'cuartos', periodCount: 4, periodMinutes: 10, courtMinutes: 90 }),
  senior: Object.freeze({ label: 'Sénior', periodLabel: 'cuartos', periodCount: 4, periodMinutes: 10, courtMinutes: 90 }),
  custom: Object.freeze({ label: 'Otro / personalizado', periodLabel: 'periodos', periodCount: 4, periodMinutes: 10, courtMinutes: 90 }),
});

export function competitionRulePreset(category) {
  return COMPETITION_RULE_PRESETS[category] || COMPETITION_RULE_PRESETS.custom;
}

export function competitionRuleSummary(category, periodCount, periodMinutes) {
  const preset = competitionRulePreset(category);
  const count = Number(periodCount);
  const minutes = Number(periodMinutes);
  const label = count === 4 && preset.periodLabel === 'cuartos' ? 'cuartos' : 'periodos';
  return `${count} ${label} × ${minutes} min`;
}
