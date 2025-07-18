import fs from 'fs'
import path from 'path'

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import nock from 'nock'

import { get } from '@/tests/helpers/e2etest.js'
import { checkCachingHeaders } from '@/tests/helpers/caching-headers.js'
import { setDefaultFastlySurrogateKey } from '@/frame/middleware/set-fastly-surrogate-key.js'
import archivedEnterpriseVersionsAssets from '@/archives/middleware/archived-enterprise-versions-assets.js'

function getNextStaticAsset(directory: string) {
  const root = path.join('.next', 'static', directory)
  const files = fs.readdirSync(root)
  if (!files.length) throw new Error(`Can't find any files in ${root}`)
  return path.join(root, files[0])
}

function mockRequest(path: string, { headers }: { headers?: Record<string, string> } = {}) {
  const _headers = Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), value]),
  )
  return {
    path,
    url: path,
    get: (header: string) => {
      return _headers[header.toLowerCase()]
    },
    set: (header: string, value: string) => {
      _headers[header.toLowerCase()] = value
    },
    headers,
  }
}

type MockResponse = {
  status: number
  statusCode: number
  json?: (payload: any) => void
  send?: (body: any) => void
  _json?: string
  _send?: string
  headers: Record<string, string>
  set?: (key: string | Object, value: string) => void
  removeHeader?: (key: string) => void
  hasHeader?: (key: string) => boolean
}

const mockResponse = () => {
  const res: MockResponse = {
    status: 404,
    statusCode: 404,
    headers: {},
  }
  res.json = (payload) => {
    res._json = payload
  }
  res.send = (body) => {
    res.status = 200
    res.statusCode = 200
    res._send = body
  }
  res.set = (key, value) => {
    if (typeof key === 'string') {
      res.headers[key.toLowerCase()] = value
    } else {
      for (const [k, value] of Object.entries(key)) {
        res.headers[k.toLowerCase()] = value
      }
    }
  }
  res.removeHeader = (key) => {
    delete res.headers[key]
  }
  res.hasHeader = (key) => {
    return key in res.headers
  }
  return res
}

describe('static assets', () => {
  vi.setConfig({ testTimeout: 60 * 1000 })

  test('should serve /assets/cb-* with optimal headers', async () => {
    const res = await get('/assets/cb-1234/images/site/logo.png')
    expect(res.statusCode).toBe(200)
    checkCachingHeaders(res)
  })

  test('should serve /assets/ with optimal headers', async () => {
    const res = await get('/assets/images/site/logo.png')
    expect(res.statusCode).toBe(200)
    checkCachingHeaders(res, true)
  })

  test('should serve /_next/static/ with optimal headers', async () => {
    // This picks the first one found. We just need it to be anything
    // that actually resolves.
    const filePath = getNextStaticAsset('css')
    const asURL = '/' + filePath.replace('.next', '_next').split(path.sep).join('/')
    const res = await get(asURL)
    expect(res.statusCode).toBe(200)
    checkCachingHeaders(res)
  })

  test('should 404 on /assets/cb-* with plain text', async () => {
    const res = await get('/assets/cb-1234/never/heard/of.png')
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('text/plain')
    // Only a tiny amount of Cache-Control on these
    checkCachingHeaders(res, true, 60)
  })
  test('should 404 on /assets/ with plain text', async () => {
    const res = await get('/assets/never/heard/of.png')
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('text/plain')
    checkCachingHeaders(res, true, 60)
  })
  test('should 404 on /_next/static/ with plain text', async () => {
    const res = await get('/_next/static/never/heard/of.css')
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('text/plain')
    checkCachingHeaders(res, true, 60)
  })
  test("should redirect if the URL isn't all lowercase", async () => {
    // Directory
    {
      const res = await get('/assets/images/SITE/logo.png')
      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toBe('/assets/images/site/logo.png')
    }
    // File name
    {
      const res = await get('/assets/images/site/LoGo.png')
      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toBe('/assets/images/site/logo.png')
    }
    // File extension
    {
      const res = await get('/assets/images/site/logo.PNG')
      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toBe('/assets/images/site/logo.png')
    }
  })
})

describe('archived enterprise static assets', () => {
  // Sometimes static assets are proxied. The URL for the static asset
  // might not indicate it's based on archived enterprise version.

  vi.setConfig({ testTimeout: 60 * 1000 })

  beforeAll(async () => {
    // The first page load takes a long time so let's get it out of the way in
    // advance to call out that problem specifically rather than misleadingly
    // attributing it to the first test
    // await get('/')

    const sampleCSS = '/* nice CSS */'

    nock('https://github.github.com')
      .get('/docs-ghes-2.21/_next/static/foo.css')
      .reply(200, sampleCSS, {
        'content-type': 'text/css',
        'content-length': `${sampleCSS.length}`,
      })
    nock('https://github.github.com')
      .get('/docs-ghes-2.21/_next/static/only-on-proxy.css')
      .reply(200, sampleCSS, {
        'content-type': 'text/css',
        'content-length': `${sampleCSS.length}`,
      })
    nock('https://github.github.com')
      .get('/docs-ghes-2.3/_next/static/only-on-2.3.css')
      .reply(200, sampleCSS, {
        'content-type': 'text/css',
        'content-length': `${sampleCSS.length}`,
      })
    nock('https://github.github.com')
      .get('/docs-ghes-2.3/_next/static/fourofour.css')
      .reply(404, 'Not found', {
        'content-type': 'text/plain',
      })
    nock('https://github.github.com')
      .get('/docs-ghes-2.3/assets/images/site/logo.png')
      .reply(404, 'Not found', {
        'content-type': 'text/plain',
      })
  })

  afterAll(() => nock.cleanAll())

  test('should proxy if the static asset is prefixed', async () => {
    const req = mockRequest('/enterprise/2.21/_next/static/foo.css', {
      headers: {
        Referrer: '/enterprise/2.21',
      },
    })
    const res = mockResponse()
    const next = () => {
      throw new Error('did not expect this to ever happen')
    }
    setDefaultFastlySurrogateKey(req, res, () => {})
    await archivedEnterpriseVersionsAssets(req as any, res as any, next)
    expect(res.statusCode).toBe(200)
    checkCachingHeaders(res, false, 60)
  })

  test('should proxy if the Referrer header indicates so on home page', async () => {
    const req = mockRequest('/_next/static/only-on-proxy.css', {
      headers: {
        Referrer: '/enterprise/2.21',
      },
    })
    const res = mockResponse()
    const next = () => {
      throw new Error('did not expect this to ever happen')
    }
    setDefaultFastlySurrogateKey(req, res, () => {})
    await archivedEnterpriseVersionsAssets(req as any, res as any, next)
    expect(res.statusCode).toBe(200)
    checkCachingHeaders(res, false, 60)
  })

  test('should proxy if the Referrer header indicates so on sub-page', async () => {
    const req = mockRequest('/_next/static/only-on-2.3.css', {
      headers: {
        Referrer: '/en/enterprise-server@2.3/some/page',
      },
    })
    const res = mockResponse()
    const next = () => {
      throw new Error('did not expect this to ever happen')
    }
    setDefaultFastlySurrogateKey(req, res, () => {})
    await archivedEnterpriseVersionsAssets(req as any, res as any, next)
    expect(res.statusCode).toBe(200)
    checkCachingHeaders(res, false, 60)
  })

  test('might still 404 even with the right referrer', async () => {
    const req = mockRequest('/_next/static/fourofour.css', {
      headers: {
        Referrer: '/en/enterprise-server@2.3/some/page',
      },
    })
    const res = mockResponse()
    let nexted = false
    const next = () => {
      nexted = true
    }
    setDefaultFastlySurrogateKey(req, res, next)
    await archivedEnterpriseVersionsAssets(req as any, res as any, next)
    expect(res.statusCode).toBe(404)
    // It didn't exit in that middleware but called next() to move on
    // with any other middlewares.
    expect(nexted).toBe(true)
  })

  test('404 on the proxy but actually present here', async () => {
    const req = mockRequest('/assets/images/site/logo.png', {
      headers: {
        Referrer: '/en/enterprise-server@2.3/some/page',
      },
    })
    const res = mockResponse()
    let nexted = false
    const next = () => {
      nexted = true
    }
    setDefaultFastlySurrogateKey(req, res, () => {})
    await archivedEnterpriseVersionsAssets(req as any, res as any, next)
    // It tried to go via the proxy, but it wasn't there, but then it
    // tried "our disk" and it's eventually there.
    expect(nexted).toBe(true)
  })
})
