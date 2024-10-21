import { Context, Hono } from 'hono'
import { env, getRuntimeKey } from 'hono/adapter'
import dayjs from 'dayjs'
import { Bindings } from '../types'

const app = new Hono<{ Bindings: Bindings }>()

// 根据content-type获取文件后缀名
function getFileExtension(contentType: string | null): string {
    if (!contentType) {
        throw new Error('Content-Type is required')
    }

    const mimeTypeMap: { [key: string]: string } = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/bmp': 'bmp',
        'image/tiff': 'tiff',
        'image/svg+xml': 'svg',
    }

    return mimeTypeMap[contentType] || 'unknown'
}

// 上传图片到R2
async function uploadImageToR2(c: Context<{ Bindings: Bindings }>, body: ArrayBuffer, contentType: string): Promise<string> {
    const r2 = c.env.R2
    const envValue = env(c)
    const { R2_BASE_URL, R2_BUCKET_PREFIX } = envValue

    const fileExtension = getFileExtension(contentType)
    const key = `${R2_BUCKET_PREFIX}${dayjs().format('YYYYMMDDHHmmssSSS')}-${Math.random().toString(36).slice(2, 9)}.${fileExtension}`

    await r2.put(key, body, {
        httpMetadata: { contentType },
    })

    const url = new URL(R2_BASE_URL)
    url.pathname = key
    return url.toString()
}

// 从URL转存图片到R2
app.post('/upload-from-url', async (c) => {
    if (getRuntimeKey() !== 'workerd') {
        return c.json({ error: 'This function is only available in Cloudflare Workers' }, 500)
    }

    const envValue = env(c)
    const MAX_BODY_SIZE = parseInt(envValue.MAX_BODY_SIZE)
    const url = c.req.query('url')
    if (!url) {
        return c.json({ error: 'URL is required' }, 400)
    }

    try {
        const response = await fetch(url)
        const contentType = response.headers.get('content-type')
        const contentLength = response.headers.get('content-length')

        if (!contentType || !contentType.startsWith('image/')) {
            return c.json({ error: 'Invalid image format' }, 400)
        }

        if (contentLength && parseInt(contentLength) > MAX_BODY_SIZE) {
            return c.json({ error: 'Image size exceeds the limit' }, 400)
        }

        const body = await response.arrayBuffer()
        const imageUrl = await uploadImageToR2(c, body, contentType)
        return c.json({ success: true, url: imageUrl })
    } catch (error) {
        return c.json({ error: 'Failed to upload image' }, 500)
    }
})

// 从请求body中转存图片到R2
app.post('/upload-from-body', async (c) => {
    if (getRuntimeKey() !== 'workerd') {
        return c.json({ error: 'This function is only available in Cloudflare Workers' }, 500)
    }
    const envValue = env(c)
    const MAX_BODY_SIZE = parseInt(envValue.MAX_BODY_SIZE)

    const contentType = c.req.header('content-type')
    const contentLength = c.req.header('content-length')

    if (!contentType || !contentType.startsWith('image/')) {
        return c.json({ error: 'Invalid image format' }, 400)
    }
    if (contentLength && parseInt(contentLength) > MAX_BODY_SIZE) {
        return c.json({ error: 'Image size exceeds the limit' }, 400)
    }
    const body = await c.req.arrayBuffer()
    const imageUrl = await uploadImageToR2(c, body, contentType)
    return c.json({ success: true, url: imageUrl })
})

export default app
