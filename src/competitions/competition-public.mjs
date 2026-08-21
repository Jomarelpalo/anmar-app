import { loadPublicCompetition } from './competition-supabase.mjs';

const text = (tag, value, className = '') => {
  const node = document.createElement(tag);
  node.textContent = String(value ?? '');
  if (className) node.className = className;
  return node;
};

export function validatePublicPayload(payload) {
  if (!payload || payload.schemaVersion !== 1 || !payload.competition?.name) return false;
  if (!Array.isArray(payload.teams) || !Array.isArray(payload.courts) || !Array.isArray(payload.matches) || !Array.isArray(payload.standings)) return false;
  const serialized = JSON.stringify(payload);
  return !/email|phone|telefono|fecha_nacimiento|lesion|avatar|created_by|assigned_by|source_team|validated_by/i.test(serialized);
}

function formatDate(value, options = { dateStyle: 'medium', timeStyle: 'short' }) {
  return new Intl.DateTimeFormat('es-ES', options).format(new Date(value));
}

export function renderPublicCompetition(root, payload) {
  if (!validatePublicPayload(payload)) throw new Error('La publicación recibida no cumple el contrato público.');
  root.replaceChildren();

  const hero = document.createElement('header');
  hero.className = 'hero';
  const heroInner = document.createElement('div');
  heroInner.className = 'wrap';
  heroInner.append(
    text('div', `ANMAR TRAINING · VERSIÓN ${payload.version}`, 'eyebrow'),
    text('h1', payload.competition.name),
    text('p', payload.competition.status || 'Calendario publicado', 'hero-status'),
  );
  hero.append(heroInner);

  const main = document.createElement('main');
  main.className = 'wrap';
  const controls = document.createElement('section');
  controls.className = 'filters card';
  const days = [...new Set(payload.matches.map((match) => String(match.start).slice(0, 10)))];
  const makeSelect = (label, id, first, rows, value, name) => {
    const box = document.createElement('label');
    box.textContent = label;
    const select = document.createElement('select');
    select.id = id;
    const initial = text('option', first);
    initial.value = '';
    select.append(initial);
    rows.forEach((row) => {
      const option = text('option', name(row));
      option.value = value(row);
      select.append(option);
    });
    box.append(select);
    return box;
  };
  controls.append(
    makeSelect('Día', 'public-day', 'Todos los días', days, (day) => day, (day) => formatDate(`${day}T12:00:00`, { dateStyle: 'full' })),
    makeSelect('Equipo', 'public-team', 'Todos los equipos', payload.teams, (team) => team.id, (team) => team.name),
    makeSelect('Pista', 'public-court', 'Todas las pistas', payload.courts, (court) => court.id, (court) => court.name),
  );

  const scheduleTitle = text('h2', 'Calendario y resultados');
  const matchList = document.createElement('section');
  matchList.id = 'public-match-list';
  const standingsTitle = text('h2', 'Clasificación');
  const tableWrap = document.createElement('div');
  tableWrap.className = 'table-wrap card';
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Pos.','Equipo','PJ','V','D','PF','PC','Dif.','Puntos'].forEach((label) => headRow.append(text('th', label)));
  head.append(headRow);
  const body = document.createElement('tbody');
  payload.standings.forEach((row) => {
    const tr = document.createElement('tr');
    [row.position,row.teamName,row.played,row.wins,row.losses,row.pointsFor,row.pointsAgainst,row.difference,row.competitionPoints]
      .forEach((value) => tr.append(text('td', value)));
    body.append(tr);
  });
  table.append(head, body);
  tableWrap.append(table);
  const updated = text('p', `Última actualización: ${formatDate(payload.publishedAt)}`, 'updated');
  main.append(controls, scheduleTitle, matchList, standingsTitle, tableWrap, updated);
  root.append(hero, main);

  const renderMatches = () => {
    const day = root.querySelector('#public-day').value;
    const team = root.querySelector('#public-team').value;
    const court = root.querySelector('#public-court').value;
    const filtered = payload.matches.filter((match) =>
      (!day || String(match.start).startsWith(day))
      && (!team || match.homeTeam.id === team || match.awayTeam.id === team)
      && (!court || match.court?.id === court)
    );
    matchList.replaceChildren();
    if (!filtered.length) {
      matchList.append(text('div', 'No hay partidos para estos filtros.', 'empty card'));
      return;
    }
    filtered.forEach((match) => {
      const article = document.createElement('article');
      article.className = 'match card';
      const when = document.createElement('div');
      when.append(text('time', formatDate(match.start), 'match-time'), text('span', match.court?.name || '', 'match-place'));
      const teams = document.createElement('div');
      teams.append(text('strong', match.homeTeam.name), text('span', ' contra '), text('strong', match.awayTeam.name));
      const scoreValue = Number.isInteger(match.homeScore) ? `${match.homeScore} – ${match.awayScore}` : 'Pendiente';
      const score = text('div', scoreValue, `match-score ${match.status || ''}`);
      article.append(when, teams, score);
      matchList.append(article);
    });
  };
  controls.querySelectorAll('select').forEach((select) => select.addEventListener('change', renderMatches));
  renderMatches();
}

export async function bootPublicCompetitionPage({ root, client, slug }) {
  if (!slug) {
    root.replaceChildren(text('div', 'Falta la dirección del campeonato.', 'public-message'));
    return null;
  }
  try {
    const payload = await loadPublicCompetition(client, slug);
    if (!payload) {
      root.replaceChildren(text('div', 'Este campeonato no está publicado o ha sido retirado.', 'public-message'));
      return null;
    }
    renderPublicCompetition(root, payload);
    return payload;
  } catch {
    root.replaceChildren(text('div', 'No se pudo cargar el campeonato. Inténtalo de nuevo.', 'public-message'));
    return null;
  }
}
