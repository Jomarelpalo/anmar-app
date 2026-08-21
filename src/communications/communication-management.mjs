import {
  canEditOwnMessage,
  deriveCommunicationCapabilities,
  formatCommunicationTime,
  visibleMessageText,
} from './communication-core.mjs';

const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = String(text);
  return node;
};

const shortId = (value) => String(value || '').slice(0, 8) || 'usuario';
const personName = (row, profiles = {}) => row?.display_name || row?.author_name || profiles[row?.user_id || row?.author_id] || shortId(row?.user_id || row?.author_id);

function button(label, action, className = 'comm-btn') {
  const node = el('button', className, label);
  node.type = 'button';
  node.dataset.action = action;
  return node;
}

function labelledControl(label, control) {
  const wrapper = el('label', 'comm-field');
  wrapper.append(el('span', 'comm-field-label', label), control);
  return wrapper;
}

function setStatus(root, message, type = 'ok') {
  const status = root.querySelector('#comm-status');
  if (!status) return;
  status.textContent = message;
  status.className = `comm-status ${type}`;
}

export async function mountCommunicationManager(root, options) {
  if (!root) throw new Error('Falta el contenedor del chat.');
  const repository = options?.repository;
  const profile = options?.profile;
  if (!repository || !profile?.id) throw new Error('Falta la sesión sintética o el repositorio de comunicaciones.');

  let spaces = [];
  let selectedId = null;
  let detail = null;
  let unsubscribe = null;
  let realtimeStatus = 'CONECTANDO';
  let profiles = { ...(options.profiles || {}) };
  const teams = options.teams || [];

  root.innerHTML = '';
  root.classList.add('comm-app');
  const shell = el('div', 'comm-shell');
  const sidebar = el('aside', 'comm-sidebar');
  const main = el('section', 'comm-main');
  shell.append(sidebar, main);
  root.append(shell);

  async function refreshList(preferredId = selectedId) {
    spaces = await repository.listSpaces(profile.id);
    selectedId = spaces.some((space) => space.id === preferredId) ? preferredId : spaces[0]?.id || null;
    renderSidebar();
    if (selectedId) await openSpace(selectedId);
    else renderEmpty();
  }

  function renderSidebar() {
    sidebar.innerHTML = '';
    const head = el('div', 'comm-sidebar-head');
    head.append(el('div', 'comm-eyebrow', 'ANMAR · COMUNICACIONES'), el('h2', '', 'Tus canales'));
    if (options.canCreateSpace !== false && ['admin', 'admin_club'].includes(profile.role)) head.append(button('Crear canal', 'show-create', 'comm-btn comm-primary'));
    sidebar.append(head);
    const list = el('nav', 'comm-space-list');
    list.id = 'comm-space-list';
    if (!spaces.length) list.append(el('p', 'comm-empty-small', 'Todavía no tienes canales autorizados.'));
    spaces.forEach((space) => {
      const item = button('', 'open-space', `comm-space-item${space.id === selectedId ? ' active' : ''}`);
      item.dataset.spaceId = space.id;
      item.append(el('strong', '', space.name));
      item.append(el('span', '', space.space_type === 'announcements' ? 'Solo avisos' : 'Conversación'));
      if (space.state !== 'active') item.append(el('em', '', space.state === 'locked' ? 'Bloqueado' : 'Archivado'));
      list.append(item);
    });
    sidebar.append(list);
    const privacy = el('div', 'comm-privacy-note');
    privacy.append(el('strong', '', 'Privacidad'), document.createTextNode(' · No compartas lesiones, teléfonos, ubicación, documentos ni fotografías de menores.'));
    sidebar.append(privacy);
  }

  function renderEmpty() {
    main.innerHTML = '';
    const empty = el('div', 'comm-empty');
    empty.append(el('h2', '', 'Comunicaciones privadas'), el('p', '', 'Selecciona un canal autorizado o crea el primero. No existen mensajes privados en esta fase.'));
    main.append(empty, statusNode());
  }

  function statusNode() {
    const status = el('div', 'comm-status');
    status.id = 'comm-status';
    status.setAttribute('role', 'status');
    return status;
  }

  async function openSpace(spaceId) {
    selectedId = spaceId;
    if (unsubscribe) await unsubscribe();
    detail = await repository.loadSpace(spaceId, profile.id);
    profiles = { ...profiles, ...(detail.profiles || {}) };
    realtimeStatus = 'CONECTANDO';
    renderSidebar();
    renderChannel();
    unsubscribe = repository.subscribe ? repository.subscribe(spaceId, async () => {
      detail = await repository.loadSpace(spaceId, profile.id);
      profiles = { ...profiles, ...(detail.profiles || {}) };
      renderChannel();
    }, (status) => {
      realtimeStatus = status === 'SUBSCRIBED' ? 'EN DIRECTO' : String(status || 'SIN CONEXIÓN');
      const badge = main.querySelector('#comm-live');
      if (badge) badge.textContent = realtimeStatus;
    }) : null;
  }

  function renderChannel() {
    main.innerHTML = '';
    const { space, membership, messages = [], memberships = [], reports = [] } = detail;
    const capabilities = deriveCommunicationCapabilities(space, membership);
    const header = el('header', 'comm-channel-head');
    const title = el('div');
    title.append(el('div', 'comm-eyebrow', space.team_id ? 'CANAL DE EQUIPO' : 'CANAL DE CLUB'), el('h2', '', space.name));
    if (space.description) title.append(el('p', '', space.description));
    const badges = el('div', 'comm-badges');
    const live = el('span', 'comm-live', realtimeStatus); live.id = 'comm-live';
    badges.append(live, el('span', 'comm-type', space.space_type === 'announcements' ? 'Solo avisos' : 'Conversación'));
    header.append(title, badges);
    main.append(header);

    if (membership?.status === 'invited') {
      const invite = el('div', 'comm-invite');
      invite.append(el('strong', '', 'Invitación pendiente'), el('p', '', 'Acepta para entrar. La incorporación nunca es automática.'));
      invite.append(button('Aceptar invitación', 'accept-membership', 'comm-btn comm-primary'));
      main.append(invite, statusNode());
      return;
    }

    if (!capabilities.canRead) {
      main.append(el('div', 'comm-empty', capabilities.readOnlyReason), statusNode());
      return;
    }

    const body = el('div', 'comm-channel-body');
    const messageList = el('div', 'comm-messages'); messageList.id = 'comm-messages';
    if (!messages.length) messageList.append(el('div', 'comm-empty-small', 'No hay mensajes todavía.'));
    messages.forEach((message) => {
      const text = visibleMessageText(message, capabilities.canModerate);
      if (!text) return;
      const article = el('article', `comm-message${message.author_id === profile.id ? ' mine' : ''}${message.state !== 'visible' ? ' muted' : ''}`);
      article.dataset.messageId = message.id;
      const meta = el('div', 'comm-message-meta');
      meta.append(el('strong', '', personName(message, profiles)), el('time', '', formatCommunicationTime(message.created_at)));
      const content = el('p', 'comm-message-text', text);
      article.append(meta, content);
      const actions = el('div', 'comm-message-actions');
      if (canEditOwnMessage(message, profile.id)) actions.append(button('Editar', 'edit-message', 'comm-link'));
      if (message.author_id !== profile.id && message.state === 'visible') actions.append(button('Denunciar', 'report-message', 'comm-link'));
      if (capabilities.canModerate) actions.append(button(message.state === 'hidden_by_moderation' ? 'Restaurar' : 'Ocultar', message.state === 'hidden_by_moderation' ? 'restore-message' : 'hide-message', 'comm-link'));
      article.append(actions);
      messageList.append(article);
    });
    body.append(messageList);

    const compose = el('form', 'comm-compose'); compose.id = 'comm-compose'; compose.dataset.anmarFormKind = 'compact';
    const textarea = el('textarea'); textarea.name = 'message'; textarea.maxLength = 2000; textarea.rows = 2;
    textarea.placeholder = capabilities.canPost ? 'Escribe un mensaje para el grupo…' : capabilities.readOnlyReason;
    textarea.disabled = !capabilities.canPost;
    const send = el('button', 'comm-btn comm-primary', 'Enviar'); send.type = 'submit'; send.disabled = !capabilities.canPost;
    compose.append(textarea, send);
    const note = el('div', 'comm-compose-note', capabilities.canPost ? 'Solo texto · máximo 2.000 caracteres' : capabilities.readOnlyReason);
    body.append(compose, note);
    main.append(body);

    if (capabilities.canModerate) main.append(renderModerationPanel(space, memberships, reports));
    main.append(statusNode());
  }

  function renderModerationPanel(space, memberships, reports) {
    const panel = el('section', 'comm-moderation'); panel.id = 'comm-moderation';
    const summary = el('details');
    summary.append(el('summary', '', 'Moderación y participantes'));
    const controls = el('div', 'comm-moderation-grid');
    const channelBox = el('div', 'comm-panel-box');
    channelBox.append(el('h3', '', 'Estado del canal'), el('p', '', 'Bloquear impide mensajes nuevos, pero mantiene la lectura autorizada.'));
    channelBox.append(button(space.state === 'locked' ? 'Reabrir canal' : 'Bloquear canal', 'toggle-lock', 'comm-btn'));

    const inviteForm = el('form', 'comm-panel-box'); inviteForm.id = 'comm-invite-form'; inviteForm.dataset.anmarFormKind = 'standard';
    inviteForm.append(el('h3', '', 'Invitar participante'));
    const idInput = el('input'); idInput.name = 'user_id'; idInput.placeholder = 'Identificador del usuario'; idInput.required = true;
    const postLabel = el('label', 'comm-check'); const post = el('input'); post.type = 'checkbox'; post.name = 'can_post'; postLabel.append(post, document.createTextNode(' Puede escribir'));
    const minorLabel = el('label', 'comm-check'); const minor = el('input'); minor.type = 'checkbox'; minor.name = 'is_minor'; minorLabel.append(minor, document.createTextNode(' Es menor'));
    const consentLabel = el('label', 'comm-check'); const consent = el('input'); consent.type = 'checkbox'; consent.name = 'consent'; consentLabel.append(consent, document.createTextNode(' Autorización verificada'));
    const role = el('select'); role.name = 'member_role';
    [['member', 'Participante'], ['moderator', 'Moderador adulto']].forEach(([value, label]) => { const option = el('option', '', label); option.value = value; role.append(option); });
    const submit = el('button', 'comm-btn comm-primary', 'Enviar invitación'); submit.type = 'submit';
    inviteForm.append(labelledControl('Identificador del usuario', idInput), labelledControl('Función en el canal', role), postLabel, minorLabel, consentLabel, submit);

    const membersBox = el('div', 'comm-panel-box');
    membersBox.append(el('h3', '', `Participantes (${memberships.length})`));
    memberships.forEach((member) => {
      const row = el('div', 'comm-member-row'); row.dataset.membershipId = member.id;
      const text = el('span', '', `${personName(member, profiles)} · ${member.member_role === 'moderator' ? 'moderador' : member.can_post ? 'participa' : 'solo lectura'} · ${member.status}`);
      row.append(text);
      if (member.user_id !== profile.id && member.status === 'active') row.append(button('Suspender', 'suspend-member', 'comm-link'));
      membersBox.append(row);
    });

    const reportsBox = el('div', 'comm-panel-box');
    reportsBox.append(el('h3', '', `Denuncias abiertas (${reports.filter((report) => report.status === 'open').length})`));
    reports.filter((report) => report.status === 'open').forEach((report) => {
      const row = el('div', 'comm-report-row', `${report.reason} · ${formatCommunicationTime(report.created_at)}`);
      row.dataset.reportId = report.id;
      row.append(button('Resolver', 'resolve-report', 'comm-link'));
      reportsBox.append(row);
    });
    if (!reports.some((report) => report.status === 'open')) reportsBox.append(el('p', '', 'No hay denuncias pendientes.'));
    controls.append(channelBox, inviteForm, membersBox, reportsBox);
    summary.append(controls); panel.append(summary);
    return panel;
  }

  function showCreateForm() {
    main.innerHTML = '';
    const form = el('form', 'comm-create-card'); form.id = 'comm-create-form'; form.dataset.anmarFormKind = 'standard';
    form.append(el('div', 'comm-eyebrow', 'NUEVO ESPACIO PRIVADO'), el('h2', '', 'Crear canal'));
    const name = el('input'); name.name = 'name'; name.placeholder = 'Nombre del canal'; name.required = true; name.maxLength = 80;
    const description = el('textarea'); description.name = 'description'; description.placeholder = 'Finalidad del canal'; description.maxLength = 300;
    const type = el('select'); type.name = 'space_type';
    [['conversation', 'Conversación de grupo'], ['announcements', 'Solo avisos']].forEach(([value, label]) => { const option = el('option', '', label); option.value = value; type.append(option); });
    const team = el('select'); team.name = 'team_id';
    const clubOption = el('option', '', 'Todo el club'); clubOption.value = ''; team.append(clubOption);
    teams.forEach((item) => { const option = el('option', '', item.name); option.value = item.id; team.append(option); });
    const actions = el('div', 'comm-actions'); const create = el('button', 'comm-btn comm-primary', 'Crear canal'); create.type = 'submit'; actions.append(create, button('Cancelar', 'cancel-create'));
    form.append(labelledControl('Nombre del canal', name), labelledControl('Finalidad del canal', description), labelledControl('Tipo de canal', type), labelledControl('Ámbito', team), actions);
    main.append(form, statusNode());
  }

  const handleClick = async (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    try {
      if (action === 'show-create') return showCreateForm();
      if (action === 'cancel-create') return selectedId ? openSpace(selectedId) : renderEmpty();
      if (action === 'open-space') return openSpace(target.dataset.spaceId);
      if (action === 'accept-membership') {
        await repository.acceptMembership(detail.membership.id, profile.id);
        setStatus(root, 'Invitación aceptada.');
        return refreshList(selectedId);
      }
      if (action === 'toggle-lock') {
        const nextState = detail.space.state === 'locked' ? 'active' : 'locked';
        await repository.updateSpace(selectedId, { state: nextState }, profile.id);
        await openSpace(selectedId); return setStatus(root, nextState === 'active' ? 'Canal reabierto.' : 'Canal bloqueado.');
      }
      const messageNode = target.closest('[data-message-id]');
      if (action === 'edit-message') {
        const message = detail.messages.find((item) => item.id === messageNode.dataset.messageId);
        const next = window.prompt('Corrige el mensaje:', message.body);
        if (next === null) return;
        await repository.editMessage(message.id, next, 'visible', profile.id);
        await openSpace(selectedId); return setStatus(root, 'Mensaje actualizado.');
      }
      if (action === 'report-message') {
        await repository.reportMessage(messageNode.dataset.messageId, 'inappropriate', 'Revisión solicitada desde el canal.', profile.id);
        await openSpace(selectedId); return setStatus(root, 'Denuncia enviada a moderación.');
      }
      if (action === 'hide-message' || action === 'restore-message') {
        await repository.moderateMessage(messageNode.dataset.messageId, action === 'hide-message' ? 'hide' : 'restore', 'inappropriate_content', profile.id);
        await openSpace(selectedId); return setStatus(root, action === 'hide-message' ? 'Mensaje ocultado.' : 'Mensaje restaurado.');
      }
      if (action === 'suspend-member') {
        const membershipId = target.closest('[data-membership-id]').dataset.membershipId;
        await repository.setMemberState(membershipId, 'suspended', 'safety', profile.id);
        await openSpace(selectedId); return setStatus(root, 'Participante suspendido.');
      }
      if (action === 'resolve-report') {
        const reportId = target.closest('[data-report-id]').dataset.reportId;
        await repository.resolveReport(reportId, 'resolved', 'Revisada por moderación.', profile.id);
        await openSpace(selectedId); return setStatus(root, 'Denuncia resuelta.');
      }
    } catch (error) { setStatus(root, error.message || 'No se pudo completar la acción.', 'error'); }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      if (form.id === 'comm-create-form') {
        const id = await repository.createSpace({
          name: form.elements.name.value,
          description: form.elements.description.value,
          spaceType: form.elements.space_type.value,
          teamId: form.elements.team_id.value || null,
        }, { userId: profile.id, clubId: profile.club_id });
        await refreshList(id); return setStatus(root, 'Canal privado creado.');
      }
      if (form.id === 'comm-compose') {
        await repository.sendMessage(form.elements.message.value, { userId: profile.id, spaceId: selectedId });
        form.reset(); await openSpace(selectedId); return setStatus(root, 'Mensaje enviado y guardado.');
      }
      if (form.id === 'comm-invite-form') {
        await repository.inviteMember({
          userId: form.elements.user_id.value,
          memberRole: form.elements.member_role.value,
          canPost: form.elements.can_post.checked,
          isMinor: form.elements.is_minor.checked,
          consentVerified: form.elements.consent.checked,
        }, { userId: profile.id, spaceId: selectedId });
        form.reset(); await openSpace(selectedId); return setStatus(root, 'Invitación registrada.');
      }
    } catch (error) { setStatus(root, error.message || 'No se pudo completar la acción.', 'error'); }
  };

  root.addEventListener('click', handleClick);
  root.addEventListener('submit', handleSubmit);

  await refreshList(options.initialSpaceId || null);
  return {
    destroy: async () => {
      if (unsubscribe) await unsubscribe();
      root.removeEventListener('click', handleClick);
      root.removeEventListener('submit', handleSubmit);
      root.innerHTML = '';
    },
    refresh: () => refreshList(selectedId),
  };
}
