import { NanoSDK, NodeDefinition, NodeInstance } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { FalImageReference, uploadGeneratedImages } from '../flux-pro/utils.js'
import { resolveLoraPath } from './utils.js'

interface ZImageTurboResponse {
    images?: FalImageReference[]
    seed?: number
    has_nsfw_concepts?: boolean[]
    data?: {
        images?: FalImageReference[]
        seed?: number
        has_nsfw_concepts?: boolean[]
    }
}

const IMAGE_SIZE_PRESETS = [
    'landscape_4_3',
    'landscape_16_9',
    'portrait_4_3',
    'portrait_16_9',
    'square',
    'square_hd',
    'custom'
] as const

const IMAGE_SIZE_OPTIONS = [
    { label: 'Landscape 4:3 (default)', value: 'landscape_4_3' },
    { label: 'Landscape 16:9', value: 'landscape_16_9' },
    { label: 'Portrait 4:3', value: 'portrait_4_3' },
    { label: 'Portrait 16:9', value: 'portrait_16_9' },
    { label: 'Square', value: 'square' },
    { label: 'Square HD', value: 'square_hd' },
    { label: 'Custom (use width & height)', value: 'custom' }
] as const

const allowedFormats = new Set(['jpeg', 'png', 'webp'])
const allowedAccelerations = new Set(['none', 'regular', 'high'])

const clampNumber = (value: number, min: number, max: number): number => {
    if (Number.isNaN(value)) {
        return min
    }
    return Math.min(Math.max(value, min), max)
}

const ensurePreset = (value: unknown): (typeof IMAGE_SIZE_PRESETS)[number] => {
    if (typeof value === 'string' && IMAGE_SIZE_PRESETS.includes(value as (typeof IMAGE_SIZE_PRESETS)[number])) {
        return value as (typeof IMAGE_SIZE_PRESETS)[number]
    }
    return 'landscape_4_3'
}

const nodeDefinition: NodeDefinition = {
    uid: 'fal-z-image-turbo-lora',
    name: 'Z-Image Turbo (LoRA)',
    category: 'Image Generation',
    version: '1.0.0',
    type: 'server',
    description: 'Generates images from text prompts using Fal.ai\'s Z-Image Turbo model with LoRA support',
    inputs: [
        {
            name: 'prompt',
            type: 'string',
            description: 'Text prompt describing the desired image'
        },
        {
            name: 'lora_1_path',
            type: 'asset:file',
            description: 'Path or URL to the first LoRA model (safetensors)'
        },
        {
            name: 'lora_2_path',
            type: 'asset:file',
            description: 'Path or URL to the second LoRA model (safetensors)'
        },
        {
            name: 'lora_3_path',
            type: 'asset:file',
            description: 'Path or URL to the third LoRA model (safetensors)'
        }
    ],
    outputs: [
        {
            name: 'images',
            type: 'asset:image',
            description: 'Generated images as NanoGraph asset URIs'
        },
        {
            name: 'seed',
            type: 'number',
            description: 'Seed used for generation'
        },
        {
            name: 'has_nsfw_concepts',
            type: 'boolean',
            description: 'Flag per generated image indicating potential NSFW content'
        }
    ],
    parameters: [
        {
            name: 'num_images',
            type: 'number',
            value: 1,
            default: 1,
            min: 1,
            max: 4,
            step: 1,
            label: 'Number of Images',
            description: 'How many images to generate (1-4)'
        },
        {
            name: 'image_size',
            type: 'select',
            value: 'landscape_4_3',
            default: 'landscape_4_3',
            label: 'Image Size Preset',
            description: 'Preset aspect ratios, or choose Custom to set explicit dimensions',
            options: IMAGE_SIZE_OPTIONS.map((option) => ({ label: option.label, value: option.value }))
        },
        {
            name: 'custom_width',
            type: 'number',
            value: 1024,
            default: 1024,
            min: 64,
            max: 14142,
            step: 1,
            label: 'Custom Width',
            description: 'Width in pixels when Image Size Preset is Custom'
        },
        {
            name: 'custom_height',
            type: 'number',
            value: 768,
            default: 768,
            min: 64,
            max: 14142,
            step: 1,
            label: 'Custom Height',
            description: 'Height in pixels when Image Size Preset is Custom'
        },
        {
            name: 'num_inference_steps',
            type: 'number',
            value: 8,
            default: 8,
            min: 1,
            max: 8,
            step: 1,
            label: 'Inference Steps',
            description: 'Number of denoising steps (1-8)'
        },
        {
            name: 'seed',
            type: 'number',
            value: -1,
            default: -1,
            min: -1,
            step: 1,
            label: 'Seed (-1 = random)',
            description: 'Use a fixed seed (>= 0) for repeatable generations'
        },
        {
            name: 'output_format',
            type: 'select',
            value: 'png',
            default: 'png',
            label: 'Output Format',
            description: 'Format for generated images',
            options: [
                { label: 'JPEG', value: 'jpeg' },
                { label: 'PNG', value: 'png' },
                { label: 'WebP', value: 'webp' }
            ]
        },
        {
            name: 'acceleration',
            type: 'select',
            value: 'none',
            default: 'none',
            label: 'Acceleration',
            description: 'Generation speed profile',
            options: [
                { label: 'None', value: 'none' },
                { label: 'Regular', value: 'regular' },
                { label: 'High', value: 'high' }
            ]
        },
        {
            name: 'sync_mode',
            type: 'boolean',
            value: false,
            default: false,
            label: 'Sync Mode',
            description: 'Wait for inline image uploads before returning (adds latency)'
        },
        {
            name: 'enable_safety_checker',
            type: 'boolean',
            value: true,
            default: true,
            label: 'Enable Safety Checker',
            description: 'Toggle the Fal.ai safety checker'
        },
        {
            name: 'enable_prompt_expansion',
            type: 'boolean',
            value: false,
            default: false,
            label: 'Enable Prompt Expansion',
            description: 'Whether to enable prompt expansion (extra cost)'
        },
        {
            name: 'lora_1_scale',
            type: 'number',
            value: 1.0,
            default: 1.0,
            min: 0,
            max: 2,
            step: 0.05,
            label: 'LoRA 1 Scale',
            description: 'Strength of the first LoRA'
        },
        {
            name: 'lora_2_scale',
            type: 'number',
            value: 1.0,
            default: 1.0,
            min: 0,
            max: 2,
            step: 0.05,
            label: 'LoRA 2 Scale',
            description: 'Strength of the second LoRA'
        },
        {
            name: 'lora_3_scale',
            type: 'number',
            value: 1.0,
            default: 1.0,
            min: 0,
            max: 2,
            step: 0.05,
            label: 'LoRA 3 Scale',
            description: 'Strength of the third LoRA'
        }
    ]
}

const zImageTurboLoraNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

zImageTurboLoraNode.execute = async ({ inputs, parameters, context }) => {
    configureFalClient()

    const prompt = inputs.prompt?.[0] as string

    if (!prompt) {
        context.sendStatus({ type: 'error', message: 'Prompt is required' })
        throw new Error('Prompt is required')
    }

    const numImages = clampNumber(Number(getParameterValue(parameters, 'num_images', 1)), 1, 4)
    const imageSizePreset = ensurePreset(getParameterValue(parameters, 'image_size', 'landscape_4_3'))
    const customWidth = clampNumber(Math.round(Number(getParameterValue(parameters, 'custom_width', 1024))), 64, 14142)
    const customHeight = clampNumber(Math.round(Number(getParameterValue(parameters, 'custom_height', 768))), 64, 14142)
    const numInferenceSteps = clampNumber(Math.round(Number(getParameterValue(parameters, 'num_inference_steps', 8))), 1, 8)
    const seedValue = Number(getParameterValue(parameters, 'seed', -1))
    const requestedFormat = String(getParameterValue(parameters, 'output_format', 'png'))
    const outputFormat = allowedFormats.has(requestedFormat) ? requestedFormat : 'png'
    const requestedAcceleration = String(getParameterValue(parameters, 'acceleration', 'none'))
    const acceleration = allowedAccelerations.has(requestedAcceleration) ? requestedAcceleration : 'none'
    const syncMode = Boolean(getParameterValue(parameters, 'sync_mode', false))
    const enableSafetyChecker = Boolean(getParameterValue(parameters, 'enable_safety_checker', true))
    const enablePromptExpansion = Boolean(getParameterValue(parameters, 'enable_prompt_expansion', false))

    // Process LoRAs
    const loras: Array<{ path: string; scale: number }> = []

    const lora1Path = inputs.lora_1_path?.[0] as string
    if (lora1Path) {
        const url = await resolveLoraPath(lora1Path)
        const scale = Number(getParameterValue(parameters, 'lora_1_scale', 1.0))
        loras.push({ path: url, scale })
    }

    const lora2Path = inputs.lora_2_path?.[0] as string
    if (lora2Path) {
        const url = await resolveLoraPath(lora2Path)
        const scale = Number(getParameterValue(parameters, 'lora_2_scale', 1.0))
        loras.push({ path: url, scale })
    }

    const lora3Path = inputs.lora_3_path?.[0] as string
    if (lora3Path) {
        const url = await resolveLoraPath(lora3Path)
        const scale = Number(getParameterValue(parameters, 'lora_3_scale', 1.0))
        loras.push({ path: url, scale })
    }

    const payload: Record<string, unknown> = {
        prompt,
        num_images: numImages,
        image_size: imageSizePreset === 'custom'
            ? { width: customWidth, height: customHeight }
            : imageSizePreset,
        num_inference_steps: numInferenceSteps,
        output_format: outputFormat,
        acceleration,
        sync_mode: syncMode,
        enable_safety_checker: enableSafetyChecker,
        enable_prompt_expansion: enablePromptExpansion,
        loras
    }

    if (Number.isInteger(seedValue) && seedValue >= 0) {
        payload.seed = seedValue
    }

    // Estimation logic
    const accelerationFactor = acceleration === 'high' ? 0.65 : acceleration === 'regular' ? 0.85 : 1
    const syncFactor = syncMode ? 1.2 : 1
    const stepFactor = numInferenceSteps / 8
    const expectedMs = Math.min(
        150000,
        Math.max(5000, Math.floor(numImages * 5000 * stepFactor * accelerationFactor * syncFactor))
    )

    const strategy = createProgressStrategy({
        expectedMs,
        inQueueMessage: 'Waiting for Z-Image Turbo (LoRA)...',
        finalizingMessage: 'Finalizing images...',
        defaultInProgressMessage: (step) => `Processing step ${step}...`
    })

    try {
        let stepCount = 0

        const result = await fal.subscribe('fal-ai/z-image/turbo/lora', {
            input: payload as any,
            logs: true,
            onQueueUpdate: (status: QueueStatus) => {
                if (status.status === 'IN_QUEUE') {
                    const update = strategy.onQueue()
                    context.sendStatus({ type: 'running', message: update.message, progress: update.progress })
                } else if (status.status === 'IN_PROGRESS') {
                    stepCount += 1
                    const update = strategy.onProgress(status, stepCount)
                    context.sendStatus({ type: 'running', message: update.message, progress: update.progress })
                } else if (status.status === 'COMPLETED') {
                    const update = strategy.onCompleted()
                    context.sendStatus({ type: 'running', message: update.message, progress: update.progress })
                }
            }
        }) as ZImageTurboResponse

        const responseData = (result as any)?.data ?? {}
        const directImages = Array.isArray(result.images) ? result.images : []
        const nestedImages = Array.isArray(responseData.images) ? responseData.images : []
        const images = (directImages.length ? directImages : nestedImages) as FalImageReference[]

        if (!images.length) {
            throw new Error('No images were returned by the Z-Image Turbo API')
        }

        const uploadedImages = await uploadGeneratedImages(images)

        const responseSeed = typeof responseData.seed === 'number'
            ? responseData.seed
            : (typeof result.seed === 'number' ? result.seed : undefined)

        const nsfwFlags = Array.isArray(responseData.has_nsfw_concepts)
            ? responseData.has_nsfw_concepts
            : (Array.isArray(result.has_nsfw_concepts) ? result.has_nsfw_concepts : [])

        return {
            images: uploadedImages,
            seed: typeof responseSeed === 'number' ? [responseSeed] : [],
            has_nsfw_concepts: nsfwFlags
        }
    } catch (error: any) {
        const message = error?.message || 'Failed to generate images with Z-Image Turbo (LoRA)'
        context.sendStatus({ type: 'error', message })
        throw error
    }
}

export default zImageTurboLoraNode
