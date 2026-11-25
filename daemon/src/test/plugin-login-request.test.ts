/**
 * plugin-login-request.test.ts — POST /api/v1/plugins/spotify/login-request
 * crea la petición pendiente y emite broadcast WS (`plugin.login-requested`,
 * topic `plugins`) para que las UIs —incluida la remota— y el launcher del
 * host (que abre el navegador bajo demanda) se enteren. Sin efectos de red.
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-loginreq-test-'))
process.env.LIBREDECK_DATA_DIR = TMP
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true })

import { initDatabase, DatabaseService } from '../db'
import { handlePlugins } from '../api/plugins'

let db: DatabaseService

beforeAll(async () => {
  await initDatabase()
  db = new DatabaseService()
})

function stubServices() {
  const broadcasts: Array<{ event: string; payload: any; topic?: string }> = []
  return {
    broadcasts,
    services: {
      pluginLoader: {
        getPluginSettingsBundle: (_id: string) => ({ configured: false, missing: [] }),
      },
      wsManager: {
        broadcast: (event: string, payload: any, topic?: string) => {
          broadcasts.push({ event, payload, topic })
        },
      },
    },
  }
}

async function call(path: string, method: string, services: any) {
  const req = new Request(`http://localhost:3001${path}`, { method })
  const res = await handlePlugins(req, {
    url: new URL(`http://localhost:3001${path}`),
    method,
    path,
    db,
    services,
  } as any)
  if (!res) throw new Error(`sin handler para ${method} ${path}`)
  return { status: res.status, body: await res.json() }
}

describe('POST /api/v1/plugins/spotify/login-request', () => {
  it('crea la petición pendiente sin cambiar el contrato y difunde por WS', async () => {
    const { broadcasts, services } = stubServices()
    const r = await call('/api/v1/plugins/spotify/login-request', 'POST', services)
    expect(r.status).toBe(200)
    expect(r.body.success).toBe(true)
    expect(r.body.pluginId).toBe('spotify')
    expect(typeof r.body.requestedAt).toBe('string')
    expect(db.getSetting('plugin.spotify.loginRequestedAt')).toBe(r.body.requestedAt)
    // Broadcast para las UIs (topic plugins, como remote.ui-* en su topic).
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].event).toBe('plugin.login-requested')
    expect(broadcasts[0].topic).toBe('plugins')
    expect(broadcasts[0].payload.pluginId).toBe('spotify')
    expect(broadcasts[0].payload.requestedAt).toBe(r.body.requestedAt)
    expect(typeof broadcasts[0].payload.ts).toBe('number')
    // GET refleja pending:true con el mismo requestedAt.
    const g = await call('/api/v1/plugins/spotify/login-request', 'GET', services)
    expect(g.status).toBe(200)
    expect(g.body.pending).toBe(true)
    expect(g.body.requestedAt).toBe(r.body.requestedAt)
  })

  it('rechaza plugins que no son spotify y funciona sin wsManager', async () => {
    const { services } = stubServices()
    const bad = await call('/api/v1/plugins/obs/login-request', 'POST', services)
    expect(bad.status).toBe(400)
    // Sin wsManager (stub mínimo): no debe lanzar, el contrato se mantiene.
    const bare = await call('/api/v1/plugins/spotify/login-request', 'POST', {
      pluginLoader: services.pluginLoader,
    })
    expect(bare.status).toBe(200)
    expect(bare.body.success).toBe(true)
  })

  it('DELETE limpia la petición (el aviso del launcher desaparece)', async () => {
    const { services } = stubServices()
    await call('/api/v1/plugins/spotify/login-request', 'POST', services)
    const del = await call('/api/v1/plugins/spotify/login-request', 'DELETE', services)
    expect(del.status).toBe(200)
    const g = await call('/api/v1/plugins/spotify/login-request', 'GET', services)
    expect(g.body.pending).toBe(false)
  })
})
