import {
  buildMembershipInput,
  buildMessageInput,
  buildReportInput,
  buildSpaceInput,
  communicationTopic,
} from './communication-core.mjs';

export class CommunicationRepositoryError extends Error {
  constructor(message, cause = null, step = 'unknown') {
    super(message);
    this.name = 'CommunicationRepositoryError';
    this.cause = cause;
    this.step = step;
  }
}

function assertClient(client) {
  if (!client || typeof client.from !== 'function' || typeof client.rpc !== 'function') {
    throw new CommunicationRepositoryError('No existe una conexión válida con Supabase.', null, 'client');
  }
}

function dataOrThrow(result, message, step) {
  if (result?.error) throw new CommunicationRepositoryError(message, result.error, step);
  return result?.data ?? null;
}

export async function listCommunicationSpaces(client) {
  assertClient(client);
  const result = await client.from('communication_spaces')
    .select('id,club_id,team_id,name,description,space_type,state,retention_days,created_by,created_at,updated_at')
    .order('updated_at', { ascending: false });
  return dataOrThrow(result, 'No se pudieron cargar los canales autorizados.', 'list_spaces') || [];
}

export async function loadCommunicationSpace(client, spaceId, userId) {
  assertClient(client);
  const [spaceResult, membershipResult, messagesResult, membersResult, reportsResult] = await Promise.all([
    client.from('communication_spaces').select('*').eq('id', spaceId).maybeSingle(),
    client.from('communication_memberships').select('*').eq('space_id', spaceId).eq('user_id', userId).maybeSingle(),
    client.from('communication_messages').select('*').eq('space_id', spaceId).order('created_at', { ascending: true }),
    client.from('communication_memberships').select('*').eq('space_id', spaceId).order('created_at', { ascending: true }),
    client.from('communication_reports').select('*').order('created_at', { ascending: false }),
  ]);
  const space = dataOrThrow(spaceResult, 'No se pudo cargar el canal.', 'load_space');
  if (!space) throw new CommunicationRepositoryError('El canal no existe o no está autorizado.', null, 'load_space');
  const membership = dataOrThrow(membershipResult, 'No se pudo comprobar tu acceso.', 'load_membership');
  const messages = dataOrThrow(messagesResult, 'No se pudieron cargar los mensajes.', 'load_messages') || [];
  const memberships = dataOrThrow(membersResult, 'No se pudieron cargar los participantes.', 'load_members') || [];
  const profileIds = [...new Set([userId, ...messages.map((row) => row.author_id), ...memberships.map((row) => row.user_id)].filter(Boolean))];
  let profiles = {};
  if (profileIds.length) {
    const profileResult = await client.from('profiles').select('id,nombre').in('id', profileIds);
    if (!profileResult?.error) profiles = Object.fromEntries((profileResult?.data || []).map((row) => [row.id, row.nombre]));
  }
  return {
    space,
    membership,
    messages,
    memberships,
    reports: dataOrThrow(reportsResult, 'No se pudieron cargar las denuncias.', 'load_reports') || [],
    profiles,
  };
}

export async function createCommunicationSpace(client, input, context) {
  assertClient(client);
  const payload = buildSpaceInput(input, context);
  const result = await client.from('communication_spaces').insert(payload).select('id').maybeSingle();
  return dataOrThrow(result, 'No se pudo crear el canal.', 'create_space')?.id || null;
}

export async function updateCommunicationSpace(client, spaceId, values) {
  assertClient(client);
  const allowed = {};
  if (values?.state && ['active', 'locked', 'archived'].includes(values.state)) allowed.state = values.state;
  if (typeof values?.name === 'string') allowed.name = values.name.trim();
  if (typeof values?.description === 'string') allowed.description = values.description.trim();
  const result = await client.from('communication_spaces').update(allowed).eq('id', spaceId).select('*').maybeSingle();
  return dataOrThrow(result, 'No se pudo actualizar el canal.', 'update_space');
}

export async function inviteCommunicationMember(client, input, context) {
  assertClient(client);
  const payload = buildMembershipInput(input, context);
  const result = await client.from('communication_memberships').insert(payload).select('id').maybeSingle();
  return dataOrThrow(result, 'No se pudo invitar al participante.', 'invite_member')?.id || null;
}

export async function acceptCommunicationMembership(client, membershipId) {
  assertClient(client);
  const result = await client.rpc('accept_communication_membership', { p_membership_id: membershipId });
  return Boolean(dataOrThrow(result, 'No se pudo aceptar la invitación.', 'accept_membership'));
}

export async function sendCommunicationMessage(client, body, context, replyToId = null) {
  assertClient(client);
  const payload = buildMessageInput(body, context, replyToId);
  const result = await client.from('communication_messages').insert(payload).select('*').maybeSingle();
  return dataOrThrow(result, 'No se pudo enviar el mensaje.', 'send_message');
}

export async function editCommunicationMessage(client, messageId, body, state = 'visible') {
  assertClient(client);
  const payload = { body: String(body || '').trim(), state };
  const result = await client.from('communication_messages').update(payload).eq('id', messageId).select('*').maybeSingle();
  return dataOrThrow(result, 'No se pudo actualizar el mensaje.', 'edit_message');
}

export async function reportCommunicationMessage(client, messageId, reason, comment, userId) {
  assertClient(client);
  const payload = buildReportInput(messageId, reason, comment, userId);
  const result = await client.from('communication_reports').insert(payload).select('id').maybeSingle();
  return dataOrThrow(result, 'No se pudo registrar la denuncia.', 'report_message')?.id || null;
}

export async function moderateCommunicationMessage(client, messageId, action, reason) {
  assertClient(client);
  const result = await client.rpc('moderate_communication_message', {
    p_message_id: messageId, p_action: action, p_reason: String(reason || '').trim(),
  });
  return Boolean(dataOrThrow(result, 'No se pudo aplicar la moderación.', 'moderate_message'));
}

export async function setCommunicationMemberState(client, membershipId, state, reason) {
  assertClient(client);
  const result = await client.rpc('set_communication_member_state', {
    p_membership_id: membershipId, p_state: state, p_reason: String(reason || '').trim(),
  });
  return Boolean(dataOrThrow(result, 'No se pudo cambiar el acceso del participante.', 'member_state'));
}

export async function resolveCommunicationReport(client, reportId, resolution, note) {
  assertClient(client);
  const result = await client.rpc('resolve_communication_report', {
    p_report_id: reportId, p_resolution: resolution, p_note: String(note || '').trim(),
  });
  return Boolean(dataOrThrow(result, 'No se pudo resolver la denuncia.', 'resolve_report'));
}

export function subscribeToCommunicationSpace(client, spaceId, onChange, onStatus = () => {}) {
  assertClient(client);
  if (typeof client.channel !== 'function') {
    throw new CommunicationRepositoryError('La conexión no ofrece Realtime.', null, 'realtime');
  }
  const topic = communicationTopic(spaceId);
  const channel = client.channel(topic, { config: { private: true } })
    .on('broadcast', { event: 'message_changed' }, (payload) => onChange(payload?.payload || payload))
    .subscribe((status, error) => onStatus(status, error || null));
  return async () => {
    if (typeof client.removeChannel === 'function') await client.removeChannel(channel);
    else if (typeof channel.unsubscribe === 'function') await channel.unsubscribe();
  };
}

export function createSupabaseCommunicationRepository(client) {
  return {
    listSpaces: () => listCommunicationSpaces(client),
    loadSpace: (spaceId, userId) => loadCommunicationSpace(client, spaceId, userId),
    createSpace: (input, context) => createCommunicationSpace(client, input, context),
    updateSpace: (id, values) => updateCommunicationSpace(client, id, values),
    inviteMember: (input, context) => inviteCommunicationMember(client, input, context),
    acceptMembership: (id) => acceptCommunicationMembership(client, id),
    sendMessage: (body, context, replyToId) => sendCommunicationMessage(client, body, context, replyToId),
    editMessage: (id, body, state) => editCommunicationMessage(client, id, body, state),
    reportMessage: (id, reason, comment, userId) => reportCommunicationMessage(client, id, reason, comment, userId),
    moderateMessage: (id, action, reason) => moderateCommunicationMessage(client, id, action, reason),
    setMemberState: (id, state, reason) => setCommunicationMemberState(client, id, state, reason),
    resolveReport: (id, resolution, note) => resolveCommunicationReport(client, id, resolution, note),
    subscribe: (spaceId, onChange, onStatus) => subscribeToCommunicationSpace(client, spaceId, onChange, onStatus),
  };
}
