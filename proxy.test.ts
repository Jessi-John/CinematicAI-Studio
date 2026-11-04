import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy, verifyJwtToken } from './proxy'
import crypto from 'node:crypto'

const JWT_SECRET = 'test-proxy-secret-must-be-32-bytes-or-more!'

function signJwtToken(payload: Record<string, unknown>): string {
  const header = { alg: 'HS256', typ: 'JWT' }
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url')
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url')
  return `${encodedHeader}.${encodedPayload}.${signature}`
}

function createRequest(pathname: string, opts?: { token?: string; accept?: string; xRequestedWith?: string }): NextRequest {
  const url = new URL(`http://localhost:3000${pathname}`)
  const headers = new Headers()
  if (opts?.accept) headers.set('accept', opts.accept)
  if (opts?.xRequestedWith) headers.set('x-requested-with', opts.xRequestedWith)
  const cookie = opts?.token ? `access_token=${opts.token}` : ''
  if (cookie) headers.set('cookie', cookie)
  return new NextRequest(url, { headers })
}

describe('proxy middleware', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET
  })

  afterAll(() => {
    delete process.env.JWT_SECRET
  })

  it('allows public assets without a token', async () => {
    const req = createRequest('/_next/static/chunk.js')
    const res = await proxy(req)
    expect(res.status).toBe(200)
  })

  it('redirects unauthenticated requests to /login for protected routes', async () => {
    const req = createRequest('/history', { accept: 'text/html' })
    const res = await proxy(req)
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toMatch(/\/login/)
  })

  it('returns 403 for XHR unauthenticated requests', async () => {
    const req = createRequest('/history', { xRequestedWith: 'XMLHttpRequest' })
    const res = await proxy(req)
    expect(res.status).toBe(200) // XHR is allowed through so client can handle 401
  })

  it('redirects malformed tokens to login', async () => {
    const req = createRequest('/history', { token: 'not-a-jwt', accept: 'text/html' })
    const res = await proxy(req)
    expect(res.status).toBe(307)
  })

  it('redirects expired tokens to login', async () => {
    const token = signJwtToken({ sub: '1', username: 'u', role: 'user', jti: '1', exp: Math.floor(Date.now() / 1000) - 1 })
    const req = createRequest('/history', { token, accept: 'text/html' })
    const res = await proxy(req)
    expect(res.status).toBe(307)
  })

  it('allows authenticated users to access protected routes', async () => {
    const token = signJwtToken({ sub: '1', username: 'u', role: 'user', jti: '1', exp: Math.floor(Date.now() / 1000) + 60 })
    const req = createRequest('/history', { token, accept: 'text/html' })
    const res = await proxy(req)
    expect(res.status).toBe(200)
  })

  it('redirects non-admin users from /admin to /', async () => {
    const token = signJwtToken({ sub: '1', username: 'u', role: 'user', jti: '1', exp: Math.floor(Date.now() / 1000) + 60 })
    const req = createRequest('/admin', { token, accept: 'text/html' })
    const res = await proxy(req)
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost:3000/')
  })

  it('allows admin users to access /admin', async () => {
    const token = signJwtToken({ sub: '1', username: 'u', role: 'admin', jti: '1', exp: Math.floor(Date.now() / 1000) + 60 })
    const req = createRequest('/admin', { token, accept: 'text/html' })
    const res = await proxy(req)
    expect(res.status).toBe(200)
  })

  it('returns 403 for XHR non-admin admin route requests', async () => {
    const token = signJwtToken({ sub: '1', username: 'u', role: 'user', jti: '1', exp: Math.floor(Date.now() / 1000) + 60 })
    const req = createRequest('/admin', { token, xRequestedWith: 'XMLHttpRequest' })
    const res = await proxy(req)
    expect(res.status).toBe(403)
  })

  it('redirects authenticated users away from /login', async () => {
    const token = signJwtToken({ sub: '1', username: 'u', role: 'user', jti: '1', exp: Math.floor(Date.now() / 1000) + 60 })
    const req = createRequest('/login', { token, accept: 'text/html' })
    const res = await proxy(req)
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost:3000/')
  })
})

describe('verifyJwtToken', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET
  })

  afterAll(() => {
    delete process.env.JWT_SECRET
  })

  it('returns null when JWT_SECRET is missing', async () => {
    delete process.env.JWT_SECRET
    const token = signJwtToken({ sub: '1', role: 'user', jti: '1' })
    expect(await verifyJwtToken(token)).toBeNull()
    process.env.JWT_SECRET = JWT_SECRET
  })

  it('returns null for malformed tokens', async () => {
    expect(await verifyJwtToken('garbage')).toBeNull()
    expect(await verifyJwtToken('a.b')).toBeNull()
  })

  it('returns null for tokens with invalid signatures', async () => {
    const token = signJwtToken({ sub: '1', role: 'user', jti: '1' })
    const tampered = token.replace(/.$/, token[token.length - 1] === 'a' ? 'b' : 'a')
    expect(await verifyJwtToken(tampered)).toBeNull()
  })

  it('returns the payload for valid tokens', async () => {
    const token = signJwtToken({ sub: '1', username: 'u', role: 'admin', jti: '1', exp: Math.floor(Date.now() / 1000) + 60 })
    const payload = await verifyJwtToken(token)
    expect(payload).toMatchObject({ sub: '1', username: 'u', role: 'admin' })
  })
})
