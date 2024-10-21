import crypto from 'crypto'
import { Context, Hono } from 'hono'
import { env, getRuntimeKey } from 'hono/adapter'
import dayjs from 'dayjs'
import { Bindings } from '../types'
import logger from '@/middlewares/logger'

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

// 计算文件的MD5值
function calculateMD5(buffer: ArrayBuffer): string {
    const hash = crypto.createHash('md5')
    hash.update(Buffer.from(buffer))
    return hash.digest('hex')
}

// 上传图片到R2
async function uploadImageToR2(c: Context<{ Bindings: Bindings }>, body: ArrayBuffer, contentType: string): Promise<string> {
    const r2 = c.env.R2
    const envValue = env(c)
    const { R2_BASE_URL, R2_BUCKET_PREFIX } = envValue

    const fileExtension = getFileExtension(contentType)
    const key = `${R2_BUCKET_PREFIX}${dayjs().format('YYYYMMDDHHmmssSSS')}-${Math.random().toString(36).slice(2, 9)}.${fileExtension}`

    const r2Object = await r2.put(key, body, {
        httpMetadata: { contentType },
        customMetadata: {},
    })
    // logger.debug('r2Object', r2Object)

    const url = new URL(R2_BASE_URL)
    url.pathname = key
    const imageUrl = url.toString()
    return imageUrl
}

// 检查IP上传次数
async function checkIPUploadCount(c: Context<{ Bindings: Bindings }>, ip: string): Promise<boolean> {
    const envValue = env(c)
    const MAX_UPLOAD_COUNT = parseInt(envValue.MAX_UPLOAD_COUNT)
    const d1 = c.env.D1

    const today = dayjs().format('YYYY-MM-DD')
    const result = await d1.prepare('SELECT COUNT(*) as count FROM uploads WHERE ip = ? AND date = ?').bind(ip, today).first()

    if (result && result.count as number >= MAX_UPLOAD_COUNT) {
        return false
    }

    await d1.prepare('INSERT INTO uploads (ip, date) VALUES (?, ?)').bind(ip, today).run()
    return true
}

// 检查文件是否已存在
async function checkFileExists(c: Context<{ Bindings: Bindings }>, md5: string): Promise<string | null> {
    const d1 = c.env.D1
    const result = await d1.prepare('SELECT url FROM images WHERE md5 = ?').bind(md5).first()
    return result ? result.url as string : null
}

// 从URL转存图片到R2
app.post('/upload-from-url', async (c) => {
    if (getRuntimeKey() !== 'workerd') {
        return c.json({ error: 'This function is only available in Cloudflare Workers' }, 500)
    }

    const envValue = env(c)
    const MAX_BODY_SIZE = parseInt(envValue.MAX_BODY_SIZE)
    const { url } = await c.req.json() || {}
    if (!url) {
        return c.json({ error: 'URL is required' }, 400)
    }
    // console.log(c.req.header())
    const ip = c.req.header('CF-Connecting-IP') || 'unknown'
    if (!await checkIPUploadCount(c, ip)) {
        return c.json({ error: 'Upload limit exceeded for this IP' }, 429)
    }
    const { R2_BASE_URL } = envValue
    if (url.startsWith(R2_BASE_URL)) { // 如果是R2的URL，直接返回
        return c.json({ success: true, url })
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

        const md5 = calculateMD5(body)
        const existingUrl = await checkFileExists(c, md5)
        if (existingUrl) {
            return c.json({ success: true, url: existingUrl })
        }

        const imageUrl = await uploadImageToR2(c, body, contentType)
        await c.env.D1.prepare('INSERT INTO images (url, md5, original_url) VALUES (?, ?, ?)').bind(imageUrl, md5, url).run()
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
    const ip = c.req.header('CF-Connecting-IP') || 'unknown'
    if (!await checkIPUploadCount(c, ip)) {
        return c.json({ error: 'Upload limit exceeded for this IP' }, 429)
    }
    const body = await c.req.arrayBuffer()
    const md5 = calculateMD5(body)
    const existingUrl = await checkFileExists(c, md5)
    if (existingUrl) {
        return c.json({ success: true, url: existingUrl })
    }
    const imageUrl = await uploadImageToR2(c, body, contentType)
    await c.env.D1.prepare('INSERT INTO images (url, md5, original_url) VALUES (?, ?, NULL)').bind(imageUrl, md5).run()
    return c.json({ success: true, url: imageUrl })
})

export default app
