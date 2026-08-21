import { mountCommunicationManager } from './communication-management.mjs';
import { createSupabaseCommunicationRepository } from './communication-supabase.mjs';

export async function mountAuthenticatedCommunications(root, options = {}) {
  const client = options.client;
  const sessionProfile = options.profile;
  if (!root) throw new Error('Falta la pantalla del Chat Seguro.');
  if (!client || !sessionProfile?.id) throw new Error('Inicia sesión para acceder al Chat Seguro.');

  const clubId = options.clubId || sessionProfile.club_id || null;
  let teams = [];
  if (clubId) {
    const result = await client.from('equipos')
      .select('id,nombre,archivado')
      .eq('club_id', clubId)
      .order('nombre', { ascending: true });
    if (result?.error) throw new Error('No se pudieron cargar los equipos autorizados del club.');
    teams = (result?.data || []).filter((team) => !team.archivado).map((team) => ({ id: team.id, name: team.nombre }));
  }

  const profile = { ...sessionProfile, club_id: clubId };
  return mountCommunicationManager(root, {
    repository: createSupabaseCommunicationRepository(client),
    profile,
    profiles: { [profile.id]: profile.nombre || 'Tú' },
    teams,
    canCreateSpace: Boolean(clubId),
    initialSpaceId: options.initialSpaceId || null,
  });
}

if (typeof window !== 'undefined') window.anmarMountCommunications = mountAuthenticatedCommunications;
