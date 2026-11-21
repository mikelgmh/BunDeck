/** Rutas `/api/v1/profiles*` — CRUD de perfiles. */
import { v4 as uuidv4 } from 'uuid';
import { jsonResponse } from './http-helpers';
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
      db.updateProfile(profileId, body);

      const updatedProfile = db.getProfile(profileId);
      services.wsManager.broadcastProfileUpdate(profileId, updatedProfile);

      return jsonResponse(updatedProfile);
    }

    if (method === 'DELETE') {
      db.deleteProfile(profileId);
      services.wsManager.broadcast('profile.deleted', { profileId });
      return jsonResponse({ success: true });
    }
  }

  return null;
};
