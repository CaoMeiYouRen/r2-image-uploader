import crypto from 'crypto'
import { Context, Hono } from 'hono'
import { env, getRuntimeKey } from 'hono/adapter'
import dayjs from 'dayjs'
import { fileTypeFromBuffer } from 'file-type'
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
    const { R2_BASE_URL, R2_BUCKET_PREFIX = '' } = envValue

    const fileExtension = getFileExtension(contentType)
    if (fileExtension === 'unknown') {
        throw new Error('Unknown file extension')
    }
    const key = `${R2_BUCKET_PREFIX}${dayjs().format('YYYYMMDDHHmmssSSS')}-${Math.random().toString(36).slice(2, 9)}.${fileExtension}`

    await r2.put(key, body, {
        httpMetadata: { contentType },
        customMetadata: {
            uploader: 'r2-image-uploader',
        },
    })
    // logger.debug('r2Object', r2Object)
    if (!R2_BASE_URL) {
        throw new Error('R2_BASE_URL is required')
    }
    const url = new URL(R2_BASE_URL)
    url.pathname = key
    const imageUrl = url.toString()
    return imageUrl
}

// 检查IP上传次数
async function checkIPUploadCount(c: Context<{ Bindings: Bindings }>, ip: string): Promise<boolean> {
    const envValue = env(c)
    const MAX_UPLOAD_COUNT = parseInt(envValue.MAX_UPLOAD_COUNT) || 100
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

async function detectFileType(buffer: ArrayBuffer): Promise<string> {
    const fileType = await fileTypeFromBuffer(buffer)
    console.log('fileType', fileType)
    return fileType?.mime || 'unknown'
}
const referers = [
    {
        host: '.weibocdn.com',
        referer: 'https://weibo.com/',
    },
    {
        host: '.sinaimg.cn',
        referer: 'https://weibo.com/',
    },
    {
        host: '.sspai.com',
        referer: 'https://sspai.com/',
    },
    {
        host: '.pximg.net',
        referer: 'https://pixiv.net/',
    },
]
// 处理 Referer
function getHeaders(url: string) {
    for (const referer of referers) {
        const urlObj = new URL(url)
        if (urlObj.host.endsWith(referer.host)) {
            return {
                referer: referer.referer,
            }
        }
    }
    return {}
}

// 从URL转存图片到R2
app.post('/upload-from-url', async (c) => {
    if (getRuntimeKey() !== 'workerd') {
        return c.json({ error: 'This function is only available in Cloudflare Workers' }, 500)
    }

    const envValue = env(c)
    const MAX_BODY_SIZE = parseInt(envValue.MAX_BODY_SIZE) || 100 * 1024 * 1024
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
        const headers = getHeaders(url)
        const response = await fetch(url, { headers })
        const contentType = response.headers.get('Content-Type')
        const contentLength = response.headers.get('Content-Length')

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
    const MAX_BODY_SIZE = parseInt(envValue.MAX_BODY_SIZE) || 100 * 1024 * 1024

    const contentLength = c.req.header('Content-Length')

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
    const contentType = c.req.header('Content-Type') || await detectFileType(body) // 如果没有Content-Type头，尝试从body中检测
    if (!contentType || !contentType.startsWith('image/')) {
        return c.json({ error: 'Invalid image format' }, 400)
    }
    const imageUrl = await uploadImageToR2(c, body, contentType)
    await c.env.D1.prepare('INSERT INTO images (url, md5, original_url) VALUES (?, ?, NULL)').bind(imageUrl, md5).run()
    return c.json({ success: true, url: imageUrl })
})

export default app
