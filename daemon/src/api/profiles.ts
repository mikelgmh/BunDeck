/** Rutas `/api/v1/profiles*` — CRUD de perfiles. */
import { v4 as uuidv4 } from 'uuid';
import { jsonResponse, dataTooLarge, MAX_PAGE_PROFILE_DATA_BYTES } from './http-helpers';
import type { ApiHandler } from './types';

export const handleProfiles: ApiHandler = async (_req, { url, method, path, db, services }) => {
  void url;
  if (path === '/api/v1/profiles') {
    if (method === 'GET') {
      const profiles = db.getProfiles();
      return jsonResponse(profiles);
    }

    if (method === 'POST') {
      const body = await _req.json();
      if (dataTooLarge(body.data)) {
        return jsonResponse(
          { error: `profile data exceeds ${MAX_PAGE_PROFILE_DATA_BYTES} bytes (possible corrupted payload)` },
          413
        );
      }
      const profile = {
        id: uuidv4(),
        name: body.name,
        data: body.data || {},
      };

      const createdProfile = db.createProfile(profile);
      services.wsManager.broadcastProfileUpdate(profile.id, createdProfile);

      return jsonResponse(createdProfile, 201);
    }
  }

  if (path.startsWith('/api/v1/profiles/')) {
    const profileId = path.split('/')[4];

    if (method === 'GET') {
      const profile = db.getProfile(profileId);
      if (!profile) {
        return jsonResponse({ error: 'Profile not found' }, 404);
      }
      return jsonResponse(profile);
    }

    if (method === 'PUT') {
      const body = await _req.json();
      if (dataTooLarge(body.data)) {
        return jsonResponse(
          { error: `profile data exceeds ${MAX_PAGE_PROFILE_DATA_BYTES} bytes (possible corrupted payload)` },
          413
        );
      }
      db.updateProfile(profileId, body);

      const updatedProfile = db.getProfile(profileId);
      services.wsManager.broadcastProfileUpdate(profileId, updatedProfile);

      return jsonResponse(updatedProfile);
    }

    if (method === 'DELETE') {
      db.deleteProfile(profileId);
      // Con topic 'profiles': los clientes suscritos lo reciben y recargan;
      // sin topic llegaba a todos pero el frontend lo ignoraba (sin handler).
      services.wsManager.broadcast('profile.deleted', { profileId }, 'profiles');
      return jsonResponse({ success: true });
    }
  }

  return null;
};
