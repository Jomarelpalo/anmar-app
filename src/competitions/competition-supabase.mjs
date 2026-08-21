const TABLES = Object.freeze({
  competitions: 'competitions',
  organizers: 'competition_organizers',
  teams: 'competition_teams',
  courts: 'competition_courts',
  slots: 'competition_slots',
  matches: 'competition_matches',
  publications: 'competition_publications',
});

export class CompetitionRepositoryError extends Error {
  constructor(message, cause, step) {
    super(message);
    this.name = 'CompetitionRepositoryError';
    this.cause = cause || null;
    this.step = step || 'unknown';
  }
}

function assertClient(client) {
  if (!client || typeof client.from !== 'function' || typeof client.rpc !== 'function') {
    throw new CompetitionRepositoryError('No existe una conexión válida con Supabase.', null, 'client');
  }
}

function asError(result, message, step) {
  if (result?.error) throw new CompetitionRepositoryError(message, result.error, step);
  return result?.data ?? null;
}

function normalizeSlug(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function createId(factory) {
  const id = factory();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new CompetitionRepositoryError('No se pudo crear un identificador seguro.', null, 'uuid');
  }
  return id;
}

export function createCompetitionBundle(input, options = {}) {
  const uuid = options.uuid || (() => crypto.randomUUID());
  const userId = String(options.userId || '');
  if (!userId) throw new CompetitionRepositoryError('La sesión no identifica al creador.', null, 'identity');
  const slug = normalizeSlug(input?.slug || input?.name);
  if (!slug) throw new CompetitionRepositoryError('La dirección pública no es válida.', null, 'slug');

  const competitionId = createId(uuid);
  const teamIds = new Map((input.teams || []).map((team) => [team.id, createId(uuid)]));
  const courtIds = new Map((input.courts || []).map((court) => [court.id, createId(uuid)]));
  const slotIds = new Map((input.slots || []).map((slot) => [slot.id, createId(uuid)]));

  return {
    competition: {
      id: competitionId,
      club_id: options.clubId || null,
      created_by: userId,
      name: String(input.name || '').trim(),
      public_slug: slug,
      format: 'round_robin_single',
      state: 'draft',
      category: String(input.category || 'custom'),
      period_count: Number(input.periodCount || 4),
      period_minutes: Number(input.periodMinutes || 10),
      match_minutes: Number(input.matchMinutes),
      min_rest_minutes: Number(input.minRestMinutes),
      win_points: Number(input.scoring?.win),
      loss_points: Number(input.scoring?.loss),
    },
    teams: input.teams.map((team) => ({
      id: teamIds.get(team.id),
      competition_id: competitionId,
      source_team_id: team.sourceTeamId || null,
      public_name: String(team.name || '').trim(),
    })),
    courts: input.courts.map((court) => ({
      id: courtIds.get(court.id),
      competition_id: competitionId,
      public_name: String(court.name || '').trim(),
      public_venue: String(court.venue || '').trim() || null,
    })),
    slots: input.slots.map((slot) => ({
      id: slotIds.get(slot.id),
      competition_id: competitionId,
      court_id: courtIds.get(slot.courtId),
      starts_at: new Date(slot.start).toISOString(),
    })),
    matches: (options.schedule || []).map((match) => ({
      id: createId(uuid),
      competition_id: competitionId,
      round_number: Number(match.round),
      home_team_id: teamIds.get(match.homeTeamId),
      away_team_id: teamIds.get(match.awayTeamId),
      slot_id: slotIds.get(match.slotId),
      status: 'scheduled',
      home_score: null,
      away_score: null,
      validated_by: null,
      validated_at: null,
    })),
  };
}

async function upsertRows(client, table, rows, step) {
  if (!rows.length) return;
  const result = await client.from(table).upsert(rows, { onConflict: 'id' });
  asError(result, `No se pudo guardar ${step}.`, step);
}

export async function saveCompetitionBundle(client, bundle) {
  assertClient(client);
  await upsertRows(client, TABLES.competitions, [bundle.competition], 'el campeonato');
  await upsertRows(client, TABLES.teams, bundle.teams, 'los equipos');
  await upsertRows(client, TABLES.courts, bundle.courts, 'las pistas');
  await upsertRows(client, TABLES.slots, bundle.slots, 'los horarios');
  await upsertRows(client, TABLES.matches, bundle.matches, 'los partidos');
  return bundle.competition.id;
}

export async function listCompetitions(client) {
  assertClient(client);
  const result = await client.from(TABLES.competitions)
    .select('id,name,public_slug,state,club_id,match_minutes,min_rest_minutes,win_points,loss_points,updated_at')
    .order('updated_at', { ascending: false });
  return asError(result, 'No se pudieron cargar los campeonatos autorizados.', 'list') || [];
}

export async function loadCompetition(client, competitionId) {
  assertClient(client);
  const id = String(competitionId || '');
  const [competition, teams, courts, slots, matches, publications] = await Promise.all([
    client.from(TABLES.competitions).select('*').eq('id', id).maybeSingle(),
    client.from(TABLES.teams).select('id,competition_id,public_name,source_team_id').eq('competition_id', id).order('public_name'),
    client.from(TABLES.courts).select('id,competition_id,public_name,public_venue').eq('competition_id', id).order('public_name'),
    client.from(TABLES.slots).select('id,competition_id,court_id,starts_at').eq('competition_id', id).order('starts_at'),
    client.from(TABLES.matches).select('id,competition_id,round_number,home_team_id,away_team_id,slot_id,status,home_score,away_score,validated_by,validated_at').eq('competition_id', id),
    client.from(TABLES.publications).select('id,competition_id,slug,version,published_at,withdrawn_at').eq('competition_id', id).order('version', { ascending: false }),
  ]);
  const row = asError(competition, 'No se pudo cargar el campeonato.', 'load_competition');
  if (!row) throw new CompetitionRepositoryError('El campeonato no existe o no está autorizado.', null, 'load_competition');
  return {
    competition: row,
    teams: asError(teams, 'No se pudieron cargar los equipos.', 'load_teams') || [],
    courts: asError(courts, 'No se pudieron cargar las pistas.', 'load_courts') || [],
    slots: asError(slots, 'No se pudieron cargar los horarios.', 'load_slots') || [],
    matches: asError(matches, 'No se pudieron cargar los partidos.', 'load_matches') || [],
    publications: asError(publications, 'No se pudieron cargar las publicaciones.', 'load_publications') || [],
  };
}

export async function saveMatchResult(client, matchId, result, userId) {
  assertClient(client);
  const validated = result.status === 'validated';
  const payload = {
    status: validated ? 'validated' : 'provisional',
    home_score: Number(result.homeScore),
    away_score: Number(result.awayScore),
    validated_by: validated ? userId : null,
    validated_at: validated ? new Date().toISOString() : null,
  };
  const response = await client.from(TABLES.matches).update(payload).eq('id', matchId).select('id').maybeSingle();
  return asError(response, 'No se pudo guardar el resultado.', 'save_result');
}

export async function publishCompetition(client, competitionId) {
  assertClient(client);
  const result = await client.rpc('publish_competition', { p_competition_id: competitionId });
  const rows = asError(result, 'No se pudo publicar el campeonato.', 'publish') || [];
  return Array.isArray(rows) ? rows[0] || null : rows;
}

export async function withdrawCompetition(client, competitionId) {
  assertClient(client);
  const result = await client.rpc('withdraw_competition', { p_competition_id: competitionId });
  return Boolean(asError(result, 'No se pudo retirar la publicación.', 'withdraw'));
}

export async function loadPublicCompetition(client, slugValue) {
  assertClient(client);
  const slug = normalizeSlug(slugValue);
  if (!slug) return null;
  const result = await client.from(TABLES.publications)
    .select('slug,version,published_at,public_payload')
    .eq('slug', slug)
    .maybeSingle();
  const row = asError(result, 'No se pudo consultar la publicación.', 'public_load');
  return row?.public_payload || null;
}

export const competitionTables = TABLES;
