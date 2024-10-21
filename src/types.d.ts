import type { R2Bucket } from '@cloudflare/workers-types'

export type Bindings = {
    NODE_ENV: string
    PORT: string
    LOGFILES: string
    LOG_LEVEL: string
    TIMEOUT: string
    MAX_BODY_SIZE: string
    R2: R2Bucket
    R2_BASE_URL: string
    R2_BUCKET_NAME: string
    R2_BUCKET_PREFIX: string
}
