export const COMMUNICATION_LIMITS = Object.freeze({
  messageCharacters: 2000,
  editMinutes: 15,
  messagesPerMinute: 10,
});

export class CommunicationValidationError extends Error {
  constructor(message, field = 'general') {
    super(message);
    this.name = 'CommunicationValidationError';
    this.field = field;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireUuid(value, field = 'identificador') {
  const id = String(value || '').trim();
  if (!UUID_RE.test(id)) throw new CommunicationValidationError(`El ${field} no es válido.`, field);
  return id;
}

export function normalizeMessageBody(value) {
  const body = String(value ?? '').trim();
  if (!body) throw new CommunicationValidationError('Escribe un mensaje antes de enviarlo.', 'body');
  if (body.length > COMMUNICATION_LIMITS.messageCharacters) {
    throw new CommunicationValidationError(`El mensaje no puede superar ${COMMUNICATION_LIMITS.messageCharacters} caracteres.`, 'body');
  }
  return body;
}

export function communicationTopic(spaceId) {
  return `communication:${requireUuid(spaceId, 'canal')}:messages`;
}

export function buildSpaceInput(input, context) {
  const name = String(input?.name || '').trim();
  if (name.length < 2 || name.length > 80) {
    throw new CommunicationValidationError('El nombre del canal debe tener entre 2 y 80 caracteres.', 'name');
  }
  const description = String(input?.description || '').trim();
  if (description.length > 300) throw new CommunicationValidationError('La descripción no puede superar 300 caracteres.', 'description');
  const type = input?.spaceType === 'announcements' ? 'announcements' : 'conversation';
  return {
    club_id: requireUuid(context?.clubId, 'club'),
    team_id: input?.teamId ? requireUuid(input.teamId, 'equipo') : null,
    created_by: requireUuid(context?.userId, 'usuario'),
    name,
    description,
    space_type: type,
    state: 'active',
    retention_days: 180,
  };
}

export function buildMembershipInput(input, context) {
  const isMinor = Boolean(input?.isMinor);
  const canPost = Boolean(input?.canPost);
  const isModerator = input?.memberRole === 'moderator';
  if (isMinor && isModerator) throw new CommunicationValidationError('Un menor no puede moderar un canal.', 'memberRole');
  if (isMinor && canPost && !input?.consentVerified) {
    throw new CommunicationValidationError('La escritura de un menor requiere autorización verificada.', 'consent');
  }
  return {
    space_id: requireUuid(context?.spaceId, 'canal'),
    user_id: requireUuid(input?.userId, 'usuario invitado'),
    member_role: isModerator ? 'moderator' : 'member',
    can_read: true,
    can_post: canPost || isModerator,
    is_minor: isMinor,
    posting_consent_verified_at: isMinor && canPost ? new Date(context?.now || Date.now()).toISOString() : null,
    posting_consent_verified_by: isMinor && canPost ? requireUuid(context?.userId, 'persona verificadora') : null,
    status: 'invited',
    assigned_by: requireUuid(context?.userId, 'persona que invita'),
  };
}

export function buildMessageInput(bodyValue, context, replyToId = null) {
  return {
    space_id: requireUuid(context?.spaceId, 'canal'),
    author_id: requireUuid(context?.userId, 'autor'),
    reply_to_id: replyToId ? requireUuid(replyToId, 'mensaje respondido') : null,
    body: normalizeMessageBody(bodyValue),
    state: 'visible',
  };
}

export function buildReportInput(messageId, reason, comment, userId) {
  const allowed = new Set(['inappropriate', 'harassment', 'privacy', 'spam', 'other']);
  if (!allowed.has(reason)) throw new CommunicationValidationError('Selecciona un motivo de denuncia válido.', 'reason');
  const note = String(comment || '').trim();
  if (note.length > 500) throw new CommunicationValidationError('La explicación no puede superar 500 caracteres.', 'comment');
  return {
    message_id: requireUuid(messageId, 'mensaje'),
    reporter_id: requireUuid(userId, 'denunciante'),
    reason,
    comment: note,
  };
}

export function deriveCommunicationCapabilities(space, membership) {
  const active = membership?.status === 'active';
  const inDate = !membership?.ends_at || new Date(membership.ends_at).getTime() > Date.now();
  const canRead = Boolean(active && inDate && membership?.can_read && space?.state !== 'archived');
  const moderator = Boolean(canRead && membership?.member_role === 'moderator');
  const consentAllowsPost = !membership?.is_minor || Boolean(
    membership?.posting_consent_verified_at && membership?.posting_consent_verified_by
  );
  const canPost = Boolean(
    canRead && space?.state === 'active' && membership?.can_post && consentAllowsPost
    && (space?.space_type === 'conversation' || moderator)
  );
  return Object.freeze({
    canRead,
    canPost,
    canModerate: moderator,
    canManageMembers: moderator,
    readOnlyReason: !canRead ? 'No tienes acceso activo a este canal.'
      : space?.state === 'locked' ? 'El canal está bloqueado temporalmente.'
        : space?.space_type === 'announcements' && !moderator ? 'Este canal es solo de avisos.'
          : membership?.is_minor && !consentAllowsPost ? 'La escritura necesita autorización verificada.'
            : !membership?.can_post ? 'Tu acceso es de solo lectura.' : '',
  });
}

export function canEditOwnMessage(message, userId, now = Date.now()) {
  if (!message || message.author_id !== userId || message.state === 'hidden_by_moderation') return false;
  const created = new Date(message.created_at).getTime();
  return Number.isFinite(created) && now - created <= COMMUNICATION_LIMITS.editMinutes * 60_000;
}

export function visibleMessageText(message, canModerate = false) {
  if (message?.state === 'hidden_by_moderation') return canModerate ? '[Mensaje oculto por moderación]' : '';
  if (message?.state === 'removed_by_author') return '[Mensaje retirado por su autor]';
  return String(message?.body || '');
}

export function formatCommunicationTime(value, locale = 'es-ES') {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}
