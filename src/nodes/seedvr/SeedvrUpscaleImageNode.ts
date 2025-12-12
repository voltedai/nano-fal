import { NanoSDK, NodeDefinition, NodeInstance, resolveAsset, uploadAsset } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { uploadBufferToFal } from '../../utils/fal-storage.js'
import { generateAssetFilename } from '../../utils/asset-utils.js'

interface SeedvrUpscaleImageResponse {
    data?: {
        image?: {
            url?: string
        }
        seed?: number
    }
}

const UPSCALE_MODES = ['factor', 'target'] as const
const TARGET_RESOLUTIONS = ['720p', '1080p', '1440p', '2160p'] as const
const OUTPUT_FORMATS = ['jpg', 'png', 'webp'] as const

const nodeDefinition: NodeDefinition = {
    uid: 'fal-seedvr-upscale-image',
    name: 'SeedVR Upscale Image',
    category: 'Image Enhancement',
    version: '1.0.0',
    type: 'server',
    description: 'Upscale images using SeedVR model',
    inputs: [
        {
            name: 'image',
            type: 'asset:image',
            description: 'Input image to upscale'
        }
    ],
    outputs: [
        {
            name: 'image',
            type: 'asset:image',
            description: 'Upscaled image'
        },
        {
            name: 'seed',
            type: 'number',
            description: 'Seed used for generation'
        }
    ],
    parameters: [
        {
            name: 'upscale_mode',
            type: 'select',
            value: 'factor',
            default: 'factor',
            label: 'Upscale Mode',
            description: 'Choose between scaling by a factor or to a specific resolution',
            options: [
                { label: 'Factor (multiply size)', value: 'factor' },
                { label: 'Target Resolution', value: 'target' }
            ]
        },
        {
            name: 'upscale_factor',
            type: 'number',
            value: 2,
            default: 2,
            label: 'Upscale Factor',
            description: 'Factor to multiply dimensions by (used when mode is Factor)',
            min: 1,
            max: 10
        },
        {
            name: 'target_resolution',
            type: 'select',
            value: '1080p',
            default: '1080p',
            label: 'Target Resolution',
            description: 'Resolution to upscale to (used when mode is Target)',
            options: TARGET_RESOLUTIONS.map(r => ({ label: r, value: r }))
        },
        {
            name: 'noise_scale',
            type: 'number',
            value: 0.1,
            default: 0.1,
            label: 'Noise Scale',
            description: 'Amount of noise to add (0-1)',
            min: 0,
            max: 1,
            step: 0.001
        },
        {
            name: 'output_format',
            type: 'select',
            value: 'jpg',
            default: 'jpg',
            label: 'Output Format',
            description: 'Format of the output image',
            options: OUTPUT_FORMATS.map(f => ({ label: f.toUpperCase(), value: f }))
        },
        {
            name: 'seed',
            type: 'number',
            value: -1,
            default: -1,
            label: 'Seed (-1 = random)',
            description: 'Random seed for generation'
        }
    ]
}

const seedvrUpscaleImageNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

seedvrUpscaleImageNode.execute = async ({ inputs, parameters, context }) => {
    configureFalClient()

    const image = inputs.image?.[0] as string

    if (!image) {
        context.sendStatus({ type: 'error', message: 'Input image is required' })
        throw new Error('Input image is required')
    }

    const upscaleMode = getParameterValue<string>(parameters, 'upscale_mode', 'factor')
    const upscaleFactor = getParameterValue<number>(parameters, 'upscale_factor', 2)
    const targetResolution = getParameterValue<string>(parameters, 'target_resolution', '1080p')
    const noiseScale = getParameterValue<number>(parameters, 'noise_scale', 0.1)
    const outputFormat = getParameterValue<string>(parameters, 'output_format', 'jpg')
    const seedValueRaw = getParameterValue<number>(parameters, 'seed', -1)

    context.sendStatus({ type: 'running', message: 'Preparing SeedVR Upscale request...' })

    try {
        const imageBuffer: Buffer = await resolveAsset(image, { asBuffer: true }) as Buffer
        const imageUrl = await uploadBufferToFal(imageBuffer, 'jpeg', { filenamePrefix: 'seedvr-upscale-in' })

        const requestPayload: any = {
            image_url: imageUrl,
            upscale_mode: upscaleMode,
            noise_scale: noiseScale,
            output_format: outputFormat
        }

        if (upscaleMode === 'factor') {
            requestPayload.upscale_factor = upscaleFactor
        } else {
            requestPayload.target_resolution = targetResolution
        }

        if (Number.isInteger(seedValueRaw) && seedValueRaw >= 0) {
            requestPayload.seed = seedValueRaw
        }

        const strategy = createProgressStrategy({
            expectedMs: 10000, // 10s estimate
            inQueueMessage: 'Waiting in queue...',
            finalizingMessage: 'Finalizing upscale...'
        })

        const result = await fal.subscribe('fal-ai/seedvr/upscale/image', {
            input: requestPayload,
            logs: true,
            onQueueUpdate: (status: QueueStatus) => {
                if (status.status === 'IN_QUEUE') {
                    const r = strategy.onQueue()
                    context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
                } else if (status.status === 'IN_PROGRESS') {
                    const r = strategy.onProgress(status, 0)
                    context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
                } else if (status.status === 'COMPLETED') {
                    const r = strategy.onCompleted()
                    context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
                }
            }
        }) as SeedvrUpscaleImageResponse

        const outputImageUrl = result.data?.image?.url

        if (!outputImageUrl) {
            throw new Error('No image was generated by SeedVR')
        }

        const response = await fetch(outputImageUrl)
        const contentType = response.headers.get('content-type')
        const arrayBuffer = await response.arrayBuffer()
        const buffer = Buffer.from(arrayBuffer)

        const filename = generateAssetFilename(outputImageUrl, contentType, 'image')
        const uploadResult = await uploadAsset(buffer, { type: 'image', filename })

        if (!uploadResult?.uri) {
            throw new Error('Failed to upload generated image')
        }

        const seedOutput = typeof result.data?.seed === 'number' ? [result.data.seed] : []

        return {
            image: [uploadResult.uri],
            seed: seedOutput
        }
    } catch (error: any) {
        const message = error?.message || 'Failed to upscale image with SeedVR'
        context.sendStatus({ type: 'error', message })
        throw error
    }
}

export default seedvrUpscaleImageNode
