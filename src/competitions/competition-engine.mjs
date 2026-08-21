const MINUTE = 60_000;

export class CompetitionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CompetitionError';
    this.code = code;
    this.details = details;
  }
}

const clean = (value) => String(value ?? '').trim();
const normalize = (value) => clean(value).toLocaleLowerCase('es-ES');

function requireUniqueNames(items, label) {
  const seen = new Set();
  for (const item of items) {
    const name = normalize(item.name);
    if (!name) throw new CompetitionError('INVALID_NAME', `Cada ${label} necesita un nombre.`);
    if (seen.has(name)) throw new CompetitionError('DUPLICATE_NAME', `El nombre "${item.name}" está repetido en ${label}.`);
    seen.add(name);
  }
}

function asDate(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new CompetitionError('INVALID_DATE', `${label} no tiene una fecha válida.`);
  return date;
}

export function validateCompetition(input) {
  const competition = structuredClone(input);
  competition.name = clean(competition.name);
  if (!competition.name) throw new CompetitionError('MISSING_NAME', 'El campeonato necesita un nombre.');
  if (!Array.isArray(competition.teams) || competition.teams.length < 2) {
    throw new CompetitionError('NOT_ENOUGH_TEAMS', 'Se necesitan al menos dos equipos.');
  }
  if (!Array.isArray(competition.courts) || competition.courts.length < 1) {
    throw new CompetitionError('NO_COURTS', 'Se necesita al menos una pista.');
  }
  if (!Array.isArray(competition.slots) || competition.slots.length < 1) {
    throw new CompetitionError('NO_SLOTS', 'Añade días y horarios disponibles.');
  }
  requireUniqueNames(competition.teams, 'los equipos');
  requireUniqueNames(competition.courts, 'las pistas');

  const teamIds = new Set();
  for (const team of competition.teams) {
    if (!clean(team.id) || teamIds.has(team.id)) throw new CompetitionError('INVALID_TEAM_ID', 'Los equipos necesitan identificadores únicos.');
    teamIds.add(team.id);
  }
  const courtIds = new Set();
  for (const court of competition.courts) {
    if (!clean(court.id) || courtIds.has(court.id)) throw new CompetitionError('INVALID_COURT_ID', 'Las pistas necesitan identificadores únicos.');
    courtIds.add(court.id);
  }

  competition.matchMinutes = Number(competition.matchMinutes);
  competition.minRestMinutes = Number(competition.minRestMinutes);
  if (!Number.isFinite(competition.matchMinutes) || competition.matchMinutes < 1) {
    throw new CompetitionError('INVALID_DURATION', 'La duración del partido debe ser mayor que cero.');
  }
  if (!Number.isFinite(competition.minRestMinutes) || competition.minRestMinutes < 0) {
    throw new CompetitionError('INVALID_REST', 'El descanso mínimo no puede ser negativo.');
  }

  const slotIds = new Set();
  for (const slot of competition.slots) {
    if (!clean(slot.id) || slotIds.has(slot.id)) throw new CompetitionError('INVALID_SLOT_ID', 'Las franjas necesitan identificadores únicos.');
    slotIds.add(slot.id);
    if (!courtIds.has(slot.courtId)) throw new CompetitionError('UNKNOWN_COURT', 'Una franja utiliza una pista inexistente.');
    asDate(slot.start, 'Una franja');
  }
  const simultaneousCourt = new Set();
  for (const slot of competition.slots) {
    const key = `${slot.courtId}|${asDate(slot.start, 'Una franja').toISOString()}`;
    if (simultaneousCourt.has(key)) throw new CompetitionError('DUPLICATE_SLOT', 'Una pista tiene dos franjas a la misma hora.');
    simultaneousCourt.add(key);
  }

  const scoring = competition.scoring ?? {};
  for (const field of ['win', 'loss']) {
    if (!Number.isFinite(Number(scoring[field]))) {
      throw new CompetitionError('INVALID_SCORING', 'Indica los puntos de clasificación por victoria y derrota.');
    }
  }
  competition.scoring = { win: Number(scoring.win), loss: Number(scoring.loss) };
  return competition;
}

export function createRoundRobinPairs(teams) {
  const participants = teams.map((team) => team.id);
  if (participants.length % 2) participants.push(null);
  const fixed = participants[0];
  let rotating = participants.slice(1);
  const rounds = [];

  for (let round = 0; round < participants.length - 1; round += 1) {
    const row = [fixed, ...rotating];
    const pairs = [];
    for (let index = 0; index < row.length / 2; index += 1) {
      const left = row[index];
      const right = row[row.length - 1 - index];
      if (left && right) {
        const swap = (round + index) % 2 === 1;
        pairs.push({ homeTeamId: swap ? right : left, awayTeamId: swap ? left : right });
      }
    }
    rounds.push(pairs);
    rotating = [rotating.at(-1), ...rotating.slice(0, -1)];
  }
  return rounds;
}

function hasTeamConflict(assignments, match, slot, durationMinutes, restMinutes) {
  const start = asDate(slot.start, 'Una franja').getTime();
  const end = start + durationMinutes * MINUTE;
  return assignments.some((assigned) => {
    const sharesTeam = [match.homeTeamId, match.awayTeamId].some((id) => id === assigned.homeTeamId || id === assigned.awayTeamId);
    if (!sharesTeam) return false;
    const assignedStart = asDate(assigned.start, 'Un partido').getTime();
    const assignedEnd = assignedStart + durationMinutes * MINUTE;
    return start < assignedEnd + restMinutes * MINUTE && assignedStart < end + restMinutes * MINUTE;
  });
}

export function generateSchedule(input) {
  const competition = validateCompetition(input);
  const rounds = createRoundRobinPairs(competition.teams);
  const matches = rounds.flatMap((pairs, roundIndex) => pairs.map((pair, pairIndex) => ({
    id: `match-${roundIndex + 1}-${pairIndex + 1}`,
    round: roundIndex + 1,
    ...pair,
    status: 'scheduled',
  })));
  const slots = competition.slots
    .map((slot) => ({ ...slot, timestamp: asDate(slot.start, 'Una franja').getTime() }))
    .sort((a, b) => a.timestamp - b.timestamp || a.courtId.localeCompare(b.courtId));
  if (slots.length < matches.length) {
    throw new CompetitionError('INSUFFICIENT_CAPACITY', `Faltan ${matches.length - slots.length} franjas para programar todos los partidos.`, {
      matches: matches.length,
      slots: slots.length,
    });
  }

  const usedSlots = new Set();
  const assignments = [];
  let explored = 0;
  const maxExplored = 250_000;

  function place(index) {
    if (index === matches.length) return true;
    if (explored > maxExplored) return false;
    const match = matches[index];
    for (const slot of slots) {
      explored += 1;
      if (usedSlots.has(slot.id)) continue;
      if (hasTeamConflict(assignments, match, slot, competition.matchMinutes, competition.minRestMinutes)) continue;
      usedSlots.add(slot.id);
      assignments.push({ ...match, slotId: slot.id, courtId: slot.courtId, start: new Date(slot.timestamp).toISOString() });
      if (place(index + 1)) return true;
      assignments.pop();
      usedSlots.delete(slot.id);
    }
    return false;
  }

  if (!place(0)) {
    throw new CompetitionError(
      'NO_VALID_SCHEDULE',
      'No existe un calendario válido con las franjas y el descanso indicados. Añade horarios, pistas o reduce el descanso mínimo.',
      { matches: matches.length, slots: slots.length, explored },
    );
  }
  return assignments.sort((a, b) => a.start.localeCompare(b.start) || a.courtId.localeCompare(b.courtId));
}

export function setMatchResult(schedule, matchId, homeScore, awayScore, validated = false) {
  const home = Number(homeScore);
  const away = Number(awayScore);
  if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0) {
    throw new CompetitionError('INVALID_SCORE', 'Los marcadores deben ser números enteros iguales o mayores que cero.');
  }
  if (home === away) throw new CompetitionError('TIED_SCORE', 'Este primer formato de baloncesto necesita un ganador; revisa el marcador.');
  let found = false;
  const updated = schedule.map((match) => {
    if (match.id !== matchId) return { ...match };
    found = true;
    return { ...match, homeScore: home, awayScore: away, status: validated ? 'validated' : 'provisional' };
  });
  if (!found) throw new CompetitionError('UNKNOWN_MATCH', 'No se encontró el partido indicado.');
  return updated;
}

export function calculateStandings(competition, schedule) {
  const valid = validateCompetition(competition);
  const rows = new Map(valid.teams.map((team) => [team.id, {
    teamId: team.id,
    teamName: team.name,
    played: 0,
    wins: 0,
    losses: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    difference: 0,
    competitionPoints: 0,
  }]));
  for (const match of schedule.filter((item) => item.status === 'validated')) {
    const home = rows.get(match.homeTeamId);
    const away = rows.get(match.awayTeamId);
    if (!home || !away) throw new CompetitionError('UNKNOWN_TEAM', 'Un resultado contiene un equipo que no pertenece al campeonato.');
    home.played += 1;
    away.played += 1;
    home.pointsFor += match.homeScore;
    home.pointsAgainst += match.awayScore;
    away.pointsFor += match.awayScore;
    away.pointsAgainst += match.homeScore;
    const homeWins = match.homeScore > match.awayScore;
    home.wins += homeWins ? 1 : 0;
    home.losses += homeWins ? 0 : 1;
    away.wins += homeWins ? 0 : 1;
    away.losses += homeWins ? 1 : 0;
    home.competitionPoints += homeWins ? valid.scoring.win : valid.scoring.loss;
    away.competitionPoints += homeWins ? valid.scoring.loss : valid.scoring.win;
  }
  return [...rows.values()]
    .map((row) => ({ ...row, difference: row.pointsFor - row.pointsAgainst }))
    .sort((a, b) => b.competitionPoints - a.competitionPoints || b.difference - a.difference || b.pointsFor - a.pointsFor || a.teamName.localeCompare(b.teamName, 'es'))
    .map((row, index) => ({ ...row, position: index + 1, tieBreaker: 'Puntos, diferencia y puntos a favor' }));
}

export function createPublicProjection(competition, schedule, publication) {
  const valid = validateCompetition(competition);
  const teamNames = new Map(valid.teams.map((team) => [team.id, team.name]));
  const courtNames = new Map(valid.courts.map((court) => [court.id, { name: court.name, venue: clean(court.venue) }]));
  return {
    schemaVersion: 1,
    slug: clean(publication.slug),
    version: Number(publication.version),
    publishedAt: new Date(publication.publishedAt).toISOString(),
    competition: { name: valid.name, status: clean(publication.status || 'Publicado') },
    teams: valid.teams.map((team) => ({ id: team.id, name: team.name })),
    courts: valid.courts.map((court) => ({ id: court.id, name: court.name, venue: clean(court.venue) })),
    matches: schedule.map((match) => ({
      id: match.id,
      round: match.round,
      start: match.start,
      court: courtNames.get(match.courtId),
      homeTeam: { id: match.homeTeamId, name: teamNames.get(match.homeTeamId) },
      awayTeam: { id: match.awayTeamId, name: teamNames.get(match.awayTeamId) },
      status: match.status,
      homeScore: Number.isInteger(match.homeScore) ? match.homeScore : null,
      awayScore: Number.isInteger(match.awayScore) ? match.awayScore : null,
    })),
    standings: calculateStandings(valid, schedule),
  };
}
