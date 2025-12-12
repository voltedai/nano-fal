import { resolveAsset } from '@nanograph/sdk'
import { fal } from '../../utils/fal-client.js'
import { File } from 'node:buffer'

export const resolveLoraPath = async (loraPath: string): Promise<string> => {
    if (loraPath.startsWith('http')) {
        return loraPath
    }

    // It's an asset URI, resolve it
    const buffer = await resolveAsset(loraPath, { asBuffer: true })

    if (!buffer || !Buffer.isBuffer(buffer)) {
        throw new Error(`Failed to resolve LoRA asset: ${loraPath}`)
    }

    // Upload to Fal
    const file = new File([buffer], 'lora.safetensors', { type: 'application/octet-stream' })
    const url = await fal.storage.upload(file as any)

    if (!url) {
        throw new Error('Failed to upload LoRA to Fal storage')
    }

    return url
}
