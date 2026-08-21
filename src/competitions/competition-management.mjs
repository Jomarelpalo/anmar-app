import { generateSchedule } from './competition-engine.mjs';
import { COMPETITION_RULE_PRESETS, competitionRulePreset, competitionRuleSummary } from './competition-rules.mjs';
import {
  CompetitionRepositoryError,
  createCompetitionBundle,
  listCompetitions,
  loadCompetition,
  publishCompetition,
  saveCompetitionBundle,
  saveMatchResult,
  withdrawCompetition,
} from './competition-supabase.mjs';

const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => (
  {'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]
));
const slugify = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const lines = (value) => String(value || '').split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
const formatCompetitionDate = (date) => new Intl.DateTimeFormat('es-ES', {
  dateStyle: 'long',
  timeZone: 'UTC',
}).format(new Date(`${date}T00:00:00Z`));
const jsonRows = (value) => {
  try { const rows = JSON.parse(String(value || '[]')); return Array.isArray(rows) ? rows : []; }
  catch { return []; }
};
const timeOptions = () => Array.from({ length: 48 }, (_, index) => {
  const hour = String(Math.floor(index / 2)).padStart(2, '0');
  const minute = index % 2 ? '30' : '00';
  return `${hour}:${minute}`;
});
const friendlyError = (error) => {
  const raw = String(error?.cause?.message || error?.message || '');
  if (/pabellón|pista|disponibilidad/i.test(raw)) return raw;
  if (/aal2|segundo factor|assurance/i.test(raw)) return 'Para publicar o retirar debes confirmar primero el segundo factor desde Administración.';
  if (/duplicate|unique|public_slug/i.test(raw)) return 'Esa dirección pública ya está utilizada. Elige otra.';
  if (/row-level security|permission denied|42501/i.test(raw)) return 'Tu identidad no tiene permiso para esta operación o para este club.';
  return error instanceof CompetitionRepositoryError ? error.message : 'No se pudo completar la operación.';
};

function parseDraft(form) {
  const teams = lines(form.elements.teams.value).map((name, index) => ({ id: `team-${index + 1}`, name }));
  const courtRows = jsonRows(form.elements.courts_data.value);
  const courts = courtRows.map((court, index) => ({ id: `court-${index + 1}`, sourceKey: court.key, name: court.name, venue: court.venue }));
  const courtIds = new Map(courts.map((court) => [court.sourceKey, court.id]));
  const slots = jsonRows(form.elements.slots_data.value).map((slot, index) => ({
    id: `slot-${index + 1}`,
    courtId: courtIds.get(slot.courtKey),
    start: `${slot.date}T${slot.time}:00`,
  }));
  if (!courts.length) throw new Error('Añade al menos una pista y su pabellón.');
  if (!slots.length) throw new Error('Añade al menos una disponibilidad de pista.');
  const name = form.elements.name.value.trim();
  return {
    name,
    slug: slugify(form.elements.slug.value || name),
    format: 'round_robin_single',
    category: form.elements.category.value,
    periodCount: Number(form.elements.period_count.value),
    periodMinutes: Number(form.elements.period_minutes.value),
    matchMinutes: Number(form.elements.court_minutes.value),
    minRestMinutes: Number(form.elements.rest.value),
    scoring: { win: Number(form.elements.win.value), loss: Number(form.elements.loss.value) },
    teams,
    courts,
    slots,
  };
}

function publicUrl(slug) {
  const url = new URL('CAMPEONATO_PUBLICO.html', window.location.href);
  url.searchParams.set('slug', slug);
  return url.href;
}

async function requireAal2(client) {
  if (!client.auth?.mfa?.getAuthenticatorAssuranceLevel) {
    throw new CompetitionRepositoryError('No se pudo comprobar el segundo factor.', null, 'aal2');
  }
  const result = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  if (result.error) throw new CompetitionRepositoryError('No se pudo comprobar el segundo factor.', result.error, 'aal2');
  if (result.data?.currentLevel !== 'aal2') {
    throw new CompetitionRepositoryError('La publicación requiere una sesión aal2.', null, 'aal2');
  }
}

export async function mountCompetitionManager(container, options = {}) {
  const client = options.client;
  if (!container || !client) return;
  const userResult = await client.auth.getUser();
  const user = userResult.data?.user;
  if (!user) {
    container.innerHTML = '<div class="card pr-panel"><div style="color:#ff6b6b">La sesión ya no está disponible. Vuelve a identificarte.</div></div>';
    return;
  }

  const state = { rows: [], selected: null, pendingBundle: null, busy: false };
  const setStatus = (text, ok = false) => {
    const node = container.querySelector('#cmp-status');
    if (!node) return;
    node.textContent = text || '';
    node.style.color = ok ? '#55d59a' : '#ff9b91';
  };

  async function refresh() {
    state.rows = await listCompetitions(client);
    renderHome();
  }

  function renderHome() {
    container.innerHTML = `
      <style>
        .cmp-grid{display:grid;gap:16px}.cmp-library{padding:17px 18px}.cmp-library-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:12px}
        .cmp-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:9px}.cmp-item{width:100%;text-align:left;border:1px solid var(--anmar-form-border);border-radius:10px;padding:12px;background:var(--anmar-form-soft);color:var(--anmar-form-ink);cursor:pointer}
        .cmp-item:hover{border-color:var(--anmar-form-accent);background:var(--anmar-form-bg)}.cmp-item b{display:block}.cmp-item small{color:var(--anmar-form-muted)}
        .cmp-editor-card{padding:18px}.cmp-editor-head{margin-bottom:16px}.cmp-editor-head h3{margin:0;color:var(--anmar-form-ink);font-size:22px}.cmp-editor-head p{margin:6px 0 0;color:var(--anmar-form-muted);font-size:13px}
        .cmp-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.cmp-full{grid-column:1/-1}.cmp-form label{display:block;margin:0}.cmp-form textarea{min-height:94px}
        .cmp-builder-group+.cmp-builder-group{margin-top:18px;padding-top:18px;border-top:1px solid var(--anmar-form-border)}.cmp-builder-title{margin:0 0 10px;color:var(--anmar-form-ink);font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.07em}
        .cmp-builder-row{display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end}.cmp-builder-row .btn{min-height:44px;margin:0;width:auto}.cmp-builder-row-wide{grid-template-columns:2fr auto}.cmp-builder-list{display:grid;gap:6px;margin-top:9px}.cmp-builder-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 11px;border:1px solid var(--anmar-form-border);border-radius:9px;background:var(--anmar-form-soft);color:var(--anmar-form-ink);font-size:12px}.cmp-builder-item button{border:0;background:none;color:var(--anmar-form-danger);cursor:pointer;font-weight:800}
        .cmp-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.cmp-actions .btn{margin:0}.cmp-note{font-size:12px;color:var(--anmar-form-muted);line-height:1.55}.cmp-summary-state{display:inline-flex;padding:4px 8px;border-radius:999px;background:#fff0d5;color:#a96300;font-size:10px;text-transform:uppercase;letter-spacing:.05em}
        .cmp-table{overflow:auto}.cmp-table table{width:100%;border-collapse:collapse;min-width:720px}.cmp-table th,.cmp-table td{padding:9px;border-bottom:1px solid var(--anmar-form-border);text-align:left}.cmp-table input,.cmp-table select{min-height:38px;padding:6px}
        @media(max-width:800px){.cmp-library-head{display:block}.cmp-form-grid{grid-template-columns:1fr}.cmp-full{grid-column:auto}.cmp-builder-row,.cmp-builder-row-wide{grid-template-columns:1fr}.cmp-builder-row .btn{width:100%}.cmp-editor-card{padding:13px}}
      </style>
      <div class="cmp-grid">
        <div class="card pr-panel cmp-library">
          <div class="cmp-library-head"><div><div class="section-t">Campeonatos autorizados</div>
          <p class="cmp-note">RLS muestra únicamente los campeonatos que puedes gestionar. No se cargan jugadores, fotografías ni datos privados.</p>
          </div></div>
          <div class="cmp-list">${state.rows.length ? state.rows.map((row) => `
            <button class="cmp-item" type="button" data-cmp-id="${esc(row.id)}"><b>${esc(row.name)}</b><small>${esc(row.state)} · /${esc(row.public_slug)}</small></button>
          `).join('') : '<div class="cmp-note">Todavía no hay campeonatos visibles para esta identidad.</div>'}</div>
        </div>
        <div class="card pr-panel cmp-editor-card">
          <div class="cmp-editor-head"><h3>Crear campeonato del club</h3><p>Completa la información por secciones y revisa el resumen antes de guardar.</p></div>
          <form id="cmp-create" class="cmp-form" data-anmar-form-kind="complex">
            <div class="anmar-form-shell">
              <div class="anmar-form-main">
                <details class="anmar-form-section" open><summary data-step="1">Datos básicos</summary><div class="anmar-form-section-body cmp-form-grid">
                  <label class="cmp-full">Nombre público<input name="name" required minlength="3" maxlength="120" placeholder="Copa Costa del Sol"></label>
                  <label>Dirección pública<input name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="Se completa desde el nombre"></label>
                  <label>Categoría<select name="category">${Object.entries(COMPETITION_RULE_PRESETS).map(([value, rule]) => `<option value="${value}" ${value === 'mini' ? 'selected' : ''}>${esc(rule.label)}</option>`).join('')}</select></label>
                </div></details>
                <details class="anmar-form-section"><summary data-step="2">Reglas del partido</summary><div class="anmar-form-section-body cmp-form-grid">
                  <label>Número de periodos<input name="period_count" type="number" min="1" max="12" value="6" required></label>
                  <label>Minutos por periodo<input name="period_minutes" type="number" min="1" max="30" value="8" required></label>
                  <label>Tiempo reservado en pista<input name="court_minutes" type="number" min="1" max="300" value="60" required></label>
                  <label>Descanso mínimo<input name="rest" type="number" min="0" max="1440" value="60" required></label>
                  <label>Puntos por victoria<input name="win" type="number" step="0.01" value="2" required></label>
                  <label>Puntos por derrota<input name="loss" type="number" step="0.01" value="1" required></label>
                  <p class="cmp-note cmp-full" id="cmp-rule-note">Sugerencia Minibasket: 6 periodos × 8 min. Puedes editarla porque las bases específicas del torneo o delegación prevalecen. El tiempo reservado en pista incluye paradas y es el que evita solapes.</p>
                </div></details>
                <details class="anmar-form-section" open><summary data-step="3">Pabellones, pistas y fechas</summary><div class="anmar-form-section-body">
                  <div class="cmp-builder-group"><h4 class="cmp-builder-title">Pabellones</h4><div class="cmp-builder-row cmp-builder-row-wide"><label>Nombre del pabellón<input id="cmp-venue-name" placeholder="Pabellón Municipal"></label><button class="btn btn-ghost" id="cmp-add-venue" type="button">Añadir pabellón</button></div><div class="cmp-builder-list" id="cmp-venue-list"></div></div>
                  <div class="cmp-builder-group"><h4 class="cmp-builder-title">Pistas</h4><div class="cmp-builder-row"><label>Pabellón<select id="cmp-court-venue"></select></label><label>Nombre de la pista<input id="cmp-court-name" placeholder="Pista central"></label><button class="btn btn-ghost" id="cmp-add-court" type="button">Añadir pista</button></div><div class="cmp-builder-list" id="cmp-court-list"></div></div>
                  <div class="cmp-builder-group"><h4 class="cmp-builder-title">Fechas del campeonato</h4><div class="cmp-builder-row cmp-builder-row-wide"><label>Selecciona una fecha<input id="cmp-date-value" type="date"></label><button class="btn btn-ghost" id="cmp-add-date" type="button">Añadir fecha</button></div><div class="cmp-builder-list" id="cmp-date-list"></div></div>
                  <div class="cmp-builder-group"><h4 class="cmp-builder-title">Disponibilidad de cada pista</h4><div class="cmp-builder-row"><label>Pista<select id="cmp-slot-court"></select></label><label>Fecha<select id="cmp-slot-date"></select></label><label>Hora<select id="cmp-slot-time">${timeOptions().map((time) => `<option value="${time}">${time}</option>`).join('')}</select></label><button class="btn btn-ghost" id="cmp-add-slot" type="button">Añadir horario</button></div><div class="cmp-builder-list" id="cmp-slot-list"></div></div>
                </div></details>
                <details class="anmar-form-section"><summary data-step="4">Equipos participantes</summary><div class="anmar-form-section-body">
                  <label>Equipos · uno por línea<textarea name="teams" required placeholder="Halcones\nLinces\nBúhos\nOsos"></textarea></label>
                </div></details>
                <details class="anmar-form-section"><summary data-step="5">Revisión y guardado</summary><div class="anmar-form-section-body">
                  <p class="cmp-note">Formato inicial: liga a una vuelta. El calendario se valida antes de guardarse. Si una red inestable interrumpe el proceso, el mismo botón reintenta con los mismos identificadores.</p>
                </div></details>
                <input type="hidden" name="courts_data" value="[]"><input type="hidden" name="slots_data" value="[]">
              </div>
              <aside class="anmar-form-summary" aria-label="Resumen del campeonato"><h3>Resumen del campeonato</h3><dl>
                <div><dt>Nombre</dt><dd id="cmp-summary-name">Sin nombre</dd></div><div><dt>Categoría</dt><dd id="cmp-summary-category">Minibasket</dd></div>
                <div><dt>Equipos</dt><dd id="cmp-summary-teams">0 equipos</dd></div><div><dt>Pistas</dt><dd id="cmp-summary-courts">0 pistas</dd></div>
                <div><dt>Fechas y horarios</dt><dd id="cmp-summary-slots">0 fechas · 0 franjas</dd></div><div><dt>Estado</dt><dd><span class="cmp-summary-state">Borrador</span></dd></div>
              </dl><div class="cmp-actions"><button class="btn btn-primary" type="submit">Generar y guardar borrador</button></div><div id="cmp-status" class="anmar-form-status" role="status"></div></aside>
            </div>
          </form>
        </div>
      </div>`;
    container.querySelectorAll('[data-cmp-id]').forEach((button) => button.addEventListener('click', () => openCompetition(button.dataset.cmpId)));
    const createForm = container.querySelector('#cmp-create');
    const builder = { venues: [], courts: [], dates: [], slots: [], nextCourt: 1 };
    const builderStatus = (message) => setStatus(message);
    const updateSummary = () => {
      const set = (selector, value) => { const node = container.querySelector(selector); if (node) node.textContent = value; };
      const teamCount = lines(createForm.elements.teams.value).length;
      const selectedCategory = createForm.elements.category.selectedOptions?.[0]?.textContent || 'Personalizada';
      set('#cmp-summary-name', createForm.elements.name.value.trim() || 'Sin nombre');
      set('#cmp-summary-category', selectedCategory);
      set('#cmp-summary-teams', `${teamCount} ${teamCount === 1 ? 'equipo' : 'equipos'}`);
      set('#cmp-summary-courts', `${builder.courts.length} ${builder.courts.length === 1 ? 'pista' : 'pistas'}`);
      set('#cmp-summary-slots', `${builder.dates.length} ${builder.dates.length === 1 ? 'fecha' : 'fechas'} · ${builder.slots.length} ${builder.slots.length === 1 ? 'franja' : 'franjas'}`);
    };
    const renderBuilders = () => {
      const previousVenue = container.querySelector('#cmp-court-venue')?.value;
      const previousCourt = container.querySelector('#cmp-slot-court')?.value;
      const previousDate = container.querySelector('#cmp-slot-date')?.value;
      createForm.elements.courts_data.value = JSON.stringify(builder.courts);
      createForm.elements.slots_data.value = JSON.stringify(builder.slots);
      const venueSelect = container.querySelector('#cmp-court-venue');
      venueSelect.innerHTML = builder.venues.length ? builder.venues.map((venue) => `<option value="${esc(venue)}">${esc(venue)}</option>`).join('') : '<option value="">Añade primero un pabellón</option>';
      if (builder.venues.includes(previousVenue)) venueSelect.value = previousVenue;
      const courtSelect = container.querySelector('#cmp-slot-court');
      courtSelect.innerHTML = builder.courts.length ? builder.courts.map((court) => `<option value="${esc(court.key)}">${esc(court.name)} · ${esc(court.venue)}</option>`).join('') : '<option value="">Añade primero una pista</option>';
      if (builder.courts.some((court) => court.key === previousCourt)) courtSelect.value = previousCourt;
      const dateSelect = container.querySelector('#cmp-slot-date');
      dateSelect.innerHTML = builder.dates.length ? builder.dates.map((date) => `<option value="${esc(date)}">${esc(formatCompetitionDate(date))}</option>`).join('') : '<option value="">Añade primero una fecha</option>';
      if (builder.dates.includes(previousDate)) dateSelect.value = previousDate;
      container.querySelector('#cmp-venue-list').innerHTML = builder.venues.map((venue) => `<div class="cmp-builder-item"><span>${esc(venue)}</span><button type="button" data-remove-venue="${esc(venue)}" aria-label="Quitar ${esc(venue)}">Quitar</button></div>`).join('');
      container.querySelector('#cmp-court-list').innerHTML = builder.courts.map((court) => `<div class="cmp-builder-item"><span><b>${esc(court.name)}</b> · ${esc(court.venue)}</span><button type="button" data-remove-court="${esc(court.key)}">Quitar</button></div>`).join('');
      container.querySelector('#cmp-date-list').innerHTML = builder.dates.map((date) => `<div class="cmp-builder-item"><span>${esc(formatCompetitionDate(date))}</span><button type="button" data-remove-date="${esc(date)}">Quitar</button></div>`).join('');
      container.querySelector('#cmp-slot-list').innerHTML = builder.slots.map((slot, index) => { const court = builder.courts.find((item) => item.key === slot.courtKey); return `<div class="cmp-builder-item"><span><b>${esc(court?.name || 'Pista')}</b> · ${esc(formatCompetitionDate(slot.date))} · ${esc(slot.time)}</span><button type="button" data-remove-slot="${index}">Quitar</button></div>`; }).join('');
      container.querySelectorAll('[data-remove-venue]').forEach((button) => button.addEventListener('click', () => { const venue = button.dataset.removeVenue; const removedKeys = new Set(builder.courts.filter((court) => court.venue === venue).map((court) => court.key)); builder.venues = builder.venues.filter((item) => item !== venue); builder.courts = builder.courts.filter((court) => court.venue !== venue); builder.slots = builder.slots.filter((slot) => !removedKeys.has(slot.courtKey)); renderBuilders(); }));
      container.querySelectorAll('[data-remove-court]').forEach((button) => button.addEventListener('click', () => { const key = button.dataset.removeCourt; builder.courts = builder.courts.filter((court) => court.key !== key); builder.slots = builder.slots.filter((slot) => slot.courtKey !== key); renderBuilders(); }));
      container.querySelectorAll('[data-remove-date]').forEach((button) => button.addEventListener('click', () => { const date = button.dataset.removeDate; builder.dates = builder.dates.filter((item) => item !== date); builder.slots = builder.slots.filter((slot) => slot.date !== date); renderBuilders(); }));
      container.querySelectorAll('[data-remove-slot]').forEach((button) => button.addEventListener('click', () => { builder.slots.splice(Number(button.dataset.removeSlot), 1); renderBuilders(); }));
      updateSummary();
    };
    container.querySelector('#cmp-add-venue').addEventListener('click', () => { const input = container.querySelector('#cmp-venue-name'); const venue = input.value.trim(); if (!venue) return builderStatus('Escribe el nombre del pabellón.'); if (builder.venues.some((item) => item.toLowerCase() === venue.toLowerCase())) return builderStatus('Ese pabellón ya está añadido.'); builder.venues.push(venue); input.value = ''; renderBuilders(); container.querySelector('#cmp-court-venue').value = venue; builderStatus(''); });
    container.querySelector('#cmp-add-court').addEventListener('click', () => { const venue = container.querySelector('#cmp-court-venue').value; const input = container.querySelector('#cmp-court-name'); const name = input.value.trim(); if (!venue) return builderStatus('Añade primero un pabellón.'); if (!name) return builderStatus('Escribe el nombre de la pista.'); if (builder.courts.some((court) => court.venue === venue && court.name.toLowerCase() === name.toLowerCase())) return builderStatus('Esa pista ya está añadida en el pabellón.'); const key = `court-choice-${builder.nextCourt++}`; builder.courts.push({ key, name, venue }); input.value = ''; renderBuilders(); container.querySelector('#cmp-slot-court').value = key; builderStatus(''); });
    container.querySelector('#cmp-add-date').addEventListener('click', () => { const input = container.querySelector('#cmp-date-value'); const date = input.value; if (!date) return builderStatus('Selecciona una fecha del campeonato.'); if (builder.dates.includes(date)) return builderStatus('Esa fecha ya está añadida.'); builder.dates.push(date); builder.dates.sort(); input.value = ''; renderBuilders(); container.querySelector('#cmp-slot-date').value = date; builderStatus(''); });
    container.querySelector('#cmp-add-slot').addEventListener('click', () => { const courtKey = container.querySelector('#cmp-slot-court').value; const date = container.querySelector('#cmp-slot-date').value; const time = container.querySelector('#cmp-slot-time').value; if (!courtKey) return builderStatus('Añade primero una pista.'); if (!date) return builderStatus('Selecciona una fecha.'); if (builder.slots.some((slot) => slot.courtKey === courtKey && slot.date === date && slot.time === time)) return builderStatus('Esa disponibilidad ya está añadida.'); builder.slots.push({ courtKey, date, time }); renderBuilders(); builderStatus(''); });
    renderBuilders();
    createForm.addEventListener('submit', createDraft);
    createForm.elements.category.addEventListener('change', () => {
      const rule = competitionRulePreset(createForm.elements.category.value);
      createForm.elements.period_count.value = String(rule.periodCount);
      createForm.elements.period_minutes.value = String(rule.periodMinutes);
      createForm.elements.court_minutes.value = String(rule.courtMinutes);
      container.querySelector('#cmp-rule-note').textContent = `Sugerencia ${rule.label}: ${competitionRuleSummary(createForm.elements.category.value, rule.periodCount, rule.periodMinutes)}. Puedes editarla porque las bases específicas del torneo o delegación prevalecen. El tiempo reservado en pista incluye paradas y es el que evita solapes.`;
      updateSummary();
    });
    createForm.elements.name.addEventListener('input', updateSummary);
    createForm.elements.teams.addEventListener('input', updateSummary);
  }

  async function createDraft(event) {
    event.preventDefault();
    if (state.busy) return;
    state.busy = true;
    const form = event.currentTarget;
    try {
      if (!state.pendingBundle) {
        const draft = parseDraft(form);
        const schedule = generateSchedule(draft);
        state.pendingBundle = createCompetitionBundle(draft, {
          userId: user.id,
          clubId: options.getClubId?.() || null,
          schedule,
        });
      }
      const id = await saveCompetitionBundle(client, state.pendingBundle);
      state.pendingBundle = null;
      await refresh();
      await openCompetition(id, 'Borrador guardado. Revísalo antes de publicar.');
    } catch (error) {
      setStatus(friendlyError(error));
    } finally {
      state.busy = false;
    }
  }

  async function openCompetition(id, notice = '') {
    try {
      state.selected = await loadCompetition(client, id);
      renderDetail(notice);
    } catch (error) {
      renderHome();
      setStatus(friendlyError(error));
    }
  }

  function renderDetail(notice = '') {
    const data = state.selected;
    const c = data.competition;
    const category = c.category || 'custom';
    const periodCount = Number(c.period_count || 4);
    const periodMinutes = Number(c.period_minutes || 10);
    const teams = new Map(data.teams.map((team) => [team.id, team.public_name]));
    const slots = new Map(data.slots.map((slot) => [slot.id, slot]));
    const courts = new Map(data.courts.map((court) => [court.id, court.public_name]));
    const active = data.publications.find((publication) => !publication.withdrawn_at);
    container.innerHTML = `
      <style>
        .cmp-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.cmp-actions .btn{margin:0}.cmp-note{font-size:12px;color:var(--muted2);line-height:1.55}
        .cmp-table{overflow:auto}.cmp-table table{width:100%;border-collapse:collapse;min-width:720px}.cmp-table th,.cmp-table td{padding:9px;border-bottom:1px solid rgba(255,255,255,.1);text-align:left}.cmp-table input,.cmp-table select{min-height:38px;padding:6px}
      </style>
      <div class="card pr-panel">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
          <div><div class="section-t">Gestión autenticada</div><h2 style="margin:4px 0">${esc(c.name)}</h2><div class="cmp-note">/${esc(c.public_slug)} · ${esc(c.state)} · ${data.teams.length} equipos · ${data.matches.length} partidos</div><div class="cmp-note">${esc(competitionRulePreset(category).label)} · ${esc(competitionRuleSummary(category, periodCount, periodMinutes))} · ${esc(c.match_minutes)} min reservados en pista</div></div>
          <button class="btn btn-ghost" id="cmp-back" type="button">Volver al listado</button>
        </div>
        ${notice ? `<div style="color:#55d59a;margin:10px 0;font-size:13px">${esc(notice)}</div>` : ''}
        <div class="cmp-table"><table><thead><tr><th>Fecha</th><th>Pista</th><th>Partido</th><th>Local</th><th>Visitante</th><th>Estado</th><th></th></tr></thead><tbody>
          ${data.matches.sort((a,b) => String(slots.get(a.slot_id)?.starts_at).localeCompare(String(slots.get(b.slot_id)?.starts_at))).map((match) => {
            const slot = slots.get(match.slot_id);
            return `<tr><td>${esc(new Intl.DateTimeFormat('es-ES',{dateStyle:'short',timeStyle:'short'}).format(new Date(slot?.starts_at)))}</td><td>${esc(courts.get(slot?.court_id) || '')}</td><td>${esc(teams.get(match.home_team_id))}<br>${esc(teams.get(match.away_team_id))}</td>
              <td><input type="number" min="0" data-home="${esc(match.id)}" value="${Number.isInteger(match.home_score) ? match.home_score : ''}" aria-label="Marcador local"></td>
              <td><input type="number" min="0" data-away="${esc(match.id)}" value="${Number.isInteger(match.away_score) ? match.away_score : ''}" aria-label="Marcador visitante"></td>
              <td><select data-state="${esc(match.id)}"><option value="provisional" ${match.status !== 'validated' ? 'selected' : ''}>Provisional</option><option value="validated" ${match.status === 'validated' ? 'selected' : ''}>Validado</option></select></td>
              <td><button class="btn btn-ghost" type="button" data-save-match="${esc(match.id)}">Guardar</button></td></tr>`;
          }).join('')}
        </tbody></table></div>
        <div class="cmp-actions">
          <button class="btn btn-primary" id="cmp-publish" type="button">Publicar nueva versión</button>
          ${active ? '<button class="btn btn-ghost" id="cmp-withdraw" type="button">Retirar publicación</button>' : ''}
          ${active ? `<a class="btn btn-ghost" target="_blank" rel="noopener" href="${esc(publicUrl(c.public_slug))}">Abrir portal público</a>` : ''}
        </div>
        <p class="cmp-note">Publicar y retirar exigen segundo factor. Una nueva versión sustituye la visible sin borrar el historial.</p>
        <div id="cmp-status" role="status" style="min-height:18px;margin-top:8px;font-size:12px"></div>
      </div>`;
    container.querySelector('#cmp-back').addEventListener('click', renderHome);
    container.querySelectorAll('[data-save-match]').forEach((button) => button.addEventListener('click', () => updateResult(button.dataset.saveMatch)));
    container.querySelector('#cmp-publish').addEventListener('click', doPublish);
    container.querySelector('#cmp-withdraw')?.addEventListener('click', doWithdraw);
  }

  async function updateResult(matchId) {
    try {
      const home = container.querySelector(`[data-home="${matchId}"]`).value;
      const away = container.querySelector(`[data-away="${matchId}"]`).value;
      const status = container.querySelector(`[data-state="${matchId}"]`).value;
      if (home === '' || away === '' || Number(home) === Number(away)) throw new Error('Marcador incompleto o empatado.');
      await saveMatchResult(client, matchId, { homeScore: home, awayScore: away, status }, user.id);
      await openCompetition(state.selected.competition.id, 'Resultado guardado.');
    } catch (error) {
      setStatus(/empatado|incompleto/i.test(error.message) ? 'Introduce dos marcadores distintos y válidos.' : friendlyError(error));
    }
  }

  async function doPublish() {
    try {
      await requireAal2(client);
      const result = await publishCompetition(client, state.selected.competition.id);
      await openCompetition(state.selected.competition.id, `Publicada la versión ${result?.publication_version || ''}.`);
    } catch (error) {
      setStatus(friendlyError(error));
    }
  }

  async function doWithdraw() {
    try {
      await requireAal2(client);
      await withdrawCompetition(client, state.selected.competition.id);
      await openCompetition(state.selected.competition.id, 'La publicación se ha retirado sin borrar el campeonato.');
    } catch (error) {
      setStatus(friendlyError(error));
    }
  }

  try {
    await refresh();
  } catch (error) {
    container.innerHTML = `<div class="card pr-panel"><div style="color:#ff9b91">${esc(friendlyError(error))}</div></div>`;
  }
}

if (typeof window !== 'undefined') {
  window.anmarMountCompetitions = mountCompetitionManager;
}
