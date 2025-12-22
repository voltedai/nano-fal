import { NanoSDK, NodeDefinition, NodeInstance, resolveAsset, uploadAsset } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { uploadBufferToFal } from '../../utils/fal-storage.js'
import { generateVideoFilename } from '../../utils/asset-utils.js'

interface SeedvrUpscaleVideoResponse {
    data?: {
        video?: {
            url?: string
        }
        seed?: number
    }
}

const UPSCALE_MODES = ['factor', 'target'] as const
const TARGET_RESOLUTIONS = ['720p', '1080p', '1440p', '2160p'] as const
const OUTPUT_FORMATS = ['X264 (.mp4)', 'VP9 (.webm)', 'PRORES4444 (.mov)', 'GIF (.gif)'] as const
const OUTPUT_QUALITIES = ['low', 'medium', 'high', 'maximum'] as const
const OUTPUT_WRITE_MODES = ['fast', 'balanced', 'small'] as const

const nodeDefinition: NodeDefinition = {
    uid: 'fal-seedvr-upscale-video',
    name: 'SeedVR Upscale Video',
    category: 'SeedVR',
    version: '1.0.0',
    type: 'server',
    description: 'Upscale videos using SeedVR model',
    inputs: [
        {
            name: 'video',
            type: 'asset:video',
            description: 'Input video to upscale'
        }
    ],
    outputs: [
        {
            name: 'video',
            type: 'asset:video',
            description: 'Upscaled video'
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
            value: 'X264 (.mp4)',
            default: 'X264 (.mp4)',
            label: 'Output Format',
            description: 'Format of the output video',
            options: OUTPUT_FORMATS.map(f => ({ label: f, value: f }))
        },
        {
            name: 'output_quality',
            type: 'select',
            value: 'high',
            default: 'high',
            label: 'Output Quality',
            description: 'Quality of the output video',
            options: OUTPUT_QUALITIES.map(q => ({ label: q.charAt(0).toUpperCase() + q.slice(1), value: q }))
        },
        {
            name: 'output_write_mode',
            type: 'select',
            value: 'balanced',
            default: 'balanced',
            label: 'Output Write Mode',
            description: 'Write mode of the output video',
            options: OUTPUT_WRITE_MODES.map(m => ({ label: m.charAt(0).toUpperCase() + m.slice(1), value: m }))
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

const seedvrUpscaleVideoNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

seedvrUpscaleVideoNode.execute = async ({ inputs, parameters, context }) => {
    configureFalClient()

    const video = inputs.video?.[0] as string

    if (!video) {
        context.sendStatus({ type: 'error', message: 'Input video is required' })
        throw new Error('Input video is required')
    }

    const upscaleMode = getParameterValue<string>(parameters, 'upscale_mode', 'factor')
    const upscaleFactor = getParameterValue<number>(parameters, 'upscale_factor', 2)
    const targetResolution = getParameterValue<string>(parameters, 'target_resolution', '1080p')
    const noiseScale = getParameterValue<number>(parameters, 'noise_scale', 0.1)
    const outputFormat = getParameterValue<string>(parameters, 'output_format', 'X264 (.mp4)')
    const outputQuality = getParameterValue<string>(parameters, 'output_quality', 'high')
    const outputWriteMode = getParameterValue<string>(parameters, 'output_write_mode', 'balanced')
    const seedValueRaw = getParameterValue<number>(parameters, 'seed', -1)

    context.sendStatus({ type: 'running', message: 'Preparing SeedVR Upscale request...' })

    try {
        const videoBuffer: Buffer = await resolveAsset(video, { asBuffer: true }) as Buffer
        const videoUrl = await uploadBufferToFal(videoBuffer, 'mp4', { filenamePrefix: 'seedvr-upscale-in' })

        const requestPayload: any = {
            video_url: videoUrl,
            upscale_mode: upscaleMode,
            noise_scale: noiseScale,
            output_format: outputFormat,
            output_quality: outputQuality,
            output_write_mode: outputWriteMode
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
            expectedMs: 30000, // 30s estimate
            inQueueMessage: 'Waiting in queue...',
            finalizingMessage: 'Finalizing upscale...'
        })

        const result = await fal.subscribe('fal-ai/seedvr/upscale/video', {
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
        }) as SeedvrUpscaleVideoResponse

        const outputVideoUrl = result.data?.video?.url

        if (!outputVideoUrl) {
            throw new Error('No video was generated by SeedVR')
        }

        const response = await fetch(outputVideoUrl)
        const contentType = response.headers.get('content-type')
        const arrayBuffer = await response.arrayBuffer()
        const buffer = Buffer.from(arrayBuffer)

        const filename = generateVideoFilename(outputVideoUrl, contentType)
        const uploadResult = await uploadAsset(buffer, { type: 'video', filename })

        if (!uploadResult?.uri) {
            throw new Error('Failed to upload generated video')
        }

        const seedOutput = typeof result.data?.seed === 'number' ? [result.data.seed] : []

        return {
            video: [uploadResult.uri],
            seed: seedOutput
        }
    } catch (error: any) {
        const message = error?.message || 'Failed to upscale video with SeedVR'
        context.sendStatus({ type: 'error', message })
        throw error
    }
}

export default seedvrUpscaleVideoNode
