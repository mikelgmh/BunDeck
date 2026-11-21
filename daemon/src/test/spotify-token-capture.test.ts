import { describe, it, expect } from 'bun:test'
import {
    normalizeSpotifyTokenCapture,
    isSpotifyStoredTokenExpired,
    SPOTIFY_EXPIRY_SKEW_MS,
} from '../plugins/spotify.plugin'

describe('normalizeSpotifyTokenCapture (extracción Web Player, sin Client ID)', () => {
    it('normaliza accessToken + expiresIn y guarda todo', () => {
        const now = 1_700_000_000_000
        const out = normalizeSpotifyTokenCapture({ accessToken: 'tok-1234567890', expiresIn: 3600, tokenType: 'Bearer' }, now)
        expect(out).toEqual({
            token: 'tok-1234567890',
            tokenType: 'Bearer',
            tokenObtainedAt: String(now),
            tokenExpiresAt: String(now + 3600_000),
            tokenExpiresIn: '3600',
        })
    })

    it('acepta snake_case (access_token/expires_in)', () => {
        const out = normalizeSpotifyTokenCapture({ access_token: 'tok-abcdefghij', expires_in: 1800 })
        expect(out.token).toBe('tok-abcdefghij')
        expect(out.tokenExpiresIn).toBe('1800')
        expect(out.tokenType).toBe('Bearer')
    })

    it('expiresIn inválido cae a 3600', () => {
        const out = normalizeSpotifyTokenCapture({ accessToken: 'tok-1234567890', expiresIn: -5 })
        expect(out.tokenExpiresIn).toBe('3600')
    })

    it('sin accessToken lanza (no guarda basura)', () => {
        expect(() => normalizeSpotifyTokenCapture({})).toThrow(/accessToken/)
        expect(() => normalizeSpotifyTokenCapture({ accessToken: '  ' })).toThrow(/accessToken/)
        expect(() => normalizeSpotifyTokenCapture({ accessToken: 'corto' })).toThrow(/accessToken/)
        expect(() => normalizeSpotifyTokenCapture(null)).toThrow(/accessToken/)
    })

    it('el token nunca sale en el error (no filtrar secreto)', () => {
        let msg = ''
        try {
            normalizeSpotifyTokenCapture({ accessToken: 'x'.repeat(50) })
        } catch (e) {
            msg = String((e as Error).message)
        }
        expect(msg).not.toContain('x'.repeat(50))
    })
})

describe('isSpotifyStoredTokenExpired', () => {
    it('token fresco no está caducado', () => {
        const now = 1_700_000_000_000
        expect(isSpotifyStoredTokenExpired({ tokenExpiresAt: String(now + 3600_000) }, now)).toBe(false)
    })

    it('token caducado (con margen de 60s) sí lo está', () => {
        const now = 1_700_000_000_000
        expect(isSpotifyStoredTokenExpired({ tokenExpiresAt: String(now - 1000) }, now)).toBe(true)
        // Dentro del margen también se considera caducado (renovar antes).
        expect(
            isSpotifyStoredTokenExpired({ tokenExpiresAt: String(now + SPOTIFY_EXPIRY_SKEW_MS - 1000) }, now)
        ).toBe(true)
    })

    it('sin metadata no bloquea (el API dirá 401)', () => {
        expect(isSpotifyStoredTokenExpired({}, Date.now())).toBe(false)
        expect(isSpotifyStoredTokenExpired({ tokenExpiresAt: 'no-numero' }, Date.now())).toBe(false)
    })
})
